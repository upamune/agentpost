import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  executableName,
  executableTarget,
  executableTargets,
  releasePayloads,
} from "../scripts/executable-targets";

test("the native CI matrix covers every advertised executable target", async () => {
  const workflow = z
    .object({
      jobs: z.object({
        executable: z.object({
          strategy: z.object({
            matrix: z.object({
              include: z.array(z.object({ platform: z.string(), runner: z.string() })),
            }),
          }),
        }),
      }),
    })
    .parse(Bun.YAML.parse(await Bun.file(".github/workflows/executables.yml").text()));
  expect(workflow.jobs.executable.strategy.matrix.include).toEqual(
    executableTargets.map(({ id, runner }) => ({ platform: id, runner })),
  );
  expect(executableTargets).toHaveLength(7);
  expect(new Set(releasePayloads("1.2.3")).size).toBe(9);
  expect(executableName("1.2.3", "windows-x64")).toBe("agentpost-1.2.3-windows-x64.exe");
  expect(() => executableTarget("windows-arm64")).toThrow("supported");
  expect(() => executableTarget("../../private")).toThrow("supported");
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agentpost-executables-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: directory, encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  await writeFile(join(directory, "package.json"), '{"version":"1.2.3"}\n');
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src/cli.ts"), 'console.log("fixture");\n');
  git("add", "package.json", "src");
  git("commit", "--quiet", "-m", "Release fixture");
  async function run(script: string, ...args: string[]) {
    const child = Bun.spawn([process.execPath, resolve(`scripts/${script}.ts`), ...args], {
      cwd: directory,
      env: { ...process.env, AGENTPOST_RELEASE_TAG: "v1.2.3" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  expect((await run("build-release")).code).toBe(0);
  const release = join(directory, "dist/release");
  for (const name of releasePayloads("1.2.3").slice(1))
    await writeFile(join(release, name), `synthetic payload ${name}\n`);
  return {
    directory,
    release,
    run,
    commit: git("rev-parse", "HEAD"),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("release finalization signs up all nine payloads with deterministic checksums and identity", async () => {
  const files = await fixture();
  try {
    expect(await files.run("finalize-release")).toMatchObject({ code: 0, stderr: "" });
    const manifest = JSON.parse(
      await readFile(join(files.release, "release-manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({ version: "1.2.3", commit: files.commit, bun: Bun.version });
    expect(manifest.files.map((file: { name: string }) => file.name)).toEqual(
      releasePayloads("1.2.3"),
    );
    for (const file of manifest.files) {
      const bytes = await readFile(join(files.release, file.name));
      expect(file.size).toBe(bytes.length);
      expect(file.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    }
    const checksum = await readFile(join(files.release, "SHA256SUMS"), "utf8");
    expect(checksum).toBe(
      manifest.files
        .map((file: { sha256: string; name: string }) => `${file.sha256}  ${file.name}\n`)
        .join(""),
    );
    expect((await files.run("finalize-release")).code).toBe(0);
    expect(await readFile(join(files.release, "SHA256SUMS"), "utf8")).toBe(checksum);
  } finally {
    await files.close();
  }
});

const corruptions: Record<string, (release: string) => Promise<void>> = {
  missing: (release) => rm(join(release, executableName("1.2.3", "windows-x64"))),
  extra: (release) => writeFile(join(release, "unexpected.sh"), "unverified\n"),
  empty: (release) => writeFile(join(release, executableName("1.2.3", "linux-x64")), ""),
  source_digest: (release) => appendFile(join(release, "agentpost-1.2.3.tar.gz"), "tampered"),
  source_identity: (release) =>
    writeFile(join(release, "release-manifest.json"), '{"version":"1.2.3","commit":"wrong"}\n'),
  symlink: async (release) => {
    const name = join(release, executableName("1.2.3", "darwin-arm64"));
    await rm(name);
    await symlink(join(release, "agentpost-1.2.3.tar.gz"), name);
  },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`release finalization rejects ${name} without replacing checksums`, async () => {
    const files = await fixture();
    try {
      const previous = await readFile(join(files.release, "SHA256SUMS"), "utf8");
      await corrupt(files.release);
      expect((await files.run("finalize-release")).code).not.toBe(0);
      expect(await readFile(join(files.release, "SHA256SUMS"), "utf8")).toBe(previous);
    } finally {
      await files.close();
    }
  });
}

test("compiling a release executable rejects dirty and untracked source before compiling", async () => {
  const files = await fixture();
  try {
    await writeFile(join(files.directory, "src/cli.ts"), "uncommitted sensitive source\n");
    const dirty = await files.run("build-executable", "darwin-arm64");
    expect(dirty.code).not.toBe(0);
    expect(dirty.stderr).toContain("committed source");
    await writeFile(join(files.directory, "src/cli.ts"), 'console.log("fixture");\n');
    await writeFile(join(files.directory, "src/private.ts"), "untracked sensitive source\n");
    expect((await files.run("build-executable", "darwin-arm64")).code).not.toBe(0);
  } finally {
    await files.close();
  }
});
