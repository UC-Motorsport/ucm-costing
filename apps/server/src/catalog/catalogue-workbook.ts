import { TextDecoder } from "node:util";

import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  type UnzipFile,
} from "fflate";
import { XMLParser } from "fast-xml-parser";

export const MAX_CATALOGUE_COMPRESSED_BYTES = 20 * 1024 * 1024;
export const MAX_CATALOGUE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;

const MAX_ARCHIVE_ENTRIES = 2_048;
const MAX_RETAINED_XML_BYTES = 8 * 1024 * 1024;
const ZIP_INPUT_CHUNK_BYTES = 64 * 1024;
const MAX_WORKSHEETS = 64;
const MAX_WORKSHEET_ROWS = 200_000;
const MAX_WORKBOOK_CELLS = 1_000_000;

export const CATALOGUE_SHEET_NAMES = [
  "Home",
  "Materials",
  "Processes",
  "Process Multipliers",
  "Fasteners",
  "Tooling",
  "Stock Sizes",
] as const;

export type CatalogueSheetName = (typeof CATALOGUE_SHEET_NAMES)[number];

export type CatalogueWorkbookErrorCode =
  | "compressed-size-limit"
  | "invalid-zip"
  | "archive-entry-limit"
  | "uncompressed-size-limit"
  | "retained-entry-size-limit"
  | "unsafe-archive-path"
  | "duplicate-archive-entry"
  | "missing-xlsx-part"
  | "invalid-xlsx"
  | "invalid-xml"
  | "invalid-relationship"
  | "invalid-cell-reference"
  | "invalid-shared-string"
  | "workbook-complexity-limit"
  | "unexpected-catalogue-sheets";

export class CatalogueWorkbookError extends Error {
  readonly code: CatalogueWorkbookErrorCode;

  constructor(code: CatalogueWorkbookErrorCode, message: string) {
    super(message);
    this.name = "CatalogueWorkbookError";
    this.code = code;
  }
}

export type ParsedCellValue = string | number | boolean | null;

export interface ParsedCatalogueCell {
  reference: string;
  rowNumber: number;
  columnNumber: number;
  columnName: string;
  cellType: string | null;
  styleIndex: string | null;
  /**
   * Literal content of the OOXML `<v>` element. This remains untouched.
   */
  rawValue: string | null;
  /**
   * Stored/cached workbook value with shared strings decoded. For formula
   * cells this is only Excel's cached value; it is never recalculated here.
   */
  value: ParsedCellValue;
  /**
   * Literal content of the OOXML `<f>` element. An empty string represents a
   * shared-formula follower with an `<f>` element but no formula body.
   */
  rawFormula: string | null;
  formulaAttributes: Record<string, string> | null;
}

export interface ParsedCatalogueRow {
  rowNumber: number;
  cells: ParsedCatalogueCell[];
}

export interface ParsedCatalogueSheet {
  name: string;
  sheetId: string;
  relationshipId: string;
  archivePath: string;
  rows: ParsedCatalogueRow[];
}

export interface ParsedCatalogueWorkbook {
  sheets: ParsedCatalogueSheet[];
  sheetsByName: Record<string, ParsedCatalogueSheet>;
  sharedStrings: string[];
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface CatalogueProfile {
  workbook: ParsedCatalogueWorkbook;
  sheets: Record<CatalogueSheetName, ParsedCatalogueSheet>;
  rowCounts: Record<CatalogueSheetName, number>;
}

interface ExtractedArchive {
  entries: Map<string, Uint8Array>;
  uncompressedBytes: number;
}

interface WorkbookSheetDefinition {
  name: string;
  sheetId: string;
  relationshipId: string;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  targetMode: string | null;
}

type XmlRecord = Record<string, unknown>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // DOCTYPE declarations are rejected before parsing, so decoding the five
  // built-in XML entities and numeric references cannot expand custom entities.
  processEntities: true,
  allowBooleanAttributes: false,
});

function isXmlRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asXmlRecord(value: unknown, context: string): XmlRecord {
  if (!isXmlRecord(value)) {
    throw new CatalogueWorkbookError(
      "invalid-xml",
      `Expected an XML object at ${context}.`,
    );
  }
  return value;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function attribute(
  node: XmlRecord,
  name: string,
  context: string,
): string {
  const value = node[name];
  if (typeof value !== "string" || value === "") {
    throw new CatalogueWorkbookError(
      "invalid-xml",
      `Missing XML attribute ${name} at ${context}.`,
    );
  }
  return value;
}

function optionalAttribute(node: XmlRecord, name: string): string | null {
  const value = node[name];
  return typeof value === "string" ? value : null;
}

function xmlText(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(xmlText).join("");
  }
  if (isXmlRecord(value) && Object.hasOwn(value, "#text")) {
    return xmlText(value["#text"]);
  }
  return "";
}

