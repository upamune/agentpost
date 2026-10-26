import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runComplexity } from "../scripts/check-complexity";
import { collectFunctions, reportSchema } from "../scripts/complexity-policy";

const temporary: string[] = [];
const policy = () => ({
  version: 1,
  toolVersion: "1.8.4",
  limits: { cognitive: 15, cyclomatic: 10 },
  exceptions: {},
});
const branches = (count: number) =>
  Array.from({ length: count }, (_, i) => `if (value === ${i}) return ${i};`).join("\n");
const source = (count: number) =>
  `export function dispatch(value: number) { ${branches(count)} return -1; }`;
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(code = source(1)) {
  const root = await mkdtemp(join(tmpdir(), "agentpost-complexity-"));
  temporary.push(root);
  for (const folder of ["src", "scripts", "verification", "website"])
    await mkdir(join(root, folder));
  await writeFile(
    join(root, "cccc.toml"),
    await Bun.file(new URL("../cccc.toml", import.meta.url)).text(),
  );
  await writeFile(join(root, "complexity-baseline.json"), JSON.stringify(policy()));
  await writeFile(join(root, "src", "app.ts"), code);
  return root;
}

async function report(root: string) {
  const saved = JSON.parse(await readFile(join(root, ".complexity", "report.json"), "utf8"));
  return reportSchema.parse(saved.report);
}

test("pinned real cccc produces a complete clean report", async () => {
  const root = await fixture();
  expect(await runComplexity(root)).toBe(0);
  expect((await report(root)).summary.function_count).toBe(1);
});

test("real nested functions use their own limits and anonymous siblings do not share exceptions", async () => {
  const complex = `(value: number) => { ${branches(16)} return -1; }`;
  const root = await fixture(`export function outer() { return [${complex}, ${complex}]; }`);
  expect(await runComplexity(root)).toBe(1);
  const functions = [...collectFunctions(await report(root))];
  const [key, fn] = functions.find(([key]) => key.includes("arrow:"))!;
  await writeFile(
    join(root, "complexity-baseline.json"),
    JSON.stringify({
      ...policy(),
      exceptions: { [key]: { cognitive: fn.cognitive, cyclomatic: fn.cyclomatic } },
    }),
  );
  expect(await runComplexity(root)).toBe(1);
  const saved = JSON.parse(await readFile(join(root, ".complexity", "report.json"), "utf8"));
  expect(saved.failures).toHaveLength(1);
  expect(saved.failures[0]).toContain("#2");
});

test("existing debt cannot grow, reductions must tighten the baseline, and deleted entries fail", async () => {
  const root = await fixture(source(17));
  expect(await runComplexity(root)).toBe(1);
  const [key, fn] = [...collectFunctions(await report(root))][0];
  const baseline = {
    ...policy(),
    exceptions: { [key]: { cognitive: fn.cognitive, cyclomatic: fn.cyclomatic } },
  };
  await writeFile(join(root, "complexity-baseline.json"), JSON.stringify(baseline));
  expect(await runComplexity(root)).toBe(0);
  // Moving a declaration to another line must not reset or expand its budget.
  await writeFile(join(root, "src", "app.ts"), `\n\n${source(17)}`);
  expect(await runComplexity(root)).toBe(0);
  await writeFile(join(root, "src", "app.ts"), source(18));
  expect(await runComplexity(root)).toBe(1);
  await writeFile(join(root, "src", "app.ts"), source(16));
  expect(await runComplexity(root)).toBe(1);
  expect(
    JSON.parse(await readFile(join(root, ".complexity", "report.json"), "utf8")).failures[0],
  ).toContain("Tighten");
  await writeFile(join(root, "src", "app.ts"), "export function replacement() { return 1; }");
  expect(await runComplexity(root)).toBe(1);
  expect(
    JSON.parse(await readFile(join(root, ".complexity", "report.json"), "utf8")).failures[0],
  ).toContain("stale");
});

test("real partial parse output cannot pass or leave a stale clean artifact", async () => {
  const root = await fixture();
  expect(await runComplexity(root)).toBe(0);
  await writeFile(join(root, "src", "broken.ts"), "export function broken( {");
  await expect(runComplexity(root)).rejects.toThrow("parse errors");
  expect(await Bun.file(join(root, ".complexity", "report.json")).exists()).toBe(false);
});

for (const status of [1, 2, 127]) {
  test(`scanner failure ${status} cannot pass even with a clean-looking JSON report`, async () => {
    const root = await fixture();
    expect(await runComplexity(root)).toBe(0);
    const clean = JSON.parse(
      await readFile(join(root, ".complexity", "report.json"), "utf8"),
    ).report;
    await writeFile(join(root, "clean.json"), JSON.stringify(clean));
    const tool = join(root, "fake-cccc");
    await writeFile(
      tool,
      `#!/usr/bin/env bash\nif [[ "$1" == --version ]]; then printf 'cccc 1.8.4\\n'; exit 0; fi\ncat clean.json\nexit ${status}\n`,
      { mode: 0o700 },
    );
    await expect(runComplexity(root, tool)).rejects.toThrow(`cccc failed (${status})`);
    expect(await Bun.file(join(root, ".complexity", "report.json")).exists()).toBe(false);
  });
}

test("malformed reports and an unexpected tool version fail closed", async () => {
  const root = await fixture();
  const tool = join(root, "fake-cccc");
  await writeFile(
    tool,
    "#!/usr/bin/env bash\nif [[ \"$1\" == --version ]]; then printf 'cccc 1.8.4\\n'; exit 0; fi\nprintf '{}'\n",
    { mode: 0o700 },
  );
  await expect(runComplexity(root, tool)).rejects.toThrow();
  await writeFile(tool, "#!/usr/bin/env bash\nprintf 'cccc 9.9.9\\n'\n", { mode: 0o700 });
  await expect(runComplexity(root, tool)).rejects.toThrow("Pinned cccc version");
  expect(await Bun.file(join(root, ".complexity", "report.json")).exists()).toBe(false);
});
