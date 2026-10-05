#!/usr/bin/env python3
"""Build a deterministic UCM25 archive from the downloaded original files.

The accepted PDF remains authoritative for submitted BOM order, historical
display totals, and page layout.  Per-part CSV files are authoritative for
editable header fields and cost-line inputs.  Every difference between those
sources is emitted in the reconciliation report. Reviewed quantity meanings
are reconciled from assembly membership tables without changing submitted display values.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import mimetypes
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from ucm25_archive_build import (
    ACCEPTED_SOURCE_SHA256,
    archive_evidence,
    build_nodes,
    choose_detail_assignments,
    clean_project_summary,
    decimal_string,
    source_manifest,
    write_archive,
)


from ucm25_quantity_reconciliation import reconcile_source_quantities


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_ROOT = (
    ROOT
    / "tmp"
    / "ucm25-original-source"
    / "20260831T1440Z"
    / "all-costing-current"
    / "Costing"
)
DEFAULT_SOURCE_ZIP = (
    ROOT / "tmp" / "ucm25-original-source" / "20260831T1440Z" / "Costing.zip"
)
DEFAULT_INDEX = (
    ROOT
    / "tmp"
    / "ucm25-original-source"
    / "20260831T1440Z"
    / "final-submission"
    / "!Part Index 2025 - version 701.xlsx"
)
DEFAULT_MODEL = ROOT / "tmp" / "pdfs" / "ucm25-reference-structure.json"
DEFAULT_SEED = ROOT / "tmp" / "pdfs" / "ucm26-empty-source.ucm.zip"
DEFAULT_EVIDENCE = ROOT / "tmp" / "pdfs" / "ucm25-evidence-source-v2" / "evidence-index.json"
DEFAULT_LAYOUT = ROOT / "tmp" / "pdfs" / "ucm25-evidence-source-v2" / "ucm25-historical-layout.json"
DEFAULT_OUTPUT_DIR = ROOT / "outputs" / "ucm25-source-reconstruction"
CSV_NAME = re.compile(
    r"^([A-Z]{2})_(\d{6})(?:-([LR]))?_([A-Z])(?:-([LR]))?$", re.IGNORECASE
)
KINDS = ("material", "process", "fastener", "tooling")


@dataclass(frozen=True)
class SourceLine:
    kind: str
    row_number: int
    order_display: str
    description: str
    use_description: str
    unit_cost: str
    quantity: str
    multiplier_name: str
    multiplier: str
    fraction_included: str
    production_volume_factor: str
    unit_display: str
    subtotal: str
    size_inputs: tuple[tuple[str, str], ...]
    raw: dict[str, str]


@dataclass(frozen=True)
class SourceCsv:
    path: Path
    identifier: str | None
    sha256: str
    header: dict[str, str]
    lines: tuple[SourceLine, ...]
    section_subtotals: dict[str, str]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized(value: str) -> str:
    return " ".join(value.strip().lower().replace("-", " ").split())


def decimal(value: Any) -> Decimal | None:
    text = str(value or "").strip().replace(",", "").replace("$", "")
    if not text:
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def archive_number(value: Any, *, default: str = "0") -> str:
    parsed = decimal(value)
    return decimal_string(parsed if parsed is not None else default)


def filename_identifier(path: Path) -> str | None:
    match = CSV_NAME.match(path.stem.strip())
    if not match:
        return None
    system, number, first_hand, revision, second_hand = match.groups()
    hand = first_hand or second_hand
    return (
        f"E13-25-{system.upper()}-{number}"
        + (f"-{hand.upper()}" if hand else "")
        + f"-{revision.upper()}"
    )


def header_index(row: list[str]) -> dict[str, int]:
    return {normalized(value): index for index, value in enumerate(row) if value.strip()}


def field(row: list[str], indices: dict[str, int], *names: str) -> str:
    for name in names:
        index = indices.get(normalized(name))
        if index is not None and index < len(row):
            return row[index].strip()
    return ""


def parse_source_csv(path: Path) -> SourceCsv:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as stream:
        rows = [[value.strip() for value in row] for row in csv.reader(stream)]
    header: dict[str, str] = {}
    for row in rows[:20]:
        if len(row) >= 2 and row[0] in {
            "University",
            "Entry No.",
            "System",
            "Assembly",
            "Assembly No.",
            "Part",
            "Part No.",
            "Revision",
            "Details",
            "Assembly Cost",
            "Part Cost",
            "Quantity",
            "Extended Cost",
        }:
            header[row[0]] = row[1]

    lines: list[SourceLine] = []
    declared: dict[str, str] = {}
    current_kind: str | None = None
    indices: dict[str, int] = {}
    for row_number, row in enumerate(rows, 1):
        if row and row[0] == "Item Order" and len(row) > 1:
            possible = normalized(row[1])
            current_kind = possible if possible in KINDS else None
            indices = header_index(row) if current_kind else {}
            continue
        if not current_kind:
            continue
        if "Subtotal" in row:
            position = row.index("Subtotal")
            value = row[position + 1].strip() if position + 1 < len(row) else ""
            if value:
                declared[current_kind] = value
            current_kind = None
            indices = {}
            continue
        description = field(row, indices, current_kind)
        if not description:
            continue
        size_inputs: list[tuple[str, str]] = []
        for index in range(1, 5):
            size = field(row, indices, f"Size {index}")
            unit = field(row, indices, f"Unit {index}")
            if size or unit:
                size_inputs.append((size, unit))
        subtotal = field(row, indices, "Sub Total", "Subtotal", "Line Total")
        lines.append(
            SourceLine(
                kind=current_kind,
                row_number=row_number,
                order_display=field(row, indices, "Item Order"),
                description=description,
                use_description=field(row, indices, "Use"),
                unit_cost=field(row, indices, "Unit Cost"),
                quantity=field(row, indices, "Quantity"),
                multiplier_name=field(row, indices, "Multiplier"),
                multiplier=field(row, indices, "Multiplier Value"),
                fraction_included=field(row, indices, "Fraction Included"),
                production_volume_factor=field(row, indices, "PVF"),
                unit_display=field(row, indices, "Unit"),
                subtotal=subtotal,
                size_inputs=tuple(size_inputs),
                raw={key: row[index] for key, index in indices.items() if index < len(row)},
            )
        )
    return SourceCsv(
        path=path,
        identifier=filename_identifier(path),
        sha256=sha256(path),
        header=header,
        lines=tuple(lines),
        section_subtotals=declared,
    )


def role_for(relative: Path) -> str:
    first = relative.parts[0] if relative.parts else ""
    if first == "!Addendum":
        return "post-submission-addendum"
    if relative.name in {"_UCM25 Final Costing Report.pdf", "UCM25 Final Costing Report.pdf"}:
        return "accepted-final-pdf"
    if first == "!Final":
        return "final-report-component"
    if first == "Costing Code":
        return "original-generation-code"
    if relative.suffix.lower() == ".csv":
        return "original-cost-record"
    if first == "@Assembly Trees":
        return "assembly-tree-source"
    return "supporting-source"


def write_source_manifest(
    source_root: Path,
    source_zip: Path,
    index_workbook: Path,
    destination: Path,
) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    aggregate = hashlib.sha256()
    for path in sorted(item for item in source_root.rglob("*") if item.is_file()):
        relative = path.relative_to(source_root)
        digest = sha256(path)
        entry = {
            "cloudPath": f"UCM 2025/Documents/Comp/Costing/{relative.as_posix()}",
            "selectedVersion": "current-at-2026-08-31-download",
            "modifiedAt": None,
            "bytes": path.stat().st_size,
            "sha256": digest,
            "mediaType": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            "role": role_for(relative),
        }
        entries.append(entry)
        aggregate.update(
            f"{entry['cloudPath']}\0{entry['bytes']}\0{digest}\n".encode("utf-8")
        )
    workbook_digest = sha256(index_workbook)
    workbook_entry = {
        "cloudPath": "UCM 2025/Documents/!Part Index 2025.xlsx",
        "selectedVersion": "701.0",
        "modifiedAt": "2025-10-02T18:14:00+12:00",
        "bytes": index_workbook.stat().st_size,
        "sha256": workbook_digest,
        "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "role": "final-submission-part-index",
    }
    entries.append(workbook_entry)
    aggregate.update(
        f"{workbook_entry['cloudPath']}\0{workbook_entry['bytes']}\0{workbook_digest}\n".encode(
            "utf-8"
        )
    )
    result = {
        "format": "ucm25-source-manifest",
        "schemaVersion": 1,
        "retrievedAt": "2026-08-31T18:40:00Z",
        "submissionCutoff": "2025-10-03T23:59:59+12:00",
        "snapshotPolicy": (
            "Part index version 701.0 is the last pre-submission version. The costing tree "
            "is the current downloaded tree and is reconciled record-by-record to the "
            "hash-locked accepted report; !Addendum is inventoried but excluded."
        ),
        "containers": [
            {
                "path": str(source_zip.resolve()),
                "bytes": source_zip.stat().st_size,
                "sha256": sha256(source_zip),
            }
        ],
        "aggregateDigest": aggregate.hexdigest(),
        "entryCount": len(entries),
        "entries": entries,
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def source_candidates(source_root: Path) -> dict[str, list[SourceCsv]]:
    result: dict[str, list[SourceCsv]] = defaultdict(list)
    for path in sorted(source_root.rglob("*.csv")):
        relative = path.relative_to(source_root)
        if relative.parts[0] == "!Addendum":
            continue
        parsed = parse_source_csv(path)
        if parsed.identifier:
            result[parsed.identifier].append(parsed)
    return result


def direct_total(source: SourceCsv) -> Decimal:
    total = Decimal(0)
    by_kind: dict[str, list[SourceLine]] = defaultdict(list)
    for line in source.lines:
        by_kind[line.kind].append(line)
    for kind in KINDS:
        declared = decimal(source.section_subtotals.get(kind))
        if declared is not None:
            total += declared
        else:
            total += sum((decimal(line.subtotal) or Decimal(0) for line in by_kind[kind]), Decimal(0))
    return total


def choose_sources(
    model: dict[str, Any], source_root: Path
) -> tuple[dict[int, SourceCsv | None], dict[int, list[SourceCsv]], list[dict[str, Any]]]:
    candidates = source_candidates(source_root)
    rail = parse_source_csv(source_root / "3 CH Chassis" / "pedal box" / "CH_140003_A.csv")
    shoulder = [
        parse_source_csv(source_root / "4 AD Aerodynamics" / "AD_130001-L_A.csv"),
        parse_source_csv(source_root / "4 AD Aerodynamics" / "AD_130001-R_A.csv"),
    ]
    selected: dict[int, SourceCsv | None] = {}
    provenance: dict[int, list[SourceCsv]] = {}
    issues: list[dict[str, Any]] = []
    for record in model["bom"]:
        occurrence = int(record["occurrence"])
        identifier = record["identifier"]
        options = list(candidates.get(identifier, []))
        reason = "exact-identifier"
        if identifier in {"E13-25-CH-140003-L-A", "E13-25-CH-140003-R-A"}:
            options = [rail]
            reason = "generic-mirrored-source"
        elif identifier == "E13-25-AD-130001-A":
            options = shoulder
            reason = "paired-handed-current-sources"
        if not options:
            selected[occurrence] = None
            provenance[occurrence] = []
            issues.append(
                {
                    "kind": "bom-record-without-csv",
                    "occurrence": occurrence,
                    "identifier": identifier,
                    "resolution": "preserve accepted PDF BOM row without direct cost lines",
                }
            )
            continue
        target = decimal(record.get("total_cost")) or Decimal(0)
        ranked = sorted(
            options,
            key=lambda source: (
                direct_total(source) != target,
                abs(direct_total(source) - target),
                source.path.as_posix(),
            ),
        )
        primary = ranked[0]
        selected[occurrence] = primary
        provenance[occurrence] = sorted(options, key=lambda item: item.path.as_posix())
        if len(options) > 1 or reason != "exact-identifier":
            issues.append(
                {
                    "kind": "explicit-source-alias",
                    "occurrence": occurrence,
                    "identifier": identifier,
                    "reason": reason,
                    "selected": str(primary.path.relative_to(source_root)),
                    "allSources": [str(item.path.relative_to(source_root)) for item in provenance[occurrence]],
                }
            )
    return selected, provenance, issues


def line_signature(line: SourceLine | dict[str, Any]) -> str:
    if isinstance(line, SourceLine):
        values = (line.description, line.use_description, line.subtotal)
    else:
        values = (
            str(line.get("description") or ""),
            str(line.get("useDescription") or ""),
            str(line.get("declaredSubtotal") or ""),
        )
    return "|".join(normalized(value) for value in values)


def source_pages_for_lines(
    source_lines: list[SourceLine],
    reference_lines: list[dict[str, Any]],
    fallback_pages: list[int],
) -> tuple[list[int | None], int]:
    if not source_lines:
        return [], 0
    if len(source_lines) == len(reference_lines):
        return [int(line["sourcePage"]) for line in reference_lines], len(source_lines)
    source_signatures = [line_signature(line) for line in source_lines]
    reference_signatures = [line_signature(line) for line in reference_lines]
    matcher = SequenceMatcher(None, source_signatures, reference_signatures, autojunk=False)
    mapped: dict[int, int] = {}
    for source_start, reference_start, length in matcher.get_matching_blocks():
        for offset in range(length):
            mapped[source_start + offset] = int(reference_lines[reference_start + offset]["sourcePage"])
    pages: list[int | None] = []
    available = sorted({int(line["sourcePage"]) for line in reference_lines}) or fallback_pages
    for index in range(len(source_lines)):
        if index in mapped:
            pages.append(mapped[index])
            continue
        previous = next((mapped[item] for item in range(index - 1, -1, -1) if item in mapped), None)
        following = next((mapped[item] for item in range(index + 1, len(source_lines)) if item in mapped), None)
        pages.append(previous or following or (available[0] if available else None))
    return pages, len(mapped)


def build_source_cost_lines(
    model: dict[str, Any],
    selected: dict[int, SourceCsv | None],
    source_root: Path,
    layout: dict[str, Any],
    source_id_by_occurrence: dict[int, str],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    details = choose_detail_assignments(model)
    fallback_by_occurrence_kind: dict[tuple[int, str], list[int]] = defaultdict(list)
    for page in layout["pages"]:
        occurrence = page.get("ownerOccurrence")
        if not isinstance(occurrence, int) or page.get("renderMode") != "generated":
            continue
        for kind in page.get("costKinds", []):
            if kind in KINDS:
                fallback_by_occurrence_kind[(occurrence, kind)].append(int(page["pageNumber"]))

    output: list[dict[str, Any]] = []
    allocation = Counter()
    for occurrence in sorted(selected):
        source = selected[occurrence]
        if source is None:
            continue
        reference = details.get(occurrence, {}).get("costLines", [])
        reference_by_kind: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for line in reference:
            reference_by_kind[line["kind"]].append(line)
        source_by_kind: dict[str, list[SourceLine]] = defaultdict(list)
        for line in source.lines:
            source_by_kind[line.kind].append(line)
        source_order = 0
        kind_sort = Counter()
        for kind in KINDS:
            lines = source_by_kind[kind]
            pages, exact_matches = source_pages_for_lines(
                lines,
                reference_by_kind[kind],
                fallback_by_occurrence_kind[(occurrence, kind)],
            )
            allocation["sourceLines"] += len(lines)
            allocation["signatureMatches"] += exact_matches
            allocation["pageAssigned"] += sum(page is not None for page in pages)
            for line, page in zip(lines, pages):
                source_order += 1
                sort_order = kind_sort[kind]
                kind_sort[kind] += 1
                quantity = line.quantity or "1"
                multiplier = line.multiplier or "1"
                fraction = line.fraction_included or "1"
                unit_cost = line.unit_cost or "0"
                subtotal = line.subtotal or "0"
                stored_unit_cost = archive_number(unit_cost)
                stored_quantity = archive_number(quantity, default="1")
                stored_multiplier = archive_number(multiplier, default="1")
                stored_fraction = archive_number(fraction, default="1")
                stored_pvf = (
                    archive_number(line.production_volume_factor)
                    if line.production_volume_factor
                    else None
                )
                stored_subtotal = archive_number(subtotal)
                for field_value in (
                    line.unit_cost,
                    line.quantity,
                    line.multiplier,
                    line.fraction_included,
                    line.production_volume_factor,
                    line.subtotal,
                ):
                    if field_value and decimal(field_value) is None:
                        allocation["unresolvedNumericSourceFields"] += 1
                size_inputs: dict[str, str] = {}
                for size_number, (size, unit) in enumerate(line.size_inputs, 1):
                    if size:
                        size_inputs[f"size{size_number}"] = size
                    if unit:
                        size_inputs[f"size{size_number}Unit"] = unit
                relative = source.path.relative_to(source_root).as_posix()
                output.append(
                    {
                        "sourceId": f"ucm25-source-line-{occurrence:04d}-{source_order:04d}",
                        "sourceNodeId": source_id_by_occurrence[occurrence],
                        "kind": kind,
                        "catalogueItemId": None,
                        "description": line.description,
                        "useDescription": line.use_description,
                        "unitCost": stored_unit_cost,
                        "quantity": stored_quantity,
                        "multiplier": stored_multiplier,
                        "multiplierName": line.multiplier_name or None,
                        "multiplierCatalogueItemId": None,
                        "fractionIncluded": stored_fraction,
                        "productionVolumeFactor": stored_pvf,
                        "sizeInputs": size_inputs,
                        "calculation": {
                            "kind": kind,
                            "unitCost": stored_unit_cost,
                            "quantity": stored_quantity,
                            "multiplier": stored_multiplier,
                            "fractionIncluded": stored_fraction,
                            "productionVolumeFactor": stored_pvf,
                            "subtotal": stored_subtotal,
                            "historicalDeclaredSubtotal": True,
                            "sourcePage": page,
                            "sourceOrder": source_order,
                            "sourceMultiplierDisplay": line.multiplier,
                            "sourceUnitDisplay": line.unit_display,
                            "recoveredQuantityMissing": not bool(line.quantity),
                            "sourceQuantityDisplay": line.quantity,
                            "sourceUnitCostDisplay": line.unit_cost,
                            "sourceCsvPath": relative,
                            "sourceCsvSha256": source.sha256,
                            "sourceCsvRow": line.row_number,
                            "sourceRawFields": line.raw,
                        },
                        "subtotal": stored_subtotal,
                        "sortOrder": sort_order,
                    }
                )
    return output, dict(allocation)


def update_nodes_from_sources(
    nodes: list[dict[str, Any]],
    selected: dict[int, SourceCsv | None],
    provenance: dict[int, list[SourceCsv]],
    source_root: Path,
    index_sha256: str,
) -> None:
    by_source_id = {node["sourceId"]: node for node in nodes}
    for occurrence, source in selected.items():
        node = by_source_id[f"ucm25-node-{occurrence:04d}"]
        note = json.loads(node["internalNote"])
        sources = provenance[occurrence]
        note.update(
            {
                "sourceIndexWorkbookVersion": "701.0",
                "sourceIndexWorkbookSha256": index_sha256,
                "sourceCsvPaths": [item.path.relative_to(source_root).as_posix() for item in sources],
                "sourceCsvSha256": [item.sha256 for item in sources],
            }
        )
        if source:
            note["sourceCsvHeader"] = source.header
            detail_cost = source.header.get("Assembly Cost") or source.header.get("Part Cost")
            if detail_cost:
                note["historicalDetailCost"] = decimal_string(detail_cost)
            if source.header.get("Quantity"):
                note["historicalDetailQuantity"] = decimal_string(source.header["Quantity"])
            if source.header.get("Extended Cost"):
                note["historicalDetailExtendedCost"] = decimal_string(source.header["Extended Cost"])
            if source.header.get("Revision"):
                node["revision"] = source.header["Revision"]
            exact_identifier = source.identifier == node["referenceId"]
            if exact_identifier:
                source_name = (
                    source.header.get("Assembly")
                    if node["kind"] == "assembly"
                    else source.header.get("Part")
                )
                if source_name:
                    node["name"] = source_name
                if source.header.get("Details"):
                    node["description"] = source.header["Details"]
        node["internalNote"] = json.dumps(note, sort_keys=True, separators=(",", ":"))


def build_reconciliation(
    model: dict[str, Any],
    selected: dict[int, SourceCsv | None],
    provenance_issues: list[dict[str, Any]],
    allocation: dict[str, Any],
    source_root: Path,
) -> dict[str, Any]:
    issues = list(provenance_issues)
    exact_direct_totals = 0
    for record in model["bom"]:
        occurrence = int(record["occurrence"])
        source = selected[occurrence]
        if source is None:
            continue
        source_total = direct_total(source)
        bom_total = decimal(record.get("total_cost")) or Decimal(0)
        if source_total == bom_total:
            exact_direct_totals += 1
        else:
            issues.append(
                {
                    "kind": "source-csv-versus-submitted-bom-total",
                    "occurrence": occurrence,
                    "identifier": record["identifier"],
                    "sourceCsvPath": source.path.relative_to(source_root).as_posix(),
                    "sourceDirectCost": decimal_string(source_total),
                    "submittedBomDirectCost": decimal_string(bom_total),
                    "resolution": (
                        "import source CSV lines for future copying; retain the submitted BOM value "
                        "as hash-locked historical display metadata"
                    ),
                }
            )
        for line in source.lines:
            numeric_fields = {
                "unitCost": line.unit_cost,
                "quantity": line.quantity,
                "multiplier": line.multiplier,
                "fractionIncluded": line.fraction_included,
                "productionVolumeFactor": line.production_volume_factor,
                "subtotal": line.subtotal,
            }
            for field_name, raw_value in numeric_fields.items():
                if raw_value and decimal(raw_value) is None:
                    issues.append(
                        {
                            "kind": "unresolved-source-numeric-field",
                            "occurrence": occurrence,
                            "identifier": record["identifier"],
                            "sourceCsvPath": source.path.relative_to(source_root).as_posix(),
                            "sourceCsvRow": line.row_number,
                            "field": field_name,
                            "rawValue": raw_value,
                            "resolution": (
                                "retain the literal source value, row, path, and hash in calculation "
                                "provenance; store numeric zero only because the portable archive schema "
                                "requires a numeric field"
                            ),
                        }
                    )
    return {
        "format": "ucm25-source-reconciliation",
        "schemaVersion": 1,
        "sourcePdfSha256": ACCEPTED_SOURCE_SHA256,
        "bomOccurrences": len(model["bom"]),
        "bomOccurrencesWithCsv": sum(source is not None for source in selected.values()),
        "bomOccurrencesWithoutCsv": sum(source is None for source in selected.values()),
        "exactCsvDirectTotalMatches": exact_direct_totals,
        "linePageAllocation": allocation,
        "issueCounts": dict(sorted(Counter(item["kind"] for item in issues).items())),
        "issues": issues,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=DEFAULT_SOURCE_ROOT)
    parser.add_argument("--source-zip", type=Path, default=DEFAULT_SOURCE_ZIP)
    parser.add_argument("--index-workbook", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--seed-archive", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--evidence-index", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--layout", type=Path, default=DEFAULT_LAYOUT)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    model = json.loads(args.model.read_text(encoding="utf-8"))
    if model.get("source", {}).get("sha256") != ACCEPTED_SOURCE_SHA256:
        raise ValueError("model is not derived from the accepted UCM25 PDF")
    layout = json.loads(args.layout.read_text(encoding="utf-8"))
    if layout.get("sourcePdfSha256") != ACCEPTED_SOURCE_SHA256:
        raise ValueError("historical layout is not hash-locked to the accepted UCM25 PDF")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    source_inventory = write_source_manifest(
        args.source_root,
        args.source_zip,
        args.index_workbook,
        args.output_dir / "source-manifest.json",
    )
    selected, provenance, source_issues = choose_sources(model, args.source_root)
    detail_assignments = choose_detail_assignments(model)
    nodes, source_ids = build_nodes(model, detail_assignments)
    index_digest = sha256(args.index_workbook)
    update_nodes_from_sources(
        nodes, selected, provenance, args.source_root, index_digest
    )
    quantity_corrections = reconcile_source_quantities(nodes, selected, args.source_root)
    cost_lines, allocation = build_source_cost_lines(
        model, selected, args.source_root, layout, source_ids
    )
    evidence_index = json.loads(args.evidence_index.read_text(encoding="utf-8"))
    evidence, evidence_paths = archive_evidence(evidence_index)
    seed = source_manifest(args.seed_archive)
    vehicle_note = json.loads(nodes[0]["internalNote"])
    vehicle_note.update(
        {
            "sourceManifestAggregateDigest": source_inventory["aggregateDigest"],
            "sourceIndexWorkbookVersion": "701.0",
            "sourceIndexWorkbookSha256": index_digest,
        }
    )
    nodes[0]["internalNote"] = json.dumps(vehicle_note, sort_keys=True, separators=(",", ":"))
    manifest = {
        "format": "ucm-project-archive",
        "schemaVersion": 1,
        "source": {
            "projectId": "ucm25-reconstructed-from-original-source",
            "projectVersion": 1,
            "projectUpdatedAt": "2025-10-03T11:59:59.000Z",
        },
        "project": {
            "name": "UC Motorsport 2025 — Source Archive",
            "season": 2025,
            "vehicleType": "electric",
            "entryNumber": "E13",
            "isHistorical": True,
            "projectSummary": clean_project_summary(model.get("frontMatterText", {}).get("2", "")),
            "numberingConvention": (
                "Submitted identifiers are preserved exactly; original per-part CSV paths and hashes "
                "are retained as record provenance."
            ),
            "bulkMethodSummary": (
                "Original 2025 CSV line inputs and declared subtotals are retained without repricing "
                "against the 2026 catalogue."
            ),
            "focusSystems": ["BR", "DR", "CH", "AD", "EL", "MS", "ST", "SU", "WT"],
        },
        "sources": seed["sources"],
        "nodes": nodes,
        "costLines": cost_lines,
        "evidence": evidence,
    }
    archive_path = args.output_dir / "ucm25-source-backed.ucm.zip"
    manifest_path = args.output_dir / "ucm25-source-backed-manifest.json"
    reconciliation_path = args.output_dir / "source-reconciliation.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    reconciliation = build_reconciliation(
        model, selected, source_issues + quantity_corrections, allocation, args.source_root
    )
    reconciliation_path.write_text(
        json.dumps(reconciliation, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    write_archive(archive_path, manifest, evidence_paths)
    print(
        json.dumps(
            {
                "archive": str(archive_path.resolve()),
                "archiveSha256": sha256(archive_path),
                "manifest": str(manifest_path.resolve()),
                "sourceManifest": str((args.output_dir / "source-manifest.json").resolve()),
                "reconciliation": str(reconciliation_path.resolve()),
                "nodes": len(nodes),
                "costLines": len(cost_lines),
                "evidence": len(evidence),
                "sourceEntries": source_inventory["entryCount"],
                "reconciliationIssueCounts": reconciliation["issueCounts"],
                "linePageAllocation": allocation,
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