function richStringText(value: unknown): string {
  if (!isXmlRecord(value)) {
    return xmlText(value);
  }

  if (Object.hasOwn(value, "t")) {
    return xmlText(value.t);
  }

  return asArray(value.r)
    .map((run, index) => {
      const runNode = asXmlRecord(run, `rich string run ${index + 1}`);
      return xmlText(runNode.t);
    })
    .join("");
}

function decodeXml(bytes: Uint8Array, archivePath: string): string {
  if (bytes.byteLength > MAX_RETAINED_XML_BYTES) {
    throw new CatalogueWorkbookError(
      "retained-entry-size-limit",
      `${archivePath} exceeds the retained XML size limit.`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CatalogueWorkbookError(
      "invalid-xml",
      `${archivePath} is not valid UTF-8 XML.`,
    );
  }

  if (/<!DOCTYPE/i.test(text)) {
    throw new CatalogueWorkbookError(
      "invalid-xml",
      `${archivePath} contains a disallowed DOCTYPE declaration.`,
    );
  }
  return text;
}

function parseXml(bytes: Uint8Array, archivePath: string): XmlRecord {
  try {
    const parsed: unknown = xmlParser.parse(decodeXml(bytes, archivePath));
    return asXmlRecord(parsed, archivePath);
  } catch (error) {
    if (error instanceof CatalogueWorkbookError) {
      throw error;
    }
    throw new CatalogueWorkbookError(
      "invalid-xml",
      `Could not parse ${archivePath}: ${errorMessage(error)}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateArchiveEntryName(name: string): void {
  if (
    name === "" ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    name.split("/").some((part) => part === "..")
  ) {
    throw new CatalogueWorkbookError(
      "unsafe-archive-path",
      `Unsafe XLSX archive entry path: ${JSON.stringify(name)}.`,
    );
  }
}

function shouldRetainEntry(name: string): boolean {
  return (
    name === "[Content_Types].xml" ||
    name.endsWith(".xml") ||
    name.endsWith(".rels")
  );
}

function concatenateChunks(
  chunks: Uint8Array[],
  totalBytes: number,
): Uint8Array {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function extractArchive(buffer: Uint8Array): ExtractedArchive {
  if (buffer.byteLength > MAX_CATALOGUE_COMPRESSED_BYTES) {
    throw new CatalogueWorkbookError(
      "compressed-size-limit",
      `XLSX input exceeds ${MAX_CATALOGUE_COMPRESSED_BYTES} compressed bytes.`,
    );
  }
  if (
    buffer.byteLength < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b
  ) {
    throw new CatalogueWorkbookError(
      "invalid-zip",
      "The input is not a ZIP-based XLSX file.",
    );
  }

  const entries = new Map<string, Uint8Array>();
  const seenNames = new Set<string>();
  let entryCount = 0;
  let declaredTotal = 0;
  let actualTotal = 0;

  const unzipper = new Unzip((file: UnzipFile) => {
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
      throw new CatalogueWorkbookError(
        "archive-entry-limit",
        `XLSX archive exceeds ${MAX_ARCHIVE_ENTRIES} entries.`,
      );
    }

    validateArchiveEntryName(file.name);
    if (seenNames.has(file.name)) {
      throw new CatalogueWorkbookError(
        "duplicate-archive-entry",
        `XLSX archive contains duplicate entry ${file.name}.`,
      );
    }
    seenNames.add(file.name);

    if (file.originalSize !== undefined) {
      declaredTotal += file.originalSize;
      if (declaredTotal > MAX_CATALOGUE_UNCOMPRESSED_BYTES) {
        throw new CatalogueWorkbookError(
          "uncompressed-size-limit",
          `XLSX archive declares more than ${MAX_CATALOGUE_UNCOMPRESSED_BYTES} uncompressed bytes.`,
        );
      }
      if (
        shouldRetainEntry(file.name) &&
        file.originalSize > MAX_RETAINED_XML_BYTES
      ) {
        throw new CatalogueWorkbookError(
          "retained-entry-size-limit",
          `${file.name} exceeds the retained XML size limit.`,
        );
      }
    }

    const retain = shouldRetainEntry(file.name);
    const chunks: Uint8Array[] = [];
    let entryBytes = 0;

    file.ondata = (error, chunk, final) => {
      if (error !== null) {
        throw error;
      }
      if (chunk === null) {
        throw new CatalogueWorkbookError(
          "invalid-zip",
          `XLSX archive returned no data for ${file.name}.`,
        );
      }

      actualTotal += chunk.byteLength;
      entryBytes += chunk.byteLength;
      if (actualTotal > MAX_CATALOGUE_UNCOMPRESSED_BYTES) {
        throw new CatalogueWorkbookError(
          "uncompressed-size-limit",
          `XLSX archive expands beyond ${MAX_CATALOGUE_UNCOMPRESSED_BYTES} bytes.`,
        );
      }
      if (retain && entryBytes > MAX_RETAINED_XML_BYTES) {
        throw new CatalogueWorkbookError(
          "retained-entry-size-limit",
          `${file.name} expands beyond the retained XML size limit.`,
        );
      }

      if (retain && chunk.byteLength > 0) {
        chunks.push(chunk.slice());
      }
      if (final && retain) {
        entries.set(file.name, concatenateChunks(chunks, entryBytes));
      }
    };
    file.start();
  });
  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);

  try {
    for (
      let offset = 0;
      offset < buffer.byteLength;
      offset += ZIP_INPUT_CHUNK_BYTES
    ) {
      const end = Math.min(offset + ZIP_INPUT_CHUNK_BYTES, buffer.byteLength);
      unzipper.push(buffer.subarray(offset, end), end === buffer.byteLength);
    }
  } catch (error) {
    if (error instanceof CatalogueWorkbookError) {
      throw error;
    }
    throw new CatalogueWorkbookError(
      "invalid-zip",
      `Could not expand XLSX archive: ${errorMessage(error)}`,
    );
  }

  return {
    entries,
    uncompressedBytes: actualTotal,
  };
}

function requiredEntry(
  archive: ExtractedArchive,
  archivePath: string,
): Uint8Array {
  const entry = archive.entries.get(archivePath);
  if (entry === undefined) {
    throw new CatalogueWorkbookError(
      "missing-xlsx-part",
      `XLSX archive is missing ${archivePath}.`,
    );
  }
  return entry;
}

function decodeRelationshipTarget(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    throw new CatalogueWorkbookError(
      "invalid-relationship",
      `Relationship target is not a valid URI: ${target}.`,
    );
  }
}

function resolveRelationshipTarget(
  sourcePartPath: string,
  rawTarget: string,
): string {
  const target = decodeRelationshipTarget(rawTarget);
  if (
    target.includes("\0") ||
    target.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  ) {
    throw new CatalogueWorkbookError(
      "invalid-relationship",
      `Unsafe external-style relationship target: ${rawTarget}.`,
    );
  }

  const parts = target.startsWith("/")
    ? []
    : sourcePartPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        throw new CatalogueWorkbookError(
          "invalid-relationship",
          `Relationship target escapes the XLSX package: ${rawTarget}.`,
        );
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  if (parts.length === 0) {
    throw new CatalogueWorkbookError(
      "invalid-relationship",
      `Relationship target resolves to an empty path: ${rawTarget}.`,
    );
  }
  return parts.join("/");
}

function relationshipPartPath(sourcePartPath: string): string {
  const parts = sourcePartPath.split("/");
  const filename = parts.pop();
  if (filename === undefined || filename === "") {
    throw new CatalogueWorkbookError(
      "invalid-relationship",
      `Cannot form relationship path for ${sourcePartPath}.`,
    );
  }
  return [...parts, "_rels", `${filename}.rels`].join("/");
}

function parseRelationships(
  archive: ExtractedArchive,
  relationshipPath: string,
): Relationship[] {
  const xml = parseXml(
    requiredEntry(archive, relationshipPath),
    relationshipPath,
  );
  const root = asXmlRecord(xml.Relationships, `${relationshipPath}:Relationships`);

  return asArray(root.Relationship).map((rawRelationship, index) => {
    const node = asXmlRecord(
      rawRelationship,
      `${relationshipPath}:Relationship[${index + 1}]`,
    );
    return {
      id: attribute(node, "Id", `${relationshipPath}:Relationship`),
      type: attribute(node, "Type", `${relationshipPath}:Relationship`),
      target: attribute(node, "Target", `${relationshipPath}:Relationship`),
      targetMode: optionalAttribute(node, "TargetMode"),
    };
  });
}

function findWorkbookPath(archive: ExtractedArchive): string {
  const rootRelationships = parseRelationships(archive, "_rels/.rels");
  const officeDocument = rootRelationships.find(({ type, targetMode }) => {
    return (
      type.endsWith("/officeDocument") &&
      (targetMode === null || targetMode !== "External")
    );
  });
  if (officeDocument === undefined) {
    throw new CatalogueWorkbookError(
      "invalid-xlsx",
      "Package relationships contain no internal officeDocument.",
    );
  }
  return resolveRelationshipTarget("", officeDocument.target);
}

function validateWorkbookContentType(
  archive: ExtractedArchive,
  workbookPath: string,
): void {
  const contentTypesPath = "[Content_Types].xml";
  const xml = parseXml(
    requiredEntry(archive, contentTypesPath),
    contentTypesPath,
  );
  const root = asXmlRecord(xml.Types, `${contentTypesPath}:Types`);
  const expectedPartName = `/${workbookPath}`;
  const override = asArray(root.Override)
    .map((rawOverride, index) =>
      asXmlRecord(rawOverride, `${contentTypesPath}:Override[${index + 1}]`),
    )
    .find((node) => optionalAttribute(node, "PartName") === expectedPartName);
  const contentType =
    override === undefined ? null : optionalAttribute(override, "ContentType");

  if (
    contentType !==
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
  ) {
    throw new CatalogueWorkbookError(
      "invalid-xlsx",
      `Package part ${workbookPath} is not an XLSX workbook.`,
    );
  }
}

function parseWorkbookSheetDefinitions(
  archive: ExtractedArchive,
  workbookPath: string,
): WorkbookSheetDefinition[] {
  const xml = parseXml(requiredEntry(archive, workbookPath), workbookPath);
  const workbook = asXmlRecord(xml.workbook, `${workbookPath}:workbook`);
  const sheets = asXmlRecord(workbook.sheets, `${workbookPath}:sheets`);
  const sheetNodes = asArray(sheets.sheet);

  if (sheetNodes.length === 0 || sheetNodes.length > MAX_WORKSHEETS) {
    throw new CatalogueWorkbookError(
      "workbook-complexity-limit",
      `Workbook sheet count must be between 1 and ${MAX_WORKSHEETS}.`,
    );
  }

  const names = new Set<string>();
  return sheetNodes.map((rawSheet, index) => {
    const node = asXmlRecord(rawSheet, `${workbookPath}:sheet[${index + 1}]`);
    const name = attribute(node, "name", `${workbookPath}:sheet`);
    if (names.has(name)) {
      throw new CatalogueWorkbookError(
        "invalid-xlsx",
        `Workbook contains duplicate sheet name ${name}.`,
      );
    }
    names.add(name);

    return {
      name,
      sheetId: attribute(node, "sheetId", `${workbookPath}:sheet`),
      relationshipId: attribute(node, "r:id", `${workbookPath}:sheet`),
    };
  });
}

function parseSharedStrings(
  archive: ExtractedArchive,
  sharedStringsPath: string | null,
): string[] {
  if (sharedStringsPath === null) {
    return [];
  }

  const xml = parseXml(
    requiredEntry(archive, sharedStringsPath),
    sharedStringsPath,
  );
  const root = asXmlRecord(xml.sst, `${sharedStringsPath}:sst`);
  return asArray(root.si).map(richStringText);
}

function parseColumnNumber(columnName: string): number {
  let result = 0;
  for (const character of columnName) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

function parseCellReference(reference: string): {
  rowNumber: number;
  columnNumber: number;
  columnName: string;
} {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(reference);
  if (match === null) {
    throw new CatalogueWorkbookError(
      "invalid-cell-reference",
      `Invalid worksheet cell reference ${reference}.`,
    );
  }

  const columnName = match[1] ?? "";
  const columnNumber = parseColumnNumber(columnName);
  const rowNumber = Number(match[2]);
  if (
    columnNumber < 1 ||
    columnNumber > 16_384 ||
    !Number.isSafeInteger(rowNumber) ||
    rowNumber < 1 ||
    rowNumber > 1_048_576
  ) {
    throw new CatalogueWorkbookError(
      "invalid-cell-reference",
      `Worksheet cell reference ${reference} is outside Excel limits.`,
    );
  }

  return { rowNumber, columnNumber, columnName };
}

function formulaDetails(cell: XmlRecord): {
  rawFormula: string | null;
  formulaAttributes: Record<string, string> | null;
} {
  if (!Object.hasOwn(cell, "f")) {
    return { rawFormula: null, formulaAttributes: null };
  }

  const formula = cell.f;
  if (!isXmlRecord(formula)) {
    return {
      rawFormula: xmlText(formula),
      formulaAttributes: {},
    };
  }

  const formulaAttributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(formula)) {
    if (key !== "#text" && typeof value === "string") {
      formulaAttributes[key] = value;
    }
  }
  return {
    rawFormula: xmlText(formula),
    formulaAttributes,
  };
}

function parseStoredValue(
  cell: XmlRecord,
  rawValue: string | null,
  sharedStrings: string[],
  context: string,
): ParsedCellValue {
  const cellType = optionalAttribute(cell, "t");

  if (cellType === "inlineStr") {
    return richStringText(cell.is);
  }
  if (rawValue === null) {
    return null;
  }
  if (cellType === "s") {
    const index = Number(rawValue);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= sharedStrings.length
    ) {
      throw new CatalogueWorkbookError(
        "invalid-shared-string",
        `${context} references invalid shared string index ${rawValue}.`,
      );
    }
    return sharedStrings[index] ?? null;
  }
  if (cellType === "b") {
    return rawValue === "1";
  }
  if (
    cellType === "str" ||
    cellType === "e" ||
    cellType === "d"
  ) {
    return rawValue;
  }

  const numberValue = Number(rawValue);
  return Number.isFinite(numberValue) ? numberValue : rawValue;
}

function parseWorksheet(
  archive: ExtractedArchive,
  definition: WorkbookSheetDefinition,
  worksheetPath: string,
  sharedStrings: string[],
  runningCellCount: { value: number },
): ParsedCatalogueSheet {
  const xml = parseXml(requiredEntry(archive, worksheetPath), worksheetPath);
  const worksheet = asXmlRecord(xml.worksheet, `${worksheetPath}:worksheet`);
  const sheetData = asXmlRecord(
    worksheet.sheetData,
    `${worksheetPath}:sheetData`,
  );
  const rawRows = asArray(sheetData.row);

  if (rawRows.length > MAX_WORKSHEET_ROWS) {
    throw new CatalogueWorkbookError(
      "workbook-complexity-limit",
      `${definition.name} exceeds ${MAX_WORKSHEET_ROWS} worksheet rows.`,
    );
  }

  const rows = rawRows.map((rawRow, rowIndex): ParsedCatalogueRow => {
    const rowNode = asXmlRecord(
      rawRow,
      `${worksheetPath}:row[${rowIndex + 1}]`,
    );
    const rowNumberRaw = attribute(
      rowNode,
      "r",
      `${worksheetPath}:row[${rowIndex + 1}]`,
    );
    const rowNumber = Number(rowNumberRaw);
    if (
      !Number.isSafeInteger(rowNumber) ||
      rowNumber < 1 ||
      rowNumber > 1_048_576
    ) {
      throw new CatalogueWorkbookError(
        "invalid-cell-reference",
        `${worksheetPath} contains invalid row number ${rowNumberRaw}.`,
      );
    }

    const cells = asArray(rowNode.c).map(
      (rawCell, cellIndex): ParsedCatalogueCell => {
        runningCellCount.value += 1;
        if (runningCellCount.value > MAX_WORKBOOK_CELLS) {
          throw new CatalogueWorkbookError(
            "workbook-complexity-limit",
            `Workbook exceeds ${MAX_WORKBOOK_CELLS} cells.`,
          );
        }

        const cell = asXmlRecord(
          rawCell,
          `${worksheetPath}:row[${rowNumber}]:cell[${cellIndex + 1}]`,
        );
        const reference = attribute(
          cell,
          "r",
          `${worksheetPath}:row[${rowNumber}]:cell`,
        );
        const parsedReference = parseCellReference(reference);
        if (parsedReference.rowNumber !== rowNumber) {
          throw new CatalogueWorkbookError(
            "invalid-cell-reference",
            `${reference} is stored under worksheet row ${rowNumber}.`,
          );
        }

        const rawValue = Object.hasOwn(cell, "v")
          ? xmlText(cell.v)
          : null;
        const formula = formulaDetails(cell);
        return {
          reference,
          ...parsedReference,
          cellType: optionalAttribute(cell, "t"),
          styleIndex: optionalAttribute(cell, "s"),
          rawValue,
          value: parseStoredValue(
            cell,
            rawValue,
            sharedStrings,
            `${definition.name}!${reference}`,
          ),
          ...formula,
        };
      },
    );

    return { rowNumber, cells };
  });

  return {
    name: definition.name,
    sheetId: definition.sheetId,
    relationshipId: definition.relationshipId,
    archivePath: worksheetPath,
    rows,
  };
}

/**
 * Parses the minimum OOXML workbook surface needed by the catalogue importer.
 *
 * Formula bodies and cached values are returned independently. Formula bodies
 * are never executed, expanded, or recalculated.
 */
export function parseCatalogueWorkbook(
  buffer: Uint8Array,
): ParsedCatalogueWorkbook {
  const archive = extractArchive(buffer);
  const workbookPath = findWorkbookPath(archive);
  validateWorkbookContentType(archive, workbookPath);

  const sheetDefinitions = parseWorkbookSheetDefinitions(
    archive,
    workbookPath,
  );
  const workbookRelationships = parseRelationships(
    archive,
    relationshipPartPath(workbookPath),
  );
  const relationshipsById = new Map(
    workbookRelationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  );

  const sharedStringsRelationship = workbookRelationships.find(
    ({ type, targetMode }) =>
      type.endsWith("/sharedStrings") && targetMode !== "External",
  );
  const sharedStringsPath =
    sharedStringsRelationship === undefined
      ? null
      : resolveRelationshipTarget(
          workbookPath,
          sharedStringsRelationship.target,
        );
  const sharedStrings = parseSharedStrings(archive, sharedStringsPath);

  const runningCellCount = { value: 0 };
  const sheets = sheetDefinitions.map((definition) => {
    const relationship = relationshipsById.get(definition.relationshipId);
    if (
      relationship === undefined ||
      !relationship.type.endsWith("/worksheet") ||
      relationship.targetMode === "External"
    ) {
      throw new CatalogueWorkbookError(
        "invalid-relationship",
        `Sheet ${definition.name} has no valid internal worksheet relationship.`,
      );
    }

    const worksheetPath = resolveRelationshipTarget(
      workbookPath,
      relationship.target,
    );
    return parseWorksheet(
      archive,
      definition,
      worksheetPath,
      sharedStrings,
      runningCellCount,
    );
  });

  return {
    sheets,
    sheetsByName: Object.fromEntries(
      sheets.map((sheet) => [sheet.name, sheet]),
    ),
    sharedStrings,
    compressedBytes: buffer.byteLength,
    uncompressedBytes: archive.uncompressedBytes,
  };
}

/**
 * Validates and maps the exact seven Formula SAE-A catalogue worksheets.
 */
export function profileCatalogue(buffer: Uint8Array): CatalogueProfile {
  const workbook = parseCatalogueWorkbook(buffer);
  const expectedNames = new Set<string>(CATALOGUE_SHEET_NAMES);
  const actualNames = workbook.sheets.map(({ name }) => name);
  const missing = CATALOGUE_SHEET_NAMES.filter(
    (name) => workbook.sheetsByName[name] === undefined,
  );
  const extra = actualNames.filter((name) => !expectedNames.has(name));

  if (
    workbook.sheets.length !== CATALOGUE_SHEET_NAMES.length ||
    missing.length > 0 ||
    extra.length > 0
  ) {
    throw new CatalogueWorkbookError(
      "unexpected-catalogue-sheets",
      `Expected exactly ${CATALOGUE_SHEET_NAMES.join(", ")}; missing [${missing.join(", ")}], extra [${extra.join(", ")}].`,
    );
  }

  const sheets = Object.fromEntries(
    CATALOGUE_SHEET_NAMES.map((name) => [
      name,
      workbook.sheetsByName[name] as ParsedCatalogueSheet,
    ]),
  ) as Record<CatalogueSheetName, ParsedCatalogueSheet>;
  const rowCounts = Object.fromEntries(
    CATALOGUE_SHEET_NAMES.map((name) => [name, sheets[name].rows.length]),
  ) as Record<CatalogueSheetName, number>;

  return { workbook, sheets, rowCounts };
}
