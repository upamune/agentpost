import { publicDns } from "./domain-dns";
import type { Env } from "./types";

export type Status = "pass" | "warning" | "fail" | "unknown";
export interface Check {
  id: string;
  status: Status;
  message: string;
  remediation?: string;
  name?: string;
}
export interface ProviderRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
}

export class DomainDiagnostics {
  signingDomain: string;
  selector = "cf-bounce";
  returnPath: string;
  providerRecords?: ProviderRecord[];
  readonly resolve: ReturnType<typeof publicDns>;
  constructor(
    readonly env: Env,
    readonly domain: string,
    readonly signal: AbortSignal,
    readonly checks: Check[],
  ) {
    this.signingDomain = domain;
    this.returnPath = `cf-bounce.${domain}`;
    this.resolve = publicDns(signal);
  }
  readonly add = (
    id: string,
    status: Status,
    message: string,
    remediation?: string,
    name?: string,
  ) =>
    this.checks.push({
      id,
      status,
      message,
      ...(remediation ? { remediation } : {}),
      ...(name ? { name } : {}),
    });

  readonly run = async (id: string, name: string, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch {
      this.add(
        id,
        "unknown",
        "Could not complete this check.",
        "Check resolver/API availability, permissions, and response compatibility; retry after DNS propagation.",
        name,
      );
    }
  };
}

export function tags(record: string): Record<string, string> {
  if (/[^\x20-\x7e\t]/.test(record)) throw new Error("Invalid record characters");
  const result: Record<string, string> = Object.create(null);
  const parts = record.trim().replace(/;\s*$/, "").split(";");
  for (const part of parts) {
    const match = part.trim().match(/^([a-z][a-z0-9_]*)\s*=\s*(.*)$/i);
    if (!match || Object.hasOwn(result, match[1]!)) throw new Error("Invalid or duplicate tag");
    result[match[1]!] = match[2]!.trim();
  }
  return result;
}
