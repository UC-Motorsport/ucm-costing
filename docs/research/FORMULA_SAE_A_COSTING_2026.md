# Formula SAE-Australasia costing guide for UCM 2026

This is an implementation-facing interpretation of the archived 2026 sources,
not a substitute for the released rule documents or a Cost Committee response.
Rule references below point to the Formula SAE-A 2026 Local Addendum v1.4,
Appendix PDA-2 unless stated otherwise.

## Governing rule boundary

Printed page 26 of the Local Addendum says the complete Formula SAE base-rule
section S.3 is replaced for Formula SAE-A by Appendix PDA-2. Therefore:

- PDA-2 is the primary authority for the Cost and Manufacturing Event.
- The official 2026 cost catalogue `26_R1` is the authority for standardised
  competition costs.
- Base Formula SAE, Formula Student Germany, and SAE International module
  examples may explain concepts, but their scoring tables, amendment factors,
  deadlines, or report mechanics must not be imported as FSAE-A rules.
- Costs are competition-normalised universal dollars. They are neither AUD nor
  NZD and are not UCM's season budget or supplier spend.

See `docs/references/SOURCES.md` for exact local files, original URLs, hashes,
and authority classifications.

## What the event is assessing

S.3.1 evaluates manufacturing-engineering knowledge, project management around
cost, and the trade-offs between manufacturing cost, business profitability,
and vehicle performance. A low number alone is not the whole event: judges
also test whether the report represents the car, whether the proposed
manufacturing is feasible, and whether the documentation is complete enough
to support production.

The cost event has three scored pieces under S.3.16:

- Cost Report: 80 points.
- Real-time costing challenge: 5 points.
- Cost Scenario: 15 points.

The report score is relative to the penalised costs of that year's field:

`80 × (Pmax - Pyour) / (Pmax - Pmin)`

`Pmax` and `Pmin` are not known until judging. `Pyour` is based on reported cost
after amendments/targeted adjustments and is then multiplied by documentation
and accuracy factors:

`Pyour = Preported × D1 × D2 × D3 × D4 × A`

The current numeric mappings for `D1` through `D4` and `A` are not published in
the archived rule pack. The software must not estimate them or present a
historical table as official 2026 scoring.

## Required costing workflow

### 1. Freeze the source versions

Before entering costs, record:

- Local Addendum version and SHA-256.
- Catalogue revision and SHA-256.
- Report season and vehicle class.

Use a new immutable release if a source changes. Never rewrite past cost lines
or reports to use a later catalogue silently. The official page warns teams to
keep checking for updates, and S.3.2.2 says the latest catalogue must be used.
The catalogue will not be changed for requests during the two calendar weeks
before the report deadline.

### 2. Build the complete hierarchy

S.3.5 defines:

`Vehicle → System → Assembly → Part and/or Subassembly`

Subassemblies may contain parts and deeper subassemblies. Parts contain
materials and/or fasteners plus processes; production tooling is associated
with the process that needs it.

The full vehicle BOM belongs at the beginning of the PDF. A system with more
than two hierarchy levels needs an assembly tree at that system's start.
Part numbers must match across the BOM, part/assembly tables, drawings, and
supporting evidence.

The rules require a standardised part identifier with a 6–12 character
reference portion that uniquely identifies the part. The illustrated FSAE-A or
FSAE-I pattern is strongly recommended, but the precise UCM season/revision/
variant grammar still needs team confirmation. Store both source segments and
the final identifier; never invent missing legacy digits.

Current UCM system codes are:

| Code | System |
|---|---|
| BR | Brakes |
| DR | Engine/Tractive Path and Drivetrain |
| CH | Chassis |
| AD | Aerodynamics |
| EL | Electrical |
| MS | Miscellaneous, Fit, and Finish |
| ST | Steering |
| SU | Suspension |
| WT | Wheels and Tyres |
| AV | Autonomous Vehicle and Control, when applicable |

The older eBOM template's `FR` label is not a reason to replace current `CH`.

### 3. Cost every part from the current catalogue

S.3.4.1 and S.3.8 require every vehicle part to use the standardised catalogue
of Materials, Processes, Fasteners, Tooling, and Multipliers.

For each line, retain:

- catalogue release, item kind, catalogue ID, source sheet, and source row;
- the published fixed cost or raw formula;
- every user-supplied formula dimension;
- quantity and use on the part;
- the selected multiplier row, its published name, and its value;
- the exact server-calculated subtotal.

The `Process Multipliers` sheet name is broader than the labels it contains.
Rows cover assembly/disassembly, fastener engagement, hole machining,
material types, and repeat counts. A factor must therefore be selected by its
exact named row for each applicable non-tooling line; it must not be a typed
number. Choose row `#1 None ×1` only after deciding that no published factor
applies.

The authoritative line equations used by the MVP are:

- Material/process/fastener:
  `unit catalogue cost × quantity × selected catalogue multiplier`.
- Tooling:
  `tooling catalogue cost × fraction included ÷ Production Volume Factor`.

