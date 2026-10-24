import { z } from "zod";

export const inboxInputSchema = z
  .object({
    label: z.string().max(100).default(""),
    local_part: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*$/)
      .describe(
        "Optional mailbox name before @ on the configured domain. ASCII letters, digits, _, +, -, and single internal dots; 1–64 characters. Stored lowercase. Omit for a random address. Existing names return a conflict, even if disabled.",
      )
      .optional(),
  })
  .strict();
