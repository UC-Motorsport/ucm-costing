#!/usr/bin/env python3
"""Extract a deterministic, auditable UCM25 report model from the final PDF.

The 2025 PDF is both a data recovery source and a historical rendering fixture.  It
contains known defects (including BOM pointers that lead to blank or mismatched
pages), so this extractor records expected BOM pointers and actual detail-page
identifiers independently.  It never rewrites or "corrects" the source document.

The script requires ``pdfplumber`` and is intended to run with the Codex bundled
PDF Python runtime documented in ``scripts/ucm25-pdf-parity.md``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import pdfplumber


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "docs" / "UCM25 Final Costing Report.pdf"
DEFAULT_OUTPUT = ROOT / "tmp" / "pdfs" / "ucm25-reference-structure.json"
EXPECTED_SOURCE_SHA256 = (
    "a922ac7220b0924d1992773e1c3fd42632d53e90dfaad357cd1947edd0b25d37"
)
EXPECTED_PAGE_COUNT = 1_078
EXPECTED_BOM_OCCURRENCES = 467

IDENTIFIER_RE = re.compile(r"E13-25-[A-Z]{2}-[0-9A-Z-]{6,12}")
COMPACT_IDENTIFIER_RE = re.compile(r"(?:E13-25-)?[A-Z]{2}-\d{6}")
INTEGER_RE = re.compile(r"^\d+$")

# The BOM was generated as a fixed-coordinate spreadsheet table.  These x
# boundaries are stable across all twelve BOM pages and avoid the unreliable
# merged-cell result returned by generic table detection on those pages.
BOM_COLUMN_BOUNDS = (
    0,
    39,
    139,
    154,
    180,
    205,
    229,
    261,
    325,
    418,
    568,
    603,
    637,
    667,
    697,
    728,
    756,
    795,
    850,
)


@dataclass(frozen=True)
class BomRecord:
    occurrence: int
    line_number: int
    bom_page: int
    expected_detail_page: int
    identifier: str
    vehicle_system: str
    system_code: str
    assembly_number: str
    level: str
    part_number: str
    revision: str
    assembly_description: str
    part_description: str
    material_cost: float
    process_cost: float
    fastener_cost: float
    tooling_cost: float
    total_cost: float
    quantity: float
    extended_cost: float


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clean_cell(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).replace("\n", " ").split())


def parse_number(value: Any, *, default: float | None = None) -> float | None:
    text = clean_cell(value).replace("$", "").replace(",", "").replace(" ", "")
    if text in {"", "-", "—", "–"}:
        return default
    try:
        number = float(text)
    except ValueError:
        return default
    return number if math.isfinite(number) else default


def numeric_or_zero(value: Any) -> float:
    return parse_number(value, default=0.0) or 0.0


def join_words(words: Iterable[dict[str, Any]], *, compact: bool = False) -> str:
    ordered = sorted(words, key=lambda word: float(word["x0"]))
    separator = "" if compact else " "
    return separator.join(str(word["text"]) for word in ordered).strip()


def words_by_visual_line(words: Sequence[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    for word in sorted(words, key=lambda item: (float(item["top"]), float(item["x0"]))):
        top = float(word["top"])
        if not groups or abs(float(groups[-1][0]["top"]) - top) > 1.25:
            groups.append([word])
        else:
            groups[-1].append(word)
    return groups


def split_bom_columns(line: Sequence[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    columns: list[list[dict[str, Any]]] = [[] for _ in range(len(BOM_COLUMN_BOUNDS) - 1)]
    for word in line:
        x = float(word["x0"])
        for index, (left, right) in enumerate(zip(BOM_COLUMN_BOUNDS, BOM_COLUMN_BOUNDS[1:])):
            if left <= x < right:
                columns[index].append(word)
                break
    return columns


def parse_bom_page(page: Any, page_number: int, occurrence_start: int) -> list[BomRecord]:
    words = page.extract_words(x_tolerance=1, y_tolerance=2, keep_blank_chars=False)
    records: list[BomRecord] = []
    for line in words_by_visual_line(words):
        line_text = join_words(line)
        identifier_match = IDENTIFIER_RE.search(line_text)
        if not identifier_match:
            continue
        columns = split_bom_columns(line)
        line_number_text = join_words(columns[0], compact=True)
        detail_page_text = join_words(columns[17], compact=True)
        if not INTEGER_RE.fullmatch(line_number_text) or not INTEGER_RE.fullmatch(
            detail_page_text
        ):
            continue
        record = BomRecord(
            occurrence=occurrence_start + len(records),
            line_number=int(line_number_text),
            bom_page=page_number,
            expected_detail_page=int(detail_page_text),
            identifier=identifier_match.group(0),
            vehicle_system=join_words(columns[1]),
            system_code=join_words(columns[2], compact=True),
            assembly_number=join_words(columns[3], compact=True),
            level=join_words(columns[4], compact=True),
            part_number=join_words(columns[5], compact=True),
            revision=join_words(columns[6], compact=True),
            assembly_description=join_words(columns[8]),
            part_description=join_words(columns[9]),
            material_cost=numeric_or_zero(join_words(columns[10], compact=True)),
            process_cost=numeric_or_zero(join_words(columns[11], compact=True)),
            fastener_cost=numeric_or_zero(join_words(columns[12], compact=True)),
            tooling_cost=numeric_or_zero(join_words(columns[13], compact=True)),
            total_cost=numeric_or_zero(join_words(columns[14], compact=True)),
            quantity=numeric_or_zero(join_words(columns[15], compact=True)),
            extended_cost=numeric_or_zero(join_words(columns[16], compact=True)),
        )
        records.append(record)
    return records


def page_class(text: str, page_number: int) -> str:
    stripped = text.strip()
    if page_number == 1:
        return "cover"
    if page_number == 2:
        return "project-summary"
    if page_number == 3:
        return "vehicle-drawing"
    if page_number == 4:
        return "cost-summary"
    if 5 <= page_number <= 16:
        return "bom"
    if not stripped:
        return "blank-evidence"
    if "University" in stripped and "Entry No." in stripped:
        return "node-detail-with-cost" if "Item Order" in stripped else "node-detail"
    if "Item Part/Sub" in stripped:
        return "assembly-contents"
    if "Item Order" in stripped:
        return "cost-line-table"
    if len(COMPACT_IDENTIFIER_RE.findall(stripped)) >= 2:
        return "hierarchy"
    return "technical-or-external-evidence"


def info_from_tables(tables: Sequence[Sequence[Sequence[Any]]]) -> dict[str, str]:
    for table in tables:
        if not table or max((len(row) for row in table), default=0) != 2:
            continue
        result: dict[str, str] = {}
        for row in table:
            if len(row) < 2:
                continue
            key = clean_cell(row[0]).rstrip(":")
            value = clean_cell(row[1])
            if key:
                result[key] = value
        if result.get("University") and result.get("Entry No."):
            return result
    return {}


def actual_identifier(info: dict[str, str]) -> str | None:
    for key in ("Part No.", "Assembly No."):
        identifier = info.get(key, "")
        if identifier:
            return identifier
    return None


def table_cost_kind(header: Sequence[Any]) -> str | None:
    cells = [clean_cell(cell).lower() for cell in header]
    if len(cells) < 2 or cells[0] != "item order":
        return None
    for kind in ("material", "process", "fastener", "tooling"):
        if cells[1] == kind:
            return kind
    return None


def multiplier_value(name: str, explicit_value: Any) -> float:
    explicit = parse_number(explicit_value)
    if explicit is not None:
        return explicit
    if not name or name.lower() == "none":
        return 1.0
    trailing = re.search(r"(-?\d+(?:\.\d+)?)\s*$", name)
    return float(trailing.group(1)) if trailing else 1.0


def cost_line_from_row(kind: str, row: Sequence[Any], page_number: int) -> dict[str, Any] | None:
    cells = [clean_cell(cell) for cell in row]
    if not cells or not INTEGER_RE.fullmatch(cells[0]):
        return None
    order = int(cells[0])
    if kind == "material":
        if len(cells) < 10:
            return None
        description, use = cells[1], cells[2]
        size_inputs = [
            {"value": cells[3], "unit": cells[4]},
            {"value": cells[5], "unit": cells[6]},
        ]
        unit_cost = numeric_or_zero(cells[7])
        quantity = numeric_or_zero(cells[8])
        declared = numeric_or_zero(cells[9])
        multiplier = 1.0
        fraction = None
        production_volume_factor = None
        multiplier_name = None
        multiplier_display = ""
        unit_display = ""
    elif kind == "process":
        if len(cells) < 9:
            return None
        description, use = cells[1], cells[2]
        unit_cost = numeric_or_zero(cells[3])
        unit = cells[4]
        size_inputs = [{"value": "", "unit": unit}]
        multiplier_name = cells[5] or None
        multiplier = multiplier_value(cells[5], cells[6])
        multiplier_display = cells[6]
        unit_display = unit
        quantity = numeric_or_zero(cells[7])
        declared = numeric_or_zero(cells[8])
        fraction = None
        production_volume_factor = None
    elif kind == "fastener":
        if len(cells) < 10:
            return None
        description, use = cells[1], cells[2]
        size_inputs = [
            {"value": cells[3], "unit": cells[4]},
            {"value": cells[5], "unit": cells[6]},
        ]
        unit_cost = numeric_or_zero(cells[7])
        quantity = numeric_or_zero(cells[8])
        declared = numeric_or_zero(cells[9])
        multiplier = 1.0
        fraction = None
        production_volume_factor = None
        multiplier_name = None
        multiplier_display = ""
        unit_display = ""
    else:
        if len(cells) < 12:
            return None
        description, use = cells[1], cells[2]
        fraction = numeric_or_zero(cells[3])
        production_volume_factor = numeric_or_zero(cells[4])
        size_inputs = [
            {"value": cells[5], "unit": cells[6]},
            {"value": cells[7], "unit": cells[8]},
        ]
        unit_cost = numeric_or_zero(cells[9])
        quantity = numeric_or_zero(cells[10])
        declared = numeric_or_zero(cells[11])
        multiplier = 1.0
        multiplier_name = None
        multiplier_display = ""
        unit_display = ""

    if kind == "tooling":
        computed = (
            unit_cost * quantity * (fraction or 0.0) / production_volume_factor
            if production_volume_factor
            else 0.0
        )
    else:
        computed = unit_cost * quantity * multiplier
    return {
        "sourcePage": page_number,
        "sourceOrder": order,
        "kind": kind,
        "description": description,
        "useDescription": use,
        "unitCost": unit_cost,
        "quantity": quantity,
        "multiplier": multiplier,
        "multiplierName": multiplier_name,
        "multiplierDisplay": multiplier_display,
        "unitDisplay": unit_display,
        "fractionIncluded": fraction,
        "productionVolumeFactor": production_volume_factor,
        "sizeInputs": size_inputs,
        "declaredSubtotal": declared,
        "computedSubtotal": round(computed, 6),
        "roundingVariance": round(declared - computed, 6),
    }


def cost_lines_from_tables(
    tables: Sequence[Sequence[Sequence[Any]]], page_number: int
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for table in tables:
        if not table:
            continue
        kind = table_cost_kind(table[0])
        if not kind:
            continue
        for row in table[1:]:
            parsed = cost_line_from_row(kind, row, page_number)
            if parsed:
                result.append(parsed)
    return result


def cost_kinds_from_tables(
    tables: Sequence[Sequence[Sequence[Any]]],
) -> list[str]:
    result: list[str] = []
    for table in tables:
        if not table:
            continue
        kind = table_cost_kind(table[0])
        if kind and kind not in result:
            result.append(kind)
    return result


def cost_table_layouts(detected_tables: Sequence[Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for table in detected_tables:
        extracted = table.extract()
        if not extracted:
            continue
        kind = table_cost_kind(extracted[0])
        if not kind or not table.rows or not table.rows[0].cells:
            continue
        header_cells = table.rows[0].cells
        if any(cell is None for cell in header_cells):
            continue
        cells = [cell for cell in header_cells if cell is not None]
        header_top = float(cells[0][1])
        header_bottom = float(cells[0][3])
        row_height = header_bottom - header_top
        if len(table.rows) > 1:
            data_cells = [cell for cell in table.rows[1].cells if cell is not None]
            if data_cells:
                row_height = float(data_cells[0][3]) - float(data_cells[0][1])
        result.append(
            {
                "kind": kind,
                "left": round(float(cells[0][0]), 6),
                "top": round(header_top, 6),
                "widths": [
                    round(float(cell[2]) - float(cell[0]), 6) for cell in cells
                ],
                "headerHeight": round(header_bottom - header_top, 6),
                "rowHeight": round(row_height, 6),
            }
        )
    return result


def largest_image_frame(page: Any) -> dict[str, float] | None:
    images = list(page.images)
    if not images:
        return None
    selected = max(
        images,
        key=lambda image: float(image["width"]) * float(image["height"]),
    )
    return {
        "left": round(float(selected["x0"]), 6),
        "top": round(float(selected["top"]), 6),
        "width": round(float(selected["x1"]) - float(selected["x0"]), 6),
        "height": round(float(selected["bottom"]) - float(selected["top"]), 6),
    }


def assembly_row_count_from_tables(
    tables: Sequence[Sequence[Sequence[Any]]],
) -> int:
    for table in tables:
        if not table:
            continue
        header = [clean_cell(cell).lower() for cell in table[0]]
        if len(header) < 2 or not header[0].startswith("item"):
            continue
        if "part/sub" not in header[1]:
            continue
        return sum(
            1
            for row in table[1:]
            if len(row) > 1 and clean_cell(row[1])
        )
    return 0


def rounded_page_size(page: Any) -> dict[str, float | int]:
    return {
        "width": round(float(page.width), 4),
        "height": round(float(page.height), 4),
        "rotation": int(page.rotation or 0),
    }


def owner_by_expected_pointer(
    records: Sequence[BomRecord], page_count: int
) -> dict[int, str]:
    owner: dict[int, str] = {}
    ordered = sorted(records, key=lambda record: record.expected_detail_page)
    for index, record in enumerate(ordered):
        next_pointer = (
            ordered[index + 1].expected_detail_page if index + 1 < len(ordered) else page_count + 1
        )
        for page_number in range(record.expected_detail_page, next_pointer):
            owner[page_number] = record.identifier
    return owner


def extract(source: Path) -> dict[str, Any]:
    source_digest = sha256(source)
    if source_digest != EXPECTED_SOURCE_SHA256:
        raise ValueError(
            "unexpected UCM25 source SHA-256: "
            f"expected {EXPECTED_SOURCE_SHA256}, received {source_digest}"
        )

    bom_records: list[BomRecord] = []
    pages: list[dict[str, Any]] = []
    details: list[dict[str, Any]] = []
    actual_detail_pages_by_identifier: dict[str, list[int]] = defaultdict(list)
    current_actual_identifier: str | None = None
    current_detail: dict[str, Any] | None = None
    front_matter_text: dict[str, str] = {}

    with pdfplumber.open(source) as pdf:
        if len(pdf.pages) != EXPECTED_PAGE_COUNT:
            raise ValueError(
                f"unexpected page count: expected {EXPECTED_PAGE_COUNT}, received {len(pdf.pages)}"
            )

        for page_number, page in enumerate(pdf.pages, 1):
            text = page.extract_text(x_tolerance=1, y_tolerance=2, layout=True) or ""
            classification = page_class(text, page_number)
            if page_number <= 4:
                front_matter_text[str(page_number)] = text.strip()
            if 5 <= page_number <= 16:
                bom_records.extend(
                    parse_bom_page(page, page_number, occurrence_start=len(bom_records) + 1)
                )

            needs_tables = classification in {
                "node-detail",
                "node-detail-with-cost",
                "assembly-contents",
                "cost-line-table",
            }
            detected_tables = page.find_tables() if needs_tables else []
            tables = [table.extract() for table in detected_tables]
            info = info_from_tables(tables)
            identifier = actual_identifier(info)
            if identifier:
                current_actual_identifier = identifier
                actual_detail_pages_by_identifier[identifier].append(page_number)
                current_detail = {
                    "occurrence": len(details) + 1,
                    "identifier": identifier,
                    "firstDetailPage": page_number,
                    "info": info,
                    "costLines": [],
                }
                details.append(current_detail)
            elif classification == "hierarchy":
                current_actual_identifier = None
                current_detail = None

            cost_lines = cost_lines_from_tables(tables, page_number)
            cost_kinds = cost_kinds_from_tables(tables)
            assembly_row_count = assembly_row_count_from_tables(tables)
            if cost_lines and current_detail:
                current_detail["costLines"].extend(cost_lines)

            pages.append(
                {
                    "pageNumber": page_number,
                    "class": classification,
                    "size": rounded_page_size(page),
                    "actualIdentifier": identifier,
                    "activeActualIdentifier": current_actual_identifier,
                    "costLineCount": len(cost_lines),
                    "costKinds": cost_kinds,
                    "costTableLayouts": cost_table_layouts(detected_tables),
                    "assemblyRowCount": assembly_row_count,
                    "embeddedImageCount": len(page.images),
                    "imageFrame": largest_image_frame(page),
                }
            )

    if len(bom_records) != EXPECTED_BOM_OCCURRENCES:
        raise ValueError(
            "unexpected BOM occurrence count: "
            f"expected {EXPECTED_BOM_OCCURRENCES}, received {len(bom_records)}"
        )

    expected_owner = owner_by_expected_pointer(bom_records, len(pages))
    for page in pages:
        page["expectedBomOwner"] = expected_owner.get(page["pageNumber"])

    bom_identifiers = {record.identifier for record in bom_records}
    pointer_anomalies: list[dict[str, Any]] = []
    page_by_number = {page["pageNumber"]: page for page in pages}
    for record in bom_records:
        pointer_page = page_by_number[record.expected_detail_page]
        actual = pointer_page["actualIdentifier"]
        if actual != record.identifier:
            pointer_anomalies.append(
                {
                    "identifier": record.identifier,
                    "expectedDetailPage": record.expected_detail_page,
                    "pageClass": pointer_page["class"],
                    "actualIdentifier": actual,
                }
            )

    detail_records = sorted(details, key=lambda detail: detail["firstDetailPage"])
    actual_detail_identifiers = set(actual_detail_pages_by_identifier)
    cost_kind_counts = Counter(
        line["kind"] for detail in detail_records for line in detail["costLines"]
    )
    class_counts = Counter(page["class"] for page in pages)
    pages_with_cost_rounding_variance = sorted(
        {
            line["sourcePage"]
            for detail in detail_records
            for line in detail["costLines"]
            if abs(line["roundingVariance"]) > 0.011
        }
    )

    return {
        "schemaVersion": 1,
        "source": {
            "path": str(source.relative_to(ROOT)),
            "sha256": source_digest,
            "bytes": source.stat().st_size,
            "pageCount": len(pages),
        },
        "acceptance": {
            "expectedPageCount": EXPECTED_PAGE_COUNT,
            "expectedBomOccurrences": EXPECTED_BOM_OCCURRENCES,
            "pageCountMatches": len(pages) == EXPECTED_PAGE_COUNT,
            "bomOccurrenceCountMatches": len(bom_records) == EXPECTED_BOM_OCCURRENCES,
        },
        "summary": {
            "pageClasses": dict(sorted(class_counts.items())),
            "bomOccurrences": len(bom_records),
            "uniqueBomIdentifiers": len(bom_identifiers),
            "actualDetailPages": len(detail_records),
            "actualDetailIdentifiers": len(actual_detail_identifiers),
            "costLines": sum(cost_kind_counts.values()),
            "costLineKinds": dict(sorted(cost_kind_counts.items())),
            "pointerAnomalies": len(pointer_anomalies),
            "bomIdentifiersWithoutActualDetail": len(
                bom_identifiers - actual_detail_identifiers
            ),
            "actualDetailsAbsentFromBom": len(
                actual_detail_identifiers - bom_identifiers
            ),
            "pagesWithCostRoundingVarianceOverOneCent": len(
                pages_with_cost_rounding_variance
            ),
        },
        "bom": [asdict(record) for record in bom_records],
        "frontMatterText": front_matter_text,
        "details": detail_records,
        "pages": pages,
        "anomalies": {
            "pointerMismatches": pointer_anomalies,
            "bomIdentifiersWithoutActualDetail": sorted(
                bom_identifiers - actual_detail_identifiers
            ),
            "actualDetailsAbsentFromBom": sorted(
                actual_detail_identifiers - bom_identifiers
            ),
            "pagesWithCostRoundingVarianceOverOneCent": pages_with_cost_rounding_variance,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    source = args.source.resolve()
    output = args.output.resolve()
    result = extract(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), **result["summary"]}, indent=2))


if __name__ == "__main__":
    main()
