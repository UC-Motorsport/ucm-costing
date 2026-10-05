import path from "node:path";

import { getAppPaths } from "../config";
import { getDatabase } from "../db/database";
import { bootstrapAdministrator } from "../security/auth-service";
import type { ActorContext } from "../security/authorization";
import {
  copyReportToOutput,
  createReport,
} from "../services/report-service";
import {
  DEMO_PROJECT_ID,
  seedDemoProject,
} from "../services/demo-seed-service";

if (process.env.NODE_ENV === "production") {
  throw new Error("demo-report-disabled-in-production");
}

const database = getDatabase();
try {
  await seedDemoProject(database);
  let administrator = await database.maybeOne<{
    id: string;
    role: "admin";
  }>(
    `
      SELECT id, role
      FROM users
      WHERE role = 'admin' AND status = 'active'
      ORDER BY created_at, id
      LIMIT 1
    `,
  );
  if (!administrator) {
    const created = await bootstrapAdministrator(database, {
      email: "demo-admin@localhost.invalid",
      displayName: "Demo Administrator",
    });
    administrator = { id: created.id, role: "admin" };
  }
  const actor: ActorContext = {
    actorUserId: administrator.id,
    systemRole: "admin",
    requestId: "cli:report-demo",
  };
  const report = await createReport(
    database,
    actor,
    DEMO_PROJECT_ID,
    "draft",
    { paths: getAppPaths(), developerDemo: true },
  );
  const output = await copyReportToOutput(
    database,
    actor,
    report.id,
    "ucm-2026-demo-cost-report.pdf",
  );

  console.log(
    JSON.stringify(
      {
        reportId: report.id,
        pdf: path.resolve(output),
        sha256: report.pdf_sha256,
        bytes: report.pdf_bytes,
        pages: report.page_count,
        developerDemo: true,
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
}
