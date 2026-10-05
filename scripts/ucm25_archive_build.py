#!/usr/bin/env python3
"""Build a deterministic local-only UCM project archive from the UCM25 model.

This archive uses the rule and catalogue document hashes already installed in
the isolated development stack.  Historical lines retain displayed 2025
values and carry no live catalogue item references, so restoring the archive
cannot silently reprice them against the 2026 catalogue.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = ROOT / "tmp" / "pdfs" / "ucm25-reference-structure.json"
DEFAULT_SOURCE_ARCHIVE = ROOT / "tmp" / "pdfs" / "ucm26-empty-source.ucm.zip"
DEFAULT_OUTPUT = ROOT / "tmp" / "pdfs" / "ucm25-reconstructed.ucm.zip"
DEFAULT_MANIFEST_OUTPUT = ROOT / "tmp" / "pdfs" / "ucm25-reconstructed-manifest.json"
DEFAULT_EVIDENCE_INDEX = ROOT / "tmp" / "pdfs" / "ucm25-evidence" / "evidence-index.json"
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
SYSTEM_NAMES = {
    "BR": "Brake System",
    "DR": "Engine/Tractive Path and Drivetrain",
    "CH": "Chassis",
    "AD": "Aerodynamics",
    "EL": "Electrical System",
    "MS": "Miscellaneous, Fit, and Finish",
    "ST": "Steering System",
    "SU": "Suspension",
    "WT": "Wheels & Tires",
}
SUMMARY_BREAKDOWNS = {
    "BR": {"material": "1284.02", "process": "156.65", "fastener": "32.13", "tooling": "0", "total": "1472.80"},
    "DR": {"material": "3081.23", "process": "2362.35", "fastener": "146.53", "tooling": "2.40", "total": "10162.58"},
    "CH": {"material": "2228.26", "process": "4876.79", "fastener": "41.24", "tooling": "653.36", "total": "7799.65"},
    "AD": {"material": "1401.25", "process": "2349.91", "fastener": "13.88", "tooling": "125.22", "total": "3890.26"},
    "EL": {"material": "4239.21", "process": "287.45", "fastener": "4.77", "tooling": "0.56", "total": "4531.99"},
    "MS": {"material": "401.60", "process": "183.52", "fastener": "5.17", "tooling": "111.24", "total": "701.53"},
    "ST": {"material": "124.66", "process": "205.27", "fastener": "2.70", "tooling": "0", "total": "332.63"},
    "SU": {"material": "1442.58", "process": "4244.70", "fastener": "82.02", "tooling": "5.52", "total": "5774.82"},
    "WT": {"material": "210.64", "process": "725.04", "fastener": "4.32", "tooling": "2.34", "total": "942.34"},
}
SUMMARY_TOTAL_BREAKDOWN = {
    "material": "14413.45",
    "process": "15391.68",
    "fastener": "332.76",
    "tooling": "900.64",
    "total": "35608.60",
}
BOM_HEADER_TOTAL = "35614.70"
ACCEPTED_SOURCE_SHA256 = "a922ac7220b0924d1992773e1c3fd42632d53e90dfaad357cd1947edd0b25d37"


def decimal_string(value: Any, *, default: str = "0") -> str:
    if value is None or value == "":
        return default
    decimal = Decimal(str(value))
    if decimal == 0:
        return "0"
    return format(decimal.normalize(), "f")


def is_assembly_record(record: dict[str, Any]) -> bool:
    return str(record["part_number"]).startswith("00")


def source_manifest(path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path) as archive:
        return json.loads(archive.read("manifest.json"))


def node_source_id(record: dict[str, Any]) -> str:
    return f"ucm25-node-{int(record['occurrence']):04d}"


def clean_project_summary(raw: str) -> str:
    lines = [line.strip() for line in raw.splitlines()]
    lines = [
        line
        for line in lines
        if line and line != "Project Cost Summary" and not re.fullmatch(r"Page\s+1", line)
    ]
    return "\n".join(lines)


def choose_detail_assignments(model: dict[str, Any]) -> dict[int, dict[str, Any]]:
    """Assign each recovered detail occurrence to at most one BOM occurrence.

    Exact identifiers win.  A malformed identifier can fall back to the BOM
    owner expected at its source page.  The nearest unused pointer is chosen
    for duplicate identifiers.
    """

    bom = model["bom"]
    by_identifier: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_occurrence = {int(record["occurrence"]): record for record in bom}
    for record in bom:
        by_identifier[record["identifier"]].append(record)
    page_owner = {
        int(page["pageNumber"]): page.get("expectedBomOwner") for page in model["pages"]
    }
    used: set[int] = set()
    result: dict[int, dict[str, Any]] = {}
    for detail in model["details"]:
        page = int(detail["firstDetailPage"])
        candidates = [
            record
            for record in by_identifier.get(detail["identifier"], [])
            if int(record["occurrence"]) not in used
        ]
        if candidates:
            chosen = min(
                candidates,
                key=lambda record: abs(int(record["expected_detail_page"]) - page),
            )
        else:
            owner_identifier = page_owner.get(page)
            owner_candidates = [
                record
                for record in by_identifier.get(owner_identifier or "", [])
                if int(record["occurrence"]) not in used
            ]
            chosen = (
                min(
                    owner_candidates,
                    key=lambda record: abs(int(record["expected_detail_page"]) - page),
                )
                if owner_candidates
                else None
            )
        if chosen is None:
            continue
        occurrence = int(chosen["occurrence"])
        if occurrence not in by_occurrence:
            continue
        used.add(occurrence)
        result[occurrence] = detail
    return result


def build_nodes(
    model: dict[str, Any], detail_by_occurrence: dict[int, dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[int, str]]:
    bom = model["bom"]
    source_pdf_sha256 = model.get("source", {}).get(
        "sha256", ACCEPTED_SOURCE_SHA256
    )
    codes = [code for code in SYSTEM_NAMES if any(row["system_code"] == code for row in bom)]
    nodes: list[dict[str, Any]] = [
        {
            "sourceId": "ucm25-vehicle",
            "sourceParentId": None,
            "kind": "vehicle",
            "systemCode": None,
            "rawHla": None,
            "rawSubassembly": None,
            "rawPartNumber": None,
            "referenceId": "UCM25",
            "fullNumber": "E13-25-UCM-000000-A",
            "name": "UCM 2025 Electric Vehicle",
            "description": "Formula SAE-Australasia 2025 competition vehicle",
            "revision": None,
            "procurementType": "made",
            "quantity": "1",
            "internalNote": json.dumps(
                {
                    "historicalBomHeaderTotal": BOM_HEADER_TOTAL,
                    "historicalSummaryBreakdown": SUMMARY_TOTAL_BREAKDOWN,
                    "sourcePdfSha256": source_pdf_sha256,
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
            "sortOrder": 0,
        }
    ]
    for sort_order, code in enumerate(codes):
        nodes.append(
            {
                "sourceId": f"ucm25-system-{code}",
                "sourceParentId": "ucm25-vehicle",
                "kind": "system",
                "systemCode": code,
                "rawHla": None,
                "rawSubassembly": None,
                "rawPartNumber": None,
                "referenceId": code,
                "fullNumber": f"E13-25-{code}-000000-A",
                "name": SYSTEM_NAMES[code],
                "description": f"Historical 2025 {SYSTEM_NAMES[code]} costing system",
                "revision": None,
                "procurementType": "made",
                "quantity": "1",
                "internalNote": json.dumps(
                    {
                        "historicalSummaryBreakdown": SUMMARY_BREAKDOWNS[code],
                        "sourcePdfSha256": source_pdf_sha256,
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                "sortOrder": sort_order,
            }
        )

    # A part's parent is the latest preceding assembly in the same spreadsheet
    # family.  This preserves L/R assembly ordering in the source BOM.
    latest_assembly_by_family: dict[tuple[str, str, str], str] = {}
    source_id_by_occurrence: dict[int, str] = {}
    identifier_occurrences: Counter[str] = Counter()
    for record in bom:
        occurrence = int(record["occurrence"])
        source_id = node_source_id(record)
        source_id_by_occurrence[occurrence] = source_id
        family = (
            record["system_code"],
            record["assembly_number"],
            record["level"],
        )
        assembly = is_assembly_record(record)
        if assembly:
            parent_id = f"ucm25-system-{record['system_code']}"
            latest_assembly_by_family[family] = source_id
        else:
            parent_id = latest_assembly_by_family.get(family)
            if not parent_id:
                raise ValueError(
                    "part has no preceding assembly family: "
                    f"{record['identifier']} ({family})"
                )
        detail = detail_by_occurrence.get(occurrence)
        info = detail.get("info", {}) if detail else {}
        name = (
            record["assembly_description"]
            if assembly
            else record["part_description"]
        ) or info.get("Assembly") or info.get("Part") or record["identifier"]
        description = info.get("Details") or name
        procurement = "made" if assembly else "unknown"
        pointer_note = {
            "sourcePdfSha256": source_pdf_sha256,
            "sourceBomOccurrence": occurrence,
            "sourceBomPage": record["bom_page"],
            "expectedDetailPage": record["expected_detail_page"],
            "recoveredActualDetailPage": detail.get("firstDetailPage") if detail else None,
            "recoveredActualIdentifier": detail.get("identifier") if detail else None,
            "historicalBomBreakdown": {
                "material": decimal_string(record.get("material_cost")),
                "process": decimal_string(record.get("process_cost")),
                "fastener": decimal_string(record.get("fastener_cost")),
                "tooling": decimal_string(record.get("tooling_cost")),
                "total": decimal_string(record.get("total_cost")),
            },
            "historicalBomExtendedCost": decimal_string(record.get("extended_cost")),
        }
        if detail:
            detail_cost = info.get("Assembly Cost") or info.get("Part Cost")
            pointer_note.update(
                {
                    "historicalDetailCost": decimal_string(detail_cost) if detail_cost else None,
                    "historicalDetailExtendedCost": decimal_string(info.get("Extended Cost")) if info.get("Extended Cost") else None,
                    "historicalDetailQuantity": decimal_string(info.get("Quantity")) if info.get("Quantity") else None,
                }
            )
        duplicate_index = identifier_occurrences[record["identifier"]]
        identifier_occurrences[record["identifier"]] += 1
        # PostgreSQL correctly requires full_number uniqueness within a
        # project, while the immutable source PDF contains one duplicate. A
        # zero-width joiner retains distinct stored values without changing
        # the report-visible historical identifier.
        stored_full_number = record["identifier"] + ("\u200d" * duplicate_index)
        if duplicate_index:
            pointer_note["duplicateIdentifierOccurrence"] = duplicate_index + 1
        nodes.append(
            {
                "sourceId": source_id,
                "sourceParentId": parent_id,
                "kind": "assembly" if assembly else "part",
                "systemCode": record["system_code"],
                "rawHla": record["assembly_number"],
                "rawSubassembly": record["level"],
                "rawPartNumber": record["part_number"],
                "referenceId": record["identifier"],
                "fullNumber": stored_full_number,
                "name": name,
                "description": description,
                "revision": record["revision"] or None,
                "procurementType": procurement,
                "quantity": decimal_string(record["quantity"], default="1"),
                "internalNote": json.dumps(pointer_note, sort_keys=True, separators=(",", ":")),
                "sortOrder": occurrence,
            }
        )
    return nodes, source_id_by_occurrence


def build_cost_lines(
    detail_by_occurrence: dict[int, dict[str, Any]],
    source_id_by_occurrence: dict[int, str],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for occurrence in sorted(detail_by_occurrence):
        detail = detail_by_occurrence[occurrence]
        sort_by_kind: Counter[str] = Counter()
        for line_index, line in enumerate(detail["costLines"], 1):
            kind = line["kind"]
            sort_order = sort_by_kind[kind]
            sort_by_kind[kind] += 1
            unit_cost = decimal_string(line["unitCost"])
            raw_quantity = Decimal(str(line["quantity"]))
            quantity = decimal_string(line["quantity"]) if raw_quantity > 0 else "1"
            multiplier = decimal_string(line["multiplier"], default="1")
            fraction = decimal_string(line.get("fractionIncluded"), default="1")
            pvf = (
                decimal_string(line.get("productionVolumeFactor"))
                if line.get("productionVolumeFactor") not in {None, 0, 0.0, "0", ""}
                else None
            )
            subtotal = decimal_string(line["declaredSubtotal"])
            size_inputs: dict[str, str] = {}
            for size_number, size in enumerate(line.get("sizeInputs", []), 1):
                value = str(size.get("value", "")).strip()
                unit = str(size.get("unit", "")).strip()
                if value:
                    size_inputs[f"size{size_number}"] = value
                if unit:
                    size_inputs[f"size{size_number}Unit"] = unit
            description = str(line.get("description") or "").strip()
            if not description:
                description = f"Historical {kind} line {line_index}"
            result.append(
                {
                    "sourceId": f"ucm25-line-{occurrence:04d}-{line_index:04d}",
                    "sourceNodeId": source_id_by_occurrence[occurrence],
                    "kind": kind,
                    "catalogueItemId": None,
                    "description": description,
                    "useDescription": str(line.get("useDescription") or ""),
                    "unitCost": unit_cost,
                    "quantity": quantity,
                    "multiplier": multiplier,
                    "multiplierName": line.get("multiplierName"),
                    "multiplierCatalogueItemId": None,
                    "fractionIncluded": fraction,
                    "productionVolumeFactor": pvf,
                    "sizeInputs": size_inputs,
                    "calculation": {
                        "kind": kind,
                        "unitCost": unit_cost,
                        "quantity": quantity,
                        "multiplier": multiplier,
                        "fractionIncluded": fraction,
                        "productionVolumeFactor": pvf,
                        "subtotal": subtotal,
                        "historicalDeclaredSubtotal": True,
                        "sourcePage": line["sourcePage"],
                        "sourceOrder": line.get("sourceOrder"),
                        "sourceMultiplierDisplay": line.get("multiplierDisplay", ""),
                        "sourceUnitDisplay": line.get("unitDisplay", ""),
                        "recoveredQuantityMissing": raw_quantity <= 0,
                    },
                    "subtotal": subtotal,
                    "sortOrder": sort_order,
                }
            )
    return result


def archive_evidence(
    index: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], dict[str, Path]]:
    if not index:
        return [], {}
    manifest_items: list[dict[str, Any]] = []
    paths: dict[str, Path] = {}
    for item in index["items"]:
        source_id = item["sourceId"]
        path = ROOT / item["path"]
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != item["contentSha256"] or len(data) != item["byteSize"]:
            raise ValueError(f"evidence index integrity mismatch: {source_id}")
        archive_key = hashlib.sha256(source_id.encode("utf-8")).hexdigest()
        manifest_items.append(
            {
                "sourceId": source_id,
                "sourceNodeId": item["sourceNodeId"],
                "kind": item["kind"],
                "displayName": item["displayName"],
                "contentSha256": digest,
                "byteSize": len(data),
                "mimeType": item["mimeType"],
                "visibility": "report",
                "reportCaption": item["reportCaption"],
                "archivePath": f"evidence/{archive_key}.blob",
            }
        )
        paths[source_id] = path
    return manifest_items, paths


def build_manifest(
    model: dict[str, Any],
    seed: dict[str, Any],
    evidence: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    detail_by_occurrence = choose_detail_assignments(model)
    nodes, source_id_by_occurrence = build_nodes(model, detail_by_occurrence)
    cost_lines = build_cost_lines(detail_by_occurrence, source_id_by_occurrence)
    summary = clean_project_summary(model.get("frontMatterText", {}).get("2", ""))
    return {
        "format": "ucm-project-archive",
        "schemaVersion": 1,
        "source": {
            "projectId": "ucm25-reconstructed-from-final-pdf",
            "projectVersion": 1,
            "projectUpdatedAt": "2025-12-31T00:00:00.000Z",
        },
        "project": {
            "name": "UC Motorsport 2025 — Reconstructed",
            "season": 2025,
            "vehicleType": "electric",
            "entryNumber": "E13",
            "isHistorical": True,
            "projectSummary": summary,
            "numberingConvention": "Identifiers are preserved exactly as displayed in the final UCM25 report.",
            "bulkMethodSummary": "Historical displayed values are retained without repricing against the 2026 catalogue.",
            "focusSystems": list(SYSTEM_NAMES),
        },
        "sources": seed["sources"],
        "nodes": nodes,
        "costLines": cost_lines,
        "evidence": evidence or [],
    }


def write_archive(
    path: Path,
    manifest: dict[str, Any],
    evidence_paths: dict[str, Path] | None = None,
) -> None:
    manifest_bytes = (
        json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
    ).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    info = zipfile.ZipInfo("manifest.json", ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    info.create_system = 3
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr(info, manifest_bytes)
        for item in sorted(manifest["evidence"], key=lambda value: value["archivePath"]):
            source_path = (evidence_paths or {}).get(item["sourceId"])
            if source_path is None:
                raise ValueError(f"missing evidence bytes for {item['sourceId']}")
            evidence_info = zipfile.ZipInfo(item["archivePath"], ZIP_TIMESTAMP)
            evidence_info.compress_type = zipfile.ZIP_DEFLATED
            evidence_info.external_attr = 0o100644 << 16
            evidence_info.create_system = 3
            archive.writestr(evidence_info, source_path.read_bytes())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--source-archive", type=Path, default=DEFAULT_SOURCE_ARCHIVE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--manifest-output", type=Path, default=DEFAULT_MANIFEST_OUTPUT)
    parser.add_argument("--evidence-index", type=Path, default=DEFAULT_EVIDENCE_INDEX)
    args = parser.parse_args()

    model = json.loads(args.model.read_text(encoding="utf-8"))
    if not model.get("acceptance", {}).get("pageCountMatches"):
        raise ValueError("reference model has not passed the 1,078-page acceptance gate")
    if not model.get("acceptance", {}).get("bomOccurrenceCountMatches"):
        raise ValueError("reference model has not passed the 467-row BOM acceptance gate")
    seed = source_manifest(args.source_archive)
    evidence_index = (
        json.loads(args.evidence_index.read_text(encoding="utf-8"))
        if args.evidence_index.exists()
        else None
    )
    evidence, evidence_paths = archive_evidence(evidence_index)
    manifest = build_manifest(model, seed, evidence)
    args.manifest_output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest_output.write_text(
        json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    write_archive(args.output, manifest, evidence_paths)
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "manifest": str(args.manifest_output.resolve()),
                "nodes": len(manifest["nodes"]),
                "costLines": len(manifest["costLines"]),
                "evidence": len(manifest["evidence"]),
                "bytes": args.output.stat().st_size,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
