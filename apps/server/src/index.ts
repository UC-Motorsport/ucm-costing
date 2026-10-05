import {
  getAppPaths,
  getHttpSecurityConfig,
  SERVER_PORT,
} from "./config";
import { createApp } from "./app";
import {
  databaseMigrationVersion,
  getDatabase,
  LATEST_DATABASE_MIGRATION,
} from "./db/database";
import {
  reconcileAccessKeys,
  type AccessKeyReconciliation,
} from "./security/auth-service";
import {
  getEvidenceFileCleanupStatus,
  processEvidenceFileCleanup,
} from "./services/evidence-service";
import {
  reconcileStaleReportLeases,
  REPORT_MAINTENANCE_INTERVAL_MS,
} from "./services/report-service";
import { installReferenceData } from "./services/reference-data-service";
import {
  reconcileManagedFiles,
} from "./services/managed-file-reconciliation-service";
import {
  ensureTeamWorkspace,
} from "./services/workspace-service";

const database = getDatabase();
const paths = getAppPaths();
let maintenanceTimer: NodeJS.Timeout | null = null;
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | null = null;

try {
  const migrationVersion = await databaseMigrationVersion(database);
  if (migrationVersion !== LATEST_DATABASE_MIGRATION) {
    throw new Error(
      `database-migration-required:${migrationVersion}->${LATEST_DATABASE_MIGRATION}`,
    );
  }
  const security = getHttpSecurityConfig();
  if (!security.secureSessionCookies) {
    process.stderr.write(
      "WARNING: UCM_ALLOW_INSECURE_HTTP=true; session cookies are not Secure. Bind only to the configured Tailscale IPv4 address and disable this mode before using an HTTPS tunnel.\n",
    );
  }
  if (security.allowWeakAccessKeys) {
    process.stderr.write(
      "WARNING: UCM_ALLOW_WEAK_ACCESS_KEYS=true; short production access keys materially weaken authentication. Keep the application behind independent access controls and rotate to strong keys when possible.\n",
    );
  }
  const accessKeyReconciliation = await reconcileAccessKeys(database, {
    sharedAccessKey: security.sharedAccessKey,
    viewerAccessKey: security.viewerAccessKey,
    adminAccessKey: security.adminAccessKey,
  });
  const catalogue = await installReferenceData(database);
  const workspace = await ensureTeamWorkspace(database);
  const [staleReports, startupCleanup] = await Promise.all([
    reconcileStaleReportLeases(database),
    processEvidenceFileCleanup(database, paths),
  ]);
  const managedFiles = await reconcileManagedFiles(database, paths);
  const cleanupStatus = await getEvidenceFileCleanupStatus(database);
  const app = createApp({
    database,
    paths,
    security,
  });

  server = app.listen(SERVER_PORT, "0.0.0.0", () => {
    process.stdout.write(
      `UCM Costing listening on port ${SERVER_PORT}; PostgreSQL migration ${migrationVersion}; workspace ${workspace.id}${workspace.created ? " provisioned" : " ready"}; catalogue ${catalogue.releaseId} (${catalogue.existing + catalogue.inserted} items); editor access key ${reconciliationState(accessKeyReconciliation.shared)}, viewer access key ${reconciliationState(accessKeyReconciliation.viewer)}, administrator access key ${reconciliationState(accessKeyReconciliation.admin)} (${accessKeyReconciliation.revokedSessions} session(s) revoked); reconciled ${staleReports} stale report lease(s); cleaned ${startupCleanup.removed} evidence file(s) and ${managedFiles.removed} orphan managed file(s); ${cleanupStatus.pending} cleanup item(s) pending\n`,
    );
  });

  let maintenanceRunning = false;
  maintenanceTimer = setInterval(() => {
    if (maintenanceRunning) {
      return;
    }
    maintenanceRunning = true;
    void runMaintenance()
      .catch((error: unknown) => {
        process.stderr.write(
          `UCM maintenance failed: ${
            error instanceof Error ? error.message : "unknown error"
          }\n`,
        );
      })
      .finally(() => {
        maintenanceRunning = false;
      });
  }, REPORT_MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();
} catch (error) {
  await database.close().catch(() => undefined);
  throw error;
}

function reconciliationState(
  reconciliation: AccessKeyReconciliation,
): "initialized" | "rotated" | "unchanged" {
  if (reconciliation.initialized) {
    return "initialized";
  }
  return reconciliation.rotated ? "rotated" : "unchanged";
}

const shutdown = async (signal: string): Promise<void> => {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
  }
  process.stdout.write(`Received ${signal}; stopping UCM Costing\n`);
  const activeServer = server;
  if (activeServer) {
    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
  await database.close();
};

process.once("SIGINT", () => {
  void shutdown("SIGINT")
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(
        `Shutdown failed: ${
          error instanceof Error ? error.message : "unknown error"
        }\n`,
      );
      process.exit(1);
    });
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM")
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(
        `Shutdown failed: ${
          error instanceof Error ? error.message : "unknown error"
        }\n`,
      );
      process.exit(1);
    });
});

async function runMaintenance(): Promise<void> {
  const [reconciled, cleanup] = await Promise.all([
    reconcileStaleReportLeases(database),
    processEvidenceFileCleanup(database, paths),
  ]);
  const status = await getEvidenceFileCleanupStatus(database);
  if (reconciled > 0 || cleanup.failed > 0) {
    process.stderr.write(
      `UCM maintenance reconciled ${reconciled} stale report lease(s); cleanup processed ${cleanup.processed}, removed ${cleanup.removed}, failed ${cleanup.failed}; ${status.pending} pending\n`,
    );
  }
}
