export const readerActions = [];
export function state(v) {
  if ([1, 2].some((c) => v.requests[c] > 1))
    return "A logical call implicitly sent another request";
  if ([1, 2].some((c) => v.phase[c] === "done" && v.key[c] !== v.surfaced[c]))
    return "A returned result lost its original idempotency key";
  return [1, 2]
    .map(
      (c) =>
        `call ${c}: ${{ start: "not started", prepared: "key selected before I/O", submitted: "request in flight", done: "result returned" }[v.phase[c]]}, key ${v.key[c] === 3 ? "not selected" : v.key[c]}, ${v.requests[c]} request(s)${v.phase[c] === "done" ? `, returned key ${v.surfaced[c]}` : ""}`,
    )
    .join("; ");
}
export function step(action) {
  return (
    {
      Resolve: "Preserve the caller key or generate one before preparation",
      PreparationFailure: "Return a sanitized preparation error with the same key",
      Submit: "Send the request once using the selected key",
      Surface: "Expose the same key in the result or transport failure",
    }[action] ?? action
  );
}
export function group(v) {
  return v.phase[1] === "done" && v.phase[2] === "done"
    ? "Keys returned for both calls"
    : "Logical send operations";
}
