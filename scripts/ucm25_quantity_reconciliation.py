"""Source-supported UCM25 corrections; never infer semantics for shared parts."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from ucm25_archive_build import ACCEPTED_SOURCE_SHA256

# Reviewed on 2026-09-25. Source tables (not these IDs) supply quantities.
# Other membership references can represent shared vehicle-level stock.
SUSPENSION_GROUPS = {
    "010100": ("010101", "010102", "010103"),
    "010200": ("010201", "010202", "010203", "010204"),
    "010300": ("010301", "010302", "010303", "010304"),
    "010400": ("010401", "010402", "010403", "010404", "010405", "010406"),
    "010700": ("010701",),
    "010800": ("010801",),
    "020000": tuple(f"02000{i}" for i in range(1, 9)),
}


def positive(value: str) -> Decimal:
    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError):
        raise ValueError(f"invalid source quantity: {value!r}") from None
    if not result.is_finite() or result <= 0:
        raise ValueError(f"invalid source quantity: {value!r}")
    return result


def membership_rows(source: Any, source_root: Path) -> dict[str, list[tuple[int, str]]]:
    """Retain CSV row numbers; duplicate references remain visible to validation."""
    raw = source.path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != source.sha256:
        raise ValueError(f"assembly source changed after selection: {source.path}")
    source.path.relative_to(source_root)
    rows = csv.reader(io.StringIO(raw.decode("utf-8-sig")))
    columns: dict[str, int] | None = None
    found: dict[str, list[tuple[int, str]]] = {}
    for row_number, row in enumerate(rows, 1):
        row = [value.strip() for value in row]
        if "Part/Sub Assembly Number" in row:
            columns = {value: i for i, value in enumerate(row)}
            if "Quantity" not in columns:
                raise ValueError("assembly membership table has no Quantity column")
            continue
        if columns is None:
            continue
        if not row or not row[0] or row[0] == "Item Order":
            columns = None
            continue
        ref_index, qty_index = columns["Part/Sub Assembly Number"], columns["Quantity"]
        if max(ref_index, qty_index) >= len(row):
            raise ValueError(f"incomplete assembly membership row {row_number}")
        # Legacy membership numbers sometimes omit a leading zero. No handedness
        # or revision guessing: the reviewed targets have plain numeric numbers.
        if re.fullmatch(r"\d{1,6}", row[ref_index]):
            number = row[ref_index].zfill(6)
            found.setdefault(number, []).append((row_number, row[qty_index]))
    return found


def reconcile_source_quantities(
    nodes: list[dict[str, Any]], selected: dict[int, Any], source_root: Path,
) -> list[dict[str, Any]]:
    """Validate the entire reviewed change set before mutating any node.

    Preserve original quantities/parents for historical rendering and provenance.
    Repeated calls produce the same changes and leave nodes byte-identical.
    Missing or ambiguous evidence is an error, not an inferred default.
    """
    by_id = {n["sourceId"]: n for n in nodes}
    if len(by_id) != len(nodes):
        raise ValueError("duplicate source node ID")
    notes = {key: json.loads(n.get("internalNote") or "{}") for key, n in by_id.items()}

    def node_for(system: str, number: str) -> dict[str, Any]:
        matches = [n for n in nodes if re.fullmatch(
            rf"E13-25-{system}-{number}-[A-Z]", n.get("referenceId") or ""
        )]
        if len(matches) != 1:
            raise ValueError(f"expected one reviewed node for {system}-{number}, got {len(matches)}")
        n = matches[0]
        if notes[n["sourceId"]].get("sourcePdfSha256") != ACCEPTED_SOURCE_SHA256:
            raise ValueError("quantity reconciliation requires the accepted UCM25 source")
        return n

    planned: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    groups = [("SU", parent, children) for parent, children in SUSPENSION_GROUPS.items()]
    groups.append(("DR", "160000", ("160100",)))
    for system, number, child_numbers in groups:
        parent = node_for(system, number)
        if parent["kind"] != "assembly" or positive(parent["quantity"]) != 2:
            raise ValueError(f"unexpected reviewed assembly count: {parent['referenceId']}")
        parent_note = notes[parent["sourceId"]]
        source = selected.get(parent_note.get("sourceBomOccurrence"))
        if source is None or source.identifier != parent["referenceId"]:
            raise ValueError(f"missing exact assembly source: {parent['referenceId']}")
        if positive(source.header.get("Quantity", "")) != 2:
            raise ValueError(f"source assembly count differs: {parent['referenceId']}")
        members = membership_rows(source, source_root)
        for child_number in child_numbers:
            child = node_for(system, child_number)
            entries = members.get(child_number, [])
            if len(entries) != 1:
                raise ValueError(f"expected one membership row for {child['referenceId']}")
            row_number, display_quantity = entries[0]
            quantity = positive(display_quantity)
            note = dict(notes[child["sourceId"]])
            previous = note.get("sourceQuantityCorrection")
            old_quantity = positive(note.get("historicalBomQuantity", child["quantity"]))
            old_parent = by_id.get(child["sourceParentId"])
            if old_parent is None:
                raise ValueError("reviewed node has no parent")
            old_parent_occurrence = note.get(
                "historicalParentOccurrence", notes[old_parent["sourceId"]].get("sourceBomOccurrence")
            )
            if system == "SU":
                if child["kind"] != "part" or old_parent is not parent or old_quantity != quantity * 2:
                    raise ValueError(f"unexpected suspension quantity or parent: {child['referenceId']}")
            elif (child["kind"] != ("subassembly" if previous else "assembly") or quantity != 3 or old_quantity != 3
                  or (previous is None and old_parent["kind"] != "system")
                  or old_parent_occurrence is not None):
                raise ValueError("unexpected planet gear quantity or parent")
            change = {
                "kind": "source-assembly-quantity-correction" if system == "SU" else "source-assembly-parent-correction",
                "identifier": child["referenceId"],
                "occurrence": note["sourceBomOccurrence"],
                "previousKind": note.get("historicalNodeKind", child["kind"]),
                "nodeKind": "part" if system == "SU" else "subassembly",
                "previousQuantity": str(old_quantity),
                "quantity": str(quantity),
                "previousParentOccurrence": old_parent_occurrence,
                "parentOccurrence": parent_note["sourceBomOccurrence"],
                "sourceCsvPath": source.path.relative_to(source_root).as_posix(),
                "sourceCsvSha256": source.sha256,
                "sourceCsvRow": row_number,
            }
            if previous is not None:
                if (previous != change or positive(child["quantity"]) != quantity
                        or child["sourceParentId"] != parent["sourceId"]):
                    raise ValueError("existing quantity correction disagrees with source")
            elif positive(child["quantity"]) != old_quantity:
                raise ValueError("unrecorded quantity change")
            note.update(historicalNodeKind=change["previousKind"],
                        historicalBomQuantity=str(old_quantity),
                        historicalParentOccurrence=old_parent_occurrence,
                        sourceQuantityCorrection=change)
            planned.append((child, parent, note))

    changes = []
    for child, parent, note in planned:
        child["kind"] = note["sourceQuantityCorrection"]["nodeKind"]
        child["quantity"] = note["sourceQuantityCorrection"]["quantity"]
        child["sourceParentId"] = parent["sourceId"]
        child["internalNote"] = json.dumps(note, sort_keys=True, separators=(",", ":"))
        changes.append(note["sourceQuantityCorrection"])
    return changes
