import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import base from "../../vitest.config.ts";

export default defineConfig({
  ...base,
  resolve: {
    alias: process.env.AGENTPOST_FORMAL_MUTANT
      ? [
          {
            find: new RegExp(
              `^(?:\\.\\.?/)+(?:src/)?${process.env.AGENTPOST_FORMAL_MUTANT_MODULE}$`,
            ),
            replacement: resolve(process.env.AGENTPOST_FORMAL_MUTANT),
          },
          {
            find: resolve(`src/${process.env.AGENTPOST_FORMAL_MUTANT_MODULE}.ts`),
            replacement: resolve(process.env.AGENTPOST_FORMAL_MUTANT),
          },
        ]
      : [],
  },
  test: { ...base.test, include: ["verification/outbound/*.test.ts"] },
});
