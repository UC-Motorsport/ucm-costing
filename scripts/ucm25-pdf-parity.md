# UCM25 historical PDF parity tooling

The 2025 source-of-truth PDF is immutable historical input.  The extractor
records the report's expected BOM pointers separately from the identifiers
actually found on those pages because the original contains blank and
mismatched pointer targets.  Do not reinterpret those defects as 2026 rules.

Install the optional Python requirements in `scripts/README.md`, then run:

```sh
python3 \
  scripts/ucm25_reference_extract.py
```

The deterministic JSON model is written to
`tmp/pdfs/ucm25-reference-structure.json`.  The extractor refuses any source
whose SHA-256 differs from the accepted final UCM25 PDF and requires exactly
1,078 pages and 467 BOM occurrences.

Run the unit tests from the scripts directory so the extractor module resolves
without mutating `PYTHONPATH`:

```sh
cd scripts
python3 \
  -m unittest -v test_ucm25_reference_extract.py
```

## Source-backed quantity reconciliation

The source-backed builder now reads assembly membership quantities for the seven
reviewed suspension groups, rather than treating their whole-car BOM quantities
as quantities per assembly. It also places the three planet gear assemblies
under the two gearboxes (as a subassembly), giving six on the vehicle. These are
28 scoped record corrections; shared components and original cost-line subtotals
are deliberately outside this correction set.

Each correction retains its source CSV path, SHA-256 and row, as well as the
original BOM quantity, parent occurrence and node kind. The reconciliation JSON
lists all changes. Missing, ambiguous, changed or unexpected source inputs stop
the build before the correction set is applied. Repeating reconciliation does
not divide quantities again.

Historical report planning restores the submitted display tree in memory, so
corrected calculation quantities do not replace the original BOM or assembly
page values. Ordinary reports and copies use the corrected tree. The generic
cost calculator and database schema have not changed.

Build future archives into a **new** output directory with `--output-dir`; do not
overwrite the accepted original archive. Building an archive is local work, not
approval to import it into production. Existing 2025 records remain unchanged
until the separately reviewed data correction is approved. The partial corrected
source roll-up is 46,354.838, not a final reconciled cost: loom, shared-part and
process arithmetic questions remain open.

Run regression tests from the repository root:

    python3 -m unittest discover -s scripts -p 'test_ucm25*.py' -v
    npm run test -w @ucm/server -- test/report/ucm25-plan.test.ts
    npm run typecheck -w @ucm/server
