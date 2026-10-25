export const readerActions = ["Disable"];
function stage(v) {
  const stages = Object.values(v.pc);
  const cachedEnabled = Object.keys(v.pc).some(
    (worker) => v.pc[worker] === "checked" && v.snapshot[worker],
  );
  if (stages.includes("waiting")) return "Provider request in flight";
  if (stages.includes("checked"))
    return cachedEnabled ? "Earlier check said inbox enabled" : "Earlier check said inbox disabled";
  if (stages.includes("claimed")) return "Worker claimed request";
  if (stages.includes("result")) return "Provider result awaits saving";
  return v.status === "pending" ? "Queued for a worker" : "No provider call running";
}
export function state(v) {
  if (v.badUnknown) return "Outcome unknown but old worker starts sending";
  if (v.badDisabled) return "Inbox disabled but provider call starts";
  return `${v.active ? "Inbox enabled" : "Inbox disabled"}; ${stage(v)}; ${v.status}; accepted ${v.acceptances}`;
}
const labels = {
  Acquire: "Wait for earlier inbox operations to finish",
  NoClaim: "Ignore a request already claimed or finished",
  Replace: "Cloudflare replaces the inbox actor",
  FenceRejected: "Stop the old actor before it can send",
  Claim: "Worker claims queued request",
  ReadActive: "Read whether inbox is enabled",
  Dispatch: "Start a request to the email provider",
  RejectDisabled: "Reject a disabled inbox",
  ProviderReply: "Provider replies",
  Persist: "Save provider outcome conditionally",
  StaleCompletion: "Ignore a result after state changed",
  Crash: "Worker stops at an await",
  Cron: "Cron marks stale request outcome unknown",
  Disable: "Admin disables inbox",
  NextJob: "Queue retries a known rejection",
};
export function step(action) {
  return labels[action] ?? action;
}
export function cause(v) {
  return [
    v.badDisabled && "Disabled inbox starts a provider call",
    v.badUnknown && "Stale worker starts a provider call",
  ]
    .filter(Boolean)
    .join("; ");
}
export function group(v) {
  return v.badDisabled || v.badUnknown ? "Needs review" : "Within the checked rules";
}
