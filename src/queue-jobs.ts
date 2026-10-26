import { z } from "zod";
import type { Job } from "./types";

const jobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbound"), id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("outbound"), id: z.uuid() }).strict(),
  z
    .object({ kind: z.literal("webhook"), id: z.string().regex(/^wh_[a-f0-9]{32}_[a-f0-9]{64}$/) })
    .strict(),
]);

export function parseJob(body: unknown): Job | null {
  const result = jobSchema.safeParse(body);
  return result.success ? result.data : null;
}

// Recovery publishes only compact durable identifiers, never mail content.
export async function publishJobs(queue: Queue<Job>, jobs: Job[]): Promise<void> {
  for (let offset = 0; offset < jobs.length; offset += 100) {
    await queue.sendBatch(jobs.slice(offset, offset + 100).map((body) => ({ body })));
  }
}
