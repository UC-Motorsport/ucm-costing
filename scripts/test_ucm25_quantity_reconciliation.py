from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from ucm25_archive_build import ACCEPTED_SOURCE_SHA256
from ucm25_source_archive_build import parse_source_csv
from ucm25_quantity_reconciliation import SUSPENSION_GROUPS, reconcile_source_quantities


class QuantityReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.nodes = []
        self.selected = {}
        for system in ("SU", "DR"):
            self.nodes.append(dict(sourceId=system, referenceId=system, kind="system",
                                   quantity="1", sourceParentId=None, internalNote="{}"))
        groups = [("SU", p, c) for p, c in SUSPENSION_GROUPS.items()] + [("DR", "160000", ("160100",))]
        for system, number, child_numbers in groups:
            parent = self.add_node(system, number, "assembly", "2", system)
            content = ["Quantity,2", "Item Order,Part/Sub Assembly,Part/Sub Assembly Number,Quantity"]
            for i, child in enumerate(child_numbers):
                qty = 3 if system == "DR" or child == "020006" else 6 if child == "020007" else 1
                self.add_node(system, child, "assembly" if system == "DR" else "part",
                              str(qty if system == "DR" else qty*2), system if system == "DR" else parent["sourceId"])
                content.append(f"{i+1},Part,{child},{qty}")
            # Shared stock must not be blindly moved or duplicated.
            content.append("99,Shared bearing,999999,8")
            content.append(",,,Subtotal")
            path = self.root / f"{system}_{number}_A.csv"
            path.write_text("\n".join(content))
            occurrence = json.loads(parent["internalNote"])["sourceBomOccurrence"]
            self.selected[occurrence] = parse_source_csv(path)

    def add_node(self, system, number, kind, quantity, parent):
        identifier = f"E13-25-{system}-{number}-A"
        node = dict(sourceId=identifier, referenceId=identifier, kind=kind, quantity=quantity,
                    sourceParentId=parent, internalNote=json.dumps({"sourceBomOccurrence": len(self.nodes)+1,
                    "sourcePdfSha256": ACCEPTED_SOURCE_SHA256, "historicalBomExtendedCost": "123.45"}))
        self.nodes.append(node)
        return node

    def test_quantities_nesting_provenance_and_idempotence(self):
        changes = reconcile_source_quantities(self.nodes, self.selected, self.root)
        self.assertEqual(len(changes), 28)
        upright = next(n for n in self.nodes if "SU-020002-" in n["referenceId"])
        self.assertEqual(upright["quantity"], "1")
        for number, expected in (("020006", "3"), ("020007", "6")):
            self.assertEqual(next(n for n in self.nodes if f"SU-{number}-" in n["referenceId"])["quantity"], expected)
        planet = next(n for n in self.nodes if "DR-160100-" in n["referenceId"])
        self.assertEqual((planet["kind"], planet["quantity"], planet["sourceParentId"]),
                         ("subassembly", "3", "E13-25-DR-160000-A"))
        note = json.loads(planet["internalNote"])
        self.assertIsNone(note["historicalParentOccurrence"])
        self.assertEqual(note["historicalNodeKind"], "assembly")
        self.assertEqual(note["historicalBomExtendedCost"], "123.45")
        before = copy.deepcopy(self.nodes)
        self.assertEqual(reconcile_source_quantities(self.nodes, self.selected, self.root), changes)
        self.assertEqual(self.nodes, before)

    def assert_atomic_failure(self):
        before = copy.deepcopy(self.nodes)
        with self.assertRaises(ValueError):
            reconcile_source_quantities(self.nodes, self.selected, self.root)
        self.assertEqual(self.nodes, before)

    def test_missing_source_fails_without_partial_changes(self):
        self.selected.pop(next(reversed(self.selected)))
        self.assert_atomic_failure()

    def test_duplicate_identifier_fails_without_partial_changes(self):
        duplicate = copy.deepcopy(self.nodes[-1]);duplicate['sourceId'] = 'duplicate'
        self.nodes.append(duplicate)
        self.assert_atomic_failure()

    def test_missing_or_duplicate_membership_and_invalid_quantity_fail(self):
        source_key = next(reversed(self.selected))
        original = self.selected[source_key].path.read_text()
        for replacement in ('', '1,Part,160100,3\n2,Part,160100,3', '1,Part,160100,0',
                            '1,Part,160100,-1', '1,Part,160100,NaN', '1,Part,160100,Infinity',
                            '1,Part,160100,[Needs Calc]', '1,Part,160100,4'):
            with self.subTest(replacement=replacement):
                path = self.selected[source_key].path
                path.write_text(original.replace('1,Part,160100,3', replacement))
                self.selected[source_key] = parse_source_csv(path)
                self.assert_atomic_failure()

    def test_source_changed_after_selection_fails(self):
        source = self.selected[next(reversed(self.selected))]
        source.path.write_text(source.path.read_text() + '\n')
        self.assert_atomic_failure()

    def test_unexpected_existing_quantity_is_not_silently_overwritten(self):
        self.nodes[-1]['quantity'] = '6'
        self.assert_atomic_failure()

    def test_nonaccepted_pdf_is_rejected(self):
        self.nodes[-1]['internalNote'] = json.dumps({'sourceBomOccurrence':99, 'sourcePdfSha256':'other'})
        self.assert_atomic_failure()


if __name__ == '__main__':
    unittest.main()
