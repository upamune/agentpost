export const readerActions = [];
export function state(v) {
  const sent = v.dispatched?.length
    ? `Provider received ${v.dispatched.join(", ")}`
    : "Provider not called";
  const states = {
    get: "Attachment waiting to be read",
    verify: "Attachment snapshot awaiting integrity check",
    ready: "Attachment bytes verified and copied into payload",
    blocked: "Attachment unavailable or invalid; sending blocked",
    done: "Prepared payload handed to provider",
  };
  return `${states[v.sendPC]}; ${sent}${v.faulted ? "; stored object changed or became unavailable" : ""}`;
}
export function step(action) {
  return (
    {
      Read: "Read one immutable object snapshot",
      Verify: "Check identity, size and content digest",
      Dispatch: "Send the verified in-memory bytes",
      StorageFault: "Stored object is deleted, replaced, corrupted or unavailable",
      UploadHead: "Upload observes whether its object exists",
      UploadPut: "Upload conditionally creates its object",
      Lookup: "Find the existing idempotency key",
      Validate: "Check the attachment belongs to this inbox",
      Insert: "Create the first outbox row atomically",
      Reread: "Read the row that won the race",
      Check: "Compare the request hash to the stored row",
    }[action] ?? action
  );
}
export function group(v) {
  return v.sendPC === "blocked" ? "Safely stopped before sending" : "Verified attachment flow";
}
