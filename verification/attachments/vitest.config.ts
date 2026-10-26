import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import base from "../../vitest.config.ts";

const moduleName = process.env.AGENTPOST_FORMAL_MUTANT_MODULE;
const replacement = process.env.AGENTPOST_FORMAL_MUTANT;
export default defineConfig({
  ...base,
  resolve: {
    alias: replacement
      ? [
          {
            find: new RegExp(`^(?:\\.\\.?/)+(?:src/)?${moduleName}$`),
            replacement: resolve(replacement),
          },
          { find: resolve(`src/${moduleName}.ts`), replacement: resolve(replacement) },
        ]
      : [],
  },
  test: {
    ...base.test,
    include: ["test/attachments.test.ts", "verification/attachments/integrity.test.ts"],
  },
});
