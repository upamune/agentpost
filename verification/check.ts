import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { tlcCommand } from "./tlc";

const root = resolve(import.meta.dir, "..");
const area = process.argv[2];
if (area !== "outbound" && area !== "inbound") throw new Error("Expected outbound or inbound");
const selftest = process.argv.includes("--selftest");
const output = resolve(root, process.env.AGENTPOST_FORMAL_OUTPUT ?? `.verification/${area}`);
const scratch = await mkdtemp(join(tmpdir(), `agentpost-${area}-`));
const moduleName = area === "outbound" ? "Outbound" : "Inbound";
const invariants =
  area === "outbound"
    ? [
        "TypeOK",
        "AtMostOneAcceptance",
        "NoBlindRetry",
        "NoDispatchAfterDisable",
        "NoDispatchAfterUnknown",
      ]
    : ["TypeOK", "OriginalRetained", "IndexHasOriginal", "ReadyHasParsed", "PoisonVisible"];
const properties = area === "inbound" ? ["EventuallyReady"] : [];
const sourceFiles =
  area === "outbound"
    ? [
        "src/coordinator.ts",
        "src/outbound.ts",
        "src/maintenance.ts",
        "src/api.ts",
        "src/index.ts",
        "wrangler.jsonc",
        "migrations/0001_mail.sql",
        "migrations/0004_inbox_active_version.sql",
      ]
    : [
        "src/inbound.ts",
        "src/bounded-json.ts",
        "src/maintenance.ts",
        "src/index.ts",
        "src/api.ts",
        "migrations/0001_mail.sql",
        "migrations/0002_events.sql",
        "migrations/0003_raw_recovery.sql",
      ];

type Mutation = {
  name: string;
  constant: string;
  checks: string[];
  file: string;
  needle: string;
  replacement: string;
  pattern: string;
  model?: string;
};
const mutations: Mutation[] =
  area === "outbound"
    ? [
        {
          name: "claim",
          constant: "UnsafeClaim",
          checks: ["AtMostOneAcceptance", "NoBlindRetry"],
          file: "outbound",
          needle: "AND status = 'pending' AND available_at",
          replacement: "AND available_at",
          pattern: "provider accepts the same request|unknown outcomes",
        },
        {
          name: "serialization",
          constant: "UnsafeSerialization",
          checks: ["NoDispatchAfterDisable", "NoDispatchAfterUnknown"],
          file: "coordinator",
          needle: "const result = this.tail.then(operation);",
          replacement: "const result = operation();",
          pattern: "no new provider|stale worker",
        },
        {
          name: "fence",
          constant: "UnsafeFence",
          checks: ["NoDispatchAfterDisable", "NoDispatchAfterUnknown"],
          file: "outbound",
          needle: "    beforeDispatch();",
          replacement: "    // removed ownership fence",
          pattern: "ownership fence failure",
        },
        {
          name: "version",
          constant: "UnsafeActiveVersion",
          checks: ["NoStaleActiveWrite"],
          file: "coordinator",
          needle: "AND active_version < ?",
          replacement: "AND ? > 0",
          pattern: "delayed old enable",
          model: "ActiveVersion",
        },
      ]
    : [
        {
          name: "poison",
          constant: "UnsafePoison",
          checks: ["EventuallyReady"],
          file: "inbound",
          needle: "    } catch (error) {\n      // One poisoned object",
          replacement: "    } catch (error) {\n      throw error;\n      // One poisoned object",
          pattern: "poisoned first page",
        },
        {
          name: "retention",
          constant: "UnsafeDelete",
          checks: ["OriginalRetained", "IndexHasOriginal"],
          file: "inbound",
          needle: "  const document = {",
          replacement: "  await env.MAIL.delete(message.raw_key);\n  const document = {",
          pattern: "D1 failure after raw persistence",
        },
        {
          name: "ready",
          constant: "UnsafeReady",
          checks: ["ReadyHasParsed"],
          file: "inbound",
          needle:
            "await env.MAIL.put(`parsed/${id}.json`, stringifyBoundedJson(document, 16 * 1024 * 1024), {",
          replacement: "await Promise.resolve({",
          pattern: "failures before parsed storage",
        },
        {
          name: "attention",
          constant: "UnsafeAttention",
          checks: ["PoisonVisible"],
          file: "inbound",
          needle: '      await env.DB.prepare(\n        "INSERT INTO raw_recovery_failures',
          replacement: '      await env.DB.prepare(\n        "INSERT INTO raw_recovery_failures',
          pattern: "poisoned first page",
        },
      ];

