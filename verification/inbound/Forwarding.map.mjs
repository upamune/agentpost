export const readerActions = ["Configure"];
const destinations = {
  unset: "not stored",
  off: "off",
  allowed: "trusted mailbox",
  forbidden: "unapproved mailbox",
};
const states = {
  none: "Awaiting forwarding index",
  pending: "Waiting for native claim",
  sending: "Claimed; outcome pending",
  accepted: "Native forwarding accepted",
  unknown: "Outcome unknown; no automatic retry",
  blocked: "Forwarding blocked",
  skipped: "Forwarding was off",
};
export function state(v) {
  if (v.status !== "none" && v.raw !== v.saved) return "Retained and indexed destinations disagree";
  if (v.claims > 1) return "Another native forwarding claim was authorized";
  if (v.callTargets.includes("forbidden")) return "Mail forwarded to an unapproved mailbox";
  if (v.raw === "unset") return "SMTP delivery arrived; original not retained";
  return `${states[v.status]}; original destination = ${destinations[v.raw]}; ${v.claims} claims; ${v.calls} native calls`;
}
const steps = {
  Configure: "Operator changes the default",
  Admit: "Capture the admission setting",
  Store: "Retain original and its admission decision",
  Index: "Index the retained decision",
  ReadPending: "Read and validate pending destination",
  Claim: "Atomically claim native forwarding",
  Call: "Start the native forwarding call",
  Complete: "Persist the native outcome if still sending",
  Crash: "SMTP handler stops",
  Recover: "Record interrupted work for operator attention",
};
export function step(action) {
  return steps[action] ?? action;
}
export function group(v) {
  return v.calls > 0 ? "Native call initiated" : "No native call";
}
