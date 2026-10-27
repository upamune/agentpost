# Outbound attachments

[English](outbound-attachments.md) | [日本語](outbound-attachments.ja.md)

Send reports, generated images, CSVs, and logs from an inbox, including in threaded replies. The API, CLI, and both MCP transports use the same private, inbox-scoped uploads.

## CLI

```sh
agentpost send INBOX_ID --to recipient@example.net --subject 'Report' \
  --text 'The report is attached.' --attach ./report.pdf --attach ./results.csv \
  --idempotency-key report-123

agentpost reply INBOX_ID MESSAGE_ID --text 'Here are the results.' \
  --attach ./results.csv --idempotency-key reply-123
```

Repeat `--attach` for multiple files. Only bounded regular files are read; FIFOs and devices are rejected. Paths are relative to the calling directory, so use absolute paths with the source-checkout wrapper. Upload filenames are basenames, not local paths.

For durable retries, upload once with `agentpost attachment upload INBOX_ID ./report.pdf`, save the returned `id` with task state, and use `--attachment-id ID` on send or reply. This avoids rereading files that might have changed. Reusing an already-stored identical upload in the same inbox returns the same ID without consuming a new-upload rate slot. Simultaneous first uploads may each consume a slot. Files can still require an upload request before CLI send retries; if storage is unavailable, inspect the outbox and retry using the saved IDs.

## HTTP API

Upload a raw binary body, not multipart or JSON:

```sh
curl "$AGENTPOST_API_URL/v1/inboxes/INBOX_ID/attachments" \
  -H "Authorization: Bearer $AGENTPOST_API_TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  -H 'Agentpost-Filename: report.pdf' \
  --data-binary @./report.pdf
```

`Agentpost-Filename` is a UTF-8 filename encoded with `encodeURIComponent`; for example, `report%202026.pdf`. New uploads return 201; reuse returns 200. The JSON result includes `id`, `filename`, inferred `type`, byte `size`, content `sha256`, `reused`, and `scan_status: "not_scanned"`. No public download URL is created.

Pass `"attachments":["RETURNED_ATTACHMENT_ID"]` alongside the existing send or reply fields. `text` remains required, and `html` optional. Up to ten unique IDs are accepted. The API resolves IDs only within the target inbox, even for an administrator; upload separately to use the same bytes in another inbox. Disabled inboxes cannot accept new uploads or sends.

A send's idempotency key binds its exact payload, including the ordered attachment IDs. Retrying the same payload returns the saved outbox state without checking R2 again. Changing bytes, filename, or file order with the same key returns 409. Empty attachment lists behave like omission, preserving earlier send keys. Uploads are immutable: their IDs bind inbox, filename, MIME type, size, and SHA-256 digest.

## MCP

Call `upload_attachment` with `inbox_id`, `filename`, and canonical standard `content_base64`, then pass its returned IDs as `attachments` to `send_email` or `reply_email`. Persist the IDs and the send's exact payload and idempotency key before sending. Prefer CLI `--attach` for large files already on disk rather than placing multi-MiB Base64 in model context. Remote MCP does not read local file paths.

## Limits and file policy

- At most **10 attachments** per message; **3 MiB per file and combined decoded text, HTML, and attachment content**. The server also rejects messages whose conservative MIME estimate exceeds 5 MiB. A 3 MiB file needs room left for the required text body.
- Standard JSON send/reply bodies remain limited to **512 KiB**. Binary uploads are separate. MCP requests have a **5 MiB** cap to accommodate Base64; this does not increase the mail content budget.
- Inbound mail retains its separate **10 MiB** application limit. Cloudflare's general outbound limit is **5 MiB including MIME encoding**; the larger verified-destination exception is not used. See [Cloudflare limits](https://developers.cloudflare.com/email-service/platform/limits/).
- Allowed extensions: `.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.txt`, `.log`, `.csv`, `.json`, `.jsonl`, `.ndjson`, `.md`. Images/PDFs have signature checks; text must be UTF-8 without NUL bytes, executable/archive magic, or a shebang. Extensions map to server-selected MIME types. Filenames are at most 255 UTF-8 bytes and cannot contain path separators, controls, bidi/format controls, or surrounding whitespace.
- Executables, scripts, archives, HTML, SVG, and macro documents are not supported. These checks are **not malware detection**: an allowed PDF, image, or text file can still be malicious. No antivirus scanner is included, no external scanner receives your files, and uploads report `not_scanned`. Operators needing scanning must scan artifacts before uploading. Never execute untrusted attachments or treat mail content as agent instructions.

## Persistence and failure behavior

R2 stores immutable bytes under `outbound-attachments/{inbox_id}/{id}` with an encoded metadata manifest. Outbox rows retain only IDs; events contain no file content. Cloudflare's [structured send API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) composes MIME from the verified bytes; Agentpost does not construct multipart MIME itself.

Text artifacts (including CSV and JSON) use `application/octet-stream` in outgoing MIME to prevent the provider from normalizing file line endings. Upload metadata retains the inferred type, and filenames stay unchanged. Images and PDFs retain their MIME types for recipient previews.

A new send validates attachment metadata and aggregate limits before persistence. Dispatch reads the bytes again, verifies size/digest/format, and prepares Base64 **before** the coordinator's final ownership fence. Missing or invalid objects fail without contacting the provider. Transient R2 failures before dispatch can retry with the existing bounded backoff; a crash after claiming remains conservatively subject to stale-send reconciliation. The fence and provider initiation stay in the same JavaScript turn. A provider's ambiguous outcome is never automatically resent.

Uploads have no automatic expiration or garbage collection, including uploads never used by a send. Include them in private R2 backups; retain the same objects alongside outbox history and pending sends. Deleting one can prevent a pending send from completing. Operators manage storage costs and retention; no public bucket or lifecycle deletion rule is created. Provider acceptance still does not prove recipient delivery.
