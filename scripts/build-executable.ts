import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { executableName, executableTarget } from "./executable-targets";
import { assertCommittedInputs, releaseIdentity } from "./release-source";
import { sha256File } from "./release-files";

const platform = executableTarget(process.argv[2]);
const { version, commit } = releaseIdentity();
assertCommittedInputs();
const directory = join(process.cwd(), "dist", "executables");
await mkdir(directory, { recursive: true });
const path = join(directory, executableName(version, platform.id));
async function compile() {
  const result = await Bun.build({
    entrypoints: ["./src/cli.ts"],
    minify: true,
    env: "disable",
    compile: {
      target: platform.target,
      outfile: path,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
}
await compile();
if (process.argv.includes("--verify-reproducible")) {
  const first = await sha256File(path);
  await compile();
  if ((await sha256File(path)) !== first) throw new Error("Executable build is not reproducible");
}
await chmod(path, 0o755);
console.log(JSON.stringify({ path, platform: platform.id, version, commit, bun: Bun.version }));