function run(args: string[], extra: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync(args, {
    cwd: root,
    env: { ...process.env, ...extra },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  });
  const log = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.signalCode) throw new Error(`Cannot run ${args[0]}: ${log}`);
  return { code: result.exitCode, log };
}

type ReplayCase = { title: string; status: string; failureMessages: string[] };
async function replay(name: string, mutant?: { file: string; path: string }, pattern?: string) {
  const reportFile = join(scratch, `${name}.json`);
  const args = [
    "bun",
    "run",
    "vitest",
    "run",
    "--config",
    `verification/${area}/vitest.config.ts`,
    "--reporter=json",
    "--outputFile",
    reportFile,
  ];
  if (pattern) args.push("-t", pattern);
  const result = run(args, {
    AGENTPOST_FORMAL_MUTANT: mutant?.path,
    AGENTPOST_FORMAL_MUTANT_MODULE: mutant?.file,
    AGENTPOST_FORMAL_INBOUND_MUTANT: area === "inbound" ? mutant?.path : undefined,
  });
  await writeFile(join(output, `${name}.log`), result.log);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  await copyFile(reportFile, join(output, `${name}-report.json`));
  const cases: ReplayCase[] = report.testResults
    .flatMap((file: { assertionResults: ReplayCase[] }) => file.assertionResults)
    .filter((item: ReplayCase) => item.status !== "pending" && item.status !== "skipped");
  const expected = pattern ? undefined : 8;
  if (
    !cases.length ||
    (expected && cases.length !== expected) ||
    report.numRuntimeErrorTestSuites > 0 ||
    report.numUnhandledErrors > 0
  )
    throw new Error(
      `Replay did not run correctly; inspect ${name}-report.json: ${JSON.stringify(report.testResults.map((item: { message?: string }) => item.message))}`,
    );
  if (result.code !== 0 && !cases.some((item) => item.status === "failed"))
    throw new Error(`Replay exited without a failed assertion; inspect ${name}.log`);
  await writeFile(
    join(output, `${name}.json`),
    JSON.stringify({ exitCode: result.code, cases }, null, 2),
  );
  return { exitCode: result.code, cases };
}

