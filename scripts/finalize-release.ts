import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releasePayloads } from "./executable-targets";
import { releaseIdentity } from "./release-source";
import { regularFile, sha256File } from "./release-files";

const { version, commit } = releaseIdentity();
const directory = join(process.cwd(), "dist", "release");
const payloads = releasePayloads(version);
const expected = [...payloads, "SHA256SUMS", "release-manifest.json"].sort();
const actual = (await readdir(directory)).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected))
  throw new Error("Incomplete or unexpected release assets");
await Promise.all(expected.map((name) => regularFile(join(directory, name))));
const source = JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8"));
if (source.version !== version || source.commit !== commit)
  throw new Error("Release source identity mismatch");

async function digest(name: string) {
  const path = join(directory, name);
  const info = await regularFile(path);
  return { name, sha256: await sha256File(path), size: info.size };
}

const files = [];
for (const name of payloads) files.push(await digest(name));
if (source.files?.[0]?.sha256 !== files[0]!.sha256)
  throw new Error("Source archive digest mismatch");
await writeFile(
  join(directory, "SHA256SUMS"),
  files.map((file) => `${file.sha256}  ${file.name}\n`).join(""),
);
await writeFile(
  join(directory, "release-manifest.json"),
  `${JSON.stringify({ version, commit, bun: Bun.version, files }, null, 2)}\n`,
);
console.log(JSON.stringify({ version, commit, payloads: files.length }));
