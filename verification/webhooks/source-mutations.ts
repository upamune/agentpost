import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class ReplayAssertionFailure extends Error {}
const mutants = [
  {
    name: "configuration-version",
    module: "webhook-store",
    pattern: "configuration replay",
    needle: "WHERE inbox_webhooks.version < excluded.version RETURNING id",
    replacement: "WHERE 1 = 1 RETURNING id",
  },
  {
    name: "conditional-claim",
    module: "webhook-delivery",
    pattern: "conditional claim replay",
    needle: "AND status = 'pending' AND available_at",
    replacement: "AND available_at",
  },
  {
    name: "ownership-fence",
    module: "webhook-delivery",
    pattern: "ownership fence replay",
    needle: "  beforeDispatch();",
    replacement: "  // Removed ownership fence.",
  },
  {
    name: "claim-token",
    module: "webhook-delivery",
    pattern: "claim token replay",
    needle: "AND status = 'sending' AND claim_token = ? RETURNING id",
    replacement: "AND status = 'sending' AND ? IS NOT NULL RETURNING id",
  },
  {
    name: "dispatch-barrier",
    module: "dispatch-barrier",
    pattern: "dispatch barrier replay",
    needle: "  const result = await env.DB.batch([",
    replacement: "  return true;\n  const result = await env.DB.batch([",
  },
];
type ReportCase = { status: string; failureMessages: string[] };
type Report = {
  numRuntimeErrorTestSuites: number;
  numUnhandledErrors: number;
  testResults: { assertionResults: ReportCase[] }[];
};

function selectedCases(name: string, report: Report, expected: number) {
  if (report.numRuntimeErrorTestSuites || report.numUnhandledErrors)
    throw new Error(`Runtime failure in webhook replay ${name}`);
  const cases = report.testResults
    .flatMap((result) => result.assertionResults)
    .filter((test) => test.status !== "pending" && test.status !== "skipped");
  if (cases.length !== expected)
    throw new Error(`Expected ${expected} webhook replays for ${name}`);
  return cases;
}

function assertBaseline(name: string, cases: ReportCase[], code: number) {
  if (code === 0 && cases.every((test) => test.status === "passed")) return;
  if (
    cases.some((test) => test.failureMessages.some((message) => message.includes("AssertionError")))
  )
    throw new ReplayAssertionFailure(`Webhook baseline assertion failed: ${name}`);
  throw new Error(`Unexpected webhook replay outcome: ${name}`);
}

function assertOutcome(name: string, report: Report, code: number, broken: boolean) {
  const cases = selectedCases(name, report, broken ? 1 : 8);
  if (!broken) return assertBaseline(name, cases, code);
  const selected = cases[0]!;
  if (code === 0 || selected.status !== "failed")
    throw new Error(`Webhook mutation survived: ${name}`);
  if (!selected.failureMessages.some((message) => message.includes("AssertionError")))
    throw new Error(`Webhook mutation did not fail an assertion: ${name}`);
}

async function replay(
  root: string,
  output: string,
  name: string,
  mutation?: { module: string; path: string; pattern: string },
) {
  const reportFile = join(output, `${name}-report.json`);
  const filter = mutation ? ["--testNamePattern", mutation.pattern] : [];
  const child = Bun.spawnSync(
    [
      "bun",
      "run",
      "vitest",
      "run",
      "--config",
      "verification/webhooks/vitest.config.ts",
      "--reporter=json",
      "--outputFile",
      reportFile,
      ...filter,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        AGENTPOST_FORMAL_MUTANT: mutation?.path,
        AGENTPOST_FORMAL_MUTANT_MODULE: mutation?.module,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
    },
  );
  await writeFile(
    join(output, `${name}.log`),
    `${child.stdout.toString()}${child.stderr.toString()}`,
  );
  if (child.signalCode) throw new Error(`Webhook replay interrupted: ${name}`);
  const report: Report = JSON.parse(await readFile(reportFile, "utf8"));
  assertOutcome(name, report, child.exitCode, mutation !== undefined);
}

export async function checkSourceMutations(
  root: string,
  scratch: string,
  output: string,
  selftest: boolean,
) {
  await replay(root, output, "source-original");
  console.log("webhooks/real-code: 8 replays passed");
  const results: { name: string; baseline: string; mutation: string }[] = [];
  if (!selftest) return results;
  for (const mutant of mutants) {
    const original = await readFile(join(root, `src/${mutant.module}.ts`), "utf8");
    if (original.split(mutant.needle).length !== 2)
      throw new Error(`Webhook implementation drifted: ${mutant.name}`);
    const path = join(scratch, `${mutant.module}.ts`);
    await writeFile(
      path,
      original
        .replace(mutant.needle, mutant.replacement)
        .replaceAll('from "./', `from "${root}/src/`),
    );
    await replay(root, output, `source-mutant-${mutant.name}`, { ...mutant, path });
    console.log(`webhooks/${mutant.name}: real-code mutation detected`);
    results.push({ name: mutant.name, baseline: "passed", mutation: "assertion-failed" });
  }
  return results;
}
