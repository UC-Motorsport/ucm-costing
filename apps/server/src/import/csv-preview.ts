import { TextDecoder } from "node:util";

import { parse } from "csv-parse/sync";

import { systemDefinitions } from "../domain/systems";

export type CsvEncoding = "utf-8" | "windows-1252";
export type CsvTemplate = "legacy-master" | "assembly-index" | "unknown";
export type SupportedCsvTemplate = Exclude<CsvTemplate, "unknown">;
export type ImportIssueSeverity = "error" | "warning" | "info";

export interface CsvPreviewOptions {
  /**
   * Optional display-only source name. Template detection never relies on it.
   */
  sourceName?: string;
  /**
   * Adds an error to the preview when content detection finds another template.
   * It does not force parsing under the requested template.
   */
  expectedTemplate?: SupportedCsvTemplate;
}

export interface ImportIssue {
  severity: ImportIssueSeverity;
  code: string;
  message: string;
  rowNumber?: number;
  columnNumber?: number;
  field?: string;
  sourceKey?: string;
  relatedRows?: number[];
  candidateFix?: string;
}

export interface RawCsvRow {
  rowNumber: number;
  cells: string[];
}

export interface OverflowCell {
  columnNumber: number;
  rawValue: string;
}

export interface RowProvenance {
  rowNumber: number;
  rawCells: string[];
  namedCells: Record<string, string>;
  /**
   * Every source cell after the detected template header, including blanks.
   * This deliberately retains legacy comments in unnamed columns.
   */
  overflowCells: OverflowCell[];
}

export interface CsvPreviewBase {
  phase: "preview";
  readOnly: true;
  template: CsvTemplate;
  sourceName?: string;
  encoding: CsvEncoding;
  delimiter: ",";
  headerRowNumber: number | null;
  rawRows: RawCsvRow[];
  issues: ImportIssue[];
}

export interface LegacyStatusValues {
  costed: string | null;
  costingUpdated: string | null;
  drawing: string | null;
  isoImage: string | null;
  costingSheet: string | null;
  compiled: string | null;
}

export interface LegacyMasterRecord {
  recordKind: "assembly" | "component";
  system: string | null;
  hla: string | null;
  subassembly: string | null;
  partNumber: string;
  partBase: string;
  variant: "L" | "R" | null;
  sourceKey: string | null;
  sixDigitCode: string | null;
  revisionRaw: string | null;
  assemblyName: string | null;
  componentName: string | null;
  description: string | null;
  procurementType: "bought" | "made" | null;
  procurementRaw: string | null;
  quantityTotal: number | null;
  quantityTotalRaw: string | null;
  quantityOnCar: number | null;
  quantityOnCarRaw: string | null;
  sourceRaw: string | null;
  checkedByRaw: string | null;
  notesRaw: string | null;
  legacyStatuses: LegacyStatusValues;
  provenance: RowProvenance;
}

export interface LegacyMasterStats {
  apparentRecordCount: number;
  assemblyRecordCount: number;
  componentRecordCount: number;
  systemSectionCount: number;
  duplicateCandidateCount: number;
}

export interface LegacyMasterCsvPreview extends CsvPreviewBase {
  template: "legacy-master";
  headerRowNumber: number;
  records: LegacyMasterRecord[];
  stats: LegacyMasterStats;
}

export interface AssemblyClaim {
  system: string;
  hla: string;
  assemblyName: string | null;
  ownerName: string | null;
  sourceKey: string;
  provenance: RowProvenance;
}

export interface AssemblyIndexStats {
  claimCount: number;
  namedClaimCount: number;
  ownedClaimCount: number;
  systemSectionCount: number;
  lookupSystemCount: number;
}

export interface AssemblyIndexCsvPreview extends CsvPreviewBase {
  template: "assembly-index";
  headerRowNumber: number;
  claims: AssemblyClaim[];
  stats: AssemblyIndexStats;
}

export interface UnknownCsvPreview extends CsvPreviewBase {
  template: "unknown";
  records: [];
  stats: {
    apparentRecordCount: 0;
  };
}

export type CsvPreview =
  | LegacyMasterCsvPreview
  | AssemblyIndexCsvPreview
  | UnknownCsvPreview;

interface DecodedCsv {
  encoding: CsvEncoding;
  text: string;
}

interface DetectedTemplate {
  template: SupportedCsvTemplate;
  headerRowIndex: number;
}

