import { npmArchiveName } from "./npm-package";

export const executableTargets = [
  { id: "darwin-arm64", target: "bun-darwin-arm64", runner: "macos-15" },
  { id: "darwin-x64", target: "bun-darwin-x64", runner: "macos-15-intel" },
  { id: "linux-arm64", target: "bun-linux-arm64", runner: "ubuntu-24.04-arm" },
  { id: "linux-x64", target: "bun-linux-x64", runner: "ubuntu-24.04" },
  { id: "linux-arm64-musl", target: "bun-linux-arm64-musl", runner: "ubuntu-24.04-arm" },
  { id: "linux-x64-musl", target: "bun-linux-x64-musl", runner: "ubuntu-24.04" },
  { id: "windows-x64", target: "bun-windows-x64", runner: "windows-2025" },
] as const satisfies readonly { id: string; target: Bun.Build.CompileTarget; runner: string }[];

export function executableTarget(id: string | undefined) {
  const target = executableTargets.find((item) => item.id === id);
  if (!target) throw new Error("Choose a supported executable platform");
  return target;
}

export function executableName(version: string, id: string): string {
  const { target } = executableTarget(id);
  return `agentpost-${version}-${id}${target.startsWith("bun-windows-") ? ".exe" : ""}`;
}

export function releasePayloads(version: string): string[] {
  return [
    `agentpost-${version}.tar.gz`,
    ...executableTargets.map(({ id }) => executableName(version, id)),
    npmArchiveName(version),
  ];
}
