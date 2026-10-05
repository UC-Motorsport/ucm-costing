#!/usr/bin/env python3
"""Recover report-visible UCM25 images and technical pages from the final PDF."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from PIL import Image
from pypdf import PdfReader, PdfWriter

from ucm25_archive_build import choose_detail_assignments, node_source_id
from ucm25_reference_extract import EXPECTED_SOURCE_SHA256, sha256


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = ROOT / "tmp" / "pdfs" / "ucm25-reference-structure.json"
DEFAULT_SOURCE = ROOT / "docs" / "UCM25 Final Costing Report.pdf"
DEFAULT_OUTPUT = ROOT / "tmp" / "pdfs" / "ucm25-evidence"
TRAILING_SOURCE_PAGES = [1076, 1077, 1078]
SOURCE_CHUNK_LIMIT = 24 * 1024 * 1024
SOURCE_PAGE_CLASSES = {
    "blank-evidence",
    "technical-or-external-evidence",
    "hierarchy",
    "vehicle-drawing",
}


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def save_image(image_file: Any, destination_stem: Path) -> tuple[Path, str]:
    name = str(image_file.name).lower()
    if name.endswith((".jpg", ".jpeg")):
        destination = destination_stem.with_suffix(".jpg")
        destination.write_bytes(image_file.data)
        return destination, "image/jpeg"
    if name.endswith(".png"):
        destination = destination_stem.with_suffix(".png")
        destination.write_bytes(image_file.data)
        return destination, "image/png"
    destination = destination_stem.with_suffix(".png")
    image: Image.Image = image_file.image
    image.save(destination, format="PNG", optimize=True)
    return destination, "image/png"


def largest_image(page: Any) -> Any | None:
    images = list(page.images)
    if not images:
        return None
    return max(images, key=lambda item: item.image.width * item.image.height)


def technical_page_groups(model: dict[str, Any]) -> dict[int, list[int]]:
    bom = sorted(model["bom"], key=lambda row: int(row["expected_detail_page"]))
    first_by_system: dict[str, int] = {}
    for record in bom:
        first_by_system.setdefault(record["system_code"], int(record["expected_detail_page"]))
    hierarchy_pages = {page - 1 for page in first_by_system.values()}
    page_classes = {
        int(page["pageNumber"]): page["class"] for page in model["pages"]
    }
    result: dict[int, list[int]] = defaultdict(list)
    for index, record in enumerate(bom):
        start = int(record["expected_detail_page"])
        end = (
            int(bom[index + 1]["expected_detail_page"])
            if index + 1 < len(bom)
            else int(model["source"]["pageCount"]) + 1
        )
        occurrence = int(record["occurrence"])
        for page_number in range(start, end):
            if page_number in hierarchy_pages:
                continue
            if page_classes[page_number] == "technical-or-external-evidence":
                result[occurrence].append(page_number)
    return dict(result)


def historical_layout_pages(model: dict[str, Any]) -> list[dict[str, Any]]:
    detail_by_occurrence = choose_detail_assignments(model)
    bom_by_occurrence = {
        int(record["occurrence"]): record for record in model["bom"]
    }
    occurrence_by_first_page = {
        int(detail["firstDetailPage"]): occurrence
        for occurrence, detail in detail_by_occurrence.items()
    }
    all_details = sorted(model["details"], key=lambda item: int(item["firstDetailPage"]))
    mapped_occurrence_by_page: dict[int, int] = {}
    for index, detail in enumerate(all_details):
        start = int(detail["firstDetailPage"])
        end = (
            int(all_details[index + 1]["firstDetailPage"])
            if index + 1 < len(all_details)
            else int(model["source"]["pageCount"]) + 1
        )
        occurrence = occurrence_by_first_page.get(start)
        if occurrence is not None:
            for page_number in range(start, end):
                mapped_occurrence_by_page[page_number] = occurrence

    imported_cost_lines_by_page: defaultdict[int, int] = defaultdict(int)
    for detail in detail_by_occurrence.values():
        for line in detail["costLines"]:
            imported_cost_lines_by_page[int(line["sourcePage"])] += 1

    result: list[dict[str, Any]] = []
    for source_page in model["pages"]:
        page_number = int(source_page["pageNumber"])
        page_class = str(source_page["class"])
        owner_occurrence = mapped_occurrence_by_page.get(page_number)
        source_cost_count = int(source_page.get("costLineCount", 0))
        assigned_detail = (
            detail_by_occurrence.get(owner_occurrence)
            if owner_occurrence is not None
            else None
        )
        assigned_bom = (
            bom_by_occurrence.get(owner_occurrence)
            if owner_occurrence is not None
            else None
        )
        detail_info = assigned_detail.get("info", {}) if assigned_detail else {}
        source_detail_kind = (
            "part"
            if detail_info.get("Part")
            else "assembly"
            if detail_info.get("Assembly")
            else None
        )
        imported_node_kind = (
            "assembly"
            if assigned_bom and str(assigned_bom.get("part_number", "")).startswith("00")
            else "part"
            if assigned_bom
            else None
        )
        assigned_identifier = (
            str(assigned_bom.get("identifier")) if assigned_bom else None
        )
        actual_identifier = source_page.get("actualIdentifier")
        expected_identifier = source_page.get("expectedBomOwner")
        owner_identifier_mismatch = (
            assigned_identifier is not None
            and (
                (
                    actual_identifier is not None
                    and actual_identifier != assigned_identifier
                )
                or (
                    actual_identifier is None
                    and expected_identifier is not None
                    and expected_identifier != assigned_identifier
                )
            )
        )
        render_mode = "generated"
        if (
            page_number >= 1076
            or page_class in SOURCE_PAGE_CLASSES
            or page_class == "assembly-contents"
            or int(source_page.get("assemblyRowCount", 0)) > 0
            or (
                page_class.startswith("node-detail")
                and not source_page.get("actualIdentifier")
            )
            or (
                source_detail_kind is not None
                and imported_node_kind is not None
                and source_detail_kind != imported_node_kind
            )
            or (page_number > 16 and owner_occurrence is None)
            or imported_cost_lines_by_page[page_number] != source_cost_count
            or owner_identifier_mismatch
        ):
            render_mode = "source"
        result.append(
            {
                "pageNumber": page_number,
                "class": page_class,
                "size": source_page["size"],
                "actualIdentifier": source_page.get("actualIdentifier"),
                "expectedBomOwner": source_page.get("expectedBomOwner"),
                "ownerOccurrence": owner_occurrence,
                "costLineCount": source_cost_count,
                "costKinds": source_page.get("costKinds", []),
                "costTableLayouts": source_page.get("costTableLayouts", []),
                "assemblyRowCount": int(source_page.get("assemblyRowCount", 0)),
                "imageFrame": source_page.get("imageFrame"),
                "renderMode": render_mode,
            }
        )
    return result


def write_source_page_chunks(
    reader: PdfReader,
    pages: list[dict[str, Any]],
    output: Path,
) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
    source_page_numbers = [
        int(page["pageNumber"])
        for page in pages
        if page["renderMode"] == "source"
    ]
    temporary_index = 0

    def write_group(page_numbers: list[int]) -> list[tuple[list[int], Path]]:
        nonlocal temporary_index
        temporary_index += 1
        path = output / f".source-evidence-{temporary_index:03d}.pdf"
        writer = PdfWriter()
        for page_number in page_numbers:
            writer.add_page(reader.pages[page_number - 1])
        with path.open("wb") as stream:
            writer.write(stream)
        if path.stat().st_size <= SOURCE_CHUNK_LIMIT or len(page_numbers) == 1:
            return [(page_numbers, path)]
        path.unlink()
        middle = len(page_numbers) // 2
        return write_group(page_numbers[:middle]) + write_group(page_numbers[middle:])

    pieces: list[tuple[list[int], Path]] = []
    for offset in range(0, len(source_page_numbers), 36):
        pieces.extend(write_group(source_page_numbers[offset : offset + 36]))

    chunks: list[dict[str, Any]] = []
    location_by_page: dict[int, dict[str, Any]] = {}
    for chunk_number, (page_numbers, temporary_path) in enumerate(pieces, 1):
        path = output / f"historical-evidence-chunk-{chunk_number:03d}.pdf"
        if path.exists():
            path.unlink()
        temporary_path.rename(path)
        data = path.read_bytes()
        item = {
            "displayName": path.name,
            "path": str(path.relative_to(ROOT)),
            "mimeType": "application/pdf",
            "kind": "other",
            "reportCaption": f"UCM25 accepted source evidence chunk {chunk_number}",
            "sourcePages": page_numbers,
            "contentSha256": digest_bytes(data),
            "byteSize": len(data),
        }
        chunks.append(item)
        for source_page_index, page_number in enumerate(page_numbers):
            location_by_page[page_number] = {
                "displayName": path.name,
                "sourcePageIndex": source_page_index,
                "contentSha256": item["contentSha256"],
                "byteSize": item["byteSize"],
            }
    return chunks, location_by_page


def extract(model_path: Path, source: Path, output: Path) -> dict[str, Any]:
    if sha256(source) != EXPECTED_SOURCE_SHA256:
        raise ValueError("UCM25 evidence source hash does not match the accepted final PDF")
    model = json.loads(model_path.read_text(encoding="utf-8"))
    reader = PdfReader(source)
    output.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, Any]] = []

    vehicle_image = largest_image(reader.pages[2])
    if vehicle_image is not None:
        path, mime_type = save_image(vehicle_image, output / "vehicle-overview")
        items.append(
            {
                "sourceId": "ucm25-image-vehicle",
                "sourceNodeId": "ucm25-vehicle",
                "kind": "image",
                "displayName": path.name,
                "path": str(path.relative_to(ROOT)),
                "mimeType": mime_type,
                "reportCaption": "UCM25 vehicle overview",
                "sourcePages": [3],
            }
        )

    detail_by_occurrence = choose_detail_assignments(model)
    for occurrence, detail in sorted(detail_by_occurrence.items()):
        page_number = int(detail["firstDetailPage"])
        image_file = largest_image(reader.pages[page_number - 1])
        if image_file is None:
            continue
        path, mime_type = save_image(
            image_file,
            output / f"node-{occurrence:04d}-summary",
        )
        items.append(
            {
                "sourceId": f"ucm25-image-{occurrence:04d}",
                "sourceNodeId": f"ucm25-node-{occurrence:04d}",
                "kind": "image",
                "displayName": path.name,
                "path": str(path.relative_to(ROOT)),
                "mimeType": mime_type,
                "reportCaption": f"{detail['identifier']} summary image",
                "sourcePages": [page_number],
            }
        )

    groups = technical_page_groups(model)
    for occurrence, page_numbers in sorted(groups.items()):
        writer = PdfWriter()
        for page_number in page_numbers:
            writer.add_page(reader.pages[page_number - 1])
        path = output / f"node-{occurrence:04d}-technical.pdf"
        with path.open("wb") as stream:
            writer.write(stream)
        record = model["bom"][occurrence - 1]
        items.append(
            {
                "sourceId": f"ucm25-drawing-{occurrence:04d}",
                "sourceNodeId": node_source_id(record),
                "kind": "drawing",
                "displayName": path.name,
                "path": str(path.relative_to(ROOT)),
                "mimeType": "application/pdf",
                "reportCaption": f"{record['identifier']} technical evidence",
                "sourcePages": page_numbers,
            }
        )

    layout_pages = historical_layout_pages(model)
    upload_items, source_location_by_page = write_source_page_chunks(
        reader,
        layout_pages,
        output,
    )
    for page in layout_pages:
        location = source_location_by_page.get(int(page["pageNumber"]))
        if location:
            page["sourceEvidence"] = location
    layout = {
        "schemaVersion": 1,
        "sourcePdfSha256": EXPECTED_SOURCE_SHA256,
        "pageCount": int(model["source"]["pageCount"]),
        "bom": model["bom"],
        "pages": layout_pages,
    }
    layout_path = output / "ucm25-historical-layout.json"
    layout_path.write_text(
        json.dumps(layout, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    items.append(
        {
            "sourceId": "ucm25-historical-layout",
            "sourceNodeId": "ucm25-vehicle",
            "kind": "other",
            "displayName": layout_path.name,
            "path": str(layout_path.relative_to(ROOT)),
            "mimeType": "application/json",
            "reportCaption": "UCM25 hash-locked historical page layout",
            "sourcePages": [],
        }
    )

    # The immutable source ends with three pages that are not reachable from
    # its final BOM pointer: the Tire detail, the Wheel Nut detail, and the
    # Wheel Nut evidence page.  Keep them as an unlinked PDF so the generic
    # report planner appends the historical orphaned tail verbatim.  This is
    # archive data, not a renderer special case, so current-season exports are
    # unaffected.
    tail_writer = PdfWriter()
    for page_number in TRAILING_SOURCE_PAGES:
        tail_writer.add_page(reader.pages[page_number - 1])
    tail_path = output / "unlinked-source-tail-1076-1078.pdf"
    with tail_path.open("wb") as stream:
        tail_writer.write(stream)
    items.append(
        {
            "sourceId": "ucm25-unlinked-source-tail",
            "sourceNodeId": None,
            "kind": "other",
            "displayName": tail_path.name,
            "path": str(tail_path.relative_to(ROOT)),
            "mimeType": "application/pdf",
            "reportCaption": "UCM25 orphaned final pages preserved from the accepted source",
            "sourcePages": TRAILING_SOURCE_PAGES,
        }
    )

    for item in items:
        path = ROOT / item["path"]
        data = path.read_bytes()
        item["contentSha256"] = digest_bytes(data)
        item["byteSize"] = len(data)

    technical_pages = sum(
        len(item["sourcePages"]) for item in items if item["kind"] == "drawing"
    )
    technical_files = sum(item["kind"] == "drawing" for item in items)
    if technical_pages != 44 or technical_files != 41:
        raise ValueError(
            f"unexpected technical evidence inventory: {technical_pages} pages in {technical_files} files"
        )
    result = {
        "schemaVersion": 1,
        "sourcePdfSha256": EXPECTED_SOURCE_SHA256,
        "items": items,
        "uploadItems": upload_items,
        "summary": {
            "items": len(items),
            "images": sum(item["kind"] == "image" for item in items),
            "technicalFiles": technical_files,
            "technicalPages": technical_pages,
            "unlinkedTailPages": len(TRAILING_SOURCE_PAGES),
            "bytes": sum(item["byteSize"] for item in items),
            "sourceEvidenceChunks": len(upload_items),
            "sourceEvidencePages": sum(len(item["sourcePages"]) for item in upload_items),
            "sourceEvidenceBytes": sum(item["byteSize"] for item in upload_items),
        },
    }
    index_path = output / "evidence-index.json"
    index_path.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    upload_index_path = output / "historical-evidence-upload-index.json"
    upload_index_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "sourcePdfSha256": EXPECTED_SOURCE_SHA256,
                "items": upload_items,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return {"index": str(index_path), **result["summary"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    print(
        json.dumps(
            extract(args.model.resolve(), args.source.resolve(), args.output.resolve()),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
