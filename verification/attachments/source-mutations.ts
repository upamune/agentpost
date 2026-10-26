import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class ReplayAssertionFailure extends Error {}

const mutants = [
  {
    name: "inbox-binding",
    module: "api",
    pattern: "foreign, missing, duplicate IDs",
    needle: 'if (!inbox || !canAccessInbox(context.get("principal"), inbox))',
    replacement: "if (!inbox)",
  },
  {
    name: "integrity",
    module: "attachments",
    pattern: "integrity replay rejects substituted bytes",
    needle:
      "if (bytes.byteLength !== descriptor.size || (await sha256(bytes)) !== descriptor.sha256)",
    replacement: "if (bytes.byteLength !== descriptor.size)",
  },
];
type ReportCase = { status: string; failureMessages: string[] };
type Report = {
  numRuntimeErrorTestSuites: number;
  numUnhandledErrors: number;
  testResults: { assertionResults: ReportCase[] }[];
};

function replayCase(name: string, report: Report): ReportCase {
  if (report.numRuntimeErrorTestSuites || report.numUnhandledErrors)
    throw new Error(`Runtime failure in attachment replay ${name}`);
  const cases = report.testResults
    .flatMap((result) => result.assertionResults)
    .filter((test) => test.status !== "pending" && test.status !== "skipped");
  if (cases.length !== 1) throw new Error(`Expected one attachment replay for ${name}`);
  return cases[0]!;
}

function isAssertionFailure(selected: ReportCase): boolean {
  return selected.failureMessages.some((message) => message.includes("AssertionError"));
}

function assertBaseline(name: string, selected: ReportCase, code: number): void {
  if (code === 0 && selected.status === "passed") return;
  if (selected.status === "failed" && isAssertionFailure(selected))
    throw new ReplayAssertionFailure(`Attachment baseline assertion failed: ${name}`);
  throw new Error(`Unexpected attachment baseline outcome: ${name}`);
}

function assertReport(name: string, report: Report, code: number, broken: boolean): void {
  const selected = replayCase(name, report);
  if (!broken) return assertBaseline(name, selected, code);
  if (code === 0 || selected.status !== "failed")
    throw new Error(`Unexpected attachment mutation outcome: ${name}`);
  if (!isAssertionFailure(selected)) throw new Error(`Mutation did not fail an assertion: ${name}`);
}

async function replay(
  root: string,
  output: string,
  name: string,
  pattern: string,
  mutation?: { module: string; path: string },
) {
  const reportFile = join(output, `${name}-report.json`);
  const child = Bun.spawnSync(
    [
      "bun",
      "run",
      "vitest",
      "run",
      "--config",
      "verification/attachments/vitest.config.ts",
      "--reporter=json",
      "--outputFile",
      reportFile,
      "--testNamePattern",
      pattern,
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
  if (child.signalCode) throw new Error(`Attachment replay interrupted: ${name}`);
  const report: Report = JSON.parse(await readFile(reportFile, "utf8"));
  assertReport(name, report, child.exitCode, mutation !== undefined);
}

export async function checkSourceMutations(root: string, scratch: string, output: string) {
  const results = [];
  for (const mutant of mutants) {
    const original = await readFile(join(root, `src/${mutant.module}.ts`), "utf8");
    if (original.split(mutant.needle).length !== 2)
      throw new Error(`Attachment implementation drifted: ${mutant.name}`);
    const path = join(scratch, `${mutant.module}.ts`);
    const broken = original
      .replace(mutant.needle, mutant.replacement)
      .replaceAll('from "./', `from "${root}/src/`);
    await writeFile(path, broken);
    await replay(root, output, `source-original-${mutant.name}`, mutant.pattern);
    await replay(root, output, `source-mutant-${mutant.name}`, mutant.pattern, {
      module: mutant.module,
      path,
    });
    console.log(`attachments/${mutant.name}: real-code mutation detected`);
    results.push({ name: mutant.name, baseline: "passed", mutation: "assertion-failed" });
  }
  return results;
}
