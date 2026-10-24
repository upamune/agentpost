import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MailClient } from "./client";
import { createMailServer } from "./mcp-server";

const url = process.env.AGENTPOST_API_URL;
const token = process.env.AGENTPOST_API_TOKEN;
if (!url || !token) {
  throw new Error("AGENTPOST_API_URL and AGENTPOST_API_TOKEN are required");
}
const handle = serveStdio(() => createMailServer(new MailClient({ url, token })));
process.once("SIGINT", () => {
  void handle.close();
});
process.once("SIGTERM", () => {
  void handle.close();
});
