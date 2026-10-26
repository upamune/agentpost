import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkComplexity, policySchema } from "./complexity-policy";

export async function runComplexity(root: string, tool = "cccc"): Promise<number> {
  const output = join(root, ".complexity", "report.json");
  await mkdir(join(root, ".complexity"), { recursive: true });
  await rm(output, { force: true });
  const policy = policySchema.parse(
    JSON.parse(await readFile(join(root, "complexity-baseline.json"), "utf8")),
  );
  const version = Bun.spawnSync([tool, "--version"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  if (version.exitCode !== 0 || version.stdout.toString().trim() !== `cccc ${policy.toolVersion}`)
    throw new Error("Pinned cccc version is unavailable or differs from the complexity policy.");
  const child = Bun.spawn(
    [tool, "--config", "cccc.toml", "--no-cache", "src", "scripts", "verification", "website"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      killSignal: "SIGKILL",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`cccc failed (${code}): ${stderr.trim()}`);
  const report: unknown = JSON.parse(stdout);
  const failures = checkComplexity(report, policy);
  await writeFile(output, `${JSON.stringify({ report, failures }, null, 2)}\n`);
  for (const failure of failures) console.error(failure);
  console.log(
    `cccc ${policy.toolVersion}: ${failures.length} complexity violation(s). Report: ${output}`,
  );
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await runComplexity(resolve(import.meta.dir, ".."));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
