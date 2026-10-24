import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          AGENTPOST_ADMIN_TOKEN: "test-admin-token-with-at-least-32-characters",
          AGENTPOST_CF_ACCOUNT_ID: "test-account",
          AGENTPOST_CF_EMAIL_API_TOKEN: "test-provider-token",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
        queueConsumers: {},
      },
    }),
  ],
  test: { include: ["test/*.test.ts"], fileParallelism: false },
});
