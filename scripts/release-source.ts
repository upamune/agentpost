import { execFileSync } from "node:child_process";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

export function releaseIdentity() {
  const commit = git("rev-parse", "HEAD");
  const { version } = JSON.parse(git("show", "HEAD:package.json"));
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Release package version must be a stable SemVer number");
  if (process.env.AGENTPOST_RELEASE_TAG && process.env.AGENTPOST_RELEASE_TAG !== `v${version}`)
    throw new Error("Release tag must match the committed package version");
  return { version, commit };
}

export function assertCommittedInputs(): void {
  const changes = git(
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "src",
    "scripts",
    "mise.toml",
    "package.json",
    "bun.lock",
    "tsconfig.json",
  );
  if (changes)
    throw new Error(
      "Executable builds require committed source, dependencies, build scripts and configuration",
    );
}
