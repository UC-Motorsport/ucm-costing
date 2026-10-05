import { strToU8, zipSync, type Zippable } from "fflate";

// ZIP stores local calendar fields. Construct the minimum DOS timestamp in
// local time so western time zones do not reinterpret midnight UTC as 1979.
const XLSX_EPOCH = new Date(1980, 0, 1, 0, 0, 0, 0);
const MAX_CELL_CHARACTERS = 32_767;
const MAX_WORKSHEET_ROWS = 200_000;
const MAX_WORKBOOK_CELLS = 1_000_000;
const MAX_UNCOMPRESSED_XML_BYTES = 64 * 1024 * 1024;

export interface WorkbookCell {
  value: string;
  kind?: "text" | "number";
  style?: number;
}

export interface WorkbookSheet {
  name: string;
  rows: readonly (readonly WorkbookCell[])[];
  headerRows?: number;
  autoFilter?: boolean;
  columnWidths?: readonly number[];
}

export interface WorkbookProperties {
  title: string;
  subject: string;
  creator: string;
  createdAt: string;
}

/**
 * Writes the small, controlled subset of SpreadsheetML needed by the
 * supporting data export. It never emits formulas, macros, external links, or
 * shared-string indirection.
 */
export function createFormulaFreeWorkbook(
  sheets: readonly WorkbookSheet[],
  properties: WorkbookProperties,
): Uint8Array {
  if (sheets.length === 0 || sheets.length > 32) {
    throw new Error("workbook must contain between 1 and 32 worksheets");
  }
  const names = new Set<string>();
  let cellCount = 0;
  let xmlBytes = 0;

  for (const sheet of sheets) {
    assertSheetName(sheet.name);
    const normalized = sheet.name.toLocaleLowerCase("en");
    if (names.has(normalized)) {
      throw new Error(`duplicate worksheet name: ${sheet.name}`);
    }
    names.add(normalized);
    if (sheet.rows.length > MAX_WORKSHEET_ROWS) {
      throw new Error(`${sheet.name} exceeds the worksheet row limit`);
    }
    cellCount += sheet.rows.reduce((sum, row) => sum + row.length, 0);
  }
  if (cellCount > MAX_WORKBOOK_CELLS) {
    throw new Error("workbook exceeds the cell limit");
  }

  const entries: Zippable = {};
  const addXml = (archivePath: string, xml: string): void => {
    const bytes = strToU8(xml);
    xmlBytes += bytes.byteLength;
    if (xmlBytes > MAX_UNCOMPRESSED_XML_BYTES) {
      throw new Error("workbook exceeds the uncompressed XML size limit");
    }
    entries[archivePath] = [
      bytes,
      { level: 6, mtime: XLSX_EPOCH },
    ];
  };

  addXml("[Content_Types].xml", contentTypesXml(sheets.length));
  addXml("_rels/.rels", packageRelationshipsXml());
  addXml("docProps/app.xml", appPropertiesXml(sheets));
  addXml("docProps/core.xml", corePropertiesXml(properties));
  addXml("xl/workbook.xml", workbookXml(sheets));
  addXml("xl/_rels/workbook.xml.rels", workbookRelationshipsXml(sheets.length));
  addXml("xl/styles.xml", stylesXml());
  sheets.forEach((sheet, index) => {
    addXml(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet));
  });

  return zipSync(entries, { level: 6, mtime: XLSX_EPOCH });
}

export function textCell(value: unknown, style = 0): WorkbookCell {
  const text = String(value ?? "");
  const sanitized = validXmlText(text);
  if ([...sanitized].length > MAX_CELL_CHARACTERS) {
    throw new Error("workbook cell exceeds Excel's 32,767-character limit");
  }
  return { value: sanitized, kind: "text", style };
}

export function numericCell(value: string, style = 3): WorkbookCell {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    throw new Error(`invalid numeric workbook cell: ${value}`);
  }
  return { value, kind: "number", style };
}

function worksheetXml(sheet: WorkbookSheet): string {
  const rowCount = Math.max(1, sheet.rows.length);
  const columnCount = Math.max(
    1,
    ...sheet.rows.map((row) => row.length),
  );
  const dimension = `A1:${columnName(columnCount)}${rowCount}`;
  const headerRows = Math.max(0, sheet.headerRows ?? 1);
  const frozenPane =
    headerRows > 0
      ? `<pane ySplit="${headerRows}" topLeftCell="A${headerRows + 1}" activePane="bottomLeft" state="frozen"/>`
      : "";
  const columns =
    sheet.columnWidths && sheet.columnWidths.length > 0
      ? `<cols>${sheet.columnWidths
          .map(
            (width, index) =>
              `<col min="${index + 1}" max="${index + 1}" width="${boundedWidth(width)}" customWidth="1"/>`,
          )
          .join("")}</cols>`
      : "";
  const rows = sheet.rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map((cell, columnIndex) =>
            cellXml(cell, columnIndex + 1, rowIndex + 1),
          )
          .join("")}</row>`,
    )
    .join("");
  const autoFilter =
    sheet.autoFilter && sheet.rows.length > 0
      ? `<autoFilter ref="A1:${columnName(columnCount)}${rowCount}"/>`
      : "";
  return xmlDocument(
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<dimension ref="${dimension}"/>` +
      `<sheetViews><sheetView workbookViewId="0">${frozenPane}</sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>${columns}` +
      `<sheetData>${rows}</sheetData>${autoFilter}` +
      `<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>` +
      `</worksheet>`,
  );
}

