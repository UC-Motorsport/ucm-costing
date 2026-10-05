import { getDatabase } from "../db/database";
import { installReferenceData } from "../services/reference-data-service";
import { ensureTeamWorkspace } from "../services/workspace-service";

const database = getDatabase();
try {
  const catalogue = await installReferenceData(database);
  const workspace = await ensureTeamWorkspace(database);
  const [identity, projectCount] = await Promise.all([
    database.one<{ database_name: string }>(
      "SELECT current_database() AS database_name",
    ),
    database.one<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM projects",
    ),
  ]);
  console.log(
    JSON.stringify(
      {
        database: identity.database_name,
        catalogue,
        workspace,
        projects: projectCount.count,
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
}
