import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MailClient } from "./client";
import { createMailServer } from "./mcp-server";

const url = process.env.MAIL_API_URL;
const token = process.env.MAIL_API_TOKEN;
if (!url || !token) {
  throw new Error("MAIL_API_URL and MAIL_API_TOKEN are required");
}
const handle = serveStdio(() => createMailServer(new MailClient({ url, token })));
process.once("SIGINT", () => {
  void handle.close();
});
process.once("SIGTERM", () => {
  void handle.close();
});
