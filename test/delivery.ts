import { afterEach, vi } from "vitest";
import { deliver as dispatch } from "../src/coordinator";
import type { cloudflareSend } from "../src/outbound";
import type { Env } from "../src/types";

afterEach(() => vi.restoreAllMocks());

/** Exercise the real actor and D1, substituting only the external mail provider. */
export async function deliver(env: Env, id: string, sender: typeof cloudflareSend) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const result = await sender(env, JSON.parse(String(init?.body)));
    if (result.status === "accepted") {
      return Response.json({ success: true, result: JSON.parse(result.result) });
    }
    return new Response(null, {
      status: result.status === "retry" ? 429 : result.status === "failed" ? 400 : 500,
      headers: result.status === "retry" ? { "Retry-After": String(result.delay) } : {},
    });
  });
  await dispatch(env, id);
}
