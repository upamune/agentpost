import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { npmArchiveName, npmPackageName } from "../scripts/npm-package";
import { version } from "../package.json";

test("npm release contains only a Node bundle, metadata, documentation and reviewed licenses", async () => {
  const child = Bun.spawn([process.execPath, "scripts/build-npm.ts", "--verify-reproducible"], {
    env: { ...process.env, AGENTPOST_API_TOKEN: "synthetic-build-secret-that-must-not-be-inlined" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const archive = resolve("dist", "npm", npmArchiveName(version));
  const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .sort();
  expect(members).toEqual([
    "package/LICENSE",
    "package/README.md",
    "package/cli.mjs",
    "package/package.json",
  ]);
  const metadata = JSON.parse(
    execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
  );
  expect(metadata).toMatchObject({
    name: npmPackageName,
    version,
    bin: { agentpost: "cli.mjs" },
    engines: { node: ">=22.14.0" },
    publishConfig: { access: "public", provenance: true },
  });
  expect(metadata.scripts).toBeUndefined();
  expect(metadata.dependencies).toBeUndefined();
  expect(metadata.optionalDependencies).toBeUndefined();
  const cli = await readFile("dist/npm/package/cli.mjs", "utf8");
  expect(cli).toStartWith("#!/usr/bin/env node\n");
  expect(cli).not.toContain("synthetic-build-secret-that-must-not-be-inlined");
  const license = await readFile("dist/npm/package/LICENSE", "utf8");
  for (const name of ["@modelcontextprotocol/core", "@modelcontextprotocol/server", "zod"])
    expect(license).toContain(`Bundled dependency: ${name}`);
  await verifyPublishSpecifier(archive);
}, 30_000);

async function verifyPublishSpecifier(archive: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agentpost-npm-publish-")));
  try {
    const workflow = await Bun.file(".github/workflows/release.yml").text();
    const match = workflow.match(/npm publish "([^"]+)" --access public/);
    if (!match) throw new Error("Missing maintained npm publish archive argument");
    const specifier = match[1]!.replace("${TAG#v}", version);
    await mkdir(join(directory, "npm-release"));
    await copyFile(archive, join(directory, "npm-release", npmArchiveName(version)));
    const child = Bun.spawn(
      [
        "npm",
        "publish",
        specifier,
        "--dry-run",
        "--offline",
        "--ignore-scripts",
        "--provenance=false",
        "--json",
        "--cache",
        join(directory, "cache"),
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 15_000 },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)[npmPackageName]).toMatchObject({ name: npmPackageName, version });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function registryFixture(mode: string, status = 200, mutation?: string) {
  const workflow = await Bun.file(".github/workflows/release.yml").text();
  const match = workflow.match(
    /cat > "\$RUNNER_TEMP\/verify-npm\.mjs" <<'NODE'\n([\s\S]*?)\n          NODE/,
  );
  if (!match) throw new Error("Missing maintained npm registry verification script");
  const directory = await mkdtemp(join(tmpdir(), "agentpost-npm-registry-"));
  await mkdir(join(directory, "npm-release"));
  const archive = Buffer.from("synthetic verified npm archive");
  await writeFile(join(directory, "npm-release/upamune-agentpost-1.2.3.tgz"), archive);
  const metadata = {
    name: npmPackageName,
    version: "1.2.3",
    dist: {
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      tarball: "https://registry.npmjs.org/@upamune/agentpost/-/agentpost-1.2.3.tgz",
      attestations: {
        url: "https://registry.npmjs.org/attestations",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
  };
  if (mutation === "integrity") metadata.dist.integrity = "sha512-unrelated";
  if (mutation === "version") metadata.version = "1.2.4";
  if (mutation === "name") metadata.name = "unrelated";
  if (mutation === "provenance") metadata.dist.attestations.url = "";
  if (mutation === "origin") metadata.dist.tarball = "https://attacker.invalid/package.tgz";
  const script = join(directory, "verify.mjs");
  await writeFile(
    script,
    match[1]!
      .split("\n")
      .map((line) => line.slice(10))
      .join("\n"),
  );
  await writeFile(join(directory, "fixture.json"), JSON.stringify({ mode, status, metadata }));
  const setup = `
    import { readFile } from 'node:fs/promises';
    const fixture = JSON.parse(await readFile('fixture.json', 'utf8'));
    process.argv = ['node', 'verify', fixture.mode];
    globalThis.fetch = async () => Response.json(fixture.metadata, {status: fixture.status});
    await import('./verify.mjs');
  `;
  const child = Bun.spawn([Bun.which("node")!, "--input-type=module", "-e", setup], {
    cwd: directory,
    env: {
      ...process.env,
      TAG: "v1.2.3",
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: join(directory, "outputs"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    directory,
    code: await child.exited,
    stderr: await new Response(child.stderr).text(),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

for (const mutation of ["integrity", "version", "name", "provenance", "origin"]) {
  test(`npm publication rejects registry ${mutation} mismatch`, async () => {
    const fixture = await registryFixture("verify", 200, mutation);
    try {
      expect(fixture.code).not.toBe(0);
    } finally {
      await fixture.close();
    }
  });
}

test("npm retries require matching provenance and generate an integrity-pinned consumer lock", async () => {
  const fixture = await registryFixture("verify");
  try {
    expect(fixture.code, fixture.stderr).toBe(0);
    const lock = JSON.parse(
      await readFile(join(fixture.directory, "npm-consumer/package-lock.json"), "utf8"),
    );
    expect(lock.packages["node_modules/@upamune/agentpost"].integrity).toStartWith("sha512-");
    expect(lock.packages[""].dependencies).toEqual({ "@upamune/agentpost": "1.2.3" });
  } finally {
    await fixture.close();
  }
});

test("npm lookup distinguishes an unpublished version from an outage and failed publication", async () => {
  for (const [mode, status, successful] of [
    ["inspect", 404, true],
    ["inspect", 503, false],
    ["verify", 404, false],
  ] as const) {
    const fixture = await registryFixture(mode, status);
    try {
      expect(fixture.code === 0, fixture.stderr).toBe(successful);
    } finally {
      await fixture.close();
    }
  }
});

test("npm metadata still processing is retryable without accepting missing provenance", async () => {
  for (const [mode, status, mutation, expected] of [
    ["verify", 404, undefined, 75],
    ["verify", 200, "provenance", 75],
    ["inspect", 200, "provenance", 1],
  ] as const) {
    const fixture = await registryFixture(mode, status, mutation);
    try {
      expect(fixture.code).toBe(expected);
    } finally {
      await fixture.close();
    }
  }
});

for (const [mode, expectedCode, attempts] of [
  ["processing", 0, 3],
  ["invalid", 1, 1],
  ["timeout", 75, 60],
] as const) {
  test(`npm verification wait handles ${mode} with bounded read-only retries`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpost-npm-wait-"));
    try {
      const workflow = await Bun.file(".github/workflows/release.yml").text();
      const loop = workflow.match(/          for \(\(attempt=1;[\s\S]*?          done/);
      if (!loop) throw new Error("Missing maintained npm publication wait");
      const bin = join(directory, "bin");
      await mkdir(bin);
      await writeFile(join(directory, "count"), "0");
      await writeFile(
        join(bin, "node"),
        `#!/bin/sh
count=$(cat "$TEST_STATE")
count=$((count+1))
printf '%s' "$count" > "$TEST_STATE"
if [ "$TEST_MODE" = invalid ]; then exit 1; fi
if [ "$TEST_MODE" = processing ] && [ "$count" -ge 3 ]; then exit 0; fi
exit 75
`,
      );
      await writeFile(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
      await chmod(join(bin, "node"), 0o755);
      await chmod(join(bin, "sleep"), 0o755);
      const script =
        "set -euo pipefail\n" +
        loop[0]
          .split("\n")
          .map((line) => line.slice(10))
          .join("\n");
      const child = Bun.spawn([Bun.which("bash")!, "-c", script], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: directory,
          TEST_STATE: join(directory, "count"),
          TEST_MODE: mode,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code, stderr).toBe(expectedCode);
      expect(Number(await readFile(join(directory, "count"), "utf8"))).toBe(attempts);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
