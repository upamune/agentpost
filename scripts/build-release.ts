import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseIdentity } from "./release-source";

// Archive committed source only. Untracked deployment files never enter the package.
const { version, commit } = releaseIdentity();
const directory = join(process.cwd(), "dist", "release");
await mkdir(directory, { recursive: true });
const name = `agentpost-${version}.tar.gz`;
execFileSync("git", [
  "archive",
  "--format=tar.gz",
  `--prefix=agentpost-${version}/`,
  "--output",
  join(directory, name),
  commit,
]);
const bytes = await readFile(join(directory, name));
const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
await writeFile(join(directory, "SHA256SUMS"), `${sha256}  ${name}\n`);
await writeFile(
  join(directory, "release-manifest.json"),
  `${JSON.stringify({ version, commit, files: [{ name, sha256, size: bytes.byteLength }] }, null, 2)}\n`,
);
console.log(JSON.stringify({ directory, version, commit, name, sha256 }));
