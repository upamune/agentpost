export const readerActions = [];
export function state(v) {
  const foreign = v.deliveries.some((d) => d.inbox !== (d.captured === 2 ? "other" : "mine"));
  const moved = v.deliveries.some((d) => d.captured !== d.target);
  if (foreign) return "An inbox captured another inbox's webhook event";
  if (moved) return "An existing event moved to a replacement destination";
  return `${v.ready.length} messages ready; ${v.deliveries.length} webhook events; ${v.changed ? "own webhook replaced" : "original configurations"}${foreign ? "; foreign inbox event captured" : ""}${moved ? "; existing event destination changed" : ""}`;
}
export function step(action) {
  return (
    {
      Ready: "Commit message readiness and capture its inbox webhook atomically",
      Replace: "Replace this inbox's webhook without rewriting existing events",
    }[action] ?? action
  );
}
export function group(v) {
  return v.ready.length === 2 ? "Both inboxes have events" : "Readiness transitions";
}
