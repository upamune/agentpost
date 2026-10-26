import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { npmArchiveName } from "./npm-package";
import { version } from "../package.json";
import { checkNodeFiles } from "./smoke-node-files";

const archive = resolve(process.argv[2] ?? join("dist", "npm", npmArchiveName(version)));
const directory = await mkdtemp(join(tmpdir(), "agentpost-npm-"));
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, stderr);
  return stdout.trim();
}
try {
  console.log(`npm package runtime: ${await command(["node", "--version"])}`);
  await command([
    "npm",
    "install",
    "--global",
    "--prefix",
    directory,
    "--ignore-scripts",
    "--offline",
    "--no-audit",
    "--no-fund",
    "--cache",
    join(directory, "cache"),
    archive,
  ]);
  const root = await command(["npm", "root", "--global", "--prefix", directory]);
  const launcher =
    process.platform === "win32"
      ? join(directory, "agentpost.cmd")
      : join(directory, "bin", "agentpost");
  assert.equal(await command([launcher, "--version"]), `agentpost ${version}`);
  const output = await command([
    process.execPath,
    resolve("scripts/smoke-executable.ts"),
    "--node",
    join(root, "@upamune", "agentpost", "cli.mjs"),
  ]);
  console.log(output);
  await checkNodeFiles(join(root, "@upamune", "agentpost", "cli.mjs"), directory);
  console.log("Offline npm global installation works with installation scripts disabled");
} finally {
  await rm(directory, { recursive: true, force: true });
}
