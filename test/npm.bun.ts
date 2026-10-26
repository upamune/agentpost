import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { npmArchiveName, npmPackageName } from "../scripts/npm-package";
import { version } from "../package.json";

test("npm release contains only a Node bundle, metadata, documentation and reviewed licenses", async () => {
  const child = Bun.spawn([process.execPath, "scripts/build-npm.ts", "--verify-reproducible"], {
    env: { ...process.env, AGENTPOST_API_TOKEN: "synthetic-build-secret-that-must-not-be-inlined" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const archive = resolve("dist", "npm", npmArchiveName(version));
  const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .sort();
  expect(members).toEqual([
    "package/LICENSE",
    "package/README.md",
    "package/cli.mjs",
    "package/package.json",
  ]);
  const metadata = JSON.parse(
    execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
  );
  expect(metadata).toMatchObject({
    name: npmPackageName,
    version,
    bin: { agentpost: "cli.mjs" },
    engines: { node: ">=22.14.0" },
    publishConfig: { access: "public", provenance: true },
  });
  expect(metadata.scripts).toBeUndefined();
  expect(metadata.dependencies).toBeUndefined();
  expect(metadata.optionalDependencies).toBeUndefined();
  const cli = await readFile("dist/npm/package/cli.mjs", "utf8");
  expect(cli).toStartWith("#!/usr/bin/env node\n");
  expect(cli).not.toContain("synthetic-build-secret-that-must-not-be-inlined");
  const license = await readFile("dist/npm/package/LICENSE", "utf8");
  for (const name of ["@modelcontextprotocol/core", "@modelcontextprotocol/server", "zod"])
    expect(license).toContain(`Bundled dependency: ${name}`);
}, 30_000);
