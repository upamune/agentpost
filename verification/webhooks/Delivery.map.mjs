export const readerActions = ["Change", "Replace"];
const phaseNames = {
  idle: "idle",
  claimed: "delivery claimed",
  checked: "configuration read",
  prepared: "request signed",
  waiting: "receiver request in flight",
  result: "response awaiting settlement",
  done: "finished",
};
function violation(v) {
  if (v.badClaim) return "A duplicate queue delivery stole an active claim";
  if (v.staleSettlement) return "An old response completed a newer delivery claim";
  if (v.dispatched.some((d) => d[2] !== 1 || !d[3])) return "An obsolete webhook request started";
  return "";
}
export function state(v) {
  const invalid = violation(v);
  if (invalid) return invalid;
  const phases = [1, 2].map((a) => `worker ${a}: ${phaseNames[v.phase[a]]}`).join("; ");
  return `${v.status}; ${v.active ? "inbox enabled" : "inbox disabled"}; ${v.config === 1 ? "original webhook" : "webhook replaced or deleted"}; owner ${v.owner}; claim ${v.claimToken}; ${phases}`;
}
export function step(action) {
  return (
    {
      Claim: "Atomically claim a pending delivery",
      ReadCurrent: "Read enabled inbox and matching configuration",
      Prepare: "Decrypt the captured destination and sign the immutable event",
      Dispatch: "Fence actor ownership and start the HTTP request",
      FenceReject: "Reject a replaced worker before making a request",
      Response: "The receiver returns its result",
      Settle: "Record the result only for the matching sending claim",
      Replace: "Cloudflare replaces the coordinator worker",
      Change: "Replace/delete the webhook or disable the inbox",
      Recover: "Retry a stale webhook using the same event identity",
    }[action] ?? action
  );
}
export function group(v) {
  if (violation(v)) return "Unsafe delivery transition";
  return ["delivered", "cancelled", "failed"].includes(v.status)
    ? "Delivery settled"
    : "Delivery in progress";
}
