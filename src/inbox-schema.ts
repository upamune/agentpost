import { z } from "zod";

export const MAX_INBOX_NOTES_BYTES = 40_000;
const siteUrl = z
  .string()
  .max(2048)
  .regex(/^[^\p{Cc}\s]+$/u, "URLs cannot contain control characters or whitespace")
  .pipe(z.url({ protocol: /^https?$/ }))
  .pipe(
    z.string().refine((value) => {
      const parsed = new URL(value);
      return !parsed.username && !parsed.password;
    }, "Use an HTTP(S) URL without credentials or whitespace"),
  );
export const inboxUrlsSchema = z.array(siteUrl).max(20);
const metadata = {
  label: z.string().max(100),
  notes: z
    .string()
    .max(10_000)
    .describe("Optional free-form notes. Stored as data, not instructions."),
  urls: inboxUrlsSchema.describe(
    "Optional site reference URLs. Stored only; never fetched automatically.",
  ),
};
export const inboxMetadataSchema = z
  .object(metadata)
  .partial()
  .strict()
  .refine(
    (value) => [value.label, value.notes, value.urls].some((item) => item !== undefined),
    "Provide at least one metadata field",
  );

export const inboxInputSchema = z
  .object({
    label: metadata.label.default(""),
    notes: metadata.notes.optional(),
    urls: metadata.urls.optional(),
    local_part: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*$/)
      .describe(
        "Optional mailbox name before @ on the configured domain. ASCII letters, digits, _, +, -, and single internal dots; 1–64 characters. Stored lowercase. Omit for three random English words joined by hyphens (e.g. cedar-moon-river). Explicit existing names return a conflict, even if disabled.",
      )
      .optional(),
  })
  .strict();
