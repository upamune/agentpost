import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { MailApiError, MailClient } from "./client";
import { eventPollResultSchema, eventQuerySchema } from "./event-schema";
import type { EventQuery } from "./event-schema";
import { wait } from "./wait";
import { readLocalText } from "./local-file";

const watchPollResultSchema = eventPollResultSchema.extend({ cursor: z.string().max(2048) });
type PollResult = z.output<typeof watchPollResultSchema>;

function assertRetryablePoll(error: unknown): void {
  if (error instanceof MailApiError && error.status < 500 && error.status !== 429) throw error;
  if (error instanceof z.ZodError) throw error;
}

async function checkpointCursor(cursor: EventQuery["cursor"], file: string | undefined) {
  if (!file) return cursor;
  let content: string;
  try {
    content = await readLocalText(file, 16 * 1024);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return cursor;
    throw error;
  }
  return parseCheckpoint(content);
}

function parseCheckpoint(content: string): string {
  try {
    return z.object({ cursor: z.string().max(2048) }).parse(JSON.parse(content)).cursor;
  } catch {
    throw new Error("Invalid event checkpoint; preserve the file and reconcile inbox state");
  }
}

async function saveCheckpoint(file: string, cursor: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ cursor }), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

class WatchSubscription {
  private failures = 0;
  constructor(
    private readonly client: MailClient,
    private readonly query: EventQuery,
    private cursor: EventQuery["cursor"],
    private readonly cursorFile: string | undefined,
    private readonly signal: AbortSignal,
  ) {}

  private retryDelay(error: unknown): number {
    assertRetryablePoll(error);
    console.error("Event source unavailable; retrying from the last checkpoint");
    if (error instanceof MailApiError && error.status === 429) return error.retryAfterMs ?? 60_000;
    return Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5));
  }

  private async poll(): Promise<PollResult | null> {
    try {
      return watchPollResultSchema.parse(
        await this.client.call(
          "POST",
          "/v1/events/poll",
          { ...this.query, cursor: this.cursor },
          undefined,
          this.signal,
        ),
      );
    } catch (error) {
      if (!this.signal.aborted) await wait(this.retryDelay(error), this.signal);
      return null;
    }
  }

  private async commit(page: PollResult): Promise<void> {
    if (page.truncated)
      console.error("Event history gap reported; reconcile inbox state through the message API");
    for (const event of page.events) {
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(`${JSON.stringify(event)}\n`, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
    if (this.cursorFile) await saveCheckpoint(this.cursorFile, page.cursor);
    this.cursor = page.cursor;
    await wait(page.hasMore ? 0 : Math.max(1000, page.nextPollMs), this.signal);
  }

  async run(): Promise<void> {
    while (!this.signal.aborted) {
      const page = await this.poll();
      if (!page) continue;
      this.failures = 0;
      await this.commit(page);
    }
  }
}

export async function watchEvents(
  client: MailClient,
  input: EventQuery,
  cursorFile: string | undefined,
): Promise<void> {
  const query = eventQuerySchema.parse(input);
  const cursor = await checkpointCursor(query.cursor, cursorFile);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await new WatchSubscription(client, query, cursor, cursorFile, controller.signal).run();
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
