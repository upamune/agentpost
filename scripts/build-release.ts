import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Archive committed source only. Untracked deployment files never enter the package.
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const { version } = JSON.parse(git("show", "HEAD:package.json"));
if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
  throw new Error("Release package version must be a stable SemVer number");
if (process.env.AGENTPOST_RELEASE_TAG && process.env.AGENTPOST_RELEASE_TAG !== `v${version}`)
  throw new Error("Release tag must match the committed package version");
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
