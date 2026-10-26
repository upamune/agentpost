import type { InboxCoordinator } from "./coordinator";

export interface Env {
  DB: D1Database;
  AGENTPOST_INBOX_COORDINATOR: DurableObjectNamespace<InboxCoordinator>;
  MAIL: R2Bucket;
  JOBS: Queue<Job>;
  AGENTPOST_REQUEST_LIMITER: RateLimit;
  AGENTPOST_SEND_LIMITER: RateLimit;
  AGENTPOST_EMAIL_DOMAIN: string;
  AGENTPOST_ADMIN_TOKEN?: string;
  AGENTPOST_AUTH_MODE?: "token" | "oauth" | "both";
  AGENTPOST_CURSOR_KEY?: string;
  AGENTPOST_ACCESS_TEAM_DOMAIN?: string;
  AGENTPOST_ACCESS_AUD?: string;
  AGENTPOST_ACCESS_PRINCIPALS?: string;
  AGENTPOST_OAUTH_RESOURCE_URL?: string;
  AGENTPOST_OAUTH_AUTHORIZATION_SERVER?: string;
  AGENTPOST_CF_ZONE_ID?: string;
  AGENTPOST_CF_SENDING_SUBDOMAIN_ID?: string;
  AGENTPOST_CF_DIAGNOSTICS_API_TOKEN?: string;
  AGENTPOST_CF_ACCOUNT_ID?: string;
  AGENTPOST_CF_EMAIL_API_TOKEN?: string;
}

export type Job = { kind: "inbound" | "outbound"; id: string };

export interface Inbox {
  id: string;
  address: string;
  label: string;
  token_hash: string;
  active: number;
  active_version: number;
  owner_id: string | null;
  created_at: number;
}

export interface Message {
  id: string;
  inbox_id: string;
  raw_key: string;
  envelope_from: string;
  envelope_to: string;
  subject: string | null;
  status: "pending" | "ready" | "failed";
  error: string | null;
  created_at: number;
}

export interface SendPayload {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: { content: string; filename: string; type: string; disposition: "attachment" }[];
}

export type StoredSendPayload = Omit<SendPayload, "attachments"> & { attachments?: string[] };

export interface Outbox {
  id: string;
  inbox_id: string;
  idempotency_key: string;
  payload: string;
  payload_hash: string;
  status: "pending" | "sending" | "accepted" | "failed" | "unknown";
  attempts: number;
  available_at: number;
  provider_result: string | null;
  error: string | null;
  resolution_note: string | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}
