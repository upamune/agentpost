import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

export async function tlcCommand(jar: string, args: string[], scratch: string): Promise<string[]> {
  // TLC 1.7.4 extracts standard modules to java.io.tmpdir by basename and deletes
  // them on exit. Each JVM needs its own directory, beyond model/metadir isolation.
  const temporary = await mkdtemp(join(scratch, "tlc-tmp-"));
  return [
    "java",
    "-XX:+UseParallelGC",
    `-Djava.io.tmpdir=${temporary}`,
    "-cp",
    jar,
    "tlc2.TLC",
    ...args,
  ];
}
