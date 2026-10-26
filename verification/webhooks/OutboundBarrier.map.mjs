import { group, readerActions, step as webhookStep } from "./DispatchBarrier.map.mjs";
export { group, readerActions };
export function state(v) {
  if (v.dispatched.some((d) => !d[2] || d[3] !== 2))
    return "A disabled inbox or replaced worker started an email request";
  return `${v.pc}; ${v.active ? "inbox enabled" : "inbox disabled"}; worker ${v.owner}; inbox update ${v.activeVersion}; ${v.pending ? "old disable still in flight" : "no old disable in flight"}`;
}
export function step(action) {
  return (
    {
      StartOldProjection: "An old worker starts an awaited inbox disable",
      Prepare: "Read inbox state and prepare the email provider payload",
      ApplyOldProjection: "The old inbox disable finally reaches D1",
      NewOwnerChange: "The newest worker disables the inbox",
      Dispatch: "Fence current ownership and start the email provider request",
    }[action] ?? webhookStep(action)
  );
}
