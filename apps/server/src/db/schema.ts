/**
 * Canonical PostgreSQL relation names.
 *
 * The executable schema lives in `migrations.ts`. Keeping this module free of
 * an ORM prevents a second, drifting schema definition and makes it safe for
 * services and tests to share stable relation names.
 */
export const tables = {
  appMetadata: "app_metadata",
  sourceDocuments: "source_documents",
  catalogueReleases: "catalogue_releases",
  catalogueItems: "catalogue_items",
  users: "users",
  userInvites: "user_invites",
  sessions: "sessions",
  projects: "projects",
  projectMemberships: "project_memberships",
  projectSetupConfirmations: "project_setup_confirmations",
  costNodes: "cost_nodes",
  costLines: "cost_lines",
  evidence: "evidence",
  importBatches: "import_batches",
  importRows: "import_rows",
  importIssues: "import_issues",
  reportSnapshots: "report_snapshots",
  evidenceFileCleanup: "evidence_file_cleanup",
  cairRequests: "cair_requests",
  cairEvidence: "cair_evidence",
  costAmendments: "cost_amendments",
  costAmendmentItems: "cost_amendment_items",
  artifacts: "artifacts",
  submissions: "submissions",
  submissionPreparations: "submission_preparations",
  auditLedger: "audit_ledger",
} as const;
