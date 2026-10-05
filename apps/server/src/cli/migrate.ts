import {
  applyMigrations,
  closeDatabase,
  configureApplicationDatabaseRole,
  databaseMigrationVersion,
  getDatabase,
} from "../db/database";

const database = getDatabase();

try {
  await applyMigrations(database);
  const applicationRole = process.env.UCM_DATABASE_APP_ROLE?.trim() || null;
  if (applicationRole) {
    const applicationRolePassword =
      process.env.UCM_DATABASE_APP_PASSWORD;
    if (!applicationRolePassword) {
      throw new Error(
        "UCM_DATABASE_APP_PASSWORD is required when UCM_DATABASE_APP_ROLE is set",
      );
    }
    await configureApplicationDatabaseRole(
      database,
      applicationRole,
      applicationRolePassword,
    );
  }
  const [identity, migrationVersion] = await Promise.all([
    database.one<{ database_name: string }>(
      "SELECT current_database() AS database_name",
    ),
    databaseMigrationVersion(database),
  ]);
  console.log(
    JSON.stringify(
      {
        database: identity.database_name,
        migrationVersion,
        applicationRole,
      },
      null,
      2,
    ),
  );
} finally {
  await closeDatabase();
}
