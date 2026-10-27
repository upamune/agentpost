import { AttachmentError, attachmentType, encodeAttachment } from "./attachment-policy";
import type { SendPayload } from "./types";

const encoder = new TextEncoder();
const eol = "\r\n";

function base64Lines(content: string): string {
  return content.match(/.{1,76}/g)?.join(eol) ?? "";
}

function encodedSubject(subject: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const character of subject) {
    if (encoder.encode(chunk + character).length > 39) {
      words.push(`=?UTF-8?B?${encodeAttachment(encoder.encode(chunk))}?=`);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${encodeAttachment(encoder.encode(chunk))}?=`);
  return words.join(`${eol} `);
}

function textPart(type: string, text: string): string {
  return [
    `Content-Type: ${type}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(encodeAttachment(encoder.encode(text))),
  ].join(eol);
}

function multipart(boundary: string, parts: string[]): string {
  return parts.map((part) => `--${boundary}${eol}${part}${eol}`).join("") + `--${boundary}--${eol}`;
}

function messageBody(payload: SendPayload): string {
  const plain = textPart("text/plain", payload.text);
  if (!payload.html) return plain;
  const boundary = `=_agentpost_${crypto.randomUUID()}`;
  return (
    `Content-Type: multipart/alternative; boundary="${boundary}"${eol}${eol}` +
    multipart(boundary, [plain, textPart("text/html", payload.html)])
  );
}

function replyHeaders(headers: SendPayload["headers"]): string[] {
  return Object.entries(headers ?? {}).map(([name, value]) => {
    if (!["In-Reply-To", "References"].includes(name) || /\p{Cc}/u.test(value))
      throw new AttachmentError(400, "Invalid reply header");
    return `${name}: ${value.split(" ").join(`${eol} `)}`;
  });
}

export function attachmentMime(payload: SendPayload): string {
  if (/\p{Cc}/u.test(payload.from + payload.to.join("") + payload.subject))
    throw new AttachmentError(400, "Invalid MIME header");
  const boundary = `=_agentpost_${crypto.randomUUID()}`;
  const parts = (payload.attachments ?? []).map((attachment) => {
    if (attachmentType(attachment.filename) !== attachment.type)
      throw new AttachmentError(400, "Invalid attachment MIME type");
    // RFC 2231 extended parameters avoid quote/backslash ambiguity and preserve UTF-8 names.
    const filename = encodeURIComponent(attachment.filename).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return [
      `Content-Type: ${attachment.type}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename*=UTF-8''${filename}`,
      "",
      base64Lines(attachment.content),
    ].join(eol);
  });
  const headers = [
    `From: ${payload.from}`,
    `To: ${payload.to.join(`,${eol} `)}`,
    `Subject: ${encodedSubject(payload.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${payload.from.split("@")[1]}>`,
    "MIME-Version: 1.0",
    ...replyHeaders(payload.headers),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const mime =
    headers.join(eol) + eol + eol + multipart(boundary, [messageBody(payload), ...parts]);
  if (encoder.encode(mime).length > 5 * 1024 * 1024)
    throw new AttachmentError(413, "Encoded message exceeds 5 MiB");
  return mime;
}
