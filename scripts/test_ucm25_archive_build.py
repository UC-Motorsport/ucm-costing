from __future__ import annotations

import unittest

from ucm25_archive_build import (
    build_nodes,
    choose_detail_assignments,
    decimal_string,
    is_assembly_record,
)


class ArchiveBuilderTests(unittest.TestCase):
    def test_decimal_strings_are_canonical(self) -> None:
        self.assertEqual(decimal_string(96.0), "96")
        self.assertEqual(decimal_string(0.125), "0.125")
        self.assertEqual(decimal_string(None, default="1"), "1")

    def test_left_and_right_zero_part_variants_are_assemblies(self) -> None:
        self.assertTrue(is_assembly_record({"part_number": "00"}))
        self.assertTrue(is_assembly_record({"part_number": "00-L"}))
        self.assertTrue(is_assembly_record({"part_number": "00-R"}))
        self.assertFalse(is_assembly_record({"part_number": "01"}))

    def test_detail_assignment_preserves_duplicate_identifiers(self) -> None:
        model = {
            "bom": [
                {
                    "occurrence": 1,
                    "identifier": "E13-25-CH-080501-A",
                    "expected_detail_page": 420,
                },
                {
                    "occurrence": 2,
                    "identifier": "E13-25-CH-080501-A",
                    "expected_detail_page": 422,
                },
            ],
            "pages": [
                {"pageNumber": number, "expectedBomOwner": None}
                for number in range(1, 423)
            ],
            "details": [
                {"identifier": "E13-25-CH-080501-A", "firstDetailPage": 420},
                {"identifier": "E13-25-CH-080501-A", "firstDetailPage": 422},
            ],
        }
        assigned = choose_detail_assignments(model)
        self.assertEqual(assigned[1]["firstDetailPage"], 420)
        self.assertEqual(assigned[2]["firstDetailPage"], 422)

    def test_duplicate_full_numbers_are_visually_disambiguated(self) -> None:
        record = {
            "occurrence": 1,
            "identifier": "E13-25-CH-080501-A",
            "system_code": "CH",
            "assembly_number": "08",
            "level": "05",
            "part_number": "00",
            "assembly_description": "Test assembly",
            "part_description": "",
            "revision": "A",
            "quantity": 1,
            "bom_page": 10,
            "expected_detail_page": 420,
        }
        model = {"bom": [record, {**record, "occurrence": 2, "expected_detail_page": 422}]}
        nodes, _ = build_nodes(model, {})
        report_nodes = [node for node in nodes if node["kind"] == "assembly"]
        self.assertEqual(report_nodes[0]["fullNumber"], record["identifier"])
        self.assertEqual(report_nodes[1]["fullNumber"], record["identifier"] + "\u200d")


if __name__ == "__main__":
    unittest.main()
