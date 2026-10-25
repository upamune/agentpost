import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("OSV workflow exit handling", () => {
  for (const status of [0, 1, 127]) {
    test(`preserves scanner exit ${status} even when a report exists`, async () => {
      const workflow = Bun.YAML.parse(
        await Bun.file(new URL("../.github/workflows/osv.yml", import.meta.url)).text(),
      ) as { jobs: { scan: { steps: Array<{ id?: string; run?: string }> } } };
      const command = workflow.jobs.scan.steps?.find((step) => step.id === "scan")?.run;
      expect(typeof command).toBe("string");
      if (!command) throw new Error("The workflow must preserve the scanner's exit status.");
      const directory = await mkdtemp(join(tmpdir(), "agentpost-osv-workflow-"));
      temporary.push(directory);
      const bin = join(directory, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "osv-scanner"),
        `#!/usr/bin/env bash\nset -eu\nreport=''\nfor argument in "$@"; do\n  case "$argument" in --output-file=*) report="\${argument#--output-file=}" ;; esac\ndone\ntest -n "$report"\nprintf '%s' '{"version":"2.1.0","runs":[{"results":[]}]}' > "$report"\nexit "$AGENTPOST_TEST_OSV_EXIT"\n`,
        { mode: 0o700 },
      );
      const output = join(directory, "outputs");
      await writeFile(output, "");
      const process = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", command], {
        cwd: directory,
        env: {
          ...Bun.env,
          PATH: `${bin}:${Bun.env.PATH}`,
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: output,
          AGENTPOST_TEST_OSV_EXIT: String(status),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      expect(exitCode).toBe(status);
      const outputs = await Bun.file(output).text();
      expect(outputs.includes("completed=true")).toBe(status === 0 || status === 1);
      if (status === 127) expect(outputs).not.toContain("report=");
    });
  }
});
