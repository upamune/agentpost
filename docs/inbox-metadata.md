# Inbox notes and site URLs

[English](inbox-metadata.md) | [日本語](inbox-metadata.ja.md)

Attach registration context to an inbox with optional `notes` and `urls`. For example, record which shop uses an alias, why it was created, and links to its account and billing pages. These are private inbox metadata, not email headers or message content. They do not change an address, forwarding, webhook configuration, authentication, or send state.

## Create and edit

```sh
agentpost inbox create --label shop.example \
  --notes 'Registered for receipts and billing notifications.' \
  --site-url https://shop.example/account \
  --site-url https://shop.example/billing

agentpost inbox edit INBOX_ID --notes 'Subscription cancelled; keep receipts.'
agentpost inbox edit INBOX_ID --notes-file /absolute/path/to/task/registration.md
agentpost inbox edit INBOX_ID --site-url https://shop.example/new-account
agentpost inbox get INBOX_ID

# Explicitly clear a field; omitted fields are unchanged.
agentpost inbox edit INBOX_ID --notes ''
agentpost inbox edit INBOX_ID --clear-urls
```

Creation supports `label`, `notes`, and `urls` alongside optional `local_part`. Omitted values are stored as `""`, `""`, and `[]`, respectively. Get/list/create responses include `notes` and a JSON array `urls`. Only creation with administrator token credentials returns the secret inbox token; metadata editing never returns one.

`PATCH /v1/inboxes/{inbox}/metadata` accepts a nonempty subset of `label`, `notes`, and `urls`. Omitted fields retain their current values; empty strings clear label/notes and `[]` clears URLs. A supplied URL list replaces the entire list. Independent field updates are atomic and do not overwrite omitted fields; concurrent edits to the same field use the last committed value. Address, ownership, credentials, and activity fields are rejected. Activity remains a separate administrator-only `PATCH /v1/inboxes/{inbox}` operation.

```json
{
  "notes": "Registered for receipts.\nBilling contact for this account.",
  "urls": ["https://shop.example/account", "https://shop.example/billing"]
}
```

MCP `create_inbox` accepts the same optional fields. `update_inbox` takes `inbox_id` plus at least one metadata field, with the same replacement/clearing rules. `get_inbox` and `list_inboxes` return the metadata. These ordinary tools use the existing MCP core contract and do not change Events or publish new notifications.

## Permissions and limits

- Administrators create and edit any inbox. OAuth agents create inboxes and edit metadata for their own active inboxes. Refreshing a token preserves ownership; revoking a grant or disabling the inbox blocks agent editing. Administrators may edit metadata on disabled inboxes without re-enabling them.
- Inbox tokens can read their active inbox's metadata but cannot edit it. Notes and URLs are visible to anyone with authorized read access to that inbox. Treat them as context data, not credentials or instructions authorizing further actions.
- Label: up to 100 UTF-16 code units. Notes: free-form text, including newlines and Unicode, up to 10,000 UTF-16 code units. CLI `--notes-file` reads a regular UTF-8 file of at most 40,000 bytes, then applies the same text limit. Choose either `--notes` or `--notes-file`.
- URLs: up to 20 HTTP(S) URLs, each at most 2,048 UTF-16 code units, without user/password credentials, whitespace, or control characters. URL order is retained. References are stored only; Agentpost never fetches them, checks site ownership, or sends mail to them. Local/private HTTP(S) references are allowed because they are not network destinations. Keep secrets out of URLs and notes.
- Repeat CLI `--site-url` for multiple references. It is distinct from `--url`, which selects the Agentpost API server. Choose `--site-url` or `--clear-urls`, not both.

## Upgrade

Apply all D1 migrations, including `0008_inbox_metadata.sql`, before deploying the updated Worker. Existing inboxes keep their address, label, token hash, ownership, activity, and messages; notes default to an empty string and URLs to an empty array. Use matching updated CLI/MCP clients for the new arguments/tools; see [deployment](deploy.md) and [installation](../INSTALL.md). A source change or passing local test does not update an existing Worker or npm installation.
