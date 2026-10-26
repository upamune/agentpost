import { z } from "zod";
import { readBounded, sha256 } from "./common";
import {
  AttachmentError,
  attachmentType,
  encodeAttachment,
  MAX_ATTACHMENT_BYTES,
  validateAttachment,
  validateMailSize,
} from "./attachment-policy";
import type { Env, SendPayload, StoredSendPayload } from "./types";

const descriptorSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    filename: z.string().min(1).max(255),
    type: z.string().max(64),
    size: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Descriptor = z.output<typeof descriptorSchema>;
const key = (inbox: string, id: string) => `outbound-attachments/${inbox}/${id}`;

async function identity(inbox: string, descriptor: Omit<Descriptor, "id">): Promise<string> {
  return sha256(JSON.stringify({ inbox, ...descriptor }));
}

function manifest(object: R2Object): string {
  return object.customMetadata?.manifest ?? "";
}

async function storedDescriptor(object: R2Object, inbox: string, id: string): Promise<Descriptor> {
  try {
    const data = descriptorSchema.parse(JSON.parse(decodeURIComponent(manifest(object))));
    const { id: storedId, ...content } = data;
    if (
      storedId !== id ||
      object.size !== data.size ||
      attachmentType(data.filename) !== data.type ||
      (await identity(inbox, content)) !== id
    )
      throw new Error("Invalid manifest");
    return data;
  } catch {
    throw new AttachmentError(409, "Stored attachment metadata is invalid");
  }
}

export async function uploadAttachment(
  env: Env,
  inbox: string,
  filename: string,
  bytes: ArrayBuffer,
  admit: () => Promise<void> = async () => {},
) {
  const type = validateAttachment(new Uint8Array(bytes), filename);
  const content = { filename, type, size: bytes.byteLength, sha256: await sha256(bytes) };
  const id = await identity(inbox, content);
  const descriptor = { id, ...content };
  const existing = await env.MAIL.head(key(inbox, id));
  if (existing) {
    await storedDescriptor(existing, inbox, id);
    return { ...descriptor, scan_status: "not_scanned" as const, reused: true };
  }
  await admit();
  const object = await env.MAIL.put(key(inbox, id), bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { manifest: encodeURIComponent(JSON.stringify(descriptor)) },
  });
  if (!object) await attachmentMetadata(env, inbox, id);
  return { ...descriptor, scan_status: "not_scanned" as const, reused: object === null };
}

async function attachmentMetadata(env: Env, inbox: string, id: string): Promise<Descriptor> {
  const object = await env.MAIL.head(key(inbox, id));
  if (!object) throw new AttachmentError(404, "Attachment not found in this inbox");
  return storedDescriptor(object, inbox, id);
}

export async function validateOutgoingAttachments(
  env: Env,
  inbox: string,
  payload: StoredSendPayload,
) {
  const descriptors = await Promise.all(
    (payload.attachments ?? []).map((id) => attachmentMetadata(env, inbox, id)),
  );
  validateMailSize(
    payload.text,
    payload.html,
    descriptors.map((item) => item.size),
  );
}

async function providerAttachment(env: Env, inbox: string, id: string) {
  const object = await env.MAIL.get(key(inbox, id));
  if (!object) throw new AttachmentError(404, "Attachment not found in this inbox");
  const descriptor = await storedDescriptor(object, inbox, id);
  const bytes = await readBounded(object.body, MAX_ATTACHMENT_BYTES);
  if (bytes.byteLength !== descriptor.size || (await sha256(bytes)) !== descriptor.sha256)
    throw new AttachmentError(409, "Stored attachment content failed integrity verification");
  validateAttachment(new Uint8Array(bytes), descriptor.filename);
  return {
    content: encodeAttachment(new Uint8Array(bytes)),
    filename: descriptor.filename,
    type: descriptor.type,
    disposition: "attachment" as const,
  };
}

export async function prepareAttachments(
  env: Env,
  inbox: string,
  stored: StoredSendPayload,
): Promise<SendPayload> {
  const { attachments, ...payload } = stored;
  if (!attachments?.length) return payload;
  const prepared = await Promise.all(attachments.map((id) => providerAttachment(env, inbox, id)));
  validateMailSize(
    stored.text,
    stored.html,
    prepared.map((item) => atob(item.content).length),
  );
  return { ...payload, attachments: prepared };
}
