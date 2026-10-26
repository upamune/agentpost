export const readerActions = [];
export function state(v) {
  return `${v.enabled ? "Webhook enabled" : "Webhook disabled"}; stored update ${v.version}; ${v.completed.includes(2) ? "deletion completed" : "deletion not completed"}`;
}
export function step(action) {
  return action === "Apply"
    ? "An awaited configuration write commits or is rejected as stale"
    : action;
}
export function group(v) {
  return v.regressed ? "Deletion overwritten" : "Monotonic configuration";
}
