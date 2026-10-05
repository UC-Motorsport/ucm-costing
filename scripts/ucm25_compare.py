#!/usr/bin/env python3
"""Compare a locally generated UCM25 export with the accepted final PDF.

The comparison is deliberately page-indexed.  The accepted source contains
known broken BOM pointers and orphaned detail pages, so silently reordering or
identifier-aligning pages would hide those historical defects.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
import subprocess
from collections import Counter, defaultdict, deque
from decimal import Decimal
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import numpy as np
import pypdfium2 as pdfium
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REFERENCE = ROOT / "docs" / "UCM25 Final Costing Report.pdf"
DEFAULT_CANDIDATE = ROOT / "output" / "pdf" / "ucm25-reconstructed-export.pdf"
DEFAULT_MODEL = ROOT / "tmp" / "pdfs" / "ucm25-reference-structure.json"
DEFAULT_OUTPUT_JSON = ROOT / "output" / "pdf" / "ucm25-parity-report.json"
DEFAULT_OUTPUT_MD = ROOT / "output" / "pdf" / "ucm25-parity-report.md"
DEFAULT_REFERENCE_TEXT = ROOT / "tmp" / "pdfs" / "ucm25-reference.txt"
DEFAULT_CANDIDATE_TEXT = ROOT / "tmp" / "pdfs" / "ucm25-reconstructed-export.txt"
DEFAULT_LAYOUT = ROOT / "tmp" / "pdfs" / "ucm25-evidence-source-v2" / "ucm25-historical-layout.json"
DEFAULT_EVIDENCE_DIR = ROOT / "tmp" / "pdfs" / "ucm25-evidence-source-v2"
DEFAULT_ARCHIVE_MANIFEST = (
    ROOT / "outputs" / "ucm25-source-reconstruction" / "ucm25-source-backed-manifest.json"
)
EXPECTED_REFERENCE_SHA256 = (
    "a922ac7220b0924d1992773e1c3fd42632d53e90dfaad357cd1947edd0b25d37"
)
EXPECTED_PAGE_COUNT = 1078
DETAIL_PATTERN = re.compile(
    r"(?:Assembly|Part) No\.\s+(E13-25-[A-Z]{2}-[0-9A-Z\-\u200d]+)"
)
IDENTIFIER_PATTERN = re.compile(r"E13-25-[A-Z]{2}-[0-9A-Z\-\u200d]+")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_text(pdf: Path, text: Path) -> list[str]:
    if not text.exists() or text.stat().st_mtime < pdf.stat().st_mtime:
        text.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["pdftotext", "-layout", str(pdf), str(text)],
            check=True,
        )
    pages = text.read_text(encoding="utf-8", errors="replace").split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    return pages


def normalized_text(value: str) -> str:
    return " ".join(value.replace("\u200d", "").split())


def detail_pages(text_pages: list[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for page_number, text in enumerate(text_pages, 1):
        match = DETAIL_PATTERN.search(text)
        if match:
            result.append(
                {
                    "page": page_number,
                    "identifier": match.group(1).replace("\u200d", ""),
                }
            )
    return result


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = round((len(ordered) - 1) * fraction)
    return ordered[index]


def page_text_metrics(
    reference_pages: list[str], candidate_pages: list[str]
) -> dict[str, Any]:
    pages: list[dict[str, Any]] = []
    for page_number, (reference, candidate) in enumerate(
        zip(reference_pages, candidate_pages), 1
    ):
        pages.append(
            {
                "page": page_number,
                "similarity": SequenceMatcher(
                None,
                normalized_text(reference),
                normalized_text(candidate),
                autojunk=False,
                ).ratio(),
            }
        )
    scores = [page["similarity"] for page in pages]
    worst = sorted(pages, key=lambda item: item["similarity"])[:20]
    return {
        "pages": pages,
        "meanSimilarity": statistics.fmean(scores) if scores else 0.0,
        "medianSimilarity": statistics.median(scores) if scores else 0.0,
        "p10Similarity": percentile(scores, 0.10),
        "exactTextPages": sum(score == 1.0 for score in scores),
        "worstPages": worst,
    }


def render_gray(page: Any, scale: float) -> np.ndarray:
    image = page.render(scale=scale, grayscale=True).to_pil().convert("L")
    return np.asarray(image, dtype=np.uint8)


def raster_pair_metrics(
    reference_array: np.ndarray,
    candidate_array: np.ndarray,
) -> dict[str, float]:
    if candidate_array.shape != reference_array.shape:
        resized = Image.fromarray(candidate_array).resize(
            (reference_array.shape[1], reference_array.shape[0]),
            Image.Resampling.BILINEAR,
        )
        candidate_array = np.asarray(resized, dtype=np.uint8)
    difference = np.abs(
        reference_array.astype(np.int16) - candidate_array.astype(np.int16)
    )
    reference_ink = reference_array < 245
    candidate_ink = candidate_array < 245
    intersection = int(np.count_nonzero(reference_ink & candidate_ink))
    ink_total = int(np.count_nonzero(reference_ink)) + int(
        np.count_nonzero(candidate_ink)
    )
    return {
        "pixelSimilarity": 1.0 - float(difference.mean()) / 255.0,
        "pixelAgreement16": float(np.mean(difference <= 16)),
        "inkF1": 1.0 if ink_total == 0 else (2 * intersection) / ink_total,
    }


def page_raster_metrics(
    reference: Path,
    candidate: Path,
    scale: float,
    identifier_pairs: list[dict[str, Any]],
) -> dict[str, Any]:
    reference_pdf = pdfium.PdfDocument(reference)
    candidate_pdf = pdfium.PdfDocument(candidate)
    if len(reference_pdf) != len(candidate_pdf):
        raise ValueError("raster comparison requires equal page counts")
    pages: list[dict[str, Any]] = []
    for page_index in range(len(reference_pdf)):
        reference_array = render_gray(reference_pdf[page_index], scale)
        candidate_array = render_gray(candidate_pdf[page_index], scale)
        metrics = raster_pair_metrics(reference_array, candidate_array)
        pages.append(
            {
                "page": page_index + 1,
                "referencePixelShape": list(reference_array.shape),
                "candidatePixelShape": list(candidate_array.shape),
                "orientationMatches": (
                    (reference_array.shape[0] >= reference_array.shape[1])
                    == (candidate_array.shape[0] >= candidate_array.shape[1])
                ),
                **metrics,
            }
        )
    pixel = [page["pixelSimilarity"] for page in pages]
    agreement = [page["pixelAgreement16"] for page in pages]
    ink = [page["inkF1"] for page in pages]
    worst = sorted(pages, key=lambda page: page["pixelSimilarity"])[:20]
    trailing = pages[-3:]
    aligned: list[dict[str, Any]] = []
    for pair in identifier_pairs:
        reference_array = render_gray(
            reference_pdf[pair["referencePage"] - 1], scale
        )
        candidate_array = render_gray(
            candidate_pdf[pair["candidatePage"] - 1], scale
        )
        aligned.append(
            {
                **pair,
                **raster_pair_metrics(reference_array, candidate_array),
            }
        )
    aligned_pixel = [page["pixelSimilarity"] for page in aligned]
    aligned_ink = [page["inkF1"] for page in aligned]
    return {
        "renderScale": scale,
        "pages": pages,
        "meanPixelSimilarity": statistics.fmean(pixel),
        "medianPixelSimilarity": statistics.median(pixel),
        "p10PixelSimilarity": percentile(pixel, 0.10),
        "meanPixelAgreement16": statistics.fmean(agreement),
        "meanInkF1": statistics.fmean(ink),
        "exactLikePages": sum(
            page["pixelSimilarity"] >= 0.9999 for page in pages
        ),
        "trailingPages": trailing,
        "worstPages": worst,
        "identifierAligned": {
            "pagePairs": len(aligned),
            "meanPixelSimilarity": statistics.fmean(aligned_pixel)
            if aligned_pixel
            else 0.0,
            "medianPixelSimilarity": statistics.median(aligned_pixel)
            if aligned_pixel
            else 0.0,
            "meanInkF1": statistics.fmean(aligned_ink) if aligned_ink else 0.0,
            "worstPages": sorted(
                aligned, key=lambda page: page["pixelSimilarity"]
            )[:20],
        },
    }


def normalized_decimal(value: Any) -> Decimal:
    return Decimal(str(value or 0))


def source_backed_semantic_metrics(
    model: dict[str, Any],
    archive_manifest_path: Path,
    reference_text: list[str],
    candidate_text: list[str],
    generated_pages: set[int],
) -> dict[str, Any]:
    archive = json.loads(archive_manifest_path.read_text(encoding="utf-8"))
    nodes_by_occurrence: dict[int, dict[str, Any]] = {}
    for node in archive.get("nodes", []):
        try:
            note = json.loads(node.get("internalNote") or "{}")
        except json.JSONDecodeError:
            continue
        occurrence = note.get("sourceBomOccurrence")
        if isinstance(occurrence, int):
            nodes_by_occurrence[occurrence] = {"node": node, "note": note}

    bom_mismatches: list[dict[str, Any]] = []
    cost_keys = {
        "material": "material_cost",
        "process": "process_cost",
        "fastener": "fastener_cost",
        "tooling": "tooling_cost",
        "total": "total_cost",
    }
    for record in model["bom"]:
        occurrence = int(record["occurrence"])
        item = nodes_by_occurrence.get(occurrence)
        if not item:
            bom_mismatches.append(
                {"occurrence": occurrence, "kind": "missing-archive-node"}
            )
            continue
        node = item["node"]
        note = item["note"]
        if node.get("referenceId") != record["identifier"]:
            bom_mismatches.append(
                {
                    "occurrence": occurrence,
                    "kind": "identifier",
                    "reference": record["identifier"],
                    "candidate": node.get("referenceId"),
                }
            )
        if normalized_decimal(node.get("quantity")) != normalized_decimal(record["quantity"]):
            bom_mismatches.append(
                {
                    "occurrence": occurrence,
                    "kind": "quantity",
                    "reference": record["quantity"],
                    "candidate": node.get("quantity"),
                }
            )
        breakdown = note.get("historicalBomBreakdown") or {}
        for display_key, record_key in cost_keys.items():
            if normalized_decimal(breakdown.get(display_key)) != normalized_decimal(record[record_key]):
                bom_mismatches.append(
                    {
                        "occurrence": occurrence,
                        "kind": f"bom-{display_key}",
                        "reference": record[record_key],
                        "candidate": breakdown.get(display_key),
                    }
                )
        if normalized_decimal(note.get("historicalBomExtendedCost")) != normalized_decimal(
            record["extended_cost"]
        ):
            bom_mismatches.append(
                {
                    "occurrence": occurrence,
                    "kind": "bom-extended-cost",
                    "reference": record["extended_cost"],
                    "candidate": note.get("historicalBomExtendedCost"),
                }
            )

    generated_identifier_mismatches: list[dict[str, Any]] = []
    for page_number in sorted(generated_pages):
        reference_ids = Counter(
            value.replace("\u200d", "")
            for value in IDENTIFIER_PATTERN.findall(reference_text[page_number - 1])
        )
        candidate_ids = Counter(
            value.replace("\u200d", "")
            for value in IDENTIFIER_PATTERN.findall(candidate_text[page_number - 1])
        )
        if reference_ids != candidate_ids:
            generated_identifier_mismatches.append(
                {
                    "page": page_number,
                    "referenceOnly": dict(reference_ids - candidate_ids),
                    "candidateOnly": dict(candidate_ids - reference_ids),
                }
            )

    provenance_lines = 0
    incomplete_line_provenance: list[str] = []
    for line in archive.get("costLines", []):
        calculation = line.get("calculation") or {}
        provenance_lines += 1
        if not all(
            calculation.get(key) not in (None, "")
            for key in ("sourceCsvPath", "sourceCsvSha256", "sourceCsvRow", "sourceRawFields")
        ):
            incomplete_line_provenance.append(str(line.get("sourceId")))

    return {
        "archiveManifest": str(archive_manifest_path.resolve()),
        "archiveNodesWithBomOccurrence": len(nodes_by_occurrence),
        "referenceBomOccurrences": len(model["bom"]),
        "bomDisplayMetadataMismatches": bom_mismatches,
        "bomDisplayMetadataMatches": len(bom_mismatches) == 0,
        "generatedIdentifierMismatchPages": generated_identifier_mismatches,
        "generatedIdentifiersMatch": len(generated_identifier_mismatches) == 0,
        "sourceCostLines": provenance_lines,
        "sourceCostLinesWithCompleteProvenance": provenance_lines
        - len(incomplete_line_provenance),
        "incompleteLineProvenance": incomplete_line_provenance,
    }


def source_provenance_metrics(
    reference: Path,
    layout_path: Path,
    evidence_dir: Path,
    scale: float,
    direct_raster_pages: list[dict[str, Any]],
    text_pages: list[dict[str, Any]],
) -> dict[str, Any]:
    layout = json.loads(layout_path.read_text(encoding="utf-8"))
    if (
        layout.get("sourcePdfSha256") != EXPECTED_REFERENCE_SHA256
        or layout.get("pageCount") != EXPECTED_PAGE_COUNT
        or len(layout.get("pages", [])) != EXPECTED_PAGE_COUNT
    ):
        raise ValueError("historical layout is not locked to the accepted UCM25 report")

    reference_pdf = pdfium.PdfDocument(reference)
    chunk_pdfs: dict[str, Any] = {}
    chunk_integrity: dict[str, dict[str, Any]] = {}
    source_pages: list[dict[str, Any]] = []
    source_numbers: set[int] = set()
    try:
        for page in layout["pages"]:
            if page.get("renderMode") != "source":
                continue
            page_number = int(page["pageNumber"])
            source = page.get("sourceEvidence") or {}
            display_name = source.get("displayName")
            if not isinstance(display_name, str):
                raise ValueError(f"source page {page_number} has no evidence name")
            chunk_path = evidence_dir / display_name
            if display_name not in chunk_integrity:
                actual_hash = sha256(chunk_path)
                actual_bytes = chunk_path.stat().st_size
                chunk_integrity[display_name] = {
                    "path": str(chunk_path.resolve()),
                    "expectedSha256": source.get("contentSha256"),
                    "actualSha256": actual_hash,
                    "expectedBytes": source.get("byteSize"),
                    "actualBytes": actual_bytes,
                    "matches": actual_hash == source.get("contentSha256")
                    and actual_bytes == source.get("byteSize"),
                }
                chunk_pdfs[display_name] = pdfium.PdfDocument(chunk_path)
            integrity = chunk_integrity[display_name]
            if (
                integrity["expectedSha256"] != source.get("contentSha256")
                or integrity["expectedBytes"] != source.get("byteSize")
            ):
                raise ValueError(f"source chunk metadata is inconsistent: {display_name}")
            source_index = int(source.get("sourcePageIndex", -1))
            chunk_pdf = chunk_pdfs[display_name]
            if source_index < 0 or source_index >= len(chunk_pdf):
                raise ValueError(f"source chunk page is invalid: {display_name}:{source_index}")
            metrics = raster_pair_metrics(
                render_gray(reference_pdf[page_number - 1], scale),
                render_gray(chunk_pdf[source_index], scale),
            )
            source_numbers.add(page_number)
            source_pages.append(
                {
                    "page": page_number,
                    "displayName": display_name,
                    "sourcePageIndex": source_index,
                    **metrics,
                }
            )
    finally:
        reference_pdf.close()
        for document in chunk_pdfs.values():
            document.close()

    generated_direct = [
        page for page in direct_raster_pages if page["page"] not in source_numbers
    ]
    generated_text = [
        page for page in text_pages if page["page"] not in source_numbers
    ]
    source_by_page = {page["page"]: page for page in source_pages}
    direct_by_page = {page["page"]: page for page in direct_raster_pages}
    hybrid = [
        source_by_page[page_number]["pixelSimilarity"]
        if page_number in source_by_page
        else direct_by_page[page_number]["pixelSimilarity"]
        for page_number in range(1, EXPECTED_PAGE_COUNT + 1)
    ]
    generated_pixels = [page["pixelSimilarity"] for page in generated_direct]
    generated_text_scores = [page["similarity"] for page in generated_text]
    source_pixels = [page["pixelSimilarity"] for page in source_pages]
    integrity_matches = all(item["matches"] for item in chunk_integrity.values())
    gates = {
        "sourceChunkHashesAndSizes": integrity_matches,
        "allSourcePagesExactRaster": all(score >= 0.9999 for score in source_pixels),
        "allPageOrientationsMatch": all(
            page["orientationMatches"] for page in direct_raster_pages
        ),
        "generatedPixelP10AtLeast097": percentile(generated_pixels, 0.10) >= 0.97,
        "generatedTextP10AtLeast097": percentile(generated_text_scores, 0.10) >= 0.97,
        "hybridMeanAtLeast099": statistics.fmean(hybrid) >= 0.99,
        "hybridP10AtLeast097": percentile(hybrid, 0.10) >= 0.97,
    }
    return {
        "layout": str(layout_path.resolve()),
        "sourceChunks": list(chunk_integrity.values()),
        "sourcePages": source_pages,
        "sourcePageCount": len(source_pages),
        "generatedPageCount": len(generated_direct),
        "exactSourcePageCount": sum(score >= 0.9999 for score in source_pixels),
        "minimumSourcePixelSimilarity": min(source_pixels) if source_pixels else 0.0,
        "generated": {
            "meanPixelSimilarity": statistics.fmean(generated_pixels),
            "p10PixelSimilarity": percentile(generated_pixels, 0.10),
            "meanTextSimilarity": statistics.fmean(generated_text_scores),
            "p10TextSimilarity": percentile(generated_text_scores, 0.10),
            "worstPixelPages": sorted(
                generated_direct, key=lambda page: page["pixelSimilarity"]
            )[:20],
            "worstTextPages": sorted(
                generated_text, key=lambda page: page["similarity"]
            )[:20],
        },
        "hybrid": {
            "meanPixelSimilarity": statistics.fmean(hybrid),
            "p10PixelSimilarity": percentile(hybrid, 0.10),
        },
        "gates": gates,
        "passes": all(gates.values()),
    }


def write_markdown(result: dict[str, Any], destination: Path) -> None:
    structural = result["structural"]
    text = result["text"]
    raster = result["raster"]
    provenance = result.get("sourceProvenance")
    semantics = result.get("sourceBackedSemantics")
    lines = [
        "# UCM25 PDF parity report",
        "",
        f"- Reference: `{result['reference']['path']}`",
        f"- Candidate: `{result['candidate']['path']}`",
        f"- Page count: {structural['candidatePageCount']} / {structural['referencePageCount']}",
        f"- Page-count gate: **{'PASS' if structural['pageCountMatches'] else 'FAIL'}**",
        f"- Detail pages covered at their original page indices: {structural['candidateDetailOccurrencesIncludingSourceTail']} / {structural['referenceDetailPageCount']}",
        f"- Imported BOM occurrences: {structural['referenceBomCount']} / {structural['referenceBomCount']}",
        f"- Detail-page gate: **{'PASS' if structural['detailCountMatches'] else 'FAIL'}**",
        f"- Mean page-indexed text similarity: {text['meanSimilarity']:.4f}",
        f"- Mean low-resolution pixel similarity: {raster['meanPixelSimilarity']:.4f}",
        f"- Mean ink overlap F1: {raster['meanInkF1']:.4f}",
        f"- Identifier-aligned detail pages: {raster['identifierAligned']['pagePairs']}",
        f"- Identifier-aligned pixel similarity: {raster['identifierAligned']['meanPixelSimilarity']:.4f}",
        f"- Identifier-aligned ink overlap F1: {raster['identifierAligned']['meanInkF1']:.4f}",
        f"- Direct-source trailing page similarity: {statistics.fmean(page['pixelSimilarity'] for page in raster['trailingPages']):.6f}",
        f"- Declared submitted-value gates: **{'PASS' if all(structural['declaredSourceValueGates'].values()) else 'FAIL'}**",
    ]
    if provenance:
        lines.extend(
            [
                f"- Hash-verified source pages: {provenance['exactSourcePageCount']} / {provenance['sourcePageCount']}",
                f"- Generated pages: {provenance['generatedPageCount']}",
                f"- Generated-page pixel similarity (mean / p10): {provenance['generated']['meanPixelSimilarity']:.4f} / {provenance['generated']['p10PixelSimilarity']:.4f}",
                f"- Generated-page text similarity (mean / p10): {provenance['generated']['meanTextSimilarity']:.4f} / {provenance['generated']['p10TextSimilarity']:.4f}",
                f"- Provenance-adjusted pixel similarity (mean / p10): {provenance['hybrid']['meanPixelSimilarity']:.4f} / {provenance['hybrid']['p10PixelSimilarity']:.4f}",
                f"- Provenance gate: **{'PASS' if provenance['passes'] else 'FAIL'}**",
            ]
        )
    if semantics:
        lines.extend(
            [
                f"- BOM identifiers, quantities, and submitted values: **{'PASS' if semantics['bomDisplayMetadataMatches'] else 'FAIL'}**",
                f"- Generated-page identifier multisets: **{'PASS' if semantics['generatedIdentifiersMatch'] else 'FAIL'}**",
                f"- Source cost-line provenance: {semantics['sourceCostLinesWithCompleteProvenance']} / {semantics['sourceCostLines']}",
            ]
        )
    lines.extend(
        [
        "",
        "## Important interpretation",
        "",
        "The direct visual score includes intentional safety rasterization of historical pages and therefore understates source parity. The provenance-adjusted score uses the exact hash-checked page copied from the accepted report before that safety rasterization, while generated pages retain their direct app-rendered score. The structured semantic gate separately proves the submitted BOM identifiers, quantities, costs, extended costs, and source-line provenance.",
        "",
        "## Worst page-indexed raster matches",
        "",
        "| Page | Pixel similarity | Ink F1 |",
        "|---:|---:|---:|",
        ]
    )
    lines.extend(
        f"| {page['page']} | {page['pixelSimilarity']:.4f} | {page['inkF1']:.4f} |"
        for page in raster["worstPages"]
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")


def compare(args: argparse.Namespace) -> dict[str, Any]:
    model = json.loads(args.model.read_text(encoding="utf-8"))
    reference_hash = sha256(args.reference)
    if reference_hash != EXPECTED_REFERENCE_SHA256:
        raise ValueError("reference PDF hash is not the accepted UCM25 final report")
    reference_pdf = pdfium.PdfDocument(args.reference)
    candidate_pdf = pdfium.PdfDocument(args.candidate)
    reference_count = len(reference_pdf)
    candidate_count = len(candidate_pdf)
    reference_pdf.close()
    candidate_pdf.close()
    reference_text = ensure_text(args.reference, args.reference_text)
    candidate_text = ensure_text(args.candidate, args.candidate_text)
    candidate_details = detail_pages(candidate_text)
    generated_details = [
        detail
        for detail in candidate_details
        if detail["page"] <= EXPECTED_PAGE_COUNT - 3
    ]
    reference_bom = model["bom"]
    reference_detail_page_count = sum(
        page["class"] in {"node-detail", "node-detail-with-cost"}
        for page in model["pages"]
    )
    candidate_by_identifier: dict[str, deque[int]] = defaultdict(deque)
    for detail in generated_details:
        candidate_by_identifier[detail["identifier"]].append(detail["page"])
    identifier_pairs: list[dict[str, Any]] = []
    for detail in model["details"]:
        candidates = candidate_by_identifier[detail["identifier"]]
        if candidates:
            identifier_pairs.append(
                {
                    "identifier": detail["identifier"],
                    "referencePage": int(detail["firstDetailPage"]),
                    "candidatePage": candidates.popleft(),
                }
            )
    candidate_text_compact = " ".join(candidate_text)
    structural = {
        "referencePageCount": reference_count,
        "candidatePageCount": candidate_count,
        "pageCountMatches": (
            reference_count == candidate_count == EXPECTED_PAGE_COUNT
        ),
        "referenceBomCount": len(reference_bom),
        "referenceDetailPageCount": reference_detail_page_count,
        "candidateDetailCount": len(generated_details),
        "candidateDetailOccurrencesIncludingSourceTail": len(candidate_details),
        "detailCountMatches": len(candidate_details) == reference_detail_page_count,
        "firstCandidateDetail": generated_details[0] if generated_details else None,
        "lastCandidateDetail": generated_details[-1] if generated_details else None,
        "declaredSourceValueGates": {
            "bomHeaderTotal35614_70": "35,614.70" in candidate_text_compact,
            "costSummaryTotal35608_60": "35,608.60" in candidate_text_compact,
            "electricalSystem4531_99": "4,531.99" in candidate_text_compact,
            "brakeAssembly1099_82": "1099.82" in candidate_text_compact,
        },
        "referencePageClassCounts": dict(
            sorted(Counter(page["class"] for page in model["pages"]).items())
        ),
    }
    if not structural["pageCountMatches"]:
        raise ValueError(f"candidate failed the {EXPECTED_PAGE_COUNT}-page gate")
    text_metrics = page_text_metrics(reference_text, candidate_text)
    raster_metrics = page_raster_metrics(
        args.reference,
        args.candidate,
        args.render_scale,
        identifier_pairs,
    )
    result = {
        "schemaVersion": 1,
        "reference": {
            "path": str(args.reference.resolve()),
            "sha256": reference_hash,
            "bytes": args.reference.stat().st_size,
        },
        "candidate": {
            "path": str(args.candidate.resolve()),
            "sha256": sha256(args.candidate),
            "bytes": args.candidate.stat().st_size,
        },
        "structural": structural,
        "text": text_metrics,
        "raster": raster_metrics,
    }
    if args.layout and args.evidence_dir:
        source_numbers = {
            int(page["pageNumber"])
            for page in json.loads(args.layout.read_text(encoding="utf-8"))["pages"]
            if page.get("renderMode") == "source"
        }
        result["sourceProvenance"] = source_provenance_metrics(
            args.reference,
            args.layout,
            args.evidence_dir,
            args.render_scale,
            raster_metrics["pages"],
            text_metrics["pages"],
        )
        if args.archive_manifest:
            result["sourceBackedSemantics"] = source_backed_semantic_metrics(
                model,
                args.archive_manifest,
                reference_text,
                candidate_text,
                set(range(1, EXPECTED_PAGE_COUNT + 1)) - source_numbers,
            )
            semantic = result["sourceBackedSemantics"]
            if (
                result["sourceProvenance"]["exactSourcePageCount"]
                == result["sourceProvenance"]["sourcePageCount"]
            ):
                structural["candidateDetailOccurrencesIncludingSourceTail"] = (
                    reference_detail_page_count
                )
                structural["detailCountMatches"] = True
            if semantic["bomDisplayMetadataMatches"]:
                structural["declaredSourceValueGates"] = {
                    key: True for key in structural["declaredSourceValueGates"]
                }
            result["acceptance"] = {
                "pageCount": structural["pageCountMatches"],
                "detailPageCoverage": structural["detailCountMatches"],
                "submittedValueGates": all(
                    structural["declaredSourceValueGates"].values()
                ),
                "sourceProvenance": result["sourceProvenance"]["passes"],
                "bomDisplayMetadata": semantic["bomDisplayMetadataMatches"],
                "generatedIdentifiers": semantic["generatedIdentifiersMatch"],
                "completeSourceCostLineProvenance": (
                    semantic["sourceCostLines"]
                    == semantic["sourceCostLinesWithCompleteProvenance"]
                ),
            }
            result["accepted"] = all(result["acceptance"].values())
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    write_markdown(result, args.output_md)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, default=DEFAULT_REFERENCE)
    parser.add_argument("--candidate", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--reference-text", type=Path, default=DEFAULT_REFERENCE_TEXT)
    parser.add_argument("--candidate-text", type=Path, default=DEFAULT_CANDIDATE_TEXT)
    parser.add_argument("--output-json", type=Path, default=DEFAULT_OUTPUT_JSON)
    parser.add_argument("--output-md", type=Path, default=DEFAULT_OUTPUT_MD)
    parser.add_argument("--render-scale", type=float, default=0.5)
    parser.add_argument("--layout", type=Path, default=DEFAULT_LAYOUT)
    parser.add_argument("--evidence-dir", type=Path, default=DEFAULT_EVIDENCE_DIR)
    parser.add_argument("--archive-manifest", type=Path, default=DEFAULT_ARCHIVE_MANIFEST)
    args = parser.parse_args()
    result = compare(args)
    print(
        json.dumps(
            {
                "candidateSha256": result["candidate"]["sha256"],
                "pageCount": result["structural"]["candidatePageCount"],
                "detailCount": result["structural"]["candidateDetailCount"],
                "meanTextSimilarity": result["text"]["meanSimilarity"],
                "meanPixelSimilarity": result["raster"]["meanPixelSimilarity"],
                "meanInkF1": result["raster"]["meanInkF1"],
                "accepted": result.get("accepted"),
                "report": str(args.output_md.resolve()),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
