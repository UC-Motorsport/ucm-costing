#!/usr/bin/env python3
"""Safely reproduce the UCM25 final merge and A3-to-A4 conversion.

The downloaded 2025 scripts contain hard-coded Windows paths and write into
their input folders.  This equivalent runner is intentionally read-only with
respect to the downloaded source tree and writes one caller-selected PDF.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject


SECTION_NAMES = (
    "!INTRO.pdf",
    "0BOM.pdf",
    "1BR.pdf",
    "2DR.pdf",
    "3CH.pdf",
    "4AD.pdf",
    "5EL.pdf",
    "6MS.pdf",
    "7ST.pdf",
    "8SU.pdf",
    "9WT.pdf",
)
A4_LANDSCAPE_WIDTH = 297 / 25.4 * 72
A4_LANDSCAPE_HEIGHT = 210 / 25.4 * 72


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rebuild(section_directory: Path, destination: Path) -> dict[str, object]:
    sections = [section_directory / name for name in SECTION_NAMES]
    missing = [str(path) for path in sections if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"missing UCM25 section PDFs: {missing}")
    if destination.exists():
        raise FileExistsError(destination)

    destination.parent.mkdir(parents=True, exist_ok=True)
    writer = PdfWriter()
    section_manifest: list[dict[str, object]] = []
    scaled_pages: list[int] = []
    page_number = 0
    for path in sections:
        reader = PdfReader(path)
        section_manifest.append(
            {
                "name": path.name,
                "pages": len(reader.pages),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
        )
        for page in reader.pages:
            page_number += 1
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)
            if width > height and width > 842:
                page.scale_to(A4_LANDSCAPE_WIDTH, A4_LANDSCAPE_HEIGHT)
                page.mediabox = RectangleObject(
                    [0, 0, A4_LANDSCAPE_WIDTH, A4_LANDSCAPE_HEIGHT]
                )
                scaled_pages.append(page_number)
            writer.add_page(page)
    with destination.open("xb") as stream:
        writer.write(stream)

    return {
        "format": "ucm25-original-pdf-rebuild",
        "schemaVersion": 1,
        "sourceDirectory": str(section_directory.resolve()),
        "sections": section_manifest,
        "pageCount": page_number,
        "scaledPageCount": len(scaled_pages),
        "scaledPages": scaled_pages,
        "output": {
            "path": str(destination.resolve()),
            "bytes": destination.stat().st_size,
            "sha256": sha256(destination),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("section_directory", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    result = rebuild(args.section_directory, args.destination)
    if args.manifest:
        if args.manifest.exists():
            raise FileExistsError(args.manifest)
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(
            json.dumps(result, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
