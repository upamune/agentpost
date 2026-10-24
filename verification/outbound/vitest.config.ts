import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import base from "../../vitest.config.ts";

export default defineConfig({
  ...base,
  resolve: {
    alias: process.env.AGENTPOST_FORMAL_MUTANT
      ? { "../../src/outbound": resolve(process.env.AGENTPOST_FORMAL_MUTANT) }
      : {},
  },
  test: { ...base.test, include: ["verification/outbound/replay.test.ts"] },
});
