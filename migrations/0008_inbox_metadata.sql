ALTER TABLE inboxes ADD COLUMN notes TEXT NOT NULL DEFAULT '' CHECK(length(notes) <= 10000);
ALTER TABLE inboxes ADD COLUMN urls_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(urls_json) AND json_type(urls_json) = 'array' AND json_array_length(urls_json) <= 20);
