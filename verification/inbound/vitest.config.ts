import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import base from "../../vitest.config.ts";

export default defineConfig({
  ...base,
  resolve: {
    alias: process.env.AGENTPOST_FORMAL_INBOUND_MUTANT
      ? {
          "../../src/inbound": resolve(process.env.AGENTPOST_FORMAL_INBOUND_MUTANT),
          "./inbound": resolve(process.env.AGENTPOST_FORMAL_INBOUND_MUTANT),
        }
      : {},
  },
  test: { ...base.test, include: ["verification/inbound/replay.test.ts"] },
});
