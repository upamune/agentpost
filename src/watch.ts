import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { MailApiError, MailClient } from "./client";
import { eventPollResultSchema, eventQuerySchema } from "./event-schema";
import type { EventQuery } from "./event-schema";
import { wait } from "./wait";

export async function watchEvents(
  client: MailClient,
  input: EventQuery,
  cursorFile: string | undefined,
): Promise<void> {
  const query = eventQuerySchema.parse(input);
  let cursor = query.cursor;
  if (cursorFile && (await Bun.file(cursorFile).exists())) {
    cursor = z
      .object({ cursor: z.string() })
      .parse(JSON.parse(await Bun.file(cursorFile).text())).cursor;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let failures = 0;
  try {
    while (!controller.signal.aborted) {
      let page;
      try {
        page = eventPollResultSchema.parse(
          await client.call(
            "POST",
            "/v1/events/poll",
            { ...query, cursor },
            undefined,
            controller.signal,
          ),
        );
      } catch (error) {
        if (controller.signal.aborted) break;
        if (error instanceof MailApiError && error.status < 500) throw error;
        if (error instanceof z.ZodError) throw error;
        console.error("Event source unavailable; retrying from the last checkpoint");
        await wait(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), controller.signal);
        continue;
      }
      failures = 0;
      if (page.truncated)
        console.error("Event history gap reported; reconcile inbox state through the message API");
      for (const event of page.events) {
        await new Promise<void>((resolve, reject) =>
          process.stdout.write(`${JSON.stringify(event)}\n`, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      }
      if (cursorFile) {
        await mkdir(dirname(cursorFile), { recursive: true });
        const temporary = `${cursorFile}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ cursor: page.cursor }), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, cursorFile);
      }
      cursor = page.cursor;
      await wait(page.hasMore ? 0 : Math.max(1000, page.nextPollMs), controller.signal);
    }
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
