import { z } from "zod";
import { MailSendError } from "./idempotency";

export async function mailToolOutput(operation: () => Promise<unknown>) {
  try {
    const result = z.record(z.string(), z.unknown()).parse(await operation());
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    return {
      isError: true,
      ...(error instanceof MailSendError
        ? { structuredContent: { idempotency_key: error.idempotencyKey } }
        : {}),
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : "Mail operation failed",
        },
      ],
    };
  }
}
