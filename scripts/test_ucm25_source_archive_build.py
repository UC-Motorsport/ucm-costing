from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from ucm25_source_archive_build import (
    archive_number,
    filename_identifier,
    parse_source_csv,
    source_pages_for_lines,
)


class SourceArchiveBuilderTests(unittest.TestCase):
    def test_filename_identifier_preserves_handed_variants(self) -> None:
        self.assertEqual(
            filename_identifier(Path("SU_010018-L_A.csv")),
            "E13-25-SU-010018-L-A",
        )
        self.assertEqual(
            filename_identifier(Path("AD_130001_A-R.csv")),
            "E13-25-AD-130001-R-A",
        )
        self.assertIsNone(filename_identifier(Path("notes.csv")))

    def test_original_csv_rows_and_unresolved_literals_are_retained(self) -> None:
        content = "\n".join(
            [
                "University,University of Canterbury",
                "Part,Fastener test",
                "Revision,A",
                "Item Order,fastener,Use,Unit Cost,Quantity,Sub Total",
                "1,M6 bolt,Fixture,Needs Calc,2,Needs Calc",
                "Subtotal,Needs Calc",
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "DR_150000_A.csv"
            path.write_text(content + "\n", encoding="utf-8")
            parsed = parse_source_csv(path)

        self.assertEqual(parsed.identifier, "E13-25-DR-150000-A")
        self.assertEqual(len(parsed.lines), 1)
        line = parsed.lines[0]
        self.assertEqual(line.description, "M6 bolt")
        self.assertEqual(line.unit_cost, "Needs Calc")
        self.assertEqual(line.subtotal, "Needs Calc")
        self.assertEqual(line.raw["unit cost"], "Needs Calc")
        self.assertEqual(archive_number(line.unit_cost), "0")

    def test_line_page_matching_preserves_source_order(self) -> None:
        content = "\n".join(
            [
                "Item Order,material,Use,Unit Cost,Quantity,Sub Total",
                "1,Steel,Bracket,2,3,6",
                "2,Aluminium,Cover,4,1,4",
                "Subtotal,10",
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "CH_010001_A.csv"
            path.write_text(content + "\n", encoding="utf-8")
            lines = list(parse_source_csv(path).lines)
        pages, matches = source_pages_for_lines(
            lines,
            [
                {
                    "description": "Steel",
                    "useDescription": "Bracket",
                    "declaredSubtotal": "6",
                    "sourcePage": 42,
                },
                {
                    "description": "Aluminium",
                    "useDescription": "Cover",
                    "declaredSubtotal": "4",
                    "sourcePage": 43,
                },
            ],
            [],
        )
        self.assertEqual(pages, [42, 43])
        self.assertEqual(matches, 2)


if __name__ == "__main__":
    unittest.main()
