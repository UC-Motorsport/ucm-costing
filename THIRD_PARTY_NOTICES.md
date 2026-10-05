# Source, data and branding

A software license does not grant rights to third-party documents, team data,
logos, trademarks or dependency code under separate licenses.

## Official competition documents

The Formula SAE-A / SME-A rule addenda and cost catalogue remain their owners'
materials. This source distribution does not include PDF or XLSX copies.
`npm run references:fetch` obtains the three pinned runtime inputs directly
from the official URLs; their provenance and SHA-256 hashes are recorded in
`docs/references/SOURCES.md`. Users must follow the owners' applicable terms.
Public availability is not treated as permission to redistribute the files.

Docker images built after fetching references contain those documents.
Review redistribution permission before publishing images or binary bundles.
The application can also export source-derived costs and reports; review the
applicable source terms before distributing those outputs.

## Team records and marks

Historical UCM reports, team CSV exports, the SharePoint workbook, internal
screenshots, design references and extracted logos are excluded. Report
rendering works without logo files. Operators with permission may install
optional marks as described in `apps/server/assets/README.md`. The project
name and team references describe its origin; they do not grant trademark
rights or imply endorsement by competition organizers.

## Dependencies and fonts

npm dependencies retain their own licenses and notices. Preserve those notices
when redistributing dependencies or bundled builds. The application uses
Geist and Carlito fonts from their `@fontsource` packages; retain the packages'
font license files when redistributing fonts. Lucide icons and shadcn-derived
UI components also retain their upstream license requirements. The shadcn 4.16.0
stylesheet is retained unchanged under `apps/web/src/styles/shadcn.css` so the
application does not require the development CLI dependency tree. Its MIT
license, also applicable to shadcn-derived components, is in
[`LICENSES/shadcn.txt`](LICENSES/shadcn.txt).

## Project license

The project source is licensed under the [MIT license](LICENSE). Existing
third-party notices and licenses remain applicable. This license does not
cover separately obtained competition documents, team records or brand assets.
