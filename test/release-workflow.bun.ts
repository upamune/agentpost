import { expect, test } from "bun:test";
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const workflow = await readFile(resolve(".github/workflows/release.yml"), "utf8");
const finalStep = "Verify uploaded draft assets and publish an immutable release";
const admissionStep = "Recheck integrity before publishing";
const repository = "example/agentpost";
const commit = "a".repeat(40);
const tag = "v1.2.3";
const archive = "agentpost-1.2.3.tar.gz";
const sourceFiles = [archive, "SHA256SUMS", "release-manifest.json"];
const bash = process.env.AGENTPOST_TEST_BASH ?? Bun.which("bash") ?? "bash";

// Execute the maintained workflow commands rather than a test-side reimplementation.
function shellStep(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`Missing release workflow step: ${name}`);
  const block = workflow.indexOf("        run: |\n", start);
  if (block < 0) throw new Error(`Missing shell block for ${name}`);
  const lines = workflow.slice(block + "        run: |\n".length).split("\n");
  const commands: string[] = [];
  for (const line of lines) {
    if (line.trim() && !line.startsWith("          ")) break;
    commands.push(line.slice(10));
  }
  if (!commands.length) throw new Error(`Empty shell block for ${name}`);
  return commands.join("\n");
}

const fakeGh = String.raw`
import { appendFileSync, cpSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
const args = process.argv.slice(2);
const config = JSON.parse(readFileSync(process.env.TEST_CONFIG, "utf8"));
appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + "\n");
const option = (name) => args[args.indexOf(name) + 1];
const fail = (message) => { console.error(message); process.exit(1); };
if (args[0] === "release" && args[1] === "download") {
  if (args[2] !== config.tag || option("--repo") !== config.repository) fail("wrong download identity");
  cpSync(config.remote, resolve(option("--dir")), { recursive: true });
} else if (args[0] === "attestation" && args[1] === "verify") {
  const bundle = JSON.parse(readFileSync(option("--bundle"), "utf8"));
  for (const [flag, expected] of [
    ["--repo", config.repository],
    ["--source-digest", config.commit],
    ["--source-ref", "refs/tags/" + config.tag],
    ["--signer-workflow", config.repository + "/.github/workflows/release.yml"],
  ]) {
    if (!args.includes(flag) || option(flag) !== expected) fail("wrong or missing " + flag);
  }
  if (!args.includes("--deny-self-hosted-runners")) fail("hosted runner policy omitted");
  // GitHub/Sigstore verification is the mocked external boundary. Its authenticated
  // identity and subject digest must still agree with every workflow-supplied flag.
  if (bundle.identity.repository !== option("--repo")) fail("repository identity mismatch");
  if (bundle.identity.commit !== option("--source-digest")) fail("source digest mismatch");
  if (bundle.identity.ref !== option("--source-ref")) fail("source-ref identity mismatch");
  if (bundle.identity.workflow !== option("--signer-workflow")) fail("workflow identity mismatch");
  if (!bundle.identity.hosted) fail("self-hosted identity rejected");
  const digest = new Bun.CryptoHasher("sha256").update(readFileSync(args[2])).digest("hex");
  if (bundle.subjects[basename(args[2])] !== digest) fail("attested subject digest mismatch");
} else if (args[0] === "api" && args[1] === "repos/" + config.repository + "/commits/refs%2Ftags%2F" + config.tag) {
  console.log(config.liveCommit);
} else if (args[0] === "api" && args[1] === "repos/" + config.repository + "/releases/tags/" + config.tag) {
  console.log(JSON.stringify({ tag_name: config.tag, draft: false, immutable: config.immutable }));
} else if (args[0] === "release" && args[1] === "edit") {
  if (args[2] !== config.tag || option("--repo") !== config.repository || !args.includes("--draft=false") || !args.includes("--verify-tag")) fail("unsafe release edit");
} else {
  fail("Unexpected gh command: " + JSON.stringify(args));
}
`;