function cellXml(
  cell: WorkbookCell,
  column: number,
  row: number,
): string {
  const reference = `${columnName(column)}${row}`;
  const style = Number.isSafeInteger(cell.style) ? cell.style : 0;
  if (cell.kind === "number") {
    return `<c r="${reference}" s="${style}"><v>${escapeXml(cell.value)}</v></c>`;
  }
  const preserve = /^\s|\s$|\n/.test(cell.value)
    ? ` xml:space="preserve"`
    : "";
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t${preserve}>${escapeXml(cell.value)}</t></is></c>`;
}

function contentTypesXml(sheetCount: number): string {
  const worksheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");
  return xmlDocument(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      worksheets +
      `</Types>`,
  );
}

function packageRelationshipsXml(): string {
  return xmlDocument(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`,
  );
}

function workbookRelationshipsXml(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join("");
  return xmlDocument(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets +
      `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  );
}

function workbookXml(sheets: readonly WorkbookSheet[]): string {
  const definitions = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  return xmlDocument(
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<workbookPr date1904="0"/>` +
      `<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>` +
      `<sheets>${definitions}</sheets>` +
      `<calcPr calcId="0" calcMode="manual" fullCalcOnLoad="0" forceFullCalc="0"/>` +
      `</workbook>`,
  );
}

function stylesXml(): string {
  return xmlDocument(
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<numFmts count="1"><numFmt numFmtId="164" formatCode="0.########################"/></numFmts>` +
      `<fonts count="2">` +
      `<font><sz val="10"/><name val="Carlito"/><family val="2"/></font>` +
      `<font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Carlito"/><family val="2"/></font>` +
      `</fonts>` +
      `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF153A5B"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="2"><border/><border><left style="thin"><color rgb="FFD5DCE3"/></left><right style="thin"><color rgb="FFD5DCE3"/></right><top style="thin"><color rgb="FFD5DCE3"/></top><bottom style="thin"><color rgb="FFD5DCE3"/></bottom><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="4">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
      `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
      `<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>` +
      `</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`,
  );
}

function corePropertiesXml(properties: WorkbookProperties): string {
  const createdAt = new Date(properties.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error("workbook createdAt must be an ISO date");
  }
  const timestamp = createdAt.toISOString();
  return xmlDocument(
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${escapeXml(validXmlText(properties.title))}</dc:title>` +
      `<dc:subject>${escapeXml(validXmlText(properties.subject))}</dc:subject>` +
      `<dc:creator>${escapeXml(validXmlText(properties.creator))}</dc:creator>` +
      `<cp:lastModifiedBy>${escapeXml(validXmlText(properties.creator))}</cp:lastModifiedBy>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>` +
      `</cp:coreProperties>`,
  );
}

function appPropertiesXml(sheets: readonly WorkbookSheet[]): string {
  return xmlDocument(
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      `<Application>UCM Costing</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>` +
      `<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>` +
      `<TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets.map(({ name }) => `<vt:lpstr>${escapeXml(name)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts>` +
      `<Company>University of Canterbury Motorsport</Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion>` +
      `</Properties>`,
  );
}

function assertSheetName(name: string): void {
  if (
    name.length === 0 ||
    name.length > 31 ||
    /[\\/?*:[\]]/.test(name) ||
    name.startsWith("'") ||
    name.endsWith("'")
  ) {
    throw new Error(`invalid worksheet name: ${name}`);
  }
}

function boundedWidth(width: number): string {
  if (!Number.isFinite(width) || width <= 0 || width > 255) {
    throw new Error(`invalid worksheet column width: ${width}`);
  }
  return String(width);
}

function columnName(column: number): string {
  if (!Number.isSafeInteger(column) || column < 1 || column > 16_384) {
    throw new Error(`invalid worksheet column: ${column}`);
  }
  let current = column;
  let name = "";
  while (current > 0) {
    current -= 1;
    name = String.fromCharCode(65 + (current % 26)) + name;
    current = Math.floor(current / 26);
  }
  return name;
}

function validXmlText(value: string): string {
  return value.replace(
    /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,
    "\uFFFD",
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}
