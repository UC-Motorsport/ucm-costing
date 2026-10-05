import { closeDatabase, getDatabase } from "../db/database";
import { bootstrapAdministrator } from "../security/auth-service";

const args = parseArguments(process.argv.slice(2));

const database = getDatabase();
try {
  const user = await bootstrapAdministrator(database, {
    email: args.email,
    displayName: args.displayName,
  });
  process.stdout.write(
    `Created administrator ${user.email} (${user.id}). They can sign in with the configured administrator access key.\n`,
  );
} finally {
  await closeDatabase();
}

function parseArguments(values: string[]): {
  email: string;
  displayName: string;
} {
  let email = "";
  let displayName = "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--email") {
      email = values[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (value === "--name") {
      displayName = values[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value ?? ""}`);
  }
  if (!email || !displayName) {
    throw new Error(
      "Usage: npm run user:create-admin -- --email admin@example.org --name \"Admin Name\"",
    );
  }
  return { email, displayName };
}
