const KEY_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;
const SAFE_FAILURES = new Set([
  "Local input must be a regular file",
  "Choose --text or --text-file",
  "At most 10 attachments are allowed",
  "Mail API returned an invalid or oversized JSON response",
]);

function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return "Mail send operation failed";
  if (SAFE_FAILURES.has(error.message)) return error.message;
  if (
    /^(Local file exceeds the|Mail API request must be valid JSON within the) \d+-byte size limit$/.test(
      error.message,
    )
  )
    return error.message;
  return "Mail send preparation, request, or response failed";
}

export function resolveIdempotencyKey(value: string | undefined): string {
  if (value === undefined) return crypto.randomUUID();
  if (!KEY_PATTERN.test(value))
    throw new Error("Idempotency key must be 1-128 ASCII letters, digits, or _.:-");
  return value;
}

export class MailSendError extends Error {
  constructor(
    public readonly idempotencyKey: string,
    reason: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(
      `${reason}. Idempotency key: ${idempotencyKey}. Save this key and reuse it with the unchanged request if retrying; never automatically resend with a new key.`,
    );
  }
}

export async function withIdempotencyKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MailSendError) throw error;
    throw new MailSendError(key, failureReason(error));
  }
}
