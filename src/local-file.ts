import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

function oversizedFile(limit: number): Error {
  return new Error(`Local file exceeds the ${limit}-byte size limit`);
}

async function readContents(file: FileHandle, limit: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(limit + 1);
  let size = 0;
  while (size < bytes.byteLength) {
    const { bytesRead } = await file.read(bytes, size, bytes.byteLength - size, null);
    if (bytesRead === 0) break;
    size += bytesRead;
  }
  if (size > limit) throw oversizedFile(limit);
  return bytes.subarray(0, size);
}

/** Follow regular-file symlinks, but never consume devices, FIFOs, or an unbounded file. */
export async function readLocalBytes(path: string, limit: number): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Local input must be a regular file");
    if (info.size > limit) throw oversizedFile(limit);
    // The file can grow after stat; consume at most one byte beyond the limit.
    return await readContents(file, limit);
  } finally {
    await file.close();
  }
}

export async function readLocalText(path: string, limit: number): Promise<string> {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
    await readLocalBytes(path, limit),
  );
}
