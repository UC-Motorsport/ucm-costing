import { defineConfig } from "tsup";

const developmentBuild = process.env.UCM_BUILD_MODE === "development";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/migrate": "src/cli/migrate.ts",
    "cli/create-admin": "src/cli/create-admin.ts",
    "cli/verify-audit-ledger": "src/cli/verify-audit-ledger.ts",
    ...(developmentBuild
      ? { "cli/seed-development": "src/cli/seed-development.ts" }
      : {}),
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      developmentBuild ? "development" : "production",
    ),
  },
  noExternal: ["@ucm/domain"],
});
