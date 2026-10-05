export interface CostBreakdown {
  material: string;
  process: string;
  fastener: string;
  tooling: string;
  total: string;
}

export type SystemRole = "admin" | "editor" | "viewer";
export type UserStatus = "invited" | "active" | "disabled";

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  role: SystemRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface AuthCapabilities {
  canManageUsers: boolean;
  canManageImports: boolean;
  canManageSources: boolean;
}

export interface AuthSession {
  user: UserRecord;
  expiresAt: string;
  csrfToken: string;
  capabilities: AuthCapabilities;
}

export interface ProjectSetupConfirmation {
  id: string;
  contentHash: string;
  confirmedAt: string;
  confirmedBy: {
    id: string;
    displayName: string;
    email: string;
  };
  projectVersion: number;
}

export interface CostLine {
  id: string;
  node_id: string;
  kind: "material" | "process" | "fastener" | "tooling";
  catalogue_item_id: string | null;
  stock_size_name?: string | null;
  catalogue_unit?: string | null;
  catalogue_unit_2?: string | null;
  catalogue_provenance?: CatalogueProvenance | null;
  catalogue_revision?: number | null;
  catalogue_uses_unit_amount?: boolean | null;
  description: string;
  use_description: string;
  unit_cost: string;
  quantity: string;
  multiplier: string;
  multiplier_name: string | null;
  multiplier_catalogue_item_id: string | null;
  fraction_included: string;
  production_volume_factor: string | null;
  size_inputs_json: string;
  subtotal: string;
  sort_order: number;
  version: number;
}

export interface HistoricalCostLineSearchItem {
  id: string;
  sourceNodeId: string;
  sourceNodeName: string;
  sourceNodeNumber: string | null;
  sourceNodeKind: NodeKind;
  sourceProjectId: string;
  sourceProjectName: string;
  sourceSeason: number;
  kind: CostLine["kind"];
  catalogueItemId: string | null;
  unit?: string | null;
  unit2?: string | null;
  description: string;
  useDescription: string;
  unitCost: string;
  sizeInputs: Record<string, string>;
  quantity: string;
  multiplier: string;
  multiplierName: string | null;
  fractionIncluded: string;
  productionVolumeFactor: string | null;
  subtotal: string;
}

export interface HistoricalCostSource {
  id: string;
  name: string;
  fullNumber: string | null;
  kind: NodeKind;
  rowCount: number;
}

export interface HistoricalCostLineSearchResult {
  sourceProject: { id: string; name: string; season: number } | null;
  matchReason: "controlled-number" | "name-type-system" | null;
  suggested: HistoricalCostLineSearchItem[];
  items: HistoricalCostLineSearchItem[];
}

export interface HistoricalCostLineImportResult {
  line: CostLine;
  source: {
    lineId: string;
    nodeId: string;
    nodeName: string;
    nodeNumber: string | null;
    projectId: string;
    projectName: string;
    season: number;
  };
  warnings: string[];
}

export type NodeKind =
  | "vehicle"
  | "system"
  | "assembly"
  | "subassembly"
  | "part";

export interface CostNodeRecord {
  id: string;
  project_id: string;
  parent_id: string | null;
  kind: NodeKind;
  system_code: string | null;
  raw_hla: string | null;
  raw_subassembly: string | null;
  raw_part_number: string | null;
  reference_id: string | null;
  full_number: string | null;
  name: string;
  description: string;
  revision: string | null;
  procurement_type: "made" | "bought" | "unknown";
  drawing_required?: boolean;
  work_status?: "none" | "needs-attention" | "done";
  flag_comment?: string;
  image_required?: boolean;
  image_requirement_reason?: string;
  quantity: string;
  internal_note: string;
  source_import_batch_id: string | null;
  source_import_row: number | null;
  sort_order: number;
  version: number;
}

