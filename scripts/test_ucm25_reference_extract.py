from __future__ import annotations

import unittest

from ucm25_reference_extract import (
    cost_line_from_row,
    multiplier_value,
    parse_number,
    table_cost_kind,
)


class NumberParsingTests(unittest.TestCase):
    def test_currency_and_spreadsheet_digit_spacing(self) -> None:
        self.assertEqual(parse_number("$ 35,614.70"), 35614.7)
        self.assertEqual(parse_number("$ 2 6.29"), 26.29)
        self.assertEqual(parse_number("-", default=0), 0)

    def test_multiplier_falls_back_to_value_embedded_in_name(self) -> None:
        self.assertEqual(multiplier_value("Repeat 12", ""), 12)
        self.assertEqual(multiplier_value("Material - Steel", "3"), 3)
        self.assertEqual(multiplier_value("None", ""), 1)


class CostLineParsingTests(unittest.TestCase):
    def test_assembly_contents_table_is_not_a_material_cost_table(self) -> None:
        self.assertIsNone(
            table_cost_kind(
                [
                    "Item Order",
                    "Part/Sub Assembly",
                    "Part/Sub Assembly Number",
                    "Description",
                    "Sub Assembly Parts Cost",
                    "Material Cost",
                ]
            )
        )

    def test_process_row_reconstructs_historical_subtotal(self) -> None:
        row = [
            "4",
            "Drilled holes < 25.4 mm dia.",
            "Drill out bearing cups",
            "0.35",
            "hole",
            "Material - Steel",
            "3",
            "3",
            "3.15",
        ]
        result = cost_line_from_row("process", row, 950)
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["multiplier"], 3)
        self.assertEqual(result["quantity"], 3)
        self.assertAlmostEqual(result["computedSubtotal"], 3.15)
        self.assertAlmostEqual(result["roundingVariance"], 0)

    def test_tooling_row_uses_fraction_and_pvf(self) -> None:
        row = [
            "1",
            "Welds - Welding Fixture",
            "Align components for welding",
            "1",
            "3000",
            "33",
            "Number of Points",
            "",
            "",
            "16500",
            "0.125",
            "0.69",
        ]
        result = cost_line_from_row("tooling", row, 950)
        self.assertIsNotNone(result)
        assert result is not None
        self.assertAlmostEqual(result["computedSubtotal"], 0.6875)
        self.assertAlmostEqual(result["roundingVariance"], 0.0025)


if __name__ == "__main__":
    unittest.main()
