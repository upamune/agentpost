import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type ReplayCase = { title: string; status: string; failureMessages: string[] };
type ReplayResult = { exitCode: number; cases: ReplayCase[] };
type Replay = (
  name: string,
  mutant?: { file: string; path: string },
  pattern?: string,
  testFiles?: string[],
) => Promise<ReplayResult>;

function assertMutation(result: ReplayResult) {
  if (result.cases.length !== 1 || result.exitCode === 0)
    throw new Error("Outbound dispatch barrier mutation was not detected");
  const selected = result.cases[0]!;
  if (
    selected.status !== "failed" ||
    !selected.failureMessages.some((message) => message.includes("AssertionError"))
  )
    throw new Error("Outbound dispatch barrier mutation did not fail an assertion");
}

export async function checkDispatchBarrierMutation(
  root: string,
  scratch: string,
  baseline: ReplayResult,
  replay: Replay,
) {
  const pattern = "delayed old disable committing";
  if (
    baseline.exitCode !== 0 ||
    baseline.cases.filter((item) => item.title.includes(pattern)).length !== 1
  )
    throw new Error("Dispatch barrier baseline replay is missing or duplicated");
  const original = await readFile(join(root, "src/outbound.ts"), "utf8");
  const needle = "  if (!(await authorizeDispatch()))";
  if (original.split(needle).length !== 2)
    throw new Error("Outbound dispatch authorization implementation drifted");
  const path = join(scratch, "outbound-dispatch-barrier.ts");
  await writeFile(
    path,
    original.replace(needle, "  if (false)").replaceAll('from "./', `from "${root}/src/`),
  );
  const result = await replay("mutant-dispatch-barrier", { file: "outbound", path }, pattern, [
    "disable-projection",
  ]);
  assertMutation(result);
  console.log("outbound/dispatch-barrier: real-code mutation detected");
  return {
    name: "dispatch-barrier",
    baseline: "replay",
    source: "assertion-failed",
    complementaryModel: "verification/webhooks/DispatchBarrier.tla (EmailOnly = TRUE)",
  };
}
