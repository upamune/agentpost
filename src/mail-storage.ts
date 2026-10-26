import { MAX_MAIL_BYTES, readBounded } from "./common";

export async function readStoredObject(object: R2ObjectBody, limit: number): Promise<ArrayBuffer> {
  if (object.size > limit) {
    await object.body.cancel();
    throw new Error("Stored object exceeds size limit");
  }
  // Check the stream as well: do not rely only on stored size metadata.
  try {
    return await readBounded(object.body, limit);
  } catch (error) {
    if (error instanceof Error && error.message === "Message exceeds size limit")
      throw new Error("Stored object exceeds size limit");
    throw error;
  }
}

export function readStoredMime(object: R2ObjectBody): Promise<ArrayBuffer> {
  return readStoredObject(object, MAX_MAIL_BYTES);
}
