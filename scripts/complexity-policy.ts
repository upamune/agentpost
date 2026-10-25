import { z } from "zod";

const count = z.number().int().nonnegative();
const metrics = z.object({ cognitive: count, cyclomatic: count }).strict();
export const policySchema = z
  .object({
    version: z.literal(1),
    toolVersion: z.literal("1.8.4"),
    limits: metrics,
    exceptions: z.record(z.string(), metrics),
  })
  .strict();

type FunctionReport = {
  name: string;
  kind: string;
  line: number;
  cognitive: number;
  cyclomatic: number;
  children?: FunctionReport[];
};
const functionSchema: z.ZodType<FunctionReport> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    kind: z.string().min(1),
    line: z.number().int().positive(),
    cognitive: count,
    cyclomatic: count,
    children: z.array(functionSchema).optional(),
  }),
);
export const reportSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        functions: z.array(functionSchema),
        parse_errors: z.array(z.string()).optional(),
      }),
    )
    .min(1),
  summary: z.object({
    file_count: z.number().int().positive(),
    function_count: z.number().int().positive(),
    parse_error_count: count,
    parse_error_file_count: count,
  }),
});

export function collectFunctions(report: z.infer<typeof reportSchema>) {
  const functions = new Map<string, FunctionReport & { path: string }>();
  function visit(path: string, nodes: FunctionReport[], parent: string) {
    const occurrences = new Map<string, number>();
    for (const node of nodes) {
      const label = `${node.kind}:${node.name}`;
      const ordinal = (occurrences.get(label) ?? 0) + 1;
      occurrences.set(label, ordinal);
      // Structural position distinguishes anonymous/duplicate siblings without
      // tying an allowance to line numbers. Renames/reordering need review.
      const identity = `${parent}/${label}#${ordinal}`;
      const key = `${path}${identity}`;
      if (functions.has(key)) throw new Error(`Duplicate function identity: ${key}`);
      functions.set(key, { ...node, path });
      visit(path, node.children ?? [], identity);
    }
  }
  for (const file of report.files) visit(file.path.replaceAll("\\", "/"), file.functions, "");
  return functions;
}

function assertComplete(
  report: z.infer<typeof reportSchema>,
  functions: ReturnType<typeof collectFunctions>,
) {
  if (
    report.summary.file_count !== report.files.length ||
    report.summary.function_count !== functions.size
  )
    throw new Error("Incomplete complexity report: population counts disagree.");
  if (
    report.summary.parse_error_count !== 0 ||
    report.summary.parse_error_file_count !== 0 ||
    report.files.some((file) => (file.parse_errors?.length ?? 0) > 0)
  )
    throw new Error("Complexity analysis contains parse errors; partial results cannot pass.");
}

function checkExceptions(
  policy: z.infer<typeof policySchema>,
  functions: ReturnType<typeof collectFunctions>,
) {
  const failures: string[] = [];
  for (const [key, entry] of Object.entries(policy.exceptions)) {
    if (!functions.has(key)) failures.push(`Remove stale exception: ${key}`);
    if (entry.cognitive <= policy.limits.cognitive && entry.cyclomatic <= policy.limits.cyclomatic)
      failures.push(`Remove unnecessary exception: ${key}`);
  }
  return failures;
}

function checkFunction(
  key: string,
  fn: FunctionReport & { path: string },
  policy: z.infer<typeof policySchema>,
): string[] {
  const allowance = policy.exceptions[key];
  const limit = allowance ?? policy.limits;
  if (exceedsMetrics(fn, limit))
    return [
      `${fn.path}:${fn.line} ${key}: ${fn.cognitive}/${fn.cyclomatic} exceeds ${limit.cognitive}/${limit.cyclomatic} (cognitive/cyclomatic)`,
    ];
  if (allowance && (fn.cognitive < allowance.cognitive || fn.cyclomatic < allowance.cyclomatic))
    return [`Tighten exception to measured values ${fn.cognitive}/${fn.cyclomatic}: ${key}`];
  return [];
}

function exceedsMetrics(
  actual: Pick<FunctionReport, "cognitive" | "cyclomatic">,
  limit: z.infer<typeof policySchema>["limits"],
): boolean {
  return actual.cognitive > limit.cognitive || actual.cyclomatic > limit.cyclomatic;
}

export function checkComplexity(raw: unknown, input: unknown): string[] {
  const report = reportSchema.parse(raw);
  const policy = policySchema.parse(input);
  const functions = collectFunctions(report);
  assertComplete(report, functions);
  return [
    ...checkExceptions(policy, functions),
    ...[...functions].flatMap(([key, fn]) => checkFunction(key, fn, policy)),
  ];
}
