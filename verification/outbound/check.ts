import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, process.env.AGENTPOST_FORMAL_OUTPUT ?? ".verification/outbound");
const scratch = await mkdtemp(join(tmpdir(), "agentpost-outbound-"));
const selftest = process.argv.includes("--selftest");
const sourceFiles = [
  "src/outbound.ts",
  "src/maintenance.ts",
  "src/api.ts",
  "src/index.ts",
  "migrations/0001_mail.sql",
];

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync(args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const log = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.signalCode) throw new Error(`Cannot run ${args[0]}: ${log}`);
  return { code: result.exitCode, log };
}

async function replay(name: string, mutant?: string, onlySafety = false) {
  const reportFile = join(scratch, `${name}.json`);
  const args = [
    "bun",
    "run",
    "vitest",
    "run",
    "--config",
    "verification/outbound/vitest.config.ts",
    "--reporter=json",
    "--outputFile",
    reportFile,
  ];
  if (onlySafety) args.push("-t", "provider accepts the same request at most once");
  const result = run(args, { AGENTPOST_FORMAL_MUTANT: mutant });
  await writeFile(join(output, `${name}.log`), result.log);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  const cases = report.testResults.flatMap(
    (file: { assertionResults: { title: string; status: string; failureMessages: string[] }[] }) =>
      file.assertionResults,
  );
  if (!cases.length || report.numRuntimeErrorTestSuites > 0)
    throw new Error(`Replay did not run correctly; inspect ${name}.log`);
  if (result.code !== 0 && !cases.some((item: { status: string }) => item.status === "failed"))
    throw new Error(`Replay exited without a failed assertion; inspect ${name}.log`);
  await writeFile(
    join(output, `${name}.json`),
    JSON.stringify({ exitCode: result.code, cases }, null, 2),
  );
  return { exitCode: result.code, cases };
}

try {
  await mkdir(output, { recursive: true });
  await rm(join(output, "result.json"), { force: true });
  const types = run(["bun", "run", "tsc", "--project", "verification/outbound/tsconfig.json"]);
  if (types.code !== 0) throw new Error(`Verification harness typecheck failed: ${types.log}`);
  const installed = run(["mise", "where", "github:tlaplus/tlaplus"]);
  if (installed.code !== 0)
    throw new Error("Install verifier tools with mise install java github:tlaplus/tlaplus");
  const jar = join(installed.log.trim(), "tla2tools.jar");
  const expected = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(jar).arrayBuffer())
    .digest("hex");
  if (digest !== expected) throw new Error("TLC checksum mismatch");
  for (const name of ["Outbound.tla", "Outbound.cfg", "Outbound.map.mjs"])
    await copyFile(join(import.meta.dir, name), join(scratch, name));
  const config = await readFile(join(scratch, "Outbound.cfg"), "utf8");
  const model = join(scratch, "Outbound.tla");

  if (selftest) {
    const safety = config.replace(/^INVARIANT.*\n/gm, "");
    for (const invariant of ["AtMostOneAcceptance", "NoBlindRetry"]) {
      const baseline = join(scratch, `${invariant}.cfg`);
      await writeFile(baseline, `${safety}INVARIANT ${invariant}\n`);
      const good = run([
        "java",
        "-XX:+UseParallelGC",
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        "1",
        "-config",
        baseline,
        "-metadir",
        join(scratch, `good-${invariant}`),
        model,
      ]);
      if (good.code !== 0) throw new Error(`Baseline ${invariant} failed: ${good.log}`);
      await writeFile(
        baseline,
        `${safety.replace("UnsafeClaim = FALSE", "UnsafeClaim = TRUE")}INVARIANT ${invariant}\n`,
      );
      const bad = run([
        "java",
        "-XX:+UseParallelGC",
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        "1",
        "-config",
        baseline,
        "-metadir",
        join(scratch, `bad-${invariant}`),
        model,
      ]);
      if (!bad.log.includes(`Invariant ${invariant} is violated`))
        throw new Error(`Mutation not caught by ${invariant}: ${bad.log}`);
      await writeFile(join(output, `mutation-${invariant}.log`), bad.log);
      console.log(`${invariant}: baseline passed; unguarded claim mutation detected`);
    }
    const original = await readFile(join(root, "src/outbound.ts"), "utf8");
    const needle = "AND status = 'pending' AND available_at";
    if (original.split(needle).length !== 2)
      throw new Error("Claim implementation drifted; review the mutation");
    const mutantFile = join(scratch, "outbound.ts");
    await writeFile(mutantFile, original.replace(needle, "AND available_at"));
    const good = await replay("safety-original", undefined, true);
    const bad = await replay("safety-mutant", mutantFile, true);
    if (
      good.exitCode !== 0 ||
      bad.exitCode === 0 ||
      !bad.cases.some((item: { status: string }) => item.status === "failed")
    )
      throw new Error("Real-code mutation was not detected");
    console.log(
      "Real-code mutation detected: duplicate queue deliveries called the provider twice",
    );
  } else {
    const checks = [];
    for (const invariant of [
      "TypeOK",
      "AtMostOneAcceptance",
      "NoBlindRetry",
      "NoDispatchAfterDisable",
      "NoDispatchAfterUnknown",
    ]) {
      const selected = join(scratch, `${invariant}.cfg`);
      await writeFile(
        selected,
        `${config.replace(/^INVARIANT.*\n/gm, "")}INVARIANT ${invariant}\n`,
      );
      const result = run([
        "java",
        "-XX:+UseParallelGC",
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        "1",
        "-config",
        selected,
        "-metadir",
        join(scratch, `states-${invariant}`),
        model,
      ]);
      const violated = result.log.includes(`Invariant ${invariant} is violated`);
      if (result.code !== 0 && !violated)
        throw new Error(`${invariant} could not run: ${result.log}`);
      checks.push({ invariant, outcome: violated ? "violated" : "passed" });
      await writeFile(join(output, `${invariant}.log`), result.log);
      console.log(`${invariant}: ${violated ? "VIOLATED" : "passed"}`);
    }
    const actual = await replay("replay");
    const hashes = await Promise.all(
      sourceFiles.map(async (path) => ({
        path,
        sha256: new Bun.CryptoHasher("sha256")
          .update(await readFile(join(root, path)))
          .digest("hex"),
      })),
    );
    const evidence = {
      verifiedProductCommit: "ed15d43123471a7de7c89be7f77f5380da136dc9",
      bounds: { workers: 2, maxClaims: 8, actualRetryLimit: 8 },
      assumptions: [
        "each D1 SQL statement is atomic",
        "429 and explicit provider rejections do not accept a message",
        "unknown provider outcomes may have accepted it",
        "scheduler may delay a worker across Cron's two-minute threshold",
      ],
      sourceFiles: hashes,
      checks,
      replay: actual,
    };
    await writeFile(join(output, "result.json"), JSON.stringify(evidence, null, 2));
    console.log(`Evidence: ${output}`);
    process.exitCode =
      checks.some((check) => check.outcome === "violated") || actual.exitCode !== 0 ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Verification tool failed");
  process.exitCode = 2;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