try {
  await mkdir(output, { recursive: true });
  await symlink(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  if (!selftest) await rm(join(output, "result.json"), { force: true });
  const types = run(["bun", "run", "tsc", "--project", `verification/${area}/tsconfig.json`]);
  if (types.code !== 0) throw new Error(`Verification harness typecheck failed: ${types.log}`);
  const installed = run(["mise", "where", "github:tlaplus/tlaplus"]);
  if (installed.code !== 0)
    throw new Error("Install verifier tools with mise install java github:tlaplus/tlaplus");
  const jar = join(installed.log.trim(), "tla2tools.jar");
  const expected = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
  if (
    new Bun.CryptoHasher("sha256").update(await Bun.file(jar).arrayBuffer()).digest("hex") !==
    expected
  )
    throw new Error("TLC checksum mismatch");
  await copyFile(
    join(root, `verification/${area}/${moduleName}.tla`),
    join(scratch, `${moduleName}.tla`),
  );
  if (area === "outbound")
    await copyFile(
      join(root, "verification/outbound/ActiveVersion.tla"),
      join(scratch, "ActiveVersion.tla"),
    );
  const versionConfig =
    area === "outbound"
      ? (await readFile(join(root, "verification/outbound/ActiveVersion.cfg"), "utf8")).replace(
          /^INVARIANT.*\n/gm,
          "",
        )
      : "";
  const config = await readFile(join(root, `verification/${area}/${moduleName}.cfg`), "utf8");
  const bare = config.replace(/^(?:INVARIANT|PROPERTY).*\n/gm, "");
  async function tlc(name: string, selected: string, configuration = bare, model = moduleName) {
    const selectedConfig = join(scratch, `${name}.cfg`);
    await writeFile(
      selectedConfig,
      `${configuration}${properties.includes(selected) ? "PROPERTY" : "INVARIANT"} ${selected}\n`,
    );
    const result = run(
      await tlcCommand(
        jar,
        [
          "-workers",
          "1",
          "-config",
          selectedConfig,
          "-metadir",
          join(scratch, name),
          join(scratch, `${model}.tla`),
        ],
        scratch,
      ),
    );
    await writeFile(join(output, `${name}.log`), result.log);
    const violated =
      result.log.includes(`Invariant ${selected} is violated`) ||
      (properties.includes(selected) && result.log.includes("Temporal properties were violated"));
    if (result.code !== 0 && !violated) throw new Error(`${selected} could not run: ${result.log}`);
    if (
      result.code === 0 &&
      !result.log.includes("Model checking completed. No error has been found")
    )
      throw new Error(`Missing TLC completion: ${selected}`);
    return { check: selected, outcome: violated ? "violated" : "passed" };
  }
  if (selftest) {
    for (const mutation of mutations) {
      const baselineConfig = mutation.model ? versionConfig : bare;
      for (const check of mutation.checks) {
        if (
          (await tlc(`original-${mutation.name}-${check}`, check, baselineConfig, mutation.model))
            .outcome !== "passed"
        )
          throw new Error(`Baseline ${check} failed`);
        const config = baselineConfig.replace(
          `${mutation.constant} = FALSE`,
          `${mutation.constant} = TRUE`,
        );
        if (config === baselineConfig) throw new Error(`Missing mutation ${mutation.constant}`);
        if (
          (await tlc(`mutant-${mutation.name}-${check}`, check, config, mutation.model)).outcome !==
          "violated"
        )
          throw new Error(`Model mutation not caught: ${mutation.name}/${check}`);
      }
      const original = await readFile(join(root, `src/${mutation.file}.ts`), "utf8");
      let broken: string;
      if (mutation.name === "attention") {
        const start = original.indexOf(
          '      await env.DB.prepare(\n        "INSERT INTO raw_recovery_failures',
        );
        const end = original.indexOf("      failures++;", start);
        if (start < 0 || end < 0) throw new Error("Attention implementation drifted");
        broken = original.slice(0, start) + original.slice(end);
      } else {
        if (original.split(mutation.needle).length !== 2)
          throw new Error(`Implementation drifted: ${mutation.name}`);
        broken = original.replace(mutation.needle, mutation.replacement);
      }
      const path = join(scratch, `${mutation.file}.ts`);
      await writeFile(path, broken.replaceAll('from "./', `from "${root}/src/`));
      const good = await replay(`original-${mutation.name}`, undefined, mutation.pattern);
      const bad = await replay(
        `mutant-${mutation.name}`,
        { file: mutation.file, path },
        mutation.pattern,
      );
      if (
        good.exitCode !== 0 ||
        bad.exitCode === 0 ||
        !bad.cases.some((item) => item.status === "failed")
      )
        throw new Error(`Real-code mutation not detected: ${mutation.name}`);
      console.log(`${area}/${mutation.name}: model and real-code mutations detected`);
    }
  } else {
    const checks = [];
    for (const check of [...invariants, ...properties]) {
      const result = await tlc(check, check);
      checks.push(result);
      console.log(`${area}/${check}: ${result.outcome}`);
    }
    if (area === "outbound") {
      const types = await tlc("ActiveVersionTypeOK", "TypeOK", versionConfig, "ActiveVersion");
      checks.push({ ...types, check: "ActiveVersionTypeOK" });
      const result = await tlc(
        "NoStaleActiveWrite",
        "NoStaleActiveWrite",
        versionConfig,
        "ActiveVersion",
      );
      checks.push(result);
      console.log(`${area}/NoStaleActiveWrite: ${result.outcome}`);
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
      verifiedProductCommit: (
        await readFile(join(root, "verification/product-revision.txt"), "utf8")
      ).trim(),
      bounds:
        area === "outbound"
          ? { workers: 2, maxClaims: 8, actualRetryLimit: 8 }
          : { originals: 3, valid: 2, poisoned: 1, pageSize: 1, transientFaults: 2 },
      assumptions:
        area === "outbound"
          ? [
              "D1 statements atomic; no rollback",
              "429/explicit rejection never accepted mail",
              "unknown may have accepted mail",
              "actor serialization and synchronous ownership fence; delayed replaced actors included",
            ]
          : [
              "originals already successfully persisted",
              "finite stable corpus",
              "at most two transient faults",
              "weakly fair successful Cron, queue and parse actions",
              "two valid originals fit MIME and 16 MiB parsed-output limits and parse successfully; one poisoned metadata object",
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
