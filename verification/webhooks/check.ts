import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { groupedOutcomes, modelViolation, type ModelResult } from "../model-results";
import { tlcCommand } from "../tlc";
import { checkSourceMutations, ReplayAssertionFailure } from "./source-mutations";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, process.env.AGENTPOST_FORMAL_OUTPUT ?? ".verification/webhooks");
const scratch = await mkdtemp(join(tmpdir(), "agentpost-webhooks-"));
const selftest = process.argv.includes("--selftest");
class PropertyViolation extends Error {}

interface Scenario {
  name: string;
  module: string;
  checks: string[];
  flags?: string[];
}
const scenarios: Scenario[] = [
  {
    name: "outbound-dispatch-barrier",
    module: "DispatchBarrier",
    checks: ["TypeOK", "NoObsoleteDispatch"],
    flags: ["EmailOnly"],
  },
  { name: "dispatch-barrier", module: "DispatchBarrier", checks: ["TypeOK", "NoObsoleteDispatch"] },
  { name: "configuration", module: "Configuration", checks: ["TypeOK", "NoStaleConfiguration"] },
  {
    name: "delivery",
    module: "Delivery",
    checks: [
      "TypeOK",
      "NoObsoleteDispatch",
      "ImmutableDestination",
      "ConditionalClaim",
      "ClaimBoundSettlement",
    ],
  },
  {
    name: "events",
    module: "Events",
    checks: ["TypeOK", "InboxIsolation", "ImmutableEventIdentity", "OneEventPerTransition"],
  },
  {
    name: "generated-key",
    module: "Idempotency",
    checks: ["TypeOK", "KeyRetained", "NoImplicitRetry", "RequestKeyBound", "SelectionPolicy"],
  },
  {
    name: "explicit-key",
    module: "Idempotency",
    flags: ["Provided"],
    checks: ["TypeOK", "KeyRetained", "NoImplicitRetry", "RequestKeyBound", "SelectionPolicy"],
  },
];
const mutants: Scenario[] = [
  {
    name: "outbound-delayed-projection-barrier",
    module: "DispatchBarrier",
    checks: ["NoObsoleteDispatch"],
    flags: ["EmailOnly", "UnsafeBarrier"],
  },
  {
    name: "outbound-barrier-final-fence",
    module: "DispatchBarrier",
    checks: ["NoObsoleteDispatch"],
    flags: ["EmailOnly", "UnsafeFence"],
  },
  {
    name: "delayed-projection-barrier",
    module: "DispatchBarrier",
    checks: ["NoObsoleteDispatch"],
    flags: ["UnsafeBarrier"],
  },
  {
    name: "barrier-final-fence",
    module: "DispatchBarrier",
    checks: ["NoObsoleteDispatch"],
    flags: ["UnsafeFence"],
  },
  {
    name: "configuration-version",
    module: "Configuration",
    checks: ["NoStaleConfiguration"],
    flags: ["UnsafeVersion"],
  },
  {
    name: "ownership-fence",
    module: "Delivery",
    checks: ["NoObsoleteDispatch"],
    flags: ["UnsafeFence"],
  },
  {
    name: "conditional-claim",
    module: "Delivery",
    checks: ["ConditionalClaim"],
    flags: ["UnsafeClaim"],
  },
  {
    name: "claim-token-settlement",
    module: "Delivery",
    checks: ["ClaimBoundSettlement"],
    flags: ["UnsafeSettlement"],
  },
  { name: "inbox-isolation", module: "Events", checks: ["InboxIsolation"], flags: ["UnsafeInbox"] },
  {
    name: "event-identity",
    module: "Events",
    checks: ["ImmutableEventIdentity"],
    flags: ["UnsafeIdentity"],
  },
  {
    name: "failure-key",
    module: "Idempotency",
    checks: ["KeyRetained"],
    flags: ["UnsafeRegenerate"],
  },
  {
    name: "implicit-retry",
    module: "Idempotency",
    checks: ["NoImplicitRetry"],
    flags: ["UnsafeRetry"],
  },
];

async function run(args: string[]): Promise<ModelResult> {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (child.signalCode) throw new Error(`Webhook verification interrupted: ${child.signalCode}`);
  return { code, log: stdout + stderr };
}

async function verifierJar() {
  const installed = await run(["mise", "where", "github:tlaplus/tlaplus"]);
  if (installed.code !== 0) throw new Error("Install pinned TLC and Java with mise install");
  const jar = join(installed.log.trim(), "tla2tools.jar");
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(jar).arrayBuffer())
    .digest("hex");
  if (digest !== "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88")
    throw new Error("TLC checksum mismatch");
  return jar;
}

async function configuration(scenario: Scenario) {
  let content = (await readFile(join(import.meta.dir, `${scenario.module}.cfg`), "utf8")).replace(
    /^INVARIANT.*\n/gm,
    "",
  );
  for (const flag of scenario.flags ?? []) {
    if (!content.includes(`${flag} = FALSE`))
      throw new Error(`Missing webhook model flag: ${flag}`);
    content = content.replace(`${flag} = FALSE`, `${flag} = TRUE`);
  }
  return content + scenario.checks.map((check) => `INVARIANT ${check}\n`).join("");
}

