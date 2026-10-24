export const readerActions = [];
export function state(v) {
  return `${v.active ? "Inbox enabled" : "Inbox disabled"}; stored update ${v.dbVersion}; ${v.oldPending ? "old enable still in flight" : "old enable finished"}; ${v.newPending ? "new disable in flight" : v.disabled ? "new disable completed" : "new disable not started"}`;
}
export function step(action) {
  return (
    {
      PrepareOld: "Old actor starts enabling the inbox",
      Replace: "Cloudflare replaces the actor",
      PrepareNew: "New actor starts disabling the inbox",
      ApplyNew: "New disable commits",
      ApplyOld: "Old enable arrives late",
    }[action] ?? action
  );
}
export function group(v) {
  return v.regressed ? "Disable overwritten" : "Within the checked rule";
}
