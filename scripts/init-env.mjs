import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const origin = process.argv[2];
if (process.argv.length !== 3 || !origin) {
  console.error("Usage: npm run env:init -- https://costing.example.org");
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(origin);
} catch {
  console.error("Provide a valid HTTPS origin.");
  process.exit(1);
}
if (parsed.protocol !== "https:" || parsed.origin !== origin) {
  console.error("Provide only an HTTPS origin, without a path, trailing slash, or credentials.");
  process.exit(1);
}

const keys = [
  "UCM_DB_MIGRATOR_PASSWORD",
  "UCM_DB_APP_PASSWORD",
  "UCM_SHARED_ACCESS_KEY",
  "UCM_VIEWER_ACCESS_KEY",
  "UCM_ADMIN_ACCESS_KEY",
  "UCM_CSRF_SECRET",
  "UCM_AUDIT_IP_SALT",
];
let contents = await readFile(new URL("../.env.example", import.meta.url), "utf8");
for (const key of keys) {
  const placeholder = `${key}=`;
  if (!contents.split("\n").includes(placeholder)) {
    throw new Error(`Missing empty template entry: ${key}`);
  }
  contents = contents.replace(`${placeholder}\n`, `${placeholder}${randomBytes(32).toString("hex")}\n`);
}
contents = contents.replace(/^UCM_ALLOWED_ORIGINS=.*$/m, `UCM_ALLOWED_ORIGINS=${origin}`);
try {
  await writeFile(new URL("../.env", import.meta.url), contents, { flag: "wx", mode: 0o600 });
} catch (error) {
  if (error.code === "EEXIST") {
    console.error("An .env file already exists; it has not been changed. See the deployment runbook to rotate keys.");
    process.exit(1);
  }
  throw error;
}
console.log("Created a private .env with seven independent random secrets. Keep it out of Git.");
console.log("Next: follow docs/operations/DEPLOYMENT.md to start the stack and create your administrator.");
