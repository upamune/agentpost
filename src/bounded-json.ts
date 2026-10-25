const shortEscapes = new Set([8, 9, 10, 12, 13]);

function escapedCodePointBytes(code: number): number {
  if (code < 0x20) return shortEscapes.has(code) ? 2 : 6;
  if (code === 0x22 || code === 0x5c) return 2;
  return unicodeJsonBytes(code);
}

function unicodeJsonBytes(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code > 0xffff) return 4;
  // Lone UTF-16 surrogates are escaped by JSON.stringify, not encoded as UTF-8.
  return code >= 0xd800 && code <= 0xdfff ? 6 : 3;
}

class JsonSize {
  private size = 0;
  constructor(private readonly limit: number) {}

  private add(bytes: number): void {
    this.size += bytes;
    if (this.size > this.limit) throw new Error("Parsed message exceeds JSON size limit");
  }

  private string(text: string): void {
    this.add(2);
    for (let index = 0; index < text.length; index++) {
      const code = text.codePointAt(index)!;
      this.add(escapedCodePointBytes(code));
      if (code > 0xffff) index++;
    }
  }

  private array(items: unknown[]): void {
    this.add(2 + Math.max(0, items.length - 1));
    for (const entry of items) this.visit(entry === undefined ? null : entry);
  }

  private container(item: object | null): void {
    if (item === null) return this.add(4);
    if (Array.isArray(item)) return this.array(item);
    this.object(item);
  }

  private object(item: object): void {
    if (!(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null))
      throw new Error("Parsed message contains unsupported JSON data");
    this.add(2);
    let first = true;
    for (const [key, entry] of Object.entries(item)) {
      if (entry === undefined) continue;
      if (!first) this.add(1);
      first = false;
      this.string(key);
      this.add(1);
      this.visit(entry);
    }
  }

  private number(item: number): void {
    this.add(Number.isFinite(item) ? String(item).length : 4);
  }

  visit(item: unknown): void {
    switch (typeof item) {
      case "string":
        return this.string(item);
      case "boolean":
        return this.add(item ? 4 : 5);
      case "number":
        return this.number(item);
      case "object":
        return this.container(item);
      default:
        throw new Error("Parsed message contains unsupported JSON data");
    }
  }
}

/** Size plain JSON data before stringifying it, including UTF-8 and JSON escapes. */
export function stringifyBoundedJson(value: unknown, limit: number): string {
  new JsonSize(limit).visit(value);
  return JSON.stringify(value);
}
