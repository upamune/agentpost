import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tlcCommand } from "../verification/tlc";
import { groupedOutcomes, modelOutcome } from "../verification/model-results";

const checkout = resolve(import.meta.dir, "..");
const modules = ["Naturals", "FiniteSets", "Sequences"];
const complete = { code: 0, log: "Model checking completed. No error has been found" };

test("a successful grouped traversal certifies every named property without extra traversals", async () => {
  let reruns = 0;
  const results = await groupedOutcomes(["TypeOK", "Safe"], [], complete, async () => {
    reruns++;
    return complete;
  });
  expect(results).toEqual([
    { check: "TypeOK", outcome: "passed" },
    { check: "Safe", outcome: "passed" },
  ]);
  expect(reruns).toBe(0);
});

test("a first grouped failure cannot mark unvisited properties as passing", async () => {
  const checked: string[] = [];
  const results = await groupedOutcomes(
    ["TypeOK", "Safe", "EventuallyReady"],
    ["EventuallyReady"],
    { code: 12, log: "Invariant Safe is violated" },
    async (check) => {
      checked.push(check);
      if (check === "Safe") return { code: 12, log: "Invariant Safe is violated" };
      if (check === "EventuallyReady")
        return { code: 13, log: "Temporal properties were violated" };
      return complete;
    },
  );
  expect(checked).toEqual(["TypeOK", "Safe", "EventuallyReady"]);
  expect(results.map((result) => result.outcome)).toEqual(["passed", "violated", "violated"]);
});

test("tool failures and incomplete TLC output never become passing grouped evidence", async () => {
  await expect(
    groupedOutcomes(["Safe"], [], { code: 1, log: "Cannot parse model" }, async () => complete),
  ).rejects.toThrow("could not run");
  await expect(
    groupedOutcomes(["Safe"], [], { code: 0, log: "Starting TLC" }, async () => complete),
  ).rejects.toThrow("Missing TLC completion");
  await expect(
    groupedOutcomes(["Safe"], [], { code: 12, log: "Invariant Safe is violated" }, async () => ({
      code: 1,
      log: "JVM failed",
    })),
  ).rejects.toThrow("could not run");
  expect(() => modelOutcome("Safe", { code: 12, log: "Invariant Other is violated" }, [])).toThrow(
    "could not run",
  );
});
const model = `---- MODULE TempIsolation ----
EXTENDS Naturals, FiniteSets, Sequences
VARIABLE x
Init == x = <<0>>
Next == IF Len(x) < 3 THEN x' = Append(x, Len(x)) ELSE UNCHANGED x
Spec == Init /\\ [][Next]_x
Safe == Cardinality({x[i] : i \\in 1..Len(x)}) <= 3
====
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentpost-tlc-test-"));
  const ambient = join(root, "ambient");
  const scratch = join(root, "private scratch");
  await mkdir(ambient);
  await mkdir(scratch);
  for (const name of modules) await writeFile(join(ambient, `${name}.tla`), `sentinel:${name}`);
  const installed = Bun.spawnSync(["mise", "where", "github:tlaplus/tlaplus"], {
    cwd: checkout,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (installed.exitCode !== 0) throw new Error(installed.stderr.toString());
  const jar = join(installed.stdout.toString().trim(), "tla2tools.jar");
  return { root, ambient, scratch, jar };
}

async function checkModel(setup: Awaited<ReturnType<typeof fixture>>, name: string) {
  const folder = join(setup.scratch, name);
  await mkdir(folder);
  await writeFile(join(folder, "TempIsolation.tla"), model);
  await writeFile(join(folder, "TempIsolation.cfg"), "SPECIFICATION Spec\nINVARIANT Safe\n");
  const command = await tlcCommand(
    setup.jar,
    [
      "-workers",
      "1",
      "-config",
      join(folder, "TempIsolation.cfg"),
      "-metadir",
      join(folder, "states"),
      join(folder, "TempIsolation.tla"),
    ],
    setup.scratch,
  );
  const child = Bun.spawn(command, {
    cwd: checkout,
    timeout: 20_000,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ?? ""} -Djava.io.tmpdir=${setup.ambient}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, log: code === 0 ? undefined : stdout + stderr }).toEqual({
    code: 0,
    log: undefined,
  });
  expect(stdout).toContain("Model checking completed. No error has been found");
  return stdout;
}

async function assertSentinels(ambient: string) {
  for (const name of modules) {
    const contents = await readFile(join(ambient, `${name}.tla`), "utf8").catch(() => "missing");
    expect(contents).toBe(`sentinel:${name}`);
  }
}

test("real TLC preserves standard-module files in the inherited JVM temporary directory", async () => {
  const setup = await fixture();
  try {
    await checkModel(setup, "single");
    await assertSentinels(setup.ambient);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
}, 30_000);

test("concurrent real TLC invocations extract standard modules into distinct private directories", async () => {
  const setup = await fixture();
  try {
    const completed = await Promise.allSettled([
      checkModel(setup, "first"),
      checkModel(setup, "second"),
    ]);
    const logs = completed.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const privateRoot = await realpath(setup.scratch);
    const paths = logs.map((log) => log.match(/^Parsing file (.+\/Naturals\.tla)$/m)?.[1]);
    expect(paths.every((path) => path?.startsWith(`${privateRoot}/`))).toBe(true);
    expect(new Set(paths).size).toBe(2);
    await assertSentinels(setup.ambient);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
}, 30_000);
