export const readerActions = [];
export function state(v) {
  const done = v.ready.length;
  const progress =
    done === 2
      ? "Both valid emails ready"
      : v.parsed.length > done
        ? "Parsed content durable; ready commit pending"
        : v.indexed.length > done
          ? "Valid mail indexed; waiting to parse"
          : "Original MIME retained; waiting for index repair";
  return `${progress}; ${done} of 2 ready; ${v.attention.length ? "bad metadata recorded for operator" : "bad metadata not yet recorded"}`;
}

const labels = {
  ReadPage: "List the next original",
  IndexGood: "Repair a valid message index",
  ClearAttention: "Clear a repaired original from operational attention",
  AttentionFault: "Attention write fails; retain the scan position",
  Ack: "Acknowledge the completed parsing job",
  IndexPoison: "Record bad metadata and keep scanning",
  IndexFault: "Record an index failure for retry",
  CursorFault: "Cursor write fails; repeat this page",
  Advance: "Commit scan progress",
  Republish: "Queue an unparsed message",
  StoreParsed: "Persist parsed content",
  CommitReady: "Commit ready state",
  JobFault: "Parsing job stops; Cron can republish",
  DeleteOriginal: "Broken variant deletes an original",
};
export function step(action) {
  return labels[action] ?? action;
}
export function group(v) {
  return v.ready.length === 2 ? "All valid mail recovered" : "Recovery in progress";
}
