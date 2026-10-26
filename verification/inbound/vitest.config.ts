import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import base from "../../vitest.config.ts";

export default defineConfig({
  ...base,
  resolve: {
    alias: process.env.AGENTPOST_FORMAL_INBOUND_MUTANT
      ? Object.fromEntries(
          ["../src/", "../../src/", "./"].map((prefix) => [
            `${prefix}${process.env.AGENTPOST_FORMAL_MUTANT_MODULE ?? "inbound"}`,
            resolve(process.env.AGENTPOST_FORMAL_INBOUND_MUTANT!),
          ]),
        )
      : {},
  },
  test: {
    ...base.test,
    include: ["verification/inbound/replay.test.ts", "test/forwarding.test.ts"],
  },
});
