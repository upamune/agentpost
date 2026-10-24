/** Size plain JSON data before stringifying it, including UTF-8 and JSON escapes. */
export function stringifyBoundedJson(value: unknown, limit: number): string {
  let size = 0;
  function add(bytes: number): void {
    size += bytes;
    if (size > limit) throw new Error("Parsed message exceeds JSON size limit");
  }
  function string(text: string): void {
    add(2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 0x20) {
        add(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6);
      } else if (code === 0x22 || code === 0x5c) {
        add(2);
      } else if (code < 0x80) {
        add(1);
      } else if (code < 0x800) {
        add(2);
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4);
          index++;
        } else {
          add(6);
        }
      } else {
        add(code >= 0xdc00 && code <= 0xdfff ? 6 : 3);
      }
    }
  }
  function visit(item: unknown): void {
    if (item === null) add(4);
    else if (typeof item === "string") string(item);
    else if (typeof item === "boolean") add(item ? 4 : 5);
    else if (typeof item === "number") add(Number.isFinite(item) ? String(item).length : 4);
    else if (Array.isArray(item)) {
      add(2 + Math.max(0, item.length - 1));
      for (const entry of item) visit(entry === undefined ? null : entry);
    } else if (
      typeof item === "object" &&
      (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
    ) {
      add(2);
      let first = true;
      for (const [key, entry] of Object.entries(item)) {
        if (entry === undefined) continue;
        if (!first) add(1);
        first = false;
        string(key);
        add(1);
        visit(entry);
      }
    } else {
      throw new Error("Parsed message contains unsupported JSON data");
    }
  }
  visit(value);
  return JSON.stringify(value);
}