const LEGACY_MASTER_HEADERS = [
  "SYS",
  "HLA",
  "SubA",
  "Part No.",
  "Rev",
  "Assembly",
  "Component",
  "Description ",
  "Bought/Made",
  "QTY  total",
  "QTY on car",
  "Costed?",
  "where did it come from (source)",
  "Costing Updated",
  "Drawing",
  "Iso image",
  "Costing sheet",
  "Checked By",
  "Notes",
  "Compiled",
] as const;

const ASSEMBLY_INDEX_HEADERS = [
  "High Level Assembly",
  "System",
  "Assembly",
  "Name",
] as const;

const LEGACY_STATUS_COLUMNS = [
  { index: 11, field: "costed" },
  { index: 13, field: "costingUpdated" },
  { index: 14, field: "drawing" },
  { index: 15, field: "isoImage" },
  { index: 16, field: "costingSheet" },
  { index: 19, field: "compiled" },
] as const;

const SYSTEM_CODES = new Set(systemDefinitions.map(({ code }) => code));

function decodeCsv(buffer: Uint8Array): DecodedCsv {
  try {
    return {
      encoding: "utf-8",
      text: stripBom(new TextDecoder("utf-8", { fatal: true }).decode(buffer)),
    };
  } catch {
    return {
      encoding: "windows-1252",
      text: stripBom(
        new TextDecoder("windows-1252", { fatal: true }).decode(buffer),
      ),
    };
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseCsvRows(text: string): string[][] {
  return parse(text, {
    bom: true,
    delimiter: ",",
    relax_column_count: true,
    skip_empty_lines: false,
  }) as string[][];
}

function cleanCell(value: string | undefined): string {
  return (value ?? "").replaceAll("\u00a0", " ").trim();
}

function nullableCell(value: string | undefined): string | null {
  const cleaned = cleanCell(value);
  return cleaned === "" ? null : cleaned;
}

function normalizeHeader(value: string | undefined): string {
  return cleanCell(value)
    .toLowerCase()
    .replace(/[?.]/g, "")
    .replace(/\s+/g, " ");
}

function isLegacyMasterHeaderRow(row: string[]): boolean {
  const header = row.map(normalizeHeader);
  return (
    header[0] === "sys" &&
    header[1] === "hla" &&
    header[2] === "suba" &&
    header[3] === "part no" &&
    header[5] === "assembly" &&
    header[6] === "component"
  );
}

function detectTemplate(rows: string[][]): DetectedTemplate | null {
  const searchLimit = Math.min(rows.length, 50);

  for (let rowIndex = 0; rowIndex < searchLimit; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const header = row.map(normalizeHeader);

    if (isLegacyMasterHeaderRow(row)) {
      return { template: "legacy-master", headerRowIndex: rowIndex };
    }

    if (
      header[0] === "high level assembly" &&
      header[1] === "system" &&
      header[2] === "assembly" &&
      header[3] === "name"
    ) {
      return { template: "assembly-index", headerRowIndex: rowIndex };
    }
  }

  return null;
}

function makeRawRows(rows: string[][]): RawCsvRow[] {
  return rows.map((cells, index) => ({
    rowNumber: index + 1,
    cells: [...cells],
  }));
}

function makeProvenance(
  rowNumber: number,
  cells: string[],
  headers: readonly string[],
): RowProvenance {
  const namedCells: Record<string, string> = {};

  headers.forEach((header, index) => {
    namedCells[header] = cells[index] ?? "";
  });

  return {
    rowNumber,
    rawCells: [...cells],
    namedCells,
    overflowCells: cells.slice(headers.length).map((rawValue, index) => ({
      columnNumber: headers.length + index + 1,
      rawValue,
    })),
  };
}

function baseIssues(
  encoding: CsvEncoding,
  detected: DetectedTemplate | null,
  options: CsvPreviewOptions,
): ImportIssue[] {
  const issues: ImportIssue[] = [];

  if (encoding === "windows-1252") {
    issues.push({
      severity: "info",
      code: "encoding-fallback",
      message:
        "The file is not valid UTF-8 and was decoded with Windows-1252.",
    });
  }

  if (detected === null) {
    issues.push({
      severity: "error",
      code: "unsupported-template",
      message:
        "No supported legacy-master or assembly-index header signature was found.",
    });
    return issues;
  }

  if (
    options.expectedTemplate !== undefined &&
    options.expectedTemplate !== detected.template
  ) {
    issues.push({
      severity: "error",
      code: "template-mismatch",
      message: `Expected ${options.expectedTemplate}, but the content is ${detected.template}.`,
    });
  }

  return issues;
}

function parseSystemSection(
  value: string,
): { code: string; label: string } | null {
  const match = /^(.*?)\s+-\s+([A-Z]{2})$/.exec(value);
  if (match === null) {
    return null;
  }

  return {
    label: cleanCell(match[1]),
    code: match[2] ?? "",
  };
}

function splitPartVariant(partNumber: string): {
  partBase: string;
  variant: "L" | "R" | null;
} {
  const match = /^(.*?)-(L|R)$/i.exec(partNumber);
  if (match === null) {
    return { partBase: partNumber, variant: null };
  }

  return {
    partBase: match[1] ?? partNumber,
    variant: (match[2] ?? "").toUpperCase() as "L" | "R",
  };
}

function parseDecimal(
  raw: string | null,
  rowNumber: number,
  columnNumber: number,
  field: string,
  issues: ImportIssue[],
): number | null {
  if (raw === null) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    issues.push({
      severity: "warning",
      code: "invalid-quantity",
      message: `${field} must be a non-negative number; the raw value was preserved.`,
      rowNumber,
      columnNumber,
      field,
    });
    return null;
  }

  return parsed;
}

function parseProcurementType(
  raw: string | null,
  rowNumber: number,
  issues: ImportIssue[],
): "bought" | "made" | null {
  const normalized = raw?.toLowerCase();
  if (normalized === "bought" || normalized === "made") {
    return normalized;
  }

  if (raw !== null) {
    issues.push({
      severity: "warning",
      code: "unexpected-procurement-value",
      message: `Bought/Made value "${raw}" was preserved but not normalized.`,
      rowNumber,
      columnNumber: 9,
      field: "procurementType",
    });
  }

  return null;
}

function makeSourceKey(
  system: string | null,
  hla: string | null,
  subassembly: string | null,
  partBase: string,
  variant: "L" | "R" | null,
): string | null {
  if (
    system === null ||
    hla === null ||
    subassembly === null ||
    partBase === ""
  ) {
    return null;
  }

  return `${system}.${hla}.${subassembly}.${partBase}${variant === null ? "" : `-${variant}`}`;
}

function makeSixDigitCode(
  hla: string | null,
  subassembly: string | null,
  partBase: string,
): string | null {
  if (
    hla === null ||
    subassembly === null ||
    !/^\d+$/.test(hla) ||
    !/^\d+$/.test(subassembly) ||
    !/^\d+$/.test(partBase)
  ) {
    return null;
  }

  const candidate = `${hla}${subassembly}${partBase}`;
  return candidate.length === 6 ? candidate : null;
}

function previewLegacyMaster(
  rows: string[][],
  encoding: CsvEncoding,
  detected: DetectedTemplate,
  options: CsvPreviewOptions,
): LegacyMasterCsvPreview {
  const issues = baseIssues(encoding, detected, options);
  const records: LegacyMasterRecord[] = [];
  let currentSystem: string | null = null;
  let currentHla: string | null = null;
  let currentSubassembly: string | null = null;
  let systemSectionCount = 0;

  for (
    let rowIndex = detected.headerRowIndex + 1;
    rowIndex < rows.length;
    rowIndex += 1
  ) {
    const cells = rows[rowIndex] ?? [];
    const rowNumber = rowIndex + 1;
    const normalized = cells.map(cleanCell);

    if (normalized.every((value) => value === "")) {
      continue;
    }

    if (isLegacyMasterHeaderRow(cells)) {
      issues.push({
        severity: "info",
        code: "repeated-header-row",
        message:
          "A repeated legacy-master header was retained in raw provenance and excluded from candidate records.",
        rowNumber,
      });
      continue;
    }

    const firstCell = normalized[0] ?? "";
    const section = parseSystemSection(firstCell);
    if (section !== null) {
      currentSystem = section.code;
      currentHla = null;
      currentSubassembly = null;
      systemSectionCount += 1;

      const extraColumns = normalized
        .slice(1)
        .map((value, index) => ({ value, columnNumber: index + 2 }))
        .filter(({ value }) => value !== "");
      if (extraColumns.length > 0) {
        issues.push({
          severity: "warning",
          code: "section-row-extra-data",
          message:
            "A system section row also contains data in other columns; it was retained only in raw provenance.",
          rowNumber,
          columnNumber: extraColumns[0]?.columnNumber,
        });
      }
      continue;
    }

    const explicitSystem = firstCell;
    if (SYSTEM_CODES.has(explicitSystem)) {
      currentSystem = explicitSystem;
    } else if (explicitSystem !== "") {
      issues.push({
        severity: "warning",
        code: "invalid-system-code",
        message: `System code "${explicitSystem}" is not recognized; the prior recognized system context was retained.`,
        rowNumber,
        columnNumber: 1,
        field: "system",
        candidateFix: currentSystem ?? undefined,
      });
    }

    const explicitHla = normalized[1] ?? "";
    if (explicitHla !== "") {
      currentHla = explicitHla;
      currentSubassembly = null;
    }

    const explicitSubassembly = normalized[2] ?? "";
    if (explicitSubassembly !== "") {
      currentSubassembly = explicitSubassembly;
    }

    const partNumber = normalized[3] ?? "";
    const assemblyName = nullableCell(cells[5]);
    const componentName = nullableCell(cells[6]);
    const isApparentRecord =
      partNumber !== "" || assemblyName !== null || componentName !== null;

    if (!isApparentRecord) {
      issues.push({
        severity: "warning",
        code: "unclassified-row",
        message:
          "The non-empty row has no part number, assembly name, or component name.",
        rowNumber,
      });
      continue;
    }

    const { partBase, variant } = splitPartVariant(partNumber);
    const sourceKey = makeSourceKey(
      currentSystem,
      currentHla,
      currentSubassembly,
      partBase,
      variant,
    );
    const missingSegments = [
      currentSystem === null ? "system" : null,
      currentHla === null ? "hla" : null,
      currentSubassembly === null ? "subassembly" : null,
      partNumber === "" ? "partNumber" : null,
    ].filter((value): value is string => value !== null);

    if (missingSegments.length > 0) {
      issues.push({
        severity: "error",
        code: "missing-hierarchy-segment",
        message: `Cannot form a stable source key; missing ${missingSegments.join(", ")}.`,
        rowNumber,
        field: missingSegments[0],
      });
    }

    const sixDigitCode = makeSixDigitCode(
      currentHla,
      currentSubassembly,
      partBase,
    );
    if (
      currentHla !== null &&
      currentSubassembly !== null &&
      /^\d+$/.test(currentHla) &&
      /^\d+$/.test(currentSubassembly) &&
      /^\d+$/.test(partBase) &&
      sixDigitCode === null
    ) {
      issues.push({
        severity: "warning",
        code: "non-six-digit-code",
        message:
          "The concatenated HLA, SubA, and part base is not six digits; no zero-padding was guessed.",
        rowNumber,
        field: "sixDigitCode",
        sourceKey: sourceKey ?? undefined,
      });
    }

    const procurementRaw = nullableCell(cells[8]);
    const quantityTotalRaw = nullableCell(cells[9]);
    const quantityOnCarRaw = nullableCell(cells[10]);
    const quantityTotal = parseDecimal(
      quantityTotalRaw,
      rowNumber,
      10,
      "quantityTotal",
      issues,
    );
    const quantityOnCar = parseDecimal(
      quantityOnCarRaw,
      rowNumber,
      11,
      "quantityOnCar",
      issues,
    );

    if (
      quantityTotal !== null &&
      quantityOnCar !== null &&
      quantityOnCar > quantityTotal
    ) {
      issues.push({
        severity: "warning",
        code: "quantity-on-car-exceeds-total",
        message:
          "QTY on car exceeds QTY total; the legacy quantity semantics require confirmation.",
        rowNumber,
        field: "quantityOnCar",
        sourceKey: sourceKey ?? undefined,
      });
    }

    for (const statusColumn of LEGACY_STATUS_COLUMNS) {
      const rawStatus = nullableCell(cells[statusColumn.index]);
      if (
        rawStatus !== null &&
        rawStatus !== "1" &&
        rawStatus !== "2"
      ) {
        issues.push({
          severity: "warning",
          code: "unexpected-legacy-status",
          message: `Legacy status "${rawStatus}" was preserved without normalization.`,
          rowNumber,
          columnNumber: statusColumn.index + 1,
          field: statusColumn.field,
          sourceKey: sourceKey ?? undefined,
        });
      }
    }

    const provenance = makeProvenance(
      rowNumber,
      cells,
      LEGACY_MASTER_HEADERS,
    );
    if (
      provenance.overflowCells.some(
        ({ rawValue }) => cleanCell(rawValue) !== "",
      )
    ) {
      issues.push({
        severity: "info",
        code: "overflow-data",
        message:
          "The row contains data after the final named header; every overflow cell was retained.",
        rowNumber,
        columnNumber: 21,
        sourceKey: sourceKey ?? undefined,
      });
    }

    records.push({
      recordKind: assemblyName === null ? "component" : "assembly",
      system: currentSystem,
      hla: currentHla,
      subassembly: currentSubassembly,
      partNumber,
      partBase,
      variant,
      sourceKey,
      sixDigitCode,
      revisionRaw: nullableCell(cells[4]),
      assemblyName,
      componentName,
      description: nullableCell(cells[7]),
      procurementType: parseProcurementType(
        procurementRaw,
        rowNumber,
        issues,
      ),
      procurementRaw,
      quantityTotal,
      quantityTotalRaw,
      quantityOnCar,
      quantityOnCarRaw,
      sourceRaw: nullableCell(cells[12]),
      checkedByRaw: nullableCell(cells[17]),
      notesRaw: nullableCell(cells[18]),
      legacyStatuses: {
        costed: nullableCell(cells[11]),
        costingUpdated: nullableCell(cells[13]),
        drawing: nullableCell(cells[14]),
        isoImage: nullableCell(cells[15]),
        costingSheet: nullableCell(cells[16]),
        compiled: nullableCell(cells[19]),
      },
      provenance,
    });
  }

  const recordsBySourceKey = new Map<string, LegacyMasterRecord[]>();
  for (const record of records) {
    if (record.sourceKey === null) {
      continue;
    }
    const matches = recordsBySourceKey.get(record.sourceKey) ?? [];
    matches.push(record);
    recordsBySourceKey.set(record.sourceKey, matches);
  }

  let duplicateCandidateCount = 0;
  for (const [sourceKey, matches] of recordsBySourceKey) {
    if (matches.length < 2) {
      continue;
    }
    duplicateCandidateCount += 1;
    const relatedRows = matches.map(({ provenance }) => provenance.rowNumber);
    issues.push({
      severity: "warning",
      code: "duplicate-source-key",
      message: `Multiple apparent records share source key ${sourceKey}; no rows were excluded or merged.`,
      rowNumber: relatedRows[0],
      sourceKey,
      relatedRows,
    });
  }

  return {
    phase: "preview",
    readOnly: true,
    template: "legacy-master",
    sourceName: options.sourceName,
    encoding,
    delimiter: ",",
    headerRowNumber: detected.headerRowIndex + 1,
    rawRows: makeRawRows(rows),
    issues,
    records,
    stats: {
      apparentRecordCount: records.length,
      assemblyRecordCount: records.filter(
        ({ recordKind }) => recordKind === "assembly",
      ).length,
      componentRecordCount: records.filter(
        ({ recordKind }) => recordKind === "component",
      ).length,
      systemSectionCount,
      duplicateCandidateCount,
    },
  };
}

function previewAssemblyIndex(
  rows: string[][],
  encoding: CsvEncoding,
  detected: DetectedTemplate,
  options: CsvPreviewOptions,
): AssemblyIndexCsvPreview {
  const issues = baseIssues(encoding, detected, options);
  const claims: AssemblyClaim[] = [];
  let currentSystem: string | null = null;
  let systemSectionCount = 0;
  let lookupSystemCount = 0;

  for (
    let rowIndex = detected.headerRowIndex + 1;
    rowIndex < rows.length;
    rowIndex += 1
  ) {
    const cells = rows[rowIndex] ?? [];
    const rowNumber = rowIndex + 1;
    const normalized = cells.map(cleanCell);

    if (normalized.every((value) => value === "")) {
      continue;
    }

    const section = parseSystemSection(normalized[0] ?? "");
    if (section !== null) {
      currentSystem = section.code;
      systemSectionCount += 1;
      continue;
    }

    const lookupSection = parseSystemSection(normalized[20] ?? "");
    if (
      lookupSection !== null &&
      normalized.every((value, index) => index === 20 || value === "")
    ) {
      lookupSystemCount += 1;
      continue;
    }

    const hla = normalized[0] ?? "";
    const system = normalized[1] ?? "";
    if (hla === "" || system === "") {
      issues.push({
        severity: "warning",
        code: "unclassified-row",
        message:
          "The non-empty row is neither a system section, lookup row, nor complete HLA claim.",
        rowNumber,
      });
      continue;
    }

    if (!/^\d+$/.test(hla)) {
      issues.push({
        severity: "error",
        code: "invalid-hla-code",
        message: `HLA code "${hla}" is not numeric.`,
        rowNumber,
        columnNumber: 1,
        field: "hla",
      });
    }

    if (!/^[A-Z]{2}$/.test(system)) {
      issues.push({
        severity: "error",
        code: "invalid-system-code",
        message: `System code "${system}" is invalid.`,
        rowNumber,
        columnNumber: 2,
        field: "system",
      });
    }

    if (currentSystem !== null && currentSystem !== system) {
      issues.push({
        severity: "warning",
        code: "section-system-mismatch",
        message: `Claim system ${system} does not match section ${currentSystem}.`,
        rowNumber,
        columnNumber: 2,
        field: "system",
        candidateFix: currentSystem,
      });
    }

    const assemblyName = nullableCell(cells[2]);
    const ownerName = nullableCell(cells[3]);
    const sourceKey = `${system}.${hla}`;

    if (assemblyName === null) {
      issues.push({
        severity: "info",
        code: "unnamed-claim-slot",
        message: "The HLA slot is reserved but has no assembly name.",
        rowNumber,
        field: "assemblyName",
        sourceKey,
      });
    } else if (ownerName === null) {
      issues.push({
        severity: "warning",
        code: "missing-claim-owner",
        message: "The named HLA claim has no owner.",
        rowNumber,
        field: "ownerName",
        sourceKey,
      });
    }

    claims.push({
      system,
      hla,
      assemblyName,
      ownerName,
      sourceKey,
      provenance: makeProvenance(
        rowNumber,
        cells,
        ASSEMBLY_INDEX_HEADERS,
      ),
    });
  }

  const claimsBySourceKey = new Map<string, AssemblyClaim[]>();
  for (const claim of claims) {
    const matches = claimsBySourceKey.get(claim.sourceKey) ?? [];
    matches.push(claim);
    claimsBySourceKey.set(claim.sourceKey, matches);
  }
  for (const [sourceKey, matches] of claimsBySourceKey) {
    if (matches.length < 2) {
      continue;
    }
    const relatedRows = matches.map(({ provenance }) => provenance.rowNumber);
    issues.push({
      severity: "error",
      code: "duplicate-source-key",
      message: `Multiple assembly claims share source key ${sourceKey}.`,
      rowNumber: relatedRows[0],
      sourceKey,
      relatedRows,
    });
  }

  return {
    phase: "preview",
    readOnly: true,
    template: "assembly-index",
    sourceName: options.sourceName,
    encoding,
    delimiter: ",",
    headerRowNumber: detected.headerRowIndex + 1,
    rawRows: makeRawRows(rows),
    issues,
    claims,
    stats: {
      claimCount: claims.length,
      namedClaimCount: claims.filter(
        ({ assemblyName }) => assemblyName !== null,
      ).length,
      ownedClaimCount: claims.filter(({ ownerName }) => ownerName !== null)
        .length,
      systemSectionCount,
      lookupSystemCount,
    },
  };
}

/**
 * Decode, detect, and construct a read-only import preview.
 *
 * This function performs no persistence, upsert, policy exclusion, or status
 * interpretation. Callers must explicitly resolve preview issues before any
 * separate commit flow is introduced.
 */
export function detectAndPreviewCsv(
  buffer: Uint8Array,
  options: CsvPreviewOptions = {},
): CsvPreview {
  const decoded = decodeCsv(buffer);
  const rows = parseCsvRows(decoded.text);
  const detected = detectTemplate(rows);

  if (detected === null) {
    return {
      phase: "preview",
      readOnly: true,
      template: "unknown",
      sourceName: options.sourceName,
      encoding: decoded.encoding,
      delimiter: ",",
      headerRowNumber: null,
      rawRows: makeRawRows(rows),
      issues: baseIssues(decoded.encoding, null, options),
      records: [],
      stats: {
        apparentRecordCount: 0,
      },
    };
  }

  if (detected.template === "legacy-master") {
    return previewLegacyMaster(rows, decoded.encoding, detected, options);
  }

  return previewAssemblyIndex(rows, decoded.encoding, detected, options);
}
