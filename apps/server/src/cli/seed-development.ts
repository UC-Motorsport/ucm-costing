import { closeDatabase, getDatabase } from "../db/database";
import {
  assertDevelopmentAccountEnabled,
  DEVELOPMENT_LOGIN,
  ensureDevelopmentAdministrator,
} from "../development/development-account";
import { installReferenceData } from "../services/reference-data-service";
import { ensureTeamWorkspace } from "../services/workspace-service";

assertDevelopmentAccountEnabled();
const database = getDatabase();

try {
  await installReferenceData(database);
  const workspace = await ensureTeamWorkspace(database);
  const result = await ensureDevelopmentAdministrator(database);
  process.stdout.write(
    `${JSON.stringify(
      {
        created: result.created,
        reconciled: result.reconciled,
        user: {
          id: result.user.id,
          email: result.user.email,
          displayName: result.user.display_name,
          role: result.user.role,
          status: result.user.status,
        },
        login: {
          email: DEVELOPMENT_LOGIN.email,
          developmentOnly: true,
        },
        workspace,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await closeDatabase();
}
