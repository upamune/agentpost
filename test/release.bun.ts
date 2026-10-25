import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("release archives contain committed source, exclude local credentials, and are reproducible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentpost-release-"));
  const script = resolve("scripts/build-release.ts");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Release Test",
        "-c",
        "user.email=release@example.invalid",
        ...args,
      ],
      { cwd: directory, encoding: "utf8" },
    ).trim();
  const build = (tag = "v1.2.3") =>
    Bun.spawn([process.execPath, script], {
      cwd: directory,
      env: { ...process.env, AGENTPOST_RELEASE_TAG: tag },
      stdout: "ignore",
      stderr: "pipe",
    });
  try {
    git("init", "--quiet");
    await writeFile(join(directory, "package.json"), JSON.stringify({ version: "1.2.3" }));
    await writeFile(join(directory, "source.txt"), "committed public source\n");
    git("add", "package.json", "source.txt");
    git("commit", "--quiet", "-m", "Synthetic release fixture");
    await mkdir(join(directory, ".agentpost"));
    await writeFile(join(directory, ".agentpost", "private.env"), "synthetic-local-secret");
    await writeFile(join(directory, "source.txt"), "uncommitted private edit\n");
    const first = build();
    expect(await first.exited).toBe(0);
    const release = join(directory, "dist", "release");
    const archive = join(release, "agentpost-1.2.3.tar.gz");
    const bytes = await readFile(archive);
    const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(members).toContain("agentpost-1.2.3/source.txt");
    expect(members).not.toContain("private.env");
    expect(members).not.toContain(".agentpost");
    expect(
      execFileSync("tar", ["-xOzf", archive, "agentpost-1.2.3/source.txt"], { encoding: "utf8" }),
    ).toBe("committed public source\n");
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(await readFile(join(release, "SHA256SUMS"), "utf8")).toBe(
      `${hash}  agentpost-1.2.3.tar.gz\n`,
    );
    const second = build();
    expect(await second.exited).toBe(0);
    expect((await readFile(archive)).equals(bytes)).toBe(true);
    const rejected = build("v1.2.4");
    expect(await rejected.exited).not.toBe(0);
    expect(await new Response(rejected.stderr).text()).toContain("committed package version");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
