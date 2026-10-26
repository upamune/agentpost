import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tlcCommand } from "../tlc";
import { checkSourceMutations, ReplayAssertionFailure } from "./source-mutations";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, process.env.AGENTPOST_FORMAL_OUTPUT ?? ".verification/attachments");
const scratch = await mkdtemp(join(tmpdir(), "agentpost-attachments-"));
const selftest = process.argv.includes("--selftest");
class PropertyViolation extends Error {}
const scenarios = {
  upload: ["TypeOK", "ImmutableUploads"],
  isolation: ["TypeOK", "InboxIsolation", "IdempotencyStable"],
  queue: ["TypeOK", "InboxIsolation", "IdempotencyStable"],
  prepare: [
    "TypeOK",
    "AvailableBeforeDispatch",
    "IntegrityBeforeDispatch",
    "PreparedSnapshotBound",
  ],
};
type Scenario = keyof typeof scenarios;
const mutants: { name: string; scenario: Scenario; check: string; flags: string[] }[] = [
  { name: "conditional-put", scenario: "upload", check: "ImmutableUploads", flags: ["UnsafePut"] },
  {
    name: "inbox-binding",
    scenario: "isolation",
    check: "InboxIsolation",
    flags: ["UnsafeIsolation"],
  },
  {
    name: "payload-hash",
    scenario: "queue",
    check: "IdempotencyStable",
    flags: ["UnsafeIdempotency"],
  },
  {
    name: "integrity",
    scenario: "prepare",
    check: "IntegrityBeforeDispatch",
    flags: ["UnsafeIntegrity"],
  },
  {
    name: "missing-object-validation",
    scenario: "prepare",
    check: "AvailableBeforeDispatch",
    flags: ["UnsafeAvailability", "UnsafeIntegrity"],
  },
  {
    name: "snapshot",
    scenario: "prepare",
    check: "PreparedSnapshotBound",
    flags: ["UnsafeSnapshot"],
  },
];

function run(args: string[]) {
  const process = Bun.spawnSync(args, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  });
  if (process.signalCode) throw new Error(`Verifier interrupted: ${process.signalCode}`);
  return {
    code: process.exitCode,
    log: `${process.stdout.toString()}${process.stderr.toString()}`,
  };
}

async function verifierJar(): Promise<string> {
  const installed = run(["mise", "where", "github:tlaplus/tlaplus"]);
  if (installed.code !== 0) throw new Error("Install pinned TLC and Java with mise install");
  const jar = join(installed.log.trim(), "tla2tools.jar");
  const hash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(jar).arrayBuffer())
    .digest("hex");
  if (hash !== "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88")
    throw new Error("TLC checksum mismatch");
  return jar;
}

function configuration(
  base: string,
  scenario: Scenario,
  checks: string[],
  flags: string[],
): string {
  let selected = base
    .replace(/^INVARIANT.*\n/gm, "")
    .replace('Scenario = "prepare"', `Scenario = "${scenario}"`);
  for (const flag of flags) {
    const original = `${flag} = FALSE`;
    if (!selected.includes(original)) throw new Error(`Missing model mutation: ${flag}`);
    selected = selected.replace(original, `${flag} = TRUE`);
  }
  return `${selected}${checks.map((check) => `INVARIANT ${check}\n`).join("")}`;
}

function assertMutation(name: string, result: ReturnType<typeof run>, violation: string) {
  if (result.code === 0 || !result.log.includes(`Invariant ${violation} is violated`))
    throw new Error(`Model mutation not detected: ${name}; inspect ${name}.log`);
}

function assertOutcome(name: string, result: ReturnType<typeof run>, violation?: string) {
  if (violation) return assertMutation(name, result, violation);
  if (result.code !== 0 && /Invariant \w+ is violated/.test(result.log))
    throw new PropertyViolation(`Attachment property violated: ${name}; inspect ${name}.log`);
  if (
    result.code !== 0 ||
    !result.log.includes("Model checking completed. No error has been found")
  )
    throw new Error(`Model check failed: ${name}; inspect ${name}.log`);
}

async function check(jar: string, name: string, config: string, violation?: string) {
  const path = join(scratch, `${name}.cfg`);
  await writeFile(path, config);
  const result = run(
    await tlcCommand(
      jar,
      [
        "-workers",
        "1",
        "-config",
        path,
        "-metadir",
        join(scratch, name),
        join(scratch, "Attachments.tla"),
      ],
      scratch,
    ),
  );
  await writeFile(join(output, `${name}.log`), result.log);
  assertOutcome(name, result, violation);
  console.log(`attachments/${name}: ${violation ? "mutation detected" : "passed"}`);
  return { name, outcome: violation ? "mutation-detected" : "passed" };
}

async function sourceHashes() {
  return Promise.all(
    ["src/attachments.ts", "src/attachment-policy.ts", "src/api.ts", "src/outbound.ts"].map(
      async (path) => ({
        path,
        sha256: new Bun.CryptoHasher("sha256")
          .update(await readFile(join(root, path)))
          .digest("hex"),
      }),
    ),
  );
}

try {
  await mkdir(output, { recursive: true });
  const baselinePath = join(output, "result.json");
  const selftestPath = join(output, "selftest-result.json");
  await rm(baselinePath, { force: true });
  await rm(selftestPath, { force: true });
  await symlink(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  const types = run(["bun", "run", "tsc", "--project", "verification/attachments/tsconfig.json"]);
  if (types.code !== 0) throw new Error(`Attachment verification typecheck failed: ${types.log}`);
  await copyFile(join(import.meta.dir, "Attachments.tla"), join(scratch, "Attachments.tla"));
  const jar = await verifierJar();
  const base = await readFile(join(import.meta.dir, "Attachments.cfg"), "utf8");
  const results = [];
  let sourceMutations: Awaited<ReturnType<typeof checkSourceMutations>> = [];
  for (const [scenario, checks] of Object.entries(scenarios)) {
    results.push(await check(jar, scenario, configuration(base, scenario as Scenario, checks, [])));
  }
  const evidence = {
    bounds: {
      inboxes: 2,
      immutableFiles: 2,
      concurrentRequests: 2,
      idempotencyKeys: 1,
      storageFaults: 1,
    },
    assumptions: [
      "Collision-free content and descriptor hashes",
      "Atomic D1 uniqueness and conditional R2 puts",
      "One immutable R2 GET snapshot",
      "Provider ambiguity and actor fencing remain covered by Outbound.tla",
    ],
    checks: results,
    sourceMutations,
    sources: await sourceHashes(),
  };
  await writeFile(baselinePath, JSON.stringify(evidence, null, 2));
  if (selftest) {
    for (const mutant of mutants) {
      const config = configuration(base, mutant.scenario, [mutant.check], mutant.flags);
      results.push(await check(jar, mutant.name, config, mutant.check));
    }
    sourceMutations = await checkSourceMutations(root, scratch, output);
    await writeFile(selftestPath, JSON.stringify({ ...evidence, sourceMutations }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Attachment verification tool failed");
  process.exitCode =
    error instanceof PropertyViolation || error instanceof ReplayAssertionFailure ? 1 : 2;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