The tooling share equation matches the supplied UCM table convention. For
example, `16500 × 0.125 ÷ 3000 = 0.6875`, displayed as `U$ 0.69`. If the 2026
Cost Committee publishes a different tooling data-table definition, that
published definition must replace this convention through a new versioned
calculation path.

Use exact decimal arithmetic until the display/report boundary. Do not add
already-rounded child display values, and do not trust a subtotal submitted by
the browser.

### 4. Use actual prototype manufacturing, with evidenced bulk deviations

S.3.4.1 requires the processes actually used for the prototype. A
bulk-production alternative is permitted only when supplementary evidence
supports equivalence. Record the actual method, proposed bulk method, the
reason it is equivalent, and a drawing/photo/process reference. Do not silently
substitute an economical mass-production process because it seems plausible.

Required production tooling includes welding jigs, moulds, patterns, and dies.
Research and development and capital expenditure are excluded, including
plant, machinery, hand tools, and power tools.

### 5. Apply stock-size and missing-item rules explicitly

S.3.8.3 applies catalogue stock sizes to purchased raw material. If a
standardised stock size exists, use it. Non-standard stock is treated as a
custom extrusion or otherwise formed. An additional stock size requires an
approved Cost Add Item Request.

Any unlisted part, process, or material requires a CAIR through the official
form (S.3.10). An unlinked typed value is not competition-ready evidence.
Preserve the approved request and resulting catalogue release; do not make a
private team-only catalogue correction.

The 26_R1 workbook has five source anomalies that must remain visible:

- Fastener ID 76 contains a malformed expression with an unmatched
  parenthesis.
- Tooling IDs 15, 16, 17, and 19 contain literal `m^2` text where a calculable
  expression would otherwise be expected.

The application rejects these rows as unavailable. It does not repair them by
guessing what the Cost Committee meant.

### 6. Classify made versus bought

S.3.9 allows parts to be Made or Bought but also says some catalogue items must
be costed as made regardless of the prototype procurement. A team that owns the
IP and genuinely makes an item normally listed as bought may cost it as made,
with proof of team manufacture.

Costing a bought part as made without the required basis is penalised by adding
125% of the catalogue bought price to reported cost. Keep classification and
supporting evidence with the part instead of inferring it from a supplier name.

### 7. Reconcile the hierarchy continuously

Each part has four BoX buckets:

- Material
- Process
- Fastener
- Tooling

Part cost is the sum of those buckets. Assembly, system, and vehicle totals are
derived from the same part data and on-vehicle quantities. Cover summary, full
BOM, system pages, part tables, and immutable snapshot must agree from this one
calculation graph.

The supplied UCM25 report demonstrates the risk: its system summary shows
`35,608.60`, while its full BOM shows `35,614.70`, a difference of `6.10`.
The new system treats any such mismatch as a generation defect, not rounding.

## Required report contents

S.3.4 requires a single PDF containing all relevant documentation. The PDF
must include:

- project cost-management summary;
- full vehicle BOM at the beginning;
- a leading cost breakdown for every system;
- required assembly trees;
- every part and assembly data table;
- drawings and supporting documentation near the tables they support;
- only critical-component datasheets, collected in an appendix at the end.

The project summary must cover performance-versus-manufacturing-cost decisions,
bulk-production methods and where they are used, and the part-numbering
convention.

For an EV, the minimum critical datasheets are:

- accumulator cells;
- battery-management system;
- tractive motor(s);
- motor controller(s);
- main vehicle control module / ECU;
- low-voltage battery pack or cells.

Sensors and additional modules may also need datasheets if their features
affect cost. For an IC vehicle the minimum is the engine, ECU, and injectors.

Supporting Excel documentation is submitted separately and may be multiple
files. PDA-2 recommends individual spreadsheets, a linked macro workbook, or a
database with a searchable display page. The rule's PDF upload limit is under
9.0 GB; a larger report needs an alternative arrangement before the deadline.

The report application therefore distinguishes:

- **internal evidence**, retained for team work but excluded from exports; and
- **report-visible evidence**, whose PDF pages or images are physically
  appended to the generated report and listed by hash.

## Drawings and judging scope

The entire vehicle still needs a complete report. Detailed on-site accuracy
judging reviews one of four system groupings under S.3.17 and at least 100 parts
and their assemblies. High-value items may be audited outside that grouping.

For documentation factors D3/D4 in 2026, S.3.12.2 nominates `DR` as the fully
prepared drawing system. Every other system still needs enough visual
information for judges to identify the part and verify its proposed
manufacturing. Basic drawings or high-quality dimensioned images/renders are
recommended; “not the focus system” does not mean “no visuals”.

## Deadlines, incompleteness, and amendments

The schedule in PDA-1 lists the Cost Report and support-material deadline as
2 October 2026, electronic, for EV and IC. PDA-1 says submissions are due by
5:00 pm Melbourne local time on the defined date and warns teams to account for
time-zone/seasonal-clock differences. The schedule also says dates may be
revised in later addendum issues, so verify the version and submission form
against live team communication.

