import { execFileSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import metadata from "../package.json";
import { assertCommittedInputs, releaseIdentity } from "./release-source";
import { npmArchiveName, npmPackageName } from "./npm-package";
import { sha256File } from "./release-files";

const { version, commit } = releaseIdentity();
assertCommittedInputs();
const directory = join(process.cwd(), "dist", "npm");
const staging = join(directory, "package");
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const result = await Bun.build({
  entrypoints: ["./src/cli.ts"],
  target: "node",
  format: "esm",
  minify: true,
  env: "disable",
  metafile: true,
});
if (!result.success) throw new Error(result.logs.map(String).join("\n"));
if (result.outputs.length !== 1 || !result.metafile) throw new Error("Expected one bundled CLI");
const external = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
if (external.some((item) => !isBuiltin(item.path)))
  throw new Error("npm CLI must have no external runtime dependencies");

const bundled = new Set(
  Object.keys(result.metafile.inputs)
    .filter((path) => path.includes("node_modules/"))
    .map((path) => path.split("node_modules/").at(-1)!)
    .map((path) =>
      path
        .split("/")
        .slice(0, path.startsWith("@") ? 2 : 1)
        .join("/"),
    ),
);
const reviewed = ["@modelcontextprotocol/core", "@modelcontextprotocol/server", "zod"];
if ([...bundled].some((name) => !reviewed.includes(name)))
  throw new Error("Review the license of newly bundled dependencies before publishing");
let license = await readFile("LICENSE", "utf8");
for (const name of [...bundled].sort()) {
  const text = await readFile(join("node_modules", name, "LICENSE"), "utf8");
  license += `\n\nBundled dependency: ${name}\n\n${text}`;
}
const cli = (await result.outputs[0]!.text()).replace(/^#![^\n]*\n/, "");
await writeFile(join(staging, "cli.mjs"), `#!/usr/bin/env node\n${cli}`);
await chmod(join(staging, "cli.mjs"), 0o755);
await writeFile(join(staging, "LICENSE"), license);
await writeFile(join(staging, "README.md"), await readFile("npm/README.md", "utf8"));
await writeFile(
  join(staging, "package.json"),
  JSON.stringify(
    {
      name: npmPackageName,
      version,
      description: metadata.description,
      homepage: metadata.homepage,
      repository: metadata.repository,
      bugs: metadata.bugs,
      license: metadata.license,
      type: "module",
      bin: { agentpost: "cli.mjs" },
      engines: { node: ">=22.14.0" },
      files: ["cli.mjs", "LICENSE", "README.md"],
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/",
        provenance: true,
      },
    },
    null,
    2,
  ) + "\n",
);

function pack() {
  execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
    cwd: staging,
    stdio: "pipe",
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
}
pack();
const archive = join(directory, npmArchiveName(version));
const sha256 = await sha256File(archive);
if (process.argv.includes("--verify-reproducible")) {
  pack();
  if ((await sha256File(archive)) !== sha256) throw new Error("npm archive is not reproducible");
}
console.log(JSON.stringify({ name: npmPackageName, version, commit, archive, sha256 }));