const checksumFallback = String.raw`
import { readFileSync } from "node:fs";
if (process.argv[2] !== "--check") process.exit(2);
for (const line of readFileSync(process.argv[3], "utf8").trim().split("\n")) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match || new Bun.CryptoHasher("sha256").update(readFileSync(match[2])).digest("hex") !== match[1]) process.exit(1);
}
`;

interface FixtureOptions {
  published?: boolean;
  immutable?: boolean;
  liveCommit?: string;
  remoteRef?: string;
  checksumFallback?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  if (!Bun.which("jq")) throw new Error("Release workflow tests require jq");
  const directory = await mkdtemp(join(tmpdir(), "agentpost-publish-"));
  const release = join(directory, "release");
  const remote = join(directory, "remote");
  const bin = join(directory, "bin");
  await Promise.all([mkdir(release), mkdir(bin)]);
  const bytes = Buffer.from("synthetic committed source archive\n");
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await writeFile(join(release, archive), bytes);
  await writeFile(join(release, "SHA256SUMS"), `${digest}  ${archive}\n`);
  await writeFile(join(release, "release-manifest.json"), `${JSON.stringify({ commit, tag })}\n`);
  const subjects: Record<string, string> = {};
  for (const name of sourceFiles)
    subjects[name] = new Bun.CryptoHasher("sha256")
      .update(await readFile(join(release, name)))
      .digest("hex");
  async function provenance(path: string, ref: string, signature: string) {
    const envelope = {
      payloadType: "application/vnd.in-toto+json",
      payload: Buffer.from(JSON.stringify({ subjects })).toString("base64"),
      signatures: [{ sig: signature }],
    };
    const bundle = {
      dsseEnvelope: envelope,
      subjects,
      identity: {
        repository,
        commit,
        ref,
        workflow: `${repository}/.github/workflows/release.yml`,
        hosted: true,
      },
    };
    await writeFile(join(path, "provenance.sigstore.json"), JSON.stringify(bundle));
    await writeFile(join(path, "provenance.intoto.jsonl"), `${JSON.stringify(envelope)}\n`);
  }
  await provenance(release, `refs/tags/${tag}`, "current-run");
  await cp(release, remote, { recursive: true });
  // A valid earlier draft may carry a different signature for the same source.
  await provenance(remote, options.remoteRef ?? `refs/tags/${tag}`, "previous-run");
  const implementation = join(directory, "gh.ts");
  const config = join(directory, "config.json");
  const calls = join(directory, "calls.ndjson");
  await writeFile(implementation, fakeGh);
  await writeFile(calls, "");
  await writeFile(
    config,
    JSON.stringify({
      repository,
      commit,
      tag,
      remote,
      liveCommit: options.liveCommit ?? commit,
      immutable: options.immutable ?? true,
    }),
  );
  const wrapper = '#!/bin/sh\nexec "$TEST_BUN" "$TEST_GH_IMPL" "$@"\n';
  await writeFile(join(bin, "gh"), wrapper);
  await chmod(join(bin, "gh"), 0o700);
  if (options.checksumFallback || !Bun.which("sha256sum")) {
    const checksum = join(directory, "checksum.ts");
    await writeFile(checksum, checksumFallback);
    await writeFile(
      join(bin, "sha256sum"),
      '#!/bin/sh\nexec "$TEST_BUN" "$TEST_CHECKSUM_IMPL" "$@"\n',
    );
    await chmod(join(bin, "sha256sum"), 0o700);
  }
  return {
    directory,
    release,
    remote,
    async run(step = finalStep) {
      const process = Bun.spawn([bash, "-c", shellStep(step)], {
        cwd: directory,
        env: {
          PATH: `${bin}:${globalThis.process.env.PATH ?? "/usr/bin:/bin"}`,
          TEST_BUN: globalThis.process.execPath,
          TEST_GH_IMPL: implementation,
          TEST_CHECKSUM_IMPL: join(directory, "checksum.ts"),
          TEST_CONFIG: config,
          TEST_CALLS: calls,
          TAG: tag,
          SOURCE_COMMIT: commit,
          GITHUB_REPOSITORY: repository,
          GH_TOKEN: "synthetic-test-token",
          ALREADY_PUBLISHED: String(options.published ?? false),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      const commands: string[][] = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return { code, stdout, stderr, commands };
    },
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function edits(commands: string[][]) {
  return commands.filter((args) => args[0] === "release" && args[1] === "edit");
}

test("release shell rejects an unexpected draft asset without publishing", async () => {
  const files = await fixture();
  try {
    await writeFile(join(files.remote, "unexpected-install.sh"), "unverified extra asset");
    const result = await files.run();
    expect(result.code, JSON.stringify(result)).not.toBe(0);
    expect(edits(result.commands)).toEqual([]);
  } finally {
    await files.close();
  }
});

for (const name of sourceFiles) {
  test(`release shell rejects modified ${name} without publishing`, async () => {
    const files = await fixture();
    try {
      await appendFile(join(files.remote, name), "tampered remote bytes\n");
      const result = await files.run();
      expect(result.code).not.toBe(0);
      expect(edits(result.commands)).toEqual([]);
    } finally {
      await files.close();
    }
  });
}

test("release shell rejects a changed live tag after checking all source attestations", async () => {
  const files = await fixture({ liveCommit: "b".repeat(40) });
  try {
    const result = await files.run();
    expect(result.code, JSON.stringify(result)).not.toBe(0);
    expect(result.commands.filter((args) => args[0] === "attestation")).toHaveLength(3);
    expect(edits(result.commands)).toEqual([]);
  } finally {
    await files.close();
  }
});

test("release shell verifies an earlier valid draft signature and publishes", async () => {
  const files = await fixture({ checksumFallback: true });
  try {
    const result = await files.run();
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(
      result.commands.filter((args) => args[0] === "attestation").map((args) => basename(args[2])),
    ).toEqual(sourceFiles);
    expect(edits(result.commands)).toHaveLength(1);
  } finally {
    await files.close();
  }
});

test("published immutable release retries verify existing provenance and skip editing", async () => {
  const files = await fixture({ published: true });
  try {
    const result = await files.run();
    expect(result.code).toBe(0);
    expect(result.commands.filter((args) => args[0] === "attestation")).toHaveLength(3);
    expect(edits(result.commands)).toEqual([]);
  } finally {
    await files.close();
  }
});

test("release shell fails if publication does not produce an immutable release", async () => {
  const files = await fixture({ immutable: false });
  try {
    const result = await files.run();
    expect(result.code, JSON.stringify(result)).not.toBe(0);
    expect(edits(result.commands)).toHaveLength(1);
  } finally {
    await files.close();
  }
});

test("release shell rejects a preview-source attestation without publishing", async () => {
  const files = await fixture({ remoteRef: "refs/heads/main" });
  try {
    const result = await files.run();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("source-ref identity mismatch");
    expect(edits(result.commands)).toEqual([]);
  } finally {
    await files.close();
  }
});

test("release shell rejects provenance envelope disagreement", async () => {
  const files = await fixture();
  try {
    await appendFile(join(files.remote, "provenance.intoto.jsonl"), "unmatched envelope\n");
    const result = await files.run();
    expect(result.code).not.toBe(0);
    expect(edits(result.commands)).toEqual([]);
  } finally {
    await files.close();
  }
});

test("prepublish shell rejects a changed tag before artifact verification", async () => {
  const files = await fixture({ liveCommit: "b".repeat(40) });
  try {
    const result = await files.run(admissionStep);
    expect(result.code).not.toBe(0);
    expect(result.commands).toHaveLength(1);
    expect(edits(result.commands)).toEqual([]);
  } finally {
    await files.close();
  }
});
