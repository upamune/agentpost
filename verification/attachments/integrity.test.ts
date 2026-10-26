import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { prepareAttachments, uploadAttachment } from "../../src/attachments";

test("integrity replay rejects substituted bytes before preparing the provider payload", async () => {
  await reset();
  const original = new TextEncoder().encode("answer,42\n");
  const file = await uploadAttachment(
    env,
    "inbox-owner",
    "report.csv",
    new Uint8Array(original).buffer,
  );
  const key = `outbound-attachments/inbox-owner/${file.id}`;
  const metadata = await env.MAIL.head(key);
  await env.MAIL.put(key, new Uint8Array(original.length).fill(65), {
    customMetadata: metadata?.customMetadata,
  });
  const result = await prepareAttachments(env, "inbox-owner", {
    from: "agent@example.com",
    to: ["recipient@example.net"],
    subject: "Report",
    text: "Attached.",
    attachments: [file.id],
  }).catch((error: unknown) => error);
  expect(result).toMatchObject({
    status: 409,
    message: "Stored attachment content failed integrity verification",
  });
});
