import { z } from "zod";

export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_MCP_REQUEST_BYTES = 5 * 1024 * 1024;
const MAX_ENCODED_MAIL_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();

export class AttachmentError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 413 | 415 | 503,
    message: string,
  ) {
    super(message);
  }
}

export const attachmentIdsSchema = z
  .array(z.string().regex(/^[a-f0-9]{64}$/))
  .max(MAX_ATTACHMENTS)
  .refine((ids) => new Set(ids).size === ids.length)
  .transform((ids) => (ids.length ? ids : undefined))
  .optional();

const types = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["txt", "text/plain"],
  ["log", "text/plain"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["jsonl", "application/x-ndjson"],
  ["ndjson", "application/x-ndjson"],
  ["md", "text/markdown"],
]);

function validFilename(filename: string): boolean {
  const encoded = encoder.encode(filename);
  const decoded = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(encoded);
  return (
    decoded === filename &&
    filename.trim() === filename &&
    encoded.length <= 255 &&
    !/[/\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(filename)
  );
}

export function attachmentType(filename: string): string {
  if (!validFilename(filename)) throw new AttachmentError(400, "Invalid attachment filename");
  const extension = filename.split(".").at(-1) ?? "";
  const type = types.get(extension.toLowerCase());
  if (!type) throw new AttachmentError(415, "Unsupported attachment file type");
  return type;
}

function validateAttachmentSize(size: number): void {
  if (size < 1) throw new AttachmentError(400, "Attachments must not be empty");
  if (size > MAX_ATTACHMENT_BYTES) throw new AttachmentError(413, "Attachment exceeds 3 MiB");
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

const signatures = new Map<string, number[][]>([
  ["application/pdf", [[37, 80, 68, 70, 45]]],
  ["image/png", [[137, 80, 78, 71, 13, 10, 26, 10]]],
  ["image/jpeg", [[255, 216, 255]]],
  [
    "image/gif",
    [
      [71, 73, 70, 56, 55, 97],
      [71, 73, 70, 56, 57, 97],
    ],
  ],
]);

function textFormat(bytes: Uint8Array): boolean {
  if (
    startsWith(bytes, [77, 90]) ||
    startsWith(bytes, [127, 69, 76, 70]) ||
    startsWith(bytes, [80, 75]) ||
    startsWith(bytes, [35, 33])
  )
    return false;
  try {
    return !new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).includes("\0");
  } catch {
    return false;
  }
}

function matchesFormat(bytes: Uint8Array, type: string): boolean {
  const allowed = signatures.get(type);
  if (allowed) return allowed.some((signature) => startsWith(bytes, signature));
  if (type === "image/webp")
    return startsWith(bytes, [82, 73, 70, 70]) && startsWith(bytes.subarray(8), [87, 69, 66, 80]);
  return textFormat(bytes);
}

export function validateAttachment(bytes: Uint8Array, filename: string): string {
  validateAttachmentSize(bytes.byteLength);
  const type = attachmentType(filename);
  if (!matchesFormat(bytes, type))
    throw new AttachmentError(415, "Attachment format does not match its filename");
  return type;
}

export function encodeAttachment(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 24_576) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24_576))));
  }
  return chunks.join("");
}

export function decodeAttachment(content: string): Uint8Array {
  if (content.length > 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3))
    throw new AttachmentError(413, "Attachment exceeds 3 MiB");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
  } catch {
    throw new AttachmentError(400, "Attachment content must be canonical Base64");
  }
  if (encodeAttachment(bytes) !== content)
    throw new AttachmentError(400, "Attachment content must be canonical Base64");
  validateAttachmentSize(bytes.byteLength);
  return bytes;
}

export function validateMailSize(text: string, html: string | undefined, sizes: number[]): void {
  const bodySize = encoder.encode(text).length + encoder.encode(html ?? "").length;
  const decoded = sizes.reduce((total, size) => total + size, bodySize);
  const encoded = sizes.reduce(
    (total, size) => {
      const base64 = 4 * Math.ceil(size / 3);
      return total + base64 + 2 * Math.ceil(base64 / 76) + 2048;
    },
    65_536 + bodySize * 3.1,
  );
  if (decoded > MAX_ATTACHMENT_BYTES || encoded > MAX_ENCODED_MAIL_BYTES)
    throw new AttachmentError(413, "Message exceeds the outbound content or MIME size budget");
}
