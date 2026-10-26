export const readerActions = [];
export function state(v) {
  const phases = { head: "checking storage", put: "waiting to create the file", done: "finished" };
  return `First upload ${phases[v.uploadPC[1]]}; second upload ${phases[v.uploadPC[2]]}; ${v.overwrites ? "existing file overwritten" : "existing files retained"}`;
}
export function step(action) {
  return (
    {
      UploadHead: "Upload observes whether its object exists",
      UploadPut: "Upload conditionally creates its object",
    }[action] ?? action
  );
}
export function group(v) {
  return v.overwrites ? "Existing file overwritten" : "Immutable stored file";
}
