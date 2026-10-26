export const readerActions = ["StartOldProjection", "Replace", "ReplaceAgain", "NewOwnerChange"];
function invalidDispatch(v) {
  return v.dispatched.some((d) => d[1] !== "original" || !d[2] || d[3] !== 2);
}
export function state(v) {
  if (invalidDispatch(v)) return "An obsolete or replaced worker started the webhook request";
  return `${v.pc}; ${v.active ? "inbox enabled" : "inbox disabled"}; ${v.config} webhook; worker ${v.owner}; config update ${v.configVersion}; inbox update ${v.activeVersion}; ${v.pending ? "old change still in flight" : "no old change in flight"}`;
}
export function step(action) {
  return (
    {
      StartOldProjection: "Old worker starts an awaited webhook change or inbox disable",
      Replace: "A replacement worker takes ownership",
      Prepare: "Read and sign the captured original webhook",
      ReserveBarrier: "Reserve an ownership sequence for the dispatch barrier",
      CommitBarrier: "Confirm the snapshot and reject older pending writes atomically",
      ApplyOldProjection: "The old configuration or inbox write finally reaches D1",
      ReplaceAgain: "Another replacement occurs during awaited preparation",
      NewOwnerChange: "The newest worker replaces the webhook and disables the inbox",
      Dispatch: "Fence current ownership and start the captured request synchronously",
      FenceReject: "Stop the replaced worker before starting a request",
    }[action] ?? action
  );
}
export function group(v) {
  if (invalidDispatch(v)) return "Unsafe request started";
  return v.pc === "cancelled"
    ? "Safely cancelled"
    : v.pc === "done"
      ? "Request started safely"
      : "Dispatch barrier protocol";
}
