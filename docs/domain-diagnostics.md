# Domain diagnostics

[English](domain-diagnostics.md) | [日本語](domain-diagnostics.ja.md)

Run a read-only diagnostic after domain onboarding, DNS changes, or suspected authentication problems. It checks the configured `AGENTPOST_EMAIL_DOMAIN`; callers cannot select another domain. An admin token or an OAuth `admin` grant is required. Inbox tokens and OAuth `agent` grants cannot run it.

```sh
mise exec -- bun run cli domain check
# Also fail on warnings in a deployment check:
mise exec -- bun run cli domain check --strict
```

The same report is available from `GET /v1/domain/check` and the MCP tool `check_domain` with `{}` arguments. The command changes no DNS records, sends no email, and does not affect sending admission, queues, or `/v1/health`. Run it deliberately; it is not scheduled automatically.

## What it checks

| Check                          | Meaning                                                                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spf`                          | Exactly one sending SPF record; safe Cloudflare include and ordering. The standard Cloudflare profile passes; custom policies require further evaluation.                                                                                                         |
| `dkim`                         | Sending selector has one usable, non-revoked RSA/SHA-256 public key; keys below 1024 bits fail, below 2048 bits or testing mode warn.                                                                                                                             |
| `dmarc`                        | Explicit From-domain policy, duplicate/malformed tags, enforcement versus monitoring/testing/legacy partial enforcement. `p=none` is valid during rollout.                                                                                                        |
| `dmarc_reports`                | Plausible aggregate-report mailto syntax; destination delivery and external-domain authorization remain unverified.                                                                                                                                               |
| `alignment` / `dkim_alignment` | Warn when strict alignment conflicts with the configured return-path or wildcard signing domain. A real message is still needed to verify alignment.                                                                                                              |
| `bounce_mx`                    | Cloudflare's bounce-processing MX hosts at the return-path domain.                                                                                                                                                                                                |
| `routing_mx`                   | Cloudflare Email Routing MX hosts at the address domain, checked separately from sending. Other providers produce a warning; missing Cloudflare hosts fail this Cloudflare-only profile.                                                                          |
| `cloudflare_sending`           | Optional API check that the configured sending-domain row covers the mail domain and has Email Sending enabled. Enabled does not itself prove DNS verification, account entitlement, or delivery.                                                                 |
| `cloudflare_dns`               | Public sending SPF/DKIM/MX compared with the provider's expected records. A stale but syntactically valid DKIM key can therefore fail; custom SPF or MX priorities warn. Custom DMARC policy is evaluated separately, not forced to equal the provider's example. |

Default sending names are `cf-bounce.DOMAIN` for SPF/bounce MX and `cf-bounce._domainkey.DOMAIN` for DKIM. The Email Routing selector is different and does not substitute for sending DKIM. With the optional provider check, the returned selector and return-path domain take precedence. Matching wildcard rows use their base signing domain.

This is a Cloudflare configuration diagnostic, not an SPF or DMARC receiver implementation. SPF include/redirect expansion, lookup-budget evaluation and sender-IP authorization are not performed. DMARC parent/organizational-domain/PSD discovery is not performed: absent explicit policy returns **unknown**, since a valid inherited policy may exist. Publish an explicit policy at each From domain where practical; use a DMARC evaluator for inheritance. Current [DMARC RFC 9989](https://www.rfc-editor.org/rfc/rfc9989.html) changes discovery from older PSL-based behavior, and receivers may differ.

## Optional Cloudflare comparison

Public DNS checks need no Cloudflare management credentials. To also compare the actual sending configuration, set these Worker vars:

```json
{
  "AGENTPOST_CF_ZONE_ID": "YOUR_32_HEX_ZONE_ID",
  "AGENTPOST_CF_SENDING_SUBDOMAIN_ID": "YOUR_32_HEX_SENDING_SUBDOMAIN_ID"
}
```

Register a separate secret:

```sh
mise exec -- bun run wrangler secret put AGENTPOST_CF_DIAGNOSTICS_API_TOKEN
```

Scope the token to the intended account/zone and the minimum available permissions that permit these two GET requests. Cloudflare's endpoint reference currently does not enumerate accepted permission groups; verify access with your token instead of assuming an undocumented permission name:

- `GET /zones/{zone_id}/email/sending/subdomains/{subdomain_id}`
- `GET /zones/{zone_id}/email/sending/subdomains/{subdomain_id}/dns`

No DNS-edit permission is used by the diagnostic. Keep this credential separate from `AGENTPOST_CF_EMAIL_API_TOKEN`; the sending credential is never used as a fallback. Do not grant a Global API Key or broaden normal sending credentials just for diagnostics. Missing/partial configuration, denied access, incompatible API responses, and unavailable services produce **unknown** findings, while the default-name DNS checks continue.

## Interpret the report

The API returns HTTP 200 when it produces a report, including reports with failed checks. Inspect the JSON `status` and every `checks` entry. Authentication/authorization and HTTP transport failures retain their normal HTTP statuses. Findings have stable IDs, a status, a message, and remediation when action is needed. DNS values, provider error bodies, and credentials are not reflected into the report.

| Overall status | Meaning                                                          | CLI exit             |
| -------------- | ---------------------------------------------------------------- | -------------------- |
| `pass`         | All checks that form this diagnostic passed                      | 0                    |
| `warning`      | No failures/unknowns, but review is needed                       | 0; 1 with `--strict` |
| `fail`         | At least one configuration/profile check failed                  | 1                    |
| `unknown`      | No known failures, but at least one check could not be completed | 2                    |

Failures take precedence over unknowns, then warnings. Without the optional provider configuration the overall result is unknown, even if public DNS checks pass. This keeps missing provider evidence visible. `checked_at` records observation time and `delivery_verified` is always `false`.

DNS is observed through Cloudflare's public recursive DoH resolver, not authoritative or globally consistent measurements. Positive/negative caches and propagation matter. Egress uses fixed Cloudflare API/DoH HTTPS origins, rejects redirects, bounds each JSON body to 256 KiB, limits DNS queries to 24, and applies 3.5-second per-request and 12-second overall network deadlines. TXT chunks concatenate within one RR; unrelated answers cannot satisfy a query. Schema or resolution errors are unknown, never pass. The resolver's JSON format is provider-specific; incompatible changes fail visibly.

## Before stronger enforcement or production use

Review existing legitimate senders before editing SPF or tightening DMARC. Start with monitoring/report review when needed; do not automatically switch to `p=reject` or delete another provider's records. Compare changes with Cloudflare's Email Service settings and rerun after propagation.

DNS authentication is only part of deliverability. With a user-specified recipient and authorization, separately inspect a real received message's trusted `Authentication-Results`, Return-Path and DKIM signing domain; check SPF/DKIM/DMARC and alignment. Cloudflare manages sending IPs, PTR and SMTP TLS; investigate those with provider evidence rather than inventing DNS records on your mail domain. Reputation, complaints, sending volume, message content, recipient filtering, bounces and suppressions also matter. Passing this diagnostic does not guarantee delivery or inbox placement.

References: [Cloudflare domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/), [sending-domain API](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/methods/get/), [expected DNS API](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/subresources/dns/methods/get/), [DoH JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/), [Gmail sender guidelines](https://support.google.com/mail/answer/81126).
