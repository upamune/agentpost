import { z } from "zod";

const endpoint = new URL(process.env.LOCAL_MAIL_URL ?? "http://127.0.0.1:8787");
if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
  throw new Error("This smoke test only supports local development URLs");
}
const vars = await Bun.file(new URL("../.dev.vars", import.meta.url)).text();
const token = vars.match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("ADMIN_TOKEN not found in .dev.vars");

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(new URL(path, endpoint), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return response.json();
}

const inbox = z
  .object({ id: z.uuid(), address: z.email() })
  .parse(
    await api("/v1/inboxes", { method: "POST", body: JSON.stringify({ label: "local-smoke" }) }),
  );
const incoming = new URL("/cdn-cgi/local/email", endpoint);
incoming.searchParams.set("from", "sender@example.net");
incoming.searchParams.set("to", inbox.address);
const raw = (await Bun.file(new URL("../test/fixtures/hello.eml", import.meta.url)).text()).replace(
  "To: agent@example.com",
  `To: ${inbox.address}`,
);
const injected = await fetch(incoming, {
  method: "POST",
  body: raw,
  signal: AbortSignal.timeout(10_000),
});
if (!injected.ok) throw new Error(`Email injection failed: HTTP ${injected.status}`);

const listSchema = z.object({ items: z.array(z.object({ id: z.string(), status: z.string() })) });
for (let attempt = 0; attempt < 50; attempt++) {
  const messages = listSchema.parse(await api(`/v1/inboxes/${inbox.id}/messages`));
  const message = messages.items.find((item) => item.status === "ready");
  if (message) {
    const detail = z
      .object({ content: z.object({ text: z.string() }) })
      .parse(await api(`/v1/inboxes/${inbox.id}/messages/${message.id}`));
    if (!detail.content.text.includes("123456"))
      throw new Error("Stored text did not match test MIME");
    const original = await fetch(
      new URL(`/v1/inboxes/${inbox.id}/messages/${message.id}/raw`, endpoint),
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!original.ok || new TextDecoder().decode(await original.arrayBuffer()) !== raw)
      throw new Error("Original MIME did not round-trip");
    console.log(
      JSON.stringify({
        local_smoke: "passed",
        inbox_id: inbox.id,
        received: "ready",
        raw_mime: "verified",
        outbound: "not_sent",
      }),
    );
    process.exit(0);
  }
  await Bun.sleep(200);
}
throw new Error("Email did not reach ready state within 10 seconds");
