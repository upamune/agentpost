import { open } from "node:fs/promises";
import { randomToken } from "../src/common";

const path = new URL("../.dev.vars", import.meta.url);
const template = await Bun.file(new URL("../.dev.vars.example", import.meta.url)).text();
let file;
try {
  file = await open(Bun.fileURLToPath(path), "wx", 0o600);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    console.error(".dev.vars already exists; keep it or edit ADMIN_TOKEN manually.");
    process.exit(1);
  }
  throw error;
}
try {
  await file.writeFile(template.replace(/^ADMIN_TOKEN=.*$/m, `ADMIN_TOKEN=${randomToken()}`));
} finally {
  await file.close();
}
console.log("Created .dev.vars with a random ADMIN_TOKEN (file permissions: 0600).");
