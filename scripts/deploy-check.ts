import { z } from "zod";
import { authConfiguration } from "../src/auth-config";

const config = z
  .object({
    vars: z.object({
      AGENTPOST_EMAIL_DOMAIN: z.hostname(),
      AGENTPOST_AUTH_MODE: z.enum(["token", "oauth", "both"]).optional(),
      AGENTPOST_ACCESS_TEAM_DOMAIN: z.string().optional(),
      AGENTPOST_ACCESS_AUD: z.string().optional(),
      AGENTPOST_ACCESS_PRINCIPALS: z.string().optional(),
      AGENTPOST_OAUTH_RESOURCE_URL: z.string().optional(),
      AGENTPOST_OAUTH_AUTHORIZATION_SERVER: z.string().optional(),
    }),
    d1_databases: z.array(z.object({ binding: z.string(), database_id: z.uuid() })),
  })
  .parse(Bun.JSONC.parse(await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text()));

// Remote Workers Secrets are unavailable here; runtime checks their actual values.
authConfiguration({
  ...config.vars,
  AGENTPOST_ADMIN_TOKEN: "preflight-placeholder-for-remote-secret-validation",
  AGENTPOST_CURSOR_KEY: "preflight-placeholder-for-remote-secret-validation",
});

const domain = config.vars.AGENTPOST_EMAIL_DOMAIN.toLowerCase();
if (
  ["example.com", "example.net", "example.org", "localhost"].includes(domain) ||
  !domain.includes(".") ||
  domain.endsWith(".invalid")
) {
  throw new Error(
    "Set AGENTPOST_EMAIL_DOMAIN in wrangler.jsonc to your purchased and verified domain before deploying",
  );
}
const database = config.d1_databases.find((entry) => entry.binding === "DB");
if (!database || database.database_id === "00000000-0000-0000-0000-000000000000") {
  throw new Error("Set the real D1 database_id in wrangler.jsonc before deploying");
}
console.log(
  "Deployment domain and authentication settings checked (remote secrets not inspected). Domain activation, secrets and mail delivery still require live verification.",
);
