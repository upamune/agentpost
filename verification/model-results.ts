export type ModelResult = { code: number; log: string };
export type ModelCheck = { check: string; outcome: "violated" | "passed" };

export function modelViolation(check: string, log: string, temporal: string[]): boolean {
  return (
    log.includes(`Invariant ${check} is violated`) ||
    (temporal.includes(check) && log.includes("Temporal properties were violated"))
  );
}

export function modelOutcome(check: string, result: ModelResult, temporal: string[]): ModelCheck {
  if (modelViolation(check, result.log, temporal)) return { check, outcome: "violated" };
  if (result.code !== 0) throw new Error(`${check} could not run: ${result.log}`);
  if (!result.log.includes("Model checking completed. No error has been found"))
    throw new Error(`Missing TLC completion: ${check}`);
  return { check, outcome: "passed" };
}

// TLC stops at its first failure. A failed combined traversal cannot certify the
// other properties; rerun them independently to retain accurate named evidence.
export async function groupedOutcomes(
  checks: string[],
  temporal: string[],
  combined: ModelResult,
  individual: (check: string) => Promise<ModelResult>,
): Promise<ModelCheck[]> {
  if (combined.code === 0) return checks.map((check) => modelOutcome(check, combined, temporal));
  if (!checks.some((check) => modelViolation(check, combined.log, temporal)))
    throw new Error(`Grouped model check could not run: ${combined.log}`);
  const results: ModelCheck[] = [];
  for (const check of checks) results.push(modelOutcome(check, await individual(check), temporal));
  return results;
}
