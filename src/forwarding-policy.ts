import { z } from "zod";
import type { Env } from "./types";

export const forwardingDestination = z
  .email()
  .max(254)
  .transform((value) => {
    const at = value.lastIndexOf("@");
    return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
  });
export const globalForwardingInput = z
  .object({ destination: forwardingDestination.nullable() })
  .strict();
export const inboxForwardingInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inherit") }).strict(),
  z.object({ mode: z.literal("off") }).strict(),
  z.object({ mode: z.literal("custom"), destination: forwardingDestination }).strict(),
]);
export type InboxForwardingInput = z.output<typeof inboxForwardingInput>;
export class ForwardingError extends Error {
  constructor(
    public status: 400 | 503,
    message: string,
  ) {
    super(message);
  }
}

function allowedDestinations(env: Env): string[] {
  const value = env.AGENTPOST_FORWARD_ALLOWED_DESTINATIONS;
  if (value === undefined) return [];
  try {
    if (value.length > 32_768) throw new Error("Oversized policy");
    return z.array(forwardingDestination).max(100).parse(JSON.parse(value));
  } catch {
    throw new ForwardingError(503, "Invalid AGENTPOST_FORWARD_ALLOWED_DESTINATIONS");
  }
}

export function requireForwardDestination(env: Env, value: string): string {
  const destination = forwardingDestination.safeParse(value);
  if (!destination.success) throw new ForwardingError(400, "Invalid forwarding destination");
  const domain = destination.data.slice(destination.data.lastIndexOf("@") + 1);
  const ownDomain = env.AGENTPOST_EMAIL_DOMAIN.toLowerCase();
  if (domain === ownDomain || domain.endsWith(`.${ownDomain}`))
    throw new ForwardingError(400, "Forwarding to the receiving domain is not allowed");
  if (!allowedDestinations(env).includes(destination.data))
    throw new ForwardingError(400, "Forwarding destination is not operator-allowed");
  return destination.data;
}

interface ForwardPlan {
  destination: string | null;
  status: "pending" | "skipped" | "blocked";
  error: string | null;
}

function forwardingPlan(
  env: Env,
  destination: string | null,
  message: ForwardableEmailMessage,
): ForwardPlan {
  if (!destination) return { destination: null, status: "skipped", error: null };
  if (message.headers.has("X-Agentpost-Forwarded"))
    return { destination, status: "blocked", error: "forwarding_loop_marker" };
  if (forwardingUnavailable(message))
    return { destination, status: "blocked", error: "message_not_forwardable" };
  try {
    return {
      destination: requireForwardDestination(env, destination),
      status: "pending",
      error: null,
    };
  } catch {
    return { destination, status: "blocked", error: "destination_policy_rejected" };
  }
}

export function forwardingUnavailable(message: ForwardableEmailMessage): boolean {
  return "canBeForwarded" in message && message.canBeForwarded === false;
}

export function forwardingMetadata(
  env: Env,
  destination: string | null,
  message: ForwardableEmailMessage,
) {
  const plan = forwardingPlan(env, destination, message);
  return {
    forward_version: "1",
    forward_destination: plan.destination ?? "",
    forward_status: plan.status,
    forward_error: plan.error ?? "",
  };
}
