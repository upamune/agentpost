import type { z } from "zod";
import { inboxMetadataSchema, inboxUrlsSchema } from "./inbox-schema";
import type { Env, Inbox } from "./types";
import type { Principal } from "./auth";

export const publicInboxColumns = "id, address, label, notes, urls_json, active, created_at";
export type PublicInboxRow = Pick<
  Inbox,
  "id" | "address" | "label" | "notes" | "urls_json" | "active" | "created_at"
>;

export function inboxCreationMetadata({
  notes = "",
  urls = [],
}: {
  notes?: string;
  urls?: string[];
}) {
  return { notes, urls };
}

export function publicInbox(row: PublicInboxRow) {
  return {
    id: row.id,
    address: row.address,
    label: row.label,
    notes: row.notes,
    urls: inboxUrlsSchema.parse(JSON.parse(row.urls_json)),
    active: row.active,
    created_at: row.created_at,
  };
}

export async function updateInboxMetadata(
  env: Env,
  id: string,
  input: z.output<typeof inboxMetadataSchema>,
  principal: Principal,
) {
  // COALESCE updates only supplied fields in one statement; independent edits cannot overwrite each other.
  const row = await env.DB.prepare(
    `UPDATE inboxes SET label = COALESCE(?, label), notes = COALESCE(?, notes), urls_json = COALESCE(?, urls_json) WHERE id = ? AND (? = 1 OR (owner_id = ? AND active = 1)) RETURNING ${publicInboxColumns}`,
  )
    .bind(
      input.label ?? null,
      input.notes ?? null,
      input.urls === undefined ? null : JSON.stringify(input.urls),
      id,
      Number(principal.admin),
      principal.ownerId ?? null,
    )
    .first<PublicInboxRow>();
  return row ? publicInbox(row) : null;
}
