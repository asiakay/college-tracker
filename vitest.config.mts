import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Base schema for tables owned by repo-dashboard, then this repo's migrations.
  const migrations = [
    ...(await readD1Migrations(path.join(import.meta.dirname, "test/fixtures"))),
    ...(await readD1Migrations(path.join(import.meta.dirname, "migrations"))),
  ];
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