export interface CostNode extends CostNodeRecord {
  costLines: CostLine[];
  breakdown: CostBreakdown;
  children: CostNode[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  season: number;
  vehicle_type: "electric" | "combustion" | "dual";
  entry_number: string;
  status: "draft" | "review" | "submitted";
  rule_source_document_id: string;
  rule_pack_version: string;
  rule_pack_sha256: string;
  catalogue_release_id: string;
  catalogue_revision: string;
  cost_model: "competition-universal-dollar";
  project_summary: string;
  numbering_convention: string;
  bulk_method_summary: string;
  report_setup_confirmed: number;
  report_setup_confirmation: ProjectSetupConfirmation | null;
  is_historical: boolean;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface HistoricalProjectPreview {
  sourceName: string;
  sourceSha256: string;
  season: number;
  name: string;
  entryNumber: string;
  vehicleType: ProjectSummary["vehicle_type"];
  template: "legacy-master";
  candidates: number;
  fatalRows: number;
  errors: number;
  warnings: number;
  limitations: string[];
}

export interface ProjectCopyPreview {
  previewHash: string;
  source: { id: string; name: string; season: number; version: number };
  target: { id: string; name: string; season: number; version: number };
  targetParent: { id: string; name: string; kind: NodeKind; version: number };
  request: ProjectCopyRequest;
  nodes: Array<{
    sourceNodeId: string;
    sourceParentId: string | null;
    depth: number;
    kind: NodeKind;
    name: string;
    proposedFullNumber: string | null;
    costLines: number;
    skippedCostLines: number;
    evidence: number;
  }>;
  totals: { nodes: number; costLines: number; skippedCostLines: number; evidence: number };
  conflicts: string[];
  warnings: string[];
}

export interface ProjectCopyRequest {
  sourceProjectId: string;
  sourceNodeId: string;
  targetProjectId: string;
  targetParentId: string;
  includeDescendants: boolean;
  copyEvidence: boolean;
}

export interface ProjectArchivePreview {
  archiveSha256: string;
  manifestSha256: string;
  previewHash: string;
  source: {
    projectId: string;
    name: string;
    season: number;
    vehicleType: ProjectSummary["vehicle_type"];
    entryNumber: string;
    isHistorical: boolean;
  };
  target: {
    targetSeason: number;
    targetName: string;
    targetEntryNumber: string;
    targetIsHistorical: boolean;
  };
  totals: { nodes: number; costLines: number; evidence: number; evidenceBytes: number };
  conflicts: string[];
  warnings: string[];
}

export interface ProjectDetail {
  project: ProjectSummary & { focusSystems: string[] };
  tree: CostNode;
  flatNodes: CostNode[];
  breakdown: CostBreakdown;
}

export interface ValidationIssue {
  id: string;
  severity: "blocker" | "warning" | "notice";
  code: string;
  title: string;
  detail: string;
  nodeId: string | null;
  ruleReference: string | null;
}

export interface ValidationResult {
  projectId: string;
  checkedAt: string;
  blockers: number;
  warnings: number;
  notices: number;
  readyForCompetitionReport: boolean;
  issues: ValidationIssue[];
}

export interface CatalogueItem {
  id: string;
  kind: CatalogueItemKind;
  catalogueId: string;
  name: string;
  category: string | null;
  supplier: string | null;
  unit: string | null;
  unit2: string | null;
  rawFormula: string | null;
  sourceFormula: string | null;
  effectiveFormula: string | null;
  formulaCorrection: {
    id: string;
    reason: string;
    evidence: string;
    sourceFormula: string;
    effectiveFormula: string;
    inputs: Record<string, { label: string; unit: string }>;
  } | null;
  effectiveFormulaValidation: {
    ok: boolean;
    normalized?: string;
    error?: string;
  } | null;
  fixedCost: string | null;
  coefficients: Record<string, number | string | null>;
  metadata: Record<string, unknown> & {
    size1?: string | null;
    size2?: string | null;
    size3?: string | null;
    size4?: string | null;
    formulaValidation?: { ok?: boolean; error?: string } | null;
  };
  sourceSheet: string;
  sourceRow: number;
  origin: "official" | "team";
  provenance: CatalogueProvenance;
  revision: number;
  latestChange: {
    reason: string;
    evidence: string | null;
    createdAt: string;
    createdBy: { id: string; displayName: string };
  } | null;
}

export type CatalogueItemKind =
  | "material"
  | "process"
  | "multiplier"
  | "fastener"
  | "tooling"
  | "stock-size";

export type CatalogueProvenance = "official" | "edited" | "team";

export interface CataloguePublicationInput {
  releaseId: string;
  kind: CatalogueItemKind;
  name: string;
  category: string | null;
  supplier: string | null;
  unit: string | null;
  unit2: string | null;
  costMode: "fixed" | "formula";
  fixedCost: string | null;
  formula: string | null;
  coefficients: Record<"c1" | "c2" | "c3" | "c4", string | null>;
  size1Label: string | null;
  size2Label: string | null;
  size3Label: string | null;
  size4Label: string | null;
  reason: string;
  evidence: string | null;
}

export interface SourceDocument {
  id: string;
  kind: string;
  title: string;
  version: string;
  sha256: string;
  applicability: string;
  originalUrl: string;
  downloadUrl: string;
}

export interface Meta {
  application: string;
  currency: {
    code: "UNIVERSAL_DOLLAR";
    label: string;
    isRealCurrency: false;
  };
  rulePack: { version: string; sha256: string };
  catalogue: { releaseId: string; revision: string; sha256: string };
  systems: Array<{ code: string; name: string }>;
  features: {
    legacyImports: boolean;
    supportingWorkbook: true;
    costAmendments: true;
    cair: true;
    submissionPackages: true;
  };
  sourceDocuments: SourceDocument[];
  guardrails: string[];
}

export interface Report {
  id: string;
  project_id: string;
  mode: "draft" | "deadline" | "competition-ready" | "export";
  status: "rendering" | "complete" | "failed";
  pdf_sha256: string | null;
  pdf_bytes: number | null;
  page_count: number | null;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
  downloadUrl: string | null;
  validation: ValidationResult;
  sourceHashes: Record<string, string>;
}

export interface Evidence {
  id: string;
  node_id: string | null;
  project_id: string;
  kind:
    | "drawing"
    | "image"
    | "datasheet"
    | "manufacturing"
    | "bulk-deviation"
    | "other";
  display_name: string;
  content_sha256: string;
  mime_type: string;
  visibility: "internal" | "report";
  report_caption: string;
  version: number;
  created_at: string;
  updated_at: string;
  viewUrl: string;
  thumbnailUrl?: string | null;
  downloadUrl: string;
}

export interface ImportIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  rowNumber?: number;
  field?: string;
}

export interface ImportRowProvenance {
  rowNumber: number;
  rawCells: string[];
  namedCells: Record<string, string>;
}

export interface LegacyImportRecord {
  recordKind: "assembly" | "component";
  system: string | null;
  hla: string | null;
  subassembly: string | null;
  partNumber: string;
  sourceKey: string | null;
  assemblyName: string | null;
  componentName: string | null;
  quantityOnCar: number | null;
  provenance: ImportRowProvenance;
}

export interface AssemblyImportClaim {
  system: string;
  hla: string;
  assemblyName: string | null;
  ownerName: string | null;
  sourceKey: string;
  provenance: ImportRowProvenance;
}

export interface ImportPreview {
  id: string;
  projectId: string;
  sourceName: string;
  sourceSha256: string;
  status: "preview" | "committed" | "cancelled";
  version: number;
  preview: {
    template: "legacy-master" | "assembly-index" | "unknown";
    encoding: "utf-8" | "windows-1252";
    readOnly: true;
    issues: ImportIssue[];
    rawRows: Array<{ rowNumber: number; cells: string[] }>;
    records?: LegacyImportRecord[];
    claims?: AssemblyImportClaim[];
    stats: Record<string, number>;
  };
  createdAt: string;
  committedAt: string | null;
  cancelledAt: string | null;
  createdBy: {
    id: string;
    displayName: string;
    email: string;
  };
}

export interface ImportCommitResult {
  batchId: string;
  status: "committed";
  version: number;
  insertedNodes: number;
  skippedRows: number;
  alreadyCommitted: boolean;
  committedAt: string;
}

export interface ImportBatchSummary {
  id: string;
  projectId: string;
  sourceName: string;
  sourceSha256: string;
  template: ImportPreview["preview"]["template"];
  status: ImportPreview["status"];
  version: number;
  createdAt: string;
  committedAt: string | null;
  cancelledAt: string | null;
  createdBy: ImportPreview["createdBy"];
  errors: number;
  warnings: number;
  insertedNodes: number;
  skippedRows: number;
}

export interface AuditEntry {
  sequence: string;
  previousHash: string | null;
  entryHash: string;
  actor: {
    id: string;
    displayName: string;
    email: string;
  } | null;
  projectId: string | null;
  requestId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
  occurredAt: string;
}

export interface Artifact {
  id: string;
  project_id: string;
  kind:
    | "cost-report"
    | "supporting-workbook"
    | "cost-amendment"
    | "submission-manifest"
    | "submission-package"
    | "other";
  status: "reserved" | "complete" | "failed";
  content_sha256: string | null;
  byte_size: string | number | null;
  mime_type: string | null;
  report_snapshot_id: string | null;
  metadata_json: Record<string, unknown>;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
  version: number;
  downloadUrl: string | null;
}

export interface CairRequest {
  id: string;
  project_id: string;
  cost_line_id: string | null;
  status:
    | "draft"
    | "submitted"
    | "catalogue-resolved"
    | "rejected"
    | "cancelled";
  requested_catalogue_description: string;
  rationale: string;
  proposed_cost: string | null;
  provenance_json: Record<string, unknown>;
  external_reference: string | null;
  decision_note: string | null;
  resolved_catalogue_release_id: string | null;
  resolved_catalogue_item_id: string | null;
  created_by: string;
  updated_by: string;
  decided_by: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  version: number;
}

export interface CairEvidenceAttachment {
  evidence_id: string;
  display_name: string;
  kind: string;
  mime_type: string;
  content_sha256: string;
  byte_size: string | null;
  evidence_version: number;
  attached_by: string;
  attached_by_display_name: string;
  attached_at: string;
  frozen_content_sha256: string | null;
  frozen_byte_size: string | null;
  frozen_evidence_version: number | null;
  frozen_metadata_json: Record<string, unknown> | null;
  frozen_at: string | null;
  download_url: string;
}

export interface CairRequestDetail extends CairRequest {
  attachments: CairEvidenceAttachment[];
}

export interface CostAmendment {
  id: string;
  project_id: string;
  event_reference: string;
  status:
    | "draft"
    | "locked"
    | "exported"
    | "manually-submitted"
    | "accepted"
    | "rejected";
  base_report_snapshot_id: string;
  total_additions: string;
  total_removals: string;
  net_change: string;
  external_reference: string | null;
  created_by: string;
  updated_by: string;
  locked_by: string | null;
  submitted_by: string | null;
  decided_by: string | null;
  created_at: string;
  updated_at: string;
  locked_at: string | null;
  exported_at: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  version: number;
}

export interface WorkflowIssue {
  code: string;
  severity: "blocker" | "warning" | "notice";
  message: string;
  itemIds?: string[];
}

export interface CostAmendmentDetail {
  amendment: CostAmendment;
  items: CostAmendmentItem[];
  blockers: WorkflowIssue[];
  baseReport: {
    catalogueReleaseId: string;
    catalogueRevision: string;
    parts: CostAmendmentBasePart[];
  };
}

export interface CostAmendmentBasePart {
  id: string;
  fullNumber: string | null;
  referenceId: string | null;
  name: string;
  quantity: string;
  breakdown: CostBreakdown;
}

export interface CostAmendmentItem {
  id: string;
  amendment_id: string;
  action: "add" | "remove";
  node_id: string | null;
  description: string;
  cost_box: CostLine["kind"];
  classification:
    | "new"
    | "deleted"
    | "modified"
    | "quantity-change"
    | "unresolved";
  change_group_id: string | null;
  quantity: string;
  original_quantity: string;
  revised_quantity: string;
  unit_cost: string;
  subtotal: string;
  source_json: {
    partIdentity: string;
    partNumber: string;
    catalogueReleaseId: string;
    catalogueItemId: string;
    catalogueId: string;
    catalogueItemName?: string;
    sizeInputs?: Record<string, string>;
    derivedFrom?: string;
    [key: string]: unknown;
  };
  sort_order: number;
}

export interface CostAmendmentItemInput {
  expectedAmendmentVersion: number;
  action: CostAmendmentItem["action"];
  partIdentity: string;
  catalogueItemId: string;
  sizeInputs?: Record<string, string>;
  description: string;
  classification: CostAmendmentItem["classification"];
  changeGroupId?: string | null;
  quantity: string;
  originalQuantity: string;
  revisedQuantity: string;
  sortOrder?: number;
}

export interface Submission {
  id: string;
  project_id: string;
  status: "prepared" | "exported" | "manually-submitted";
  report_snapshot_id: string;
  cost_amendment_id: string | null;
  supporting_artifact_id: string;
  amendment_artifact_id: string | null;
  manifest_artifact_id: string;
  package_artifact_id: string;
  manifest_json: Record<string, unknown>;
  external_reference: string | null;
  prepared_by: string;
  exported_by: string | null;
  submitted_by: string | null;
  prepared_at: string;
  exported_at: string | null;
  submitted_at: string | null;
  version: number;
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(
    message: string,
    status: number,
    code: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const headers = new Headers(options?.headers);
  const method = (options?.method ?? "GET").toUpperCase();
  if (UNSAFE_METHODS.has(method) && csrfToken && !headers.has(CSRF_HEADER)) {
    headers.set(CSRF_HEADER, csrfToken);
  }
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | {
          error?: {
            code?: string;
            message?: string;
            validation?: unknown;
            issues?: unknown;
          };
        }
      | null;
    const error = new ApiError(
      body?.error?.message ?? `Request failed (${response.status})`,
      response.status,
      body?.error?.code ?? "request-failed",
      body?.error?.validation ?? body?.error?.issues,
    );
    if (response.status === 401) {
      csrfToken = null;
      for (const listener of authenticationRequiredListeners) {
        listener();
      }
    }
    throw error;
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function requestDownload(
  url: string,
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      body?.error?.message ?? `Request failed (${response.status})`,
      response.status,
      body?.error?.code ?? "request-failed",
    );
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? "ucm-workspace.ucm.zip";
  return { blob: await response.blob(), filename };
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CSRF_HEADER = "x-csrf-token";
const authenticationRequiredListeners = new Set<() => void>();
let csrfToken: string | null = null;

function rememberSession(session: AuthSession): AuthSession {
  csrfToken = session.csrfToken;
  return session;
}

function forgetSession(): void {
  csrfToken = null;
}

export function onAuthenticationRequired(listener: () => void): () => void {
  authenticationRequiredListeners.add(listener);
  return () => authenticationRequiredListeners.delete(listener);
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function formWithFile(
  file: File,
  fields: Record<string, string | number | boolean>,
): FormData {
  const body = new FormData();
  body.append("file", file);
  for (const [key, value] of Object.entries(fields)) {
    body.append(key, String(value));
  }
  return body;
}

export const api = {
  currentSession: () =>
    request<AuthSession>("/api/auth/me").then(rememberSession),
  login: (email: string, key: string) =>
    request<AuthSession>(
      "/api/auth/login",
      json({ email, key }),
    ).then(rememberSession),
  logout: async () => {
    await request<void>("/api/auth/logout", { method: "POST" });
    forgetSession();
  },
  meta: () => request<Meta>("/api/meta"),
  workspace: () => request<ProjectDetail>("/api/workspace"),
  projects: () => request<{ projects: ProjectSummary[] }>("/api/projects"),
  project: (projectId: string) =>
    request<ProjectDetail>(`/api/projects/${projectId}`),
  updateWorkspace: (
    projectId: string,
    body: {
      expectedVersion: number;
      status?: "draft" | "review";
      projectSummary?: string;
      numberingConvention?: string;
      bulkMethodSummary?: string;
    },
  ) =>
    request<{ project: ProjectSummary }>(
      `/api/projects/${projectId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  confirmReportSetup: (projectId: string, expectedVersion: number) =>
    request<{ project: ProjectSummary }>(
      `/api/projects/${projectId}/declarations`,
      json({ expectedVersion, attested: true }),
    ),
  workspaceActivity: (projectId: string, beforeSequence?: string) => {
    const query = beforeSequence
      ? `?cursor=${encodeURIComponent(beforeSequence)}`
      : "";
    return request<{
      entries: AuditEntry[];
      nextCursor: string | null;
    }>(`/api/projects/${projectId}/activity${query}`);
  },
  previewHistoricalProject: (
    file: File,
    input: {
      season: number;
      name: string;
      entryNumber: string;
      vehicleType: ProjectSummary["vehicle_type"];
    },
  ) => {
    const body = formWithFile(file, input);
    return request<HistoricalProjectPreview>("/api/historical-projects/preview", {
      method: "POST",
      body,
    });
  },
  commitHistoricalProject: (
    file: File,
    input: {
      season: number;
      name: string;
      entryNumber: string;
      vehicleType: ProjectSummary["vehicle_type"];
      expectedSourceSha256: string;
      idempotencyKey: string;
    },
  ) => {
    const body = formWithFile(file, { ...input, commitValidOnly: true });
    return request<{ project: ProjectSummary; alreadyImported: boolean }>(
      "/api/historical-projects/commit",
      { method: "POST", body },
    );
  },
  previewProjectCopy: (input: ProjectCopyRequest) =>
    request<ProjectCopyPreview>("/api/project-copy/preview", json(input)),
  commitProjectCopy: (
    input: ProjectCopyRequest & { previewHash: string; idempotencyKey: string },
  ) =>
    request<{
      operationId: string;
      targetProjectId: string;
      rootNodeId: string;
      createdNodeIds: string[];
      copiedCostLines: number;
      skippedCostLines: number;
      copiedEvidence: number;
      alreadyCommitted: boolean;
    }>("/api/project-copy/commit", json(input)),
  downloadProjectArchive: (projectId: string) =>
    requestDownload(`/api/project-archives/${projectId}/download`),
  previewProjectArchive: (
    file: File,
    input: {
      targetSeason: number;
      targetName: string;
      targetEntryNumber: string;
      targetIsHistorical: boolean;
    },
  ) => {
    const body = formWithFile(file, input);
    return request<ProjectArchivePreview>("/api/project-archives/preview", {
      method: "POST",
      body,
    });
  },
  commitProjectArchive: (
    file: File,
    input: {
      targetSeason: number;
      targetName: string;
      targetEntryNumber: string;
      targetIsHistorical: boolean;
      expectedArchiveSha256: string;
      previewHash: string;
      idempotencyKey: string;
    },
  ) => {
    const body = formWithFile(file, input);
    return request<{
      projectId: string;
      season: number;
      createdNodes: number;
      createdCostLines: number;
      createdEvidence: number;
      alreadyImported: boolean;
    }>("/api/project-archives/commit", { method: "POST", body });
  },
  users: () => request<{ users: UserRecord[] }>("/api/users"),
  createUser: (body: {
    email: string;
    displayName: string;
    role: SystemRole;
  }) =>
    request<{ user: UserRecord }>("/api/users", json(body)),
  updateUser: (
    userId: string,
    body: {
      expectedVersion: number;
      displayName?: string;
      role?: SystemRole;
      status?: Extract<UserStatus, "active" | "disabled">;
    },
  ) =>
    request<{ user: UserRecord }>(`/api/users/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  revokeUserSessions: (userId: string) =>
    request<{ revokedSessions: number }>(
      `/api/users/${userId}/revoke-sessions`,
      { method: "POST" },
    ),
  validation: (projectId: string) =>
    request<ValidationResult>(`/api/projects/${projectId}/validation`),
  updateNode: (
    nodeId: string,
    body: {
      expectedVersion: number;
      name?: string;
      description?: string;
      procurementType?: CostNode["procurement_type"];
      quantity?: string;
      revision?: string | null;
      fullNumber?: string | null;
      referenceId?: string | null;
      internalNote?: string;
      drawingRequired?: boolean;
      workStatus?: "none" | "needs-attention" | "done";
      flagComment?: string;
      imageRequired?: boolean;
      imageRequirementReason?: string;
    },
  ) =>
    request<{ node: CostNodeRecord }>(`/api/nodes/${nodeId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  moveNode: (
    nodeId: string,
    body: {
      expectedVersion: number;
      targetParentId: string;
      expectedTargetParentVersion: number;
      kind: Extract<NodeKind, "assembly" | "subassembly" | "part">;
    },
  ) =>
    request<{ node: CostNodeRecord }>(`/api/nodes/${nodeId}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  createNode: (
    parentId: string,
    body: {
      expectedParentVersion: number;
      kind: Extract<
        NodeKind,
        "system" | "assembly" | "subassembly" | "part"
      >;
      name: string;
      systemCode?: string;
      description?: string;
      procurementType?: CostNode["procurement_type"];
      quantity?: string;
      revision?: string | null;
      fullNumber?: string | null;
      referenceId?: string | null;
      internalNote?: string;
    },
  ) =>
    request<{ node: CostNodeRecord }>(
      `/api/nodes/${parentId}/children`,
      json(body),
    ),
  reorderNodeChildren: (
    parentId: string,
    expectedParentVersion: number,
    childIds: string[],
  ) =>
    request<{ parentVersion: number; childIds: string[] }>(
      `/api/nodes/${parentId}/children/order`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedParentVersion, childIds }),
      },
    ),
  deleteNode: (
    nodeId: string,
    expectedVersion: number,
    cascade: boolean,
  ) => {
    const params = new URLSearchParams({
      expectedVersion: String(expectedVersion),
      cascade: String(cascade),
    });
    return request<void>(`/api/nodes/${nodeId}?${params}`, {
      method: "DELETE",
    });
  },
  createCostLine: (nodeId: string, body: Record<string, unknown>) =>
    request<{ line: CostLine }>(
      `/api/nodes/${nodeId}/cost-lines`,
      json(body),
    ),
  searchHistoricalCostSources: (nodeId: string, query: string) =>
    request<{ sourceProject: { id: string; name: string; season: number } | null; items: HistoricalCostSource[]; hasMore: boolean }>(
      `/api/nodes/${nodeId}/cost-lines/import-2025/sources?${new URLSearchParams({ q: query })}`,
    ),
  historicalSourceCosts: (nodeId: string, sourceNodeId: string) =>
    request<{ items: HistoricalCostLineSearchItem[] }>(
      `/api/nodes/${nodeId}/cost-lines/import-2025/sources/${sourceNodeId}`,
    ),
  importHistoricalCostLines: (nodeId: string, sourceNodeId: string, sourceLineIds: string[]) =>
    request<{ results: HistoricalCostLineImportResult[]; warnings: string[] }>(
      `/api/nodes/${nodeId}/cost-lines/import-2025/batch`, json({ sourceNodeId, sourceLineIds }),
    ),
  searchHistoricalCostLines: (
    nodeId: string,
    query: string,
    limit = 40,
  ) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return request<HistoricalCostLineSearchResult>(
      `/api/nodes/${nodeId}/cost-lines/import-2025?${params}`,
    );
  },
  importHistoricalCostLine: (nodeId: string, sourceLineId: string) =>
    request<HistoricalCostLineImportResult>(
      `/api/nodes/${nodeId}/cost-lines/import-2025`,
      json({ sourceLineId }),
    ),
  updateCostLine: (lineId: string, body: Record<string, unknown>) =>
    request<{ line: CostLine }>(`/api/cost-lines/${lineId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteCostLine: (lineId: string, expectedVersion: number) =>
    request<void>(
      `/api/cost-lines/${lineId}?expectedVersion=${expectedVersion}`,
      { method: "DELETE" },
    ),
  reorderCostLines: (
    nodeId: string,
    kind: CostLine["kind"],
    lines: { id: string; expectedVersion: number }[],
  ) =>
    request<void>(`/api/nodes/${nodeId}/cost-lines/order`, {
      ...json({ kind, lines }),
      method: "PATCH",
    }),
  deleteCostLines: (
    nodeId: string,
    lines: { id: string; expectedVersion: number }[],
  ) =>
    request<void>(
      `/api/nodes/${nodeId}/cost-lines/delete-batch`,
      json({ lines }),
    ),
  catalogue: (
    releaseId: string,
    kind: CatalogueItemKind,
    query: string,
    limit = 40,
  ) => {
    const params = new URLSearchParams({
      releaseId,
      kind,
      q: query,
      limit: String(limit),
    });
    return request<{ items: CatalogueItem[] }>(
      `/api/catalogue?${params}`,
    );
  },
  catalogueItem: (releaseId: string, itemId: string) => {
    const params = new URLSearchParams({ releaseId });
    return request<{ item: CatalogueItem }>(
      `/api/catalogue/${itemId}?${params}`,
    );
  },
  createTeamCatalogueItem: (body: CataloguePublicationInput) =>
    request<{ item: CatalogueItem }>("/api/catalogue/team", json(body)),
  reviseCatalogueItem: (
    itemId: string,
    body: CataloguePublicationInput & { expectedRevision: number },
  ) =>
    request<{ item: CatalogueItem }>(
      `/api/catalogue/${itemId}/revisions`,
      json(body),
    ),
  previewImport: (projectId: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<ImportPreview>(
      `/api/projects/${projectId}/imports/preview`,
      { method: "POST", body },
    );
  },
  importBatches: (
    projectId: string,
    options: {
      status?: ImportPreview["status"];
      cursor?: string;
      limit?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return request<{
      batches: ImportBatchSummary[];
      nextCursor: string | null;
    }>(
      `/api/projects/${projectId}/imports${query ? `?${query}` : ""}`,
    );
  },
  importPreview: (batchId: string) =>
    request<ImportPreview>(`/api/imports/${batchId}`),
  cancelImport: (batchId: string, expectedVersion: number) =>
    request<ImportPreview>(`/api/imports/${batchId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion }),
    }),
  commitImport: (
    batchId: string,
    expectedVersion: number,
    commitValidOnly: boolean,
    idempotencyKey: string,
  ) =>
    request<ImportCommitResult>(
      `/api/imports/${batchId}/commit`,
      json({ expectedVersion, commitValidOnly, idempotencyKey }),
    ),
  evidence: (projectId: string) =>
    request<{ evidence: Evidence[] }>(
      `/api/projects/${projectId}/evidence`,
    ),
  uploadEvidence: (
    projectId: string,
    file: File,
    input: {
      kind: Evidence["kind"];
      nodeId?: string | null;
      reportCaption: string;
    },
  ) => {
    const body = new FormData();
    body.append("file", file);
    body.append("kind", input.kind);
    if (input.nodeId) body.append("nodeId", input.nodeId);
    body.append("visibility", "report");
    body.append("reportCaption", input.reportCaption);
    return request<{ evidence: Evidence }>(
      `/api/projects/${projectId}/evidence`,
      { method: "POST", body },
    );
  },
  updateEvidence: (
    evidenceId: string,
    input: {
      expectedVersion: number;
      visibility?: Evidence["visibility"];
      reportCaption?: string;
    },
  ) =>
    request<{ evidence: Evidence }>(`/api/evidence/${evidenceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  replaceEvidence: (
    evidenceId: string,
    file: File,
    expectedVersion: number,
  ) => {
    const body = new FormData();
    body.append("file", file);
    body.append("expectedVersion", String(expectedVersion));
    return request<{ evidence: Evidence }>(
      `/api/evidence/${evidenceId}/file`,
      { method: "PUT", body },
    );
  },
  deleteEvidence: (evidenceId: string, expectedVersion: number) =>
    request<void>(
      `/api/evidence/${evidenceId}?expectedVersion=${expectedVersion}`,
      { method: "DELETE" },
    ),
  reports: (projectId: string) =>
    request<{ reports: Report[] }>(
      `/api/projects/${projectId}/reports`,
    ),
  createReport: (
    projectId: string,
    mode: Report["mode"],
  ) =>
    request<{ report: Report }>(
      `/api/projects/${projectId}/reports`,
      json({ mode }),
    ),
  createSupportingWorkbook: (reportId: string) =>
    request<{ artifact: Artifact }>(
      `/api/reports/${reportId}/supporting-workbook`,
      { method: "POST" },
    ),
  artifacts: (projectId: string) =>
    request<{ artifacts: Artifact[] }>(
      `/api/projects/${projectId}/artifacts`,
    ),
  cairs: (projectId: string) =>
    request<{ cairs: CairRequestDetail[] }>(
      `/api/projects/${projectId}/cairs`,
    ),
  createCair: (
    projectId: string,
    body: {
      costLineId?: string | null;
      requestedCatalogueDescription: string;
      rationale: string;
      proposedCost?: string | null;
      provenance?: Record<string, unknown>;
    },
  ) =>
    request<{ cair: CairRequest }>(
      `/api/projects/${projectId}/cairs`,
      json(body),
    ),
  updateCair: (
    cairId: string,
    body: {
      expectedVersion: number;
      costLineId?: string | null;
      requestedCatalogueDescription: string;
      rationale: string;
      proposedCost?: string | null;
      provenance?: Record<string, unknown>;
    },
  ) =>
    request<{ cair: CairRequest }>(
      `/api/cairs/${cairId}`,
      { ...json(body), method: "PUT" },
    ),
  transitionCair: (
    cairId: string,
    body: {
      expectedVersion: number;
      next:
        | "submitted"
        | "catalogue-resolved"
        | "rejected"
        | "cancelled";
      externalReference?: string | null;
      decisionNote?: string | null;
      resolvedCatalogueReleaseId?: string | null;
      resolvedCatalogueItemId?: string | null;
    },
  ) =>
    request<{ cair: CairRequestDetail }>(
      `/api/cairs/${cairId}/transitions`,
      json(body),
    ),
  attachCairEvidence: (
    cairId: string,
    evidenceId: string,
    expectedVersion: number,
  ) =>
    request<{ cair: CairRequestDetail }>(
      `/api/cairs/${cairId}/evidence`,
      json({ evidenceId, expectedVersion }),
    ),
  detachCairEvidence: (
    cairId: string,
    evidenceId: string,
    expectedVersion: number,
  ) =>
    request<{ cair: CairRequestDetail }>(
      `/api/cairs/${cairId}/evidence/${evidenceId}`,
      { ...json({ expectedVersion }), method: "DELETE" },
    ),
  costAmendments: (projectId: string) =>
    request<{ amendments: CostAmendment[] }>(
      `/api/projects/${projectId}/cost-amendments`,
    ),
  createCostAmendment: (
    projectId: string,
    body: { eventReference: string; baseReportSnapshotId: string },
  ) =>
    request<{ amendment: CostAmendment }>(
      `/api/projects/${projectId}/cost-amendments`,
      json(body),
    ),
  costAmendment: (amendmentId: string) =>
    request<CostAmendmentDetail>(
      `/api/cost-amendments/${amendmentId}`,
    ),
  addCostAmendmentItem: (
    amendmentId: string,
    body: CostAmendmentItemInput,
  ) =>
    request<CostAmendmentDetail>(
      `/api/cost-amendments/${amendmentId}/items`,
      json(body),
    ),
  updateCostAmendmentItem: (
    amendmentId: string,
    itemId: string,
    body: CostAmendmentItemInput,
  ) =>
    request<CostAmendmentDetail>(
      `/api/cost-amendments/${amendmentId}/items/${itemId}`,
      { ...json(body), method: "PUT" },
    ),
  deleteCostAmendmentItem: (
    amendmentId: string,
    itemId: string,
    expectedAmendmentVersion: number,
  ) =>
    request<CostAmendmentDetail>(
      `/api/cost-amendments/${amendmentId}/items/${itemId}`,
      {
        ...json({ expectedAmendmentVersion }),
        method: "DELETE",
      },
    ),
  createCostAmendmentPreview: (amendmentId: string) =>
    request<{ artifact: Artifact }>(
      `/api/cost-amendments/${amendmentId}/preview`,
      { method: "POST" },
    ),
  checkCostAmendmentLock: (amendmentId: string) =>
    request<void>(`/api/cost-amendments/${amendmentId}/lock`, {
      method: "POST",
    }),
  submissions: (projectId: string) =>
    request<{ submissions: Submission[] }>(
      `/api/projects/${projectId}/submissions`,
    ),
  prepareSubmission: (
    projectId: string,
    body: { reportSnapshotId: string; supportingArtifactId: string },
  ) =>
    request<{
      submission: Submission;
      packageArtifact: Artifact;
      manifestArtifact: Artifact;
    }>(
      `/api/projects/${projectId}/submissions/prepare`,
      json(body),
    ),
  markSubmissionExported: (
    submissionId: string,
    expectedVersion: number,
  ) =>
    request<{ submission: Submission }>(
      `/api/submissions/${submissionId}/exported`,
      json({ expectedVersion }),
    ),
  recordManualSubmission: (
    submissionId: string,
    expectedVersion: number,
    externalReference: string,
  ) =>
    request<{ submission: Submission }>(
      `/api/submissions/${submissionId}/manual-submission`,
      json({ expectedVersion, externalReference }),
    ),
};

export function universal(value: string | number): string {
  return Number(value).toLocaleString("en-NZ", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
