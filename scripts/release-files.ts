import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

export async function regularFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size === 0)
    throw new Error("Release asset must be a nonempty regular file");
  return info;
}

export async function sha256File(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
