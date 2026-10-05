# Formula SAE-A costing source ledger

PDFs and workbooks are external inputs, excluded from the source distribution.
Run `npm run references:fetch` on Node 24 to download and checksum-verify the
three required runtime files; `npm run references:check` verifies local copies.
Downloads come directly from the original URLs below. If a pinned version is
unavailable, obtain that exact version from its owner and place it at the listed
path. A newer version requires an explicit rule/catalogue migration.

The remaining listed documents are optional research context. Fetching a file
does not grant redistribution rights; see `THIRD_PARTY_NOTICES.md`.


Retrieved and checked on 29 July 2026 unless noted otherwise. The live 2026
documents index was rechecked on 1 September 2026 and now lists Local Addendum
v1.4, released 24 August 2026. The Cost Amendment Report still has no
downloadable 2026 template and points teams to the 2025 page, while the 2026
Cost Scenario remains a future October release. SHA-256 values
identify the exact local bytes; a changed upstream file must be imported as a
new source, never overwrite an existing release.

## Authority order

1. **Governing for 2026 costing:** Formula SAE-A 2026 Local Addendum v1.4,
   Appendix PDA-2. Its page 26 explicitly replaces the complete Formula SAE
   base-rule section S.3 for the Australasian event.
2. **Governing cost inputs:** Formula SAE-A Cost Catalogue 2026 v1.0,
   catalogue revision `26_R1`.
3. **Official context:** the 2026 base rules, event handbook, and cost-report
   templates. They apply only where they do not conflict with the local
   addendum; the templates are layout aids, not permission to ignore PDA-2.
4. **Supporting only:** SAE International module guidance and sample reports.
   These help explain mechanics and layouts but cannot override the
   Australasian rules. In particular, other competitions' amendment factors
   and scoring tables are not 2026 FSAE-A rules.
5. **Team history:** the SharePoint workbook and UCM25 report are preserved
   evidence, not rule authorities.

The official live index is the [SME-A 2026 Documents and
Templates](https://www.sme-a.org/rules-documents-templates) page. It says teams
must keep checking for updates. At retrieval time the 2026 Cost Amendment
Report template and Cost Scenario were future placeholders, so neither has
been represented as an available rule input.

## Governing and current official sources

| Local file | Title/version and owner | Original URL | SHA-256 | Applicability |
|---|---|---|---|---|
| `docs/references/official/FSAE-A_2026_Local_Addendum_v1.4.pdf` | Formula SAE-A 2026 Local Rules Addendum v1.4, released 24 August 2026; SME-A / FSAE-A Rules Committee | [Official PDF](https://www.sme-a.org/client_images/5832409.pdf) | `1cfd33c17bcf8c7621283b3592633f816c29b0fa60bfc8eab9c1b5eaa9fc6688` | Current normative source. Appendix PDA-2 is the complete 2026 Cost and Manufacturing rule set. Retrieved 1 September 2026. |
| `docs/Local Addendum 2026 Version 1.2 (1).pdf` | Formula SAE-A 2026 Local Rules Addendum v1.2, released 14 June 2026; SME-A / FSAE-A Rules Committee | [Official PDF](https://www.sme-a.org/client_images/5276665.pdf) | `4eee1b95f3c9b11d4a4b93bdcdedfd3273d9ae55278d1bd35afa238102c1b8d9` | Immutable historical governing source retained for projects and snapshots pinned before the v1.4 update. |
| `docs/references/official/FSAE-A_Cost_Catalogue_2026_v1.0.xlsx` | Cost Catalogue 2026 v1.0, revision `26_R1`; SME-A / FSAE-A Cost Committee | [Official XLSX](https://www.sme-a.org/client_images/5102753.xlsx) | `392e6a0b4729df6fe43e57af9846859758195f5a80ba926c1a3756824892e070` | Normative catalogue values, formulas, multipliers, tooling, and stock sizes. |
| `docs/references/official/FSAE_Rules_2026_V1.pdf` | Formula SAE Rules 2026 v1; SAE International | [Official PDF](https://www.sme-a.org/client_images/4627125.pdf) | `4620c33700f16bdc514a1e959b8746caef0a8878646c9b79b2ed01e8f790f7d8` | Official base rules outside the locally replaced S.3 section. Not a costing override. |
| `docs/references/official/FSAE-A_2026_Event_Handbook_v2.1.pdf` | FSAE-A 2026 Event Handbook draft v2.1, released 18 May 2026; SME-A | [Official PDF](https://www.sme-a.org/client_images/5088253.pdf) | `9e13471db9a2ceed8cd1ef5c4dd05259735cba43e50c4ffa61395d1ac755cd45` | Official event administration and timetable context; draft status is retained. |
| `docs/references/official/FSAE-A_Cost_Report_EBOM_Template.xlsx` | Cost Report eBOM Template; SME-A | [Official XLSX](https://www.sme-a.org/client_images/2792367.xlsx) | `6a5e47efba3da137e952e4961ed8601496120304321343462804860a988f3dd2` | Official layout example. Its revision history and some system labels predate the 2026 addendum, so it is not the schema authority. |
| `docs/references/official/FSAE-A_Cost_Report_Data_Table_Template.xlsx` | Cost Report Data Table Template; SME-A | [Official XLSX](https://www.sme-a.org/client_images/2792370.xlsx) | `d9887d085a610ec3b12462cf6934143b93878e225f85eb85c0f7845a82c2b240` | Official part/assembly table layout example, subordinate to PDA-2 and catalogue `26_R1`. |

## Supporting examples

All four files below were obtained through SAE International's [Formula SAE
Series Resources](https://www.fsaeonline.com/cdsweb/gen/DocumentResources.aspx)
library.

| Local file | Title/version and owner | SHA-256 | Permitted use |
|---|---|---|---|
| `docs/references/supporting/FSAE_Cost_Module_Guide_V4_2022.pdf` | Formula SAE Cost Module Guide v4 (2022); SAE International | `ffcb8cd54d4493a9d0a3d79c83e8c88c13ca6aceb603aaef945ffb013b31526f` | Background on module-era costing mechanics only. |
| `docs/references/supporting/FSAE_Cost_Supplement_V4.pdf` | Formula SAE Cost Supplement v4; SAE International | `0d72499f90f0b9d2966a514a9070fca3389bd5b8d95c0bf00fac03347be13896` | Terminology and calculation examples only. |
| `docs/references/supporting/Sample_FSAE_Cost_Report_EV_UV23e_No_Drawings.pdf` | Sample Formula SAE EV Cost Report, UV23e, drawings omitted; SAE International | `87377fd026648f449741e69ce5b57320f45b522059eb7cbaabd5400d082bb180` | Non-normative EV report/table example. Its missing drawings are not acceptable evidence of 2026 FSAE-A completeness. |
| `docs/references/supporting/Sample_FSAE_Cost_Report_IC_UV23_No_Drawings.pdf` | Sample Formula SAE IC Cost Report, UV23, drawings omitted; SAE International | `6d34eb971869ca320bf16d2a9b60a57f7e718c461537422d012fce03ca57d84e` | Non-normative IC report/table example. |

## Team and historical sources

Private team reports, tracker exports and SharePoint copies are not distributed
or required for normal development. Import tests use invented records under
`apps/server/test/fixtures/`.

## Integrity check

```sh
npm run references:check
```

When an upstream document changes, record its retrieval date, checksum,
release/revision and applicability. Do not edit an existing catalogue release
or generated report snapshot in place.