async function execute(jar: string, scenario: Scenario, suffix = "") {
  const name = scenario.name + suffix;
  const path = join(scratch, `${name}.cfg`);
  await writeFile(path, await configuration(scenario));
  const result = await run(
    await tlcCommand(
      jar,
      [
        "-workers",
        "1",
        "-config",
        path,
        "-metadir",
        join(scratch, name),
        join(scratch, `${scenario.module}.tla`),
      ],
      scratch,
    ),
  );
  await writeFile(join(output, `${name}.log`), result.log);
  return result;
}

async function baseline(jar: string, scenario: Scenario) {
  const combined = await execute(jar, scenario);
  const checks = await groupedOutcomes(scenario.checks, [], combined, (check) =>
    execute(jar, { ...scenario, checks: [check] }, `-${check}`),
  );
  if (checks.some((check) => check.outcome !== "passed"))
    throw new PropertyViolation(`Webhook property violated: ${scenario.name}; inspect its logs`);
  console.log(`webhooks/${scenario.name}: passed`);
  const counts = combined.log.match(/([\d,]+) states generated, ([\d,]+) distinct states found/);
  if (!counts) throw new Error(`Missing TLC state counts: ${scenario.name}`);
  return {
    name: scenario.name,
    checks,
    generatedStates: Number(counts[1]!.replaceAll(",", "")),
    distinctStates: Number(counts[2]!.replaceAll(",", "")),
  };
}

async function mutation(jar: string, scenario: Scenario) {
  const result = await execute(jar, scenario);
  if (result.code === 0 || !modelViolation(scenario.checks[0]!, result.log, []))
    throw new Error(`Webhook model mutation not detected: ${scenario.name}; inspect its log`);
  console.log(`webhooks/${scenario.name}: mutation detected`);
  return { name: scenario.name, check: scenario.checks[0], outcome: "mutation-detected" };
}

async function sourceHashes() {
  const webhooks = (await readdir(join(root, "src"))).filter(
    (name) => name.startsWith("webhook") && name.endsWith(".ts"),
  );
  const paths = [
    ...webhooks.map((name) => `src/${name}`),
    "src/coordinator.ts",
    "src/inbound.ts",
    "src/api.ts",
    "src/events.ts",
    "src/inbox-metadata.ts",
    "src/maintenance.ts",
    "src/queue-jobs.ts",
    "src/index.ts",
    "src/idempotency.ts",
    "src/client.ts",
    "src/outbound.ts",
    "src/dispatch-barrier.ts",
    "migrations/0006_inbox_webhooks.sql",
    "migrations/0009_recovery_indexes.sql",
    "wrangler.jsonc",
  ];
  return Promise.all(
    paths.map(async (path) => ({
      path,
      sha256: new Bun.CryptoHasher("sha256").update(await readFile(join(root, path))).digest("hex"),
    })),
  );
}

async function main() {
  await mkdir(output, { recursive: true });
  await rm(join(output, "result.json"), { force: true });
  await rm(join(output, "selftest-result.json"), { force: true });
  const types = await run([
    "bun",
    "run",
    "tsc",
    "--project",
    "verification/webhooks/tsconfig.json",
  ]);
  if (types.code !== 0) throw new Error(`Webhook verification typecheck failed: ${types.log}`);
  for (const module of new Set(scenarios.map((scenario) => scenario.module)))
    await copyFile(join(import.meta.dir, `${module}.tla`), join(scratch, `${module}.tla`));
  const jar = await verifierJar();
  const checks = [];
  for (const scenario of scenarios) checks.push(await baseline(jar, scenario));
  const sourceMutations = await checkSourceMutations(root, scratch, output, selftest);
  const evidence = {
    bounds: {
      inboxes: 2,
      coordinatorIncarnations: 3,
      configurationWrites: 2,
      deliveryClaims: 2,
      messagesPerInbox: 1,
      logicalSendCalls: 2,
    },
    assumptions: [
      "Atomic D1 writes, triggers, uniqueness and conditional updates",
      "Monotonic SQLite ownership fences; no await between fence and fetch initiation",
      "Webhook retries are at-least-once and preserve their delivery identity; receivers deduplicate",
      "Distinct generated UUIDv4 values are collision-free within this finite model",
      "Cryptography, exact-origin validation, HTTP behavior and elapsed timeout arithmetic require real-code tests",
      "The existing outbound model independently protects email unknown-outcome non-retry",
    ],
    sourceMutations,
    realCodeReplays: 8,
    checks,
    sources: await sourceHashes(),
  };
  await writeFile(join(output, "result.json"), JSON.stringify(evidence, null, 2));
  if (!selftest) return;
  const mutations = [];
  for (const mutant of mutants) mutations.push(await mutation(jar, mutant));
  await writeFile(
    join(output, "selftest-result.json"),
    JSON.stringify({ ...evidence, mutations }, null, 2),
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Webhook verification tool failed");
  process.exitCode =
    error instanceof PropertyViolation || error instanceof ReplayAssertionFailure ? 1 : 2;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
