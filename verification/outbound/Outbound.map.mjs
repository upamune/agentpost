export const readerActions = ["Disable"];
export function state(v) {
  if (v.badUnknown) return "Outcome unknown but old worker starts sending";
  if (v.badDisabled) return "Inbox disabled but provider call starts";
  const stages = Object.values(v.pc);
  const cachedEnabled = Object.keys(v.pc).some(
    (worker) => v.pc[worker] === "checked" && v.snapshot[worker],
  );
  const stage = stages.includes("waiting")
    ? "Provider request in flight"
    : stages.includes("checked")
      ? cachedEnabled
        ? "Earlier check said inbox enabled"
        : "Earlier check said inbox disabled"
      : stages.includes("claimed")
        ? "Worker claimed request"
        : stages.includes("result")
          ? "Provider result awaits saving"
          : v.status === "pending"
            ? "Queued for a worker"
            : "No provider call running";
  return `${v.active ? "Inbox enabled" : "Inbox disabled"}; ${stage}; ${v.status}; accepted ${v.acceptances}`;
}
const labels = {
  Claim: "Worker claims queued request",
  ReadActive: "Read whether inbox is enabled",
  Dispatch: "Call email provider using the earlier read",
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