S.3.6 applies `-5` points for each business day late, for up to 10 business
days, and then gives zero Cost Report points. Table PS-2 instead summarises
`X = 14 calendar days`. Those windows are not safely equivalent. This requires
a written Cost Committee clarification; the software should not calculate an
official late penalty from an assumed conversion.

A submission is treated as not submitted when a whole section of part and
assembly tables is missing, or more than 20% of those tables are missing
(subject to the stated autonomous exception). Competition-ready generation
must therefore block major completeness failures.

S.3.7 permits one Cost Amendment Report. It says the PDF may be submitted
electronically after the original report but no later than 11:59 pm on the
Saturday immediately before competition. PDA-1's schedule labels the final
deadline “On Site”. Confirm the route; do not infer that a local file is a
submission.

Amendment deltas are applied to each BoX total:

- added item: `+1.05 × catalogue cost`;
- removed item: `-0.95 × catalogue cost`.

The cover must summarise part identity, original BOM quantity/bucket prices/
total, and revised values. Generic Formula SAE 125%/75% amendment factors are
not applicable here. The current MVP does not yet create amendment reports.

## Penalties that must not be guessed

S.3.12 describes:

- targeted material underquote of at least 500 universal dollars;
- targeted process underquote of at least 50 universal dollars;
- adding the difference to `Preported`;
- wording that also calls for a “10 point deduction” in the specific accuracy
  multiplier;
- missing hardware `-0.5`, missing part `-2`, and missing assembly `-5` points
  after the report score calculation.

The “10 point” phrase does not define a numeric transformation of `A`. Record
the audit finding, but do not invent one.

An adjusted IC cost above four times the minimum, or EV/Dual cost above
3.5 times the minimum, receives zero report points. Approximate prior-year
prices printed in the rule are context, not a pre-event official `Pmin`.

## Current production enforcement

| Requirement | Current behavior |
|---|---|
| Pinned rule/catalogue | Immutable source records and report hashes. |
| Required report summaries | Project setup editor plus an explicit versioned confirmation blocker. |
| Exact catalogue calculations | Server resolves fixed/formula costs; safe allow-listed formula parser; no `eval`. |
| Multiplier provenance | Every new non-tooling line must reference an exact `26_R1` multiplier row; typed values are rejected. |
| Complete hierarchy and exact totals | PostgreSQL hierarchy and one Decimal-based roll-up graph with optimistic versions. |
| Legacy spreadsheet import | Administrator/feature-gated preview, retained hashes/raw rows/issues, Windows-1252 fallback, reload recovery, cancellation, and atomic idempotent commit. |
| Made/bought and part identity | Editable part fields; unknown classification and absent numbers are visible validation issues. |
| Evidence | Signature-checked PDF/PNG/JPEG uploads, internal/report visibility, hashes, and actual report-page merging. |
| Draft/ready reports | Drafts retain blockers and watermark; ready reports are blocked by validation. Snapshots/PDFs are immutable. |
| Rule gaps | Visible blockers/notices; no fabricated D/A/Pmin/Pmax or automatic late ruling. |
| Cost amendments | Exact per-BoX `1.05 × additions − 0.95 × removals`, versioned machine-readable snapshots, and a watermarked preview; final lock blocks until the official template/classification guidance exists. |
| CAIR | Actor-attributed request/evidence/receipt workflow; only a matching official catalogue release/item resolves costing authority. |
| Submission | Immutable PDF/XLSX/manifest ZIP preparation plus actor-attributed manual external receipt; no fabricated organizer transmission. |
| Users and audit | Signed-in admin/editor/viewer roles, project membership, stale-write rejection, and a PostgreSQL-enforced append-only hash-chained ledger. |
| Backup | PostgreSQL custom dump plus uploads/reports/artifacts/manifest; verified guarded restore. |

Known rules boundaries remain deliberate: no automatic competition submission,
no official score prediction, and no final Cost Amendment Report while the
promised official 2026 template and classification guidance are absent.
Production browser access requires TLS.

## Decisions still required from UCM or the Cost Committee

1. What do legacy tracker status values `1`, `2`, and their malformed variants
   mean? Until confirmed they stay raw and do not control readiness.
2. What is the exact UCM26 part-number, revision, handedness, and variant
   grammar?
3. In every legacy column, does quantity mean total manufactured, quantity per
   assembly, or quantity on the vehicle? Confirm before bulk import decisions.
4. Which interpretation governs the 10-business-day versus 14-calendar-day
   late window?
5. Is the Cost Amendment Report delivered through the electronic form, on
   site, or both, and what is the released 2026 template?
6. How is the targeted-underquote “10 point” wording applied to `A`, and what
   are the 2026 D1–D4/A mappings?
7. How should the committee treat the five malformed `26_R1` rows and
   stock-size edge cases?

Until those answers are recorded against a dated source, the application must
surface the uncertainty rather than silently choose a rule.
