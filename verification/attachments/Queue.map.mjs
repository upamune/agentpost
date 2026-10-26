export const readerActions = [];
export function state(v) {
  const phases = {
    lookup: "finding the key",
    validate: "checking inbox ownership",
    insert: "waiting to create the row",
    reread: "reading the winning row",
    check: "checking the stored hash",
    done: "finished",
  };
  return `First request ${phases[v.requestPC[1]]}; second request ${phases[v.requestPC[2]]}; ${v.queued === "absent" ? "key unused" : `key assigned to ${v.queued}`}; ${v.accepted.length} requests accepted`;
}
export function step(action) {
  return (
    {
      Lookup: "Find the existing idempotency key",
      Validate: "Check the attachment belongs to this inbox",
      Insert: "Create the first outbox row atomically",
      Reread: "Read the row that won the race",
      Check: "Compare the request hash to the stored row",
    }[action] ?? action
  );
}
export function group() {
  return "Inbox-owned attachments under one stable key";
}
