/**
 * PDF text extraction (P12-B).
 *
 * The product must read PDFs on a machine with nothing installed, so the
 * primary path is our own parser over the bytes the browser fetched. The plan
 * originally nominated Chrome's PDF-viewer accessibility tree as rung 1; the
 * spike (2026-11-06, `evidence/P12-spike.md`) measured that tree on Chrome 157
 * and found only the viewer chrome — toolbar labels, page number, zoom — and no
 * document text. A parser in our own tree is therefore rung 1, and `pdftotext`
 * / `mutool` remain optional fallbacks behind `capability()` (PO1).
 *
 * What this parser supports: classic indirect objects and PDF 1.5 object
 * streams, Flate / ASCIIHex / ASCII85 streams, the page tree, Type0 and simple
 * fonts, ToUnicode CMaps (including `bfrange` arrays), `/Differences` glyph
 * names, and the text operators `Tj`, `TJ`, `'`, `"`, with line breaks from
 * `Td`/`TD`/`T*`/`Tm`/`ET`. It deliberately does not do layout, OCR, vector
 * graphics, or font programs: it returns text, or it says honestly that there
 * is none.
 *
 * A scanned page is `E_PDF_SCANNED` (image-only, no text layer). A malformed or
 * unsupported encoding is `E_PDF_UNSUPPORTED` after the binary rungs have had
 * their turn. Neither ever fabricates text.
 */

import { execFile } from "node:child_process";
import { inflateRawSync, inflateSync } from "node:zlib";

import type { CapabilityName } from "../runtime/host.ts";
import { capability as hostCapability } from "../runtime/host.ts";
import { fail } from "../runtime/errors.ts";
import type { ErrorCode } from "../runtime/error-codes.ts";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type PdfExtractor = "in-tree" | "pdftotext" | "mutool";

export interface PdfExtractOptions {
  /** Per-page character cap; the renderer still applies the caller's window. */
  pageMaxChars?: number;
  /** Injected capability resolver; tests pass one that finds nothing. */
  capability?: (name: CapabilityName) => string | null;
  /** Injected binary runner; tests substitute a fake `pdftotext`. */
  runBinary?: BinaryRunner;
  /** Ceiling for a fallback extractor; defaults to 15 s. */
  timeoutMs?: number;
  /** Cooperative cancellation; checked before each rung. */
  signal?: AbortSignal;
}

export interface PdfExtractResult {
  pages: string[];
  pageCount: number;
  extractor: PdfExtractor;
  chars: number;
  /** Pages where `pageMaxChars` cut the text. */
  truncatedPages: number;
  /** Rungs that produced no usable text before the winner (diagnostics). */
  attempted: string[];
}

export interface PdfWindow {
  text: string;
  chars: number;
  totalChars: number;
  truncated: boolean;
  nextOffset?: number;
  pageCount: number;
}

export interface BinaryRunner {
  (command: string, args: readonly string[], input: Buffer, timeoutMs: number): Promise<string>;
}

/**
 * Any decoded text is a success. A short PDF (`Dummy PDF file`, a one-line
 * receipt) used to fall through to the binary rungs and then fail as
 * "unsupported" on a machine without them; the parser only emits text from
 * real text operators, so one visible character is honest evidence of a text
 * layer.
 */
const MIN_USEFUL_CHARS = 1;
const DEFAULT_PAGE_MAX_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 15_000;
/** A page tree deeper than this is malformed, not a document. */
const MAX_PAGE_DEPTH = 32;
const MAX_FORM_DEPTH = 8;

// ---------------------------------------------------------------------------
// PDF value model
// ---------------------------------------------------------------------------

interface PdfName {
  readonly kind: "name";
  readonly name: string;
}

interface PdfRef {
  readonly kind: "ref";
  readonly num: number;
  readonly gen: number;
}

type PdfValue = number | boolean | null | PdfName | Buffer | PdfRef | PdfValue[] | PdfDict;

interface PdfDict {
  readonly kind: "dict";
  readonly map: Map<string, PdfValue>;
}

interface PdfObject {
  num: number;
  gen: number;
  value: PdfValue;
  stream?: Buffer;
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isWhitespace(code: number): boolean {
  return WHITESPACE.has(code);
}

function isDelimiter(code: number): boolean {
  return DELIMITERS.has(code);
}

function name(value: string): PdfName {
  return { kind: "name", name: value };
}

function dictOf(entries: Iterable<readonly [string, PdfValue]>): PdfDict {
  return { kind: "dict", map: new Map(entries) };
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

class Scanner {
  readonly text: string;
  readonly bytes: Buffer;
  pos = 0;

  constructor(bytes: Buffer, text?: string) {
    this.bytes = bytes;
    this.text = text ?? bytes.toString("latin1");
  }

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  peek(): number {
    return this.text.charCodeAt(this.pos);
  }

  skipSpace(): void {
    while (this.pos < this.text.length) {
      const code = this.text.charCodeAt(this.pos);
      if (isWhitespace(code)) {
        this.pos += 1;
        continue;
      }
      // A comment runs to the end of the line; `%` inside a string is consumed
      // by parseString, so this branch only sees real comments.
      if (code === 0x25) {
        while (this.pos < this.text.length && this.text[this.pos] !== "\n" && this.text[this.pos] !== "\r") {
          this.pos += 1;
        }
        continue;
      }
      break;
    }
  }

  parseValue(depth = 0): PdfValue {
    if (depth > 64) throw new Error("pdf: nesting too deep");
    this.skipSpace();
    if (this.atEnd()) return null;
    const code = this.peek();

    if (code === 0x3c) {
      if (this.text[this.pos + 1] === "<") return this.parseDict(depth);
      return this.parseHexString();
    }
    if (code === 0x5b) return this.parseArray(depth);
    if (code === 0x28) return this.parseLiteralString();
    if (code === 0x2f) return this.parseName();

    const start = this.pos;
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (isWhitespace(c) || isDelimiter(c)) break;
      this.pos += 1;
    }
    const token = this.text.slice(start, this.pos);
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;

    if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)$/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error(`pdf: bad number ${token}`);
      // `n g R` is a reference; look ahead without consuming whitespace state
      // that a following object parse needs.
      const afterNumber = this.pos;
      this.skipSpace();
      const genMatch = /^(\d+)\s+R\b/.exec(this.text.slice(this.pos, this.pos + 24));
      if (Number.isInteger(value) && genMatch !== null) {
        this.pos += genMatch[0].length;
        return { kind: "ref", num: value, gen: Number(genMatch[1]) };
      }
      this.pos = afterNumber;
      return value;
    }
    throw new Error(`pdf: unexpected token ${JSON.stringify(token.slice(0, 24))}`);
  }

  parseName(): PdfName {
    this.pos += 1; // '/'
    const start = this.pos;
    while (this.pos < this.text.length) {
      const code = this.text.charCodeAt(this.pos);
      if (isWhitespace(code) || isDelimiter(code)) break;
      this.pos += 1;
    }
    let raw = this.text.slice(start, this.pos);
    // `#xx` escapes are part of the name grammar.
    raw = raw.replace(/#([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return name(raw);
  }

  parseLiteralString(): Buffer {
    this.pos += 1; // '('
    const out: number[] = [];
    let nesting = 1;
    while (this.pos < this.text.length) {
      const code = this.text.charCodeAt(this.pos);
      if (code === 0x5c) {
        this.pos += 1;
        const escaped = this.text.charCodeAt(this.pos);
        const mapped: Record<number, number> = {
          0x6e: 0x0a, // \n
          0x72: 0x0d, // \r
          0x74: 0x09, // \t
          0x62: 0x08,
          0x66: 0x0c,
          0x28: 0x28,
          0x29: 0x29,
          0x5c: 0x5c,
        };
        if (escaped === 0x0d) {
          // Line continuation: CR, optional LF, then nothing.
          this.pos += 1;
          if (this.text[this.pos] === "\n") this.pos += 1;
        } else if (escaped === 0x0a) {
          this.pos += 1;
        } else if (mapped[escaped] !== undefined) {
          out.push(mapped[escaped]);
          this.pos += 1;
        } else if (escaped >= 0x30 && escaped <= 0x37) {
          let octal = 0;
          let digits = 0;
          while (digits < 3 && this.text.charCodeAt(this.pos) >= 0x30 && this.text.charCodeAt(this.pos) <= 0x37) {
            octal = octal * 8 + (this.text.charCodeAt(this.pos) - 0x30);
            this.pos += 1;
            digits += 1;
          }
          out.push(octal & 0xff);
        } else {
          out.push(escaped & 0xff);
          this.pos += 1;
        }
        continue;
      }
      if (code === 0x28) nesting += 1;
      if (code === 0x29) {
        nesting -= 1;
        if (nesting === 0) {
          this.pos += 1;
          break;
        }
      }
      out.push(code & 0xff);
      this.pos += 1;
    }
    return Buffer.from(out);
  }

  parseHexString(): Buffer {
    this.pos += 1; // '<'
    const start = this.pos;
    while (this.pos < this.text.length && this.text[this.pos] !== ">") this.pos += 1;
    let hex = this.text.slice(start, this.pos).replace(/[^0-9a-fA-F]/g, "");
    this.pos += 1; // '>'
    if (hex.length % 2 === 1) hex += "0";
    return Buffer.from(hex, "hex");
  }

  parseArray(depth: number): PdfValue[] {
    this.pos += 1; // '['
    const values: PdfValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) break;
      if (this.peek() === 0x5d) {
        this.pos += 1;
        break;
      }
      values.push(this.parseValue(depth + 1));
    }
    return values;
  }

  parseDict(depth: number): PdfDict {
    this.pos += 2; // '<<'
    const entries: Array<readonly [string, PdfValue]> = [];
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) break;
      if (this.text[this.pos] === ">" && this.text[this.pos + 1] === ">") {
        this.pos += 2;
        break;
      }
      const key = this.parseValue(depth + 1);
      if (key === null || typeof key !== "object" || !("kind" in key) || key.kind !== "name") {
        // A malformed key would desynchronise everything after it; stop the dict.
        continue;
      }
      entries.push([key.name, this.parseValue(depth + 1)]);
    }
    return dictOf(entries);
  }
}

// ---------------------------------------------------------------------------
// Object table
// ---------------------------------------------------------------------------

interface ParsedPdf {
  objects: Map<number, PdfObject>;
  trailer: PdfDict | null;
}

function asDict(value: PdfValue | undefined): PdfDict | null {
  return value !== undefined && value !== null && typeof value === "object" && "kind" in value && value.kind === "dict"
    ? value
    : null;
}

function asArray(value: PdfValue | undefined): PdfValue[] | null {
  return Array.isArray(value) ? value : null;
}

function asName(value: PdfValue | undefined): string | null {
  return value !== undefined && value !== null && typeof value === "object" && "kind" in value && value.kind === "name"
    ? value.name
    : null;
}

function asNumber(value: PdfValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dictGet(dict: PdfDict | null, key: string): PdfValue | undefined {
  return dict?.map.get(key);
}

class PdfReader {
  readonly parsed: ParsedPdf;

  constructor(parsed: ParsedPdf) {
    this.parsed = parsed;
  }

  resolve(value: PdfValue | undefined): PdfValue | undefined {
    let current = value;
    // A reference chain is legal but rare; cap it instead of trusting the file.
    for (let hops = 0; hops < 16; hops += 1) {
      if (current === undefined || current === null || typeof current !== "object") return current;
      if (!("kind" in current) || current.kind !== "ref") return current;
      const object = this.parsed.objects.get(current.num);
      if (object === undefined) return undefined;
      current = object.value;
    }
    return undefined;
  }

  resolveDict(value: PdfValue | undefined): PdfDict | null {
    return asDict(this.resolve(value));
  }

  resolveStream(value: PdfValue | undefined): { dict: PdfDict; bytes: Buffer } | null {
    if (value === undefined || value === null || typeof value !== "object" || !("kind" in value)) return null;
    if (value.kind !== "ref") return null;
    const object = this.parsed.objects.get(value.num);
    if (object === undefined || object.stream === undefined) return null;
    return { dict: asDict(object.value) ?? dictOf([]), bytes: object.stream };
  }

  objectStream(value: PdfValue | undefined): PdfObject | undefined {
    return value !== undefined && value !== null && typeof value === "object" && "kind" in value && value.kind === "ref"
      ? this.parsed.objects.get(value.num)
      : undefined;
  }
}

function parseObjectAt(text: string, bytes: Buffer, start: number, num: number, gen: number): PdfObject | null {
  const scanner = new Scanner(bytes, text);
  scanner.pos = start;
  let value: PdfValue;
  try {
    value = scanner.parseValue();
  } catch {
    return null;
  }
  scanner.skipSpace();
  let stream: Buffer | undefined;
  if (text.startsWith("stream", scanner.pos)) {
    let dataStart = scanner.pos + "stream".length;
    if (text[dataStart] === "\r") dataStart += 1;
    if (text[dataStart] === "\n") dataStart += 1;
    const dict = asDict(value);
    const declared = asNumber(dictGet(dict, "Length"));
    let end = -1;
    if (declared !== null && declared > 0) {
      const candidate = dataStart + declared;
      const after = text.slice(candidate, candidate + 24);
      if (/^\s*endstream/.test(after)) end = candidate;
    }
    if (end < 0) {
      const found = text.indexOf("endstream", dataStart);
      if (found < 0) return null;
      end = found;
      // The EOL before `endstream` belongs to the syntax, not the payload.
      if (text[end - 1] === "\n") end -= 1;
      if (text[end - 1] === "\r") end -= 1;
    }
    stream = bytes.subarray(dataStart, end);
  }
  return { num, gen, value, ...(stream === undefined ? {} : { stream }) };
}

function decodeFilters(reader: PdfReader, dict: PdfDict, input: Buffer): Buffer {
  const filters = reader.resolve(dictGet(dict, "Filter"));
  const list = Array.isArray(filters) ? filters : filters === undefined ? [] : [filters];
  let data = input;
  for (const entry of list) {
    const name = asName(reader.resolve(entry)) ?? "";
    data = applyFilter(name, data);
  }
  return data;
}

function applyFilter(name: string, input: Buffer): Buffer {
  if (name === "FlateDecode" || name === "Fl") {
    try {
      return inflateSync(input);
    } catch {
      try {
        return inflateRawSync(input);
      } catch {
        // Some producers pad the stream; retry from the next byte a few times.
        for (let skip = 1; skip < 8 && skip < input.length; skip += 1) {
          try {
            return inflateSync(input.subarray(skip));
          } catch {
            // keep trying
          }
        }
        return Buffer.alloc(0);
      }
    }
  }
  if (name === "ASCIIHexDecode" || name === "AHx") {
    let hex = input.toString("latin1").replace(/[^0-9a-fA-F]/g, "");
    if (hex.length % 2 === 1) hex += "0";
    return Buffer.from(hex, "hex");
  }
  if (name === "ASCII85Decode" || name === "A85") {
    return decodeAscii85(input);
  }
  // An unsupported filter (JPX, CCITT, LZW) means "no text from this stream",
  // not a crash: the page still descends through the rungs.
  return Buffer.alloc(0);
}

function decodeAscii85(input: Buffer): Buffer {
  const text = input.toString("latin1").replace(/\s+/g, "");
  const body = text.startsWith("<~") ? text.slice(2) : text;
  const until = body.indexOf("~>");
  const payload = until >= 0 ? body.slice(0, until) : body;
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  for (const char of payload) {
    if (char === "z" && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = char.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    tuple = tuple * 85 + code;
    count += 1;
    if (count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i += 1) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(out);
}

function parsePdf(bytes: Buffer): ParsedPdf {
  const text = bytes.toString("latin1");
  const objects = new Map<number, PdfObject>();
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(text)) !== null) {
    const num = Number(match[1]);
    const gen = Number(match[2]);
    const parsed = parseObjectAt(text, bytes, header.lastIndex, num, gen);
    if (parsed !== null) objects.set(num, parsed);
  }

  // PDF 1.5 object streams: the "objects" above include the container, and the
  // real objects live compressed inside it. Expand them after the first pass.
  const reader = new PdfReader({ objects, trailer: null });
  for (const object of [...objects.values()]) {
    const dict = asDict(object.value);
    if (asName(dictGet(dict, "Type")) !== "ObjStm" || object.stream === undefined) continue;
    const data = decodeFilters(reader, dict ?? dictOf([]), object.stream);
    const n = asNumber(dictGet(dict, "N")) ?? 0;
    const first = asNumber(dictGet(dict, "First")) ?? 0;
    const headerText = data.subarray(0, first).toString("latin1").trim();
    const pairs = headerText.split(/\s+/).filter((part) => part !== "");
    for (let i = 0; i + 1 < pairs.length && i / 2 < n; i += 2) {
      const innerNum = Number(pairs[i]);
      const offset = Number(pairs[i + 1]);
      if (!Number.isFinite(innerNum) || !Number.isFinite(offset)) continue;
      if (objects.has(innerNum)) continue;
      const scanner = new Scanner(data);
      scanner.pos = first + offset;
      let value: PdfValue;
      try {
        value = scanner.parseValue();
      } catch {
        continue;
      }
      objects.set(innerNum, { num: innerNum, gen: 0, value });
    }
  }

  let trailer: PdfDict | null = null;
  const trailerRe = /trailer\s*<</g;
  let trailerMatch: RegExpExecArray | null;
  while ((trailerMatch = trailerRe.exec(text)) !== null) {
    const scanner = new Scanner(bytes, text);
    scanner.pos = trailerMatch.index + "trailer".length;
    try {
      const value = scanner.parseValue();
      const dict = asDict(value);
      if (dict !== null) trailer = dict;
    } catch {
      // A broken trailer only costs inherited attributes we can still find on Pages.
    }
  }
  return { objects, trailer };
}

// ---------------------------------------------------------------------------
// Fonts and encodings
// ---------------------------------------------------------------------------

interface PdfFont {
  twoByte: boolean;
  toUnicode: Map<number, string> | null;
  encoding: string[] | null;
}

const CP1252 = new TextDecoder("windows-1252");
let cp1252Table: string[] | null = null;

function cp1252(code: number): string {
  if (cp1252Table === null) {
    cp1252Table = [];
    for (let i = 0; i < 256; i += 1) cp1252Table.push(CP1252.decode(Uint8Array.of(i)));
  }
  if (code < 0 || code > 255) return "";
  return cp1252Table[code] ?? "";
}

/**
 * Glyph names that actually appear in `/Differences` arrays. Unknown names are
 * dropped rather than guessed: a wrong character is worse than a missing one.
 */
const GLYPH_NAMES: Record<string, string> = {
  space: " ",
  exclam: "!",
  quotedbl: "\"",
  numbersign: "#",
  dollar: "$",
  percent: "%",
  ampersand: "&",
  quotesingle: "'",
  parenleft: "(",
  parenright: ")",
  asterisk: "*",
  plus: "+",
  comma: ",",
  hyphen: "-",
  period: ".",
  slash: "/",
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  colon: ":",
  semicolon: ";",
  less: "<",
  equal: "=",
  greater: ">",
  question: "?",
  at: "@",
  bracketleft: "[",
  backslash: "\\",
  bracketright: "]",
  asciicircum: "^",
  underscore: "_",
  grave: "`",
  braceleft: "{",
  bar: "|",
  braceright: "}",
  asciitilde: "~",
  quoteleft: "\u2018",
  quoteright: "\u2019",
  quotedblleft: "\u201c",
  quotedblright: "\u201d",
  quotesinglbase: "\u201a",
  quotedblbase: "\u201e",
  endash: "\u2013",
  emdash: "\u2014",
  bullet: "\u2022",
  ellipsis: "\u2026",
  dagger: "\u2020",
  daggerdbl: "\u2021",
  perthousand: "\u2030",
  guilsinglleft: "\u2039",
  guilsinglright: "\u203a",
  guillemotleft: "\u00ab",
  guillemotright: "\u00bb",
  fi: "\ufb01",
  fl: "\ufb02",
  ff: "\ufb00",
  ffi: "\ufb03",
  ffl: "\ufb04",
  germandbls: "\u00df",
  ae: "\u00e6",
  AE: "\u00c6",
  oe: "\u0153",
  OE: "\u0152",
  oslash: "\u00f8",
  Oslash: "\u00d8",
  ordfeminine: "\u00aa",
  ordmasculine: "\u00ba",
  degree: "\u00b0",
  plusminus: "\u00b1",
  multiply: "\u00d7",
  divide: "\u00f7",
  section: "\u00a7",
  paragraph: "\u00b6",
  copyright: "\u00a9",
  registered: "\u00ae",
  trademark: "\u2122",
  Euro: "\u20ac",
  sterling: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  nbspace: "\u00a0",
  minus: "\u2212",
  periodcentered: "\u00b7",
  middot: "\u00b7",
  dotlessi: "\u0131",
  dotlessj: "\u0237",
};

function glyphToUnicode(glyph: string): string {
  const direct = GLYPH_NAMES[glyph];
  if (direct !== undefined) return direct;
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(glyph);
  if (uni !== null) {
    const code = parseInt(uni[1] as string, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  }
  const single = /^u([0-9A-Fa-f]{4,6})$/.exec(glyph);
  if (single !== null) {
    const code = parseInt(single[1] as string, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  }
  if (glyph.length === 1) return glyph;
  return "";
}

/**
 * Adobe StandardEncoding places ligatures and typographic punctuation where
 * cp1252 has unrelated letters (`0xDE` is `fi`, not `Þ`). Fonts without an
 * explicit `/Encoding` use StandardEncoding, so mapping those slots matters for
 * ordinary text quality. Only the high half is overridden; ASCII is identical
 * in every encoding we claim to support.
 */
const STANDARD_ENCODING: Readonly<Record<number, string>> = {
  0xb1: "\u00e6",
  0xb5: "\u00b5",
  0xc1: "\u0060",
  0xc2: "\u00b4",
  0xc3: "\u02c6",
  0xc4: "\u02dc",
  0xc5: "\u00af",
  0xc6: "\u02d8",
  0xc7: "\u02d9",
  0xc8: "\u00a8",
  0xca: "\u02da",
  0xcb: "\u00b8",
  0xcd: "\u02dd",
  0xce: "\u02db",
  0xcf: "\u02c7",
  0xd0: "\u2014",
  0xde: "\ufb01",
  0xdf: "\ufb02",
  0xe1: "\u00c6",
  0xe3: "\u00aa",
  0xe8: "\u0141",
  0xe9: "\u00d8",
  0xea: "\u0152",
  0xeb: "\u00ba",
  0xf1: "\u00e6",
  0xf5: "\u0131",
  0xf8: "\u0142",
  0xf9: "\u00f8",
  0xfa: "\u0153",
  0xfb: "\u00df",
};

function baseEncodingTable(encoding: string | null): string[] {
  const table: string[] = [];
  for (let i = 0; i < 256; i += 1) table.push(cp1252(i));
  // WinAnsi is already cp1252. MacRoman keeps the approximation (printable
  // ASCII is identical); only the default/Standard table gets the overrides.
  if (encoding !== "WinAnsiEncoding" && encoding !== "MacRomanEncoding") {
    for (const [code, value] of Object.entries(STANDARD_ENCODING)) table[Number(code)] = value;
  }
  return table;
}

function utf16beToString(bytes: Buffer): string {
  if (bytes.length % 2 === 0) {
    let out = "";
    let allZero = true;
    for (let i = 0; i < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | (bytes[i + 1] ?? 0);
      if (code !== 0) allZero = false;
      out += String.fromCharCode(code);
    }
    if (!allZero) return out;
  }
  return bytes.toString("latin1");
}

function parseToUnicode(data: Buffer): Map<number, string> {
  const result = new Map<number, string>();
  const text = data.toString("latin1");
  const bfcharBlocks = [...text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)];
  for (const block of bfcharBlocks) {
    const entries = [...(block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)];
    for (const entry of entries) {
      const code = parseInt(entry[1] as string, 16);
      const value = utf16beToString(Buffer.from(entry[2] ?? "", "hex"));
      if (Number.isFinite(code) && value !== "") result.set(code, value);
    }
  }
  const bfrangeBlocks = [...text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)];
  for (const block of bfrangeBlocks) {
    const body = block[1] ?? "";
    for (const entry of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([\s\S]*?)\])/g)) {
      const lo = parseInt(entry[1] as string, 16);
      const hi = parseInt(entry[2] as string, 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 0xffff) continue;
      if (entry[4] !== undefined) {
        const start = Buffer.from(entry[4], "hex");
        if (start.length < 2) continue;
        const base = start.readUIntBE(0, start.length);
        const width = start.length;
        for (let code = lo; code <= hi; code += 1) {
          const target = base + (code - lo);
          const encoded = Buffer.alloc(width);
          encoded.writeUIntBE(target, 0, width);
          result.set(code, utf16beToString(encoded));
        }
      } else {
        const destinations = [...(entry[5] ?? "").matchAll(/<([0-9a-fA-F]*)>/g)];
        for (let i = 0; i < destinations.length; i += 1) {
          result.set(lo + i, utf16beToString(Buffer.from(destinations[i]?.[1] ?? "", "hex")));
        }
      }
    }
  }
  return result;
}

function loadFont(reader: PdfReader, fontDict: PdfDict): PdfFont {
  const subtype = asName(reader.resolve(dictGet(fontDict, "Subtype"))) ?? "";
  const twoByte = subtype === "Type0";
  const toUnicodeStream = reader.resolveStream(dictGet(fontDict, "ToUnicode"));
  const toUnicode = toUnicodeStream === null ? null : parseToUnicode(decodeFilters(reader, toUnicodeStream.dict, toUnicodeStream.bytes));

  const encodingValue = reader.resolve(dictGet(fontDict, "Encoding"));
  const encodingName = asName(encodingValue);
  let encoding: string[] | null = null;
  if (!twoByte) {
    encoding = baseEncodingTable(encodingName);
    const encodingDict = asDict(encodingValue);
    const differences = asArray(reader.resolve(dictGet(encodingDict, "Differences")));
    if (differences !== null) {
      let code = 0;
      for (const entry of differences) {
        const resolved = reader.resolve(entry);
        if (typeof resolved === "number") {
          code = resolved;
          continue;
        }
        const glyph = asName(resolved);
        if (glyph === null) continue;
        if (code >= 0 && code < 256) encoding[code] = glyphToUnicode(glyph);
        code += 1;
      }
    }
  }
  return { twoByte, toUnicode, encoding };
}

// ---------------------------------------------------------------------------
// Content stream
// ---------------------------------------------------------------------------

interface ContentString {
  kind: "string";
  bytes: Buffer;
}

interface ContentNumber {
  kind: "number";
  value: number;
}

interface ContentName {
  kind: "name";
  value: string;
}

interface ContentArray {
  kind: "array";
  items: ContentToken[];
}

interface ContentOperator {
  kind: "op";
  value: string;
}

type ContentToken = ContentString | ContentNumber | ContentName | ContentArray | ContentOperator;

function tokenizeContent(data: Buffer): ContentToken[] {
  const scanner = new Scanner(data);
  const tokens: ContentToken[] = [];
  while (!scanner.atEnd()) {
    scanner.skipSpace();
    if (scanner.atEnd()) break;
    const code = scanner.peek();
    try {
      if (code === 0x28) {
        tokens.push({ kind: "string", bytes: scanner.parseLiteralString() });
      } else if (code === 0x3c && scanner.text[scanner.pos + 1] !== "<") {
        tokens.push({ kind: "string", bytes: scanner.parseHexString() });
      } else if (code === 0x5b) {
        const value = scanner.parseValue();
        if (Array.isArray(value)) tokens.push({ kind: "array", items: value.map(toContentToken) });
      } else if (code === 0x2f) {
        tokens.push({ kind: "name", value: scanner.parseName().name });
      } else if (code === 0x2b || code === 0x2d || code === 0x2e || (code >= 0x30 && code <= 0x39)) {
        const start = scanner.pos;
        while (scanner.pos < scanner.text.length) {
          const c = scanner.text.charCodeAt(scanner.pos);
          if (isWhitespace(c) || isDelimiter(c)) break;
          scanner.pos += 1;
        }
        const raw = scanner.text.slice(start, scanner.pos);
        const value = Number(raw);
        if (Number.isFinite(value)) tokens.push({ kind: "number", value });
      } else {
        const start = scanner.pos;
        while (scanner.pos < scanner.text.length) {
          const c = scanner.text.charCodeAt(scanner.pos);
          if (isWhitespace(c) || isDelimiter(c)) break;
          scanner.pos += 1;
        }
        const raw = scanner.text.slice(start, scanner.pos);
        if (raw === "") {
          scanner.pos += 1;
          continue;
        }
        tokens.push({ kind: "op", value: raw });
      }
    } catch {
      scanner.pos += 1;
    }
  }
  return tokens;
}

function toContentToken(value: PdfValue): ContentToken {
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "string") return { kind: "name", value };
  if (Buffer.isBuffer(value)) return { kind: "string", bytes: value };
  if (Array.isArray(value)) return { kind: "array", items: value.map(toContentToken) };
  if (value !== null && typeof value === "object" && "kind" in value && value.kind === "name") {
    return { kind: "name", value: value.name };
  }
  return { kind: "op", value: "" };
}

interface PageText {
  text: string;
  hasImage: boolean;
}

class TextCollector {
  lines: string[] = [];
  current = "";
  hasImage = false;
  readonly seenForms = new Set<string>();

  push(text: string): void {
    if (text === "") return;
    // A word gap before punctuation is an artefact of positioning, not text:
    // `outputs , by` reads wrong and no PDF author typed it.
    if (/^[.,;:!?)\]]/.test(text)) this.current = this.current.replace(/ +$/, "");
    this.current += text;
  }

  newline(): void {
    const trimmed = this.current.replace(/[ \t]+/g, " ").trim();
    if (trimmed !== "") this.lines.push(trimmed);
    this.current = "";
  }

  /** A word gap inside one line; never doubles an existing space. */
  space(): void {
    if (this.current === "" || /\s$/.test(this.current)) return;
    this.current += " ";
  }

  finish(): string {
    this.newline();
    return this.lines.join("\n");
  }
}

function decodeText(font: PdfFont | null, bytes: Buffer): string {
  if (font === null) return "";
  if (font.twoByte) {
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | (bytes[i + 1] ?? 0);
      const mapped = font.toUnicode?.get(code);
      if (mapped !== undefined) out += mapped;
    }
    return out;
  }
  let out = "";
  for (const code of bytes) {
    const mapped = font.toUnicode?.get(code);
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const table = font.encoding;
    if (table !== null) out += table[code] ?? "";
  }
  return out;
}

function isTextShow(token: ContentOperator): boolean {
  return token.value === "Tj" || token.value === "TJ" || token.value === "T'" || token.value === "\"";
}

function showText(
  collector: TextCollector,
  font: PdfFont | null,
  token: ContentToken | undefined,
  isArray: boolean,
): void {
  if (token === undefined) return;
  if (!isArray && token.kind === "string") {
    collector.push(decodeText(font, token.bytes));
    return;
  }
  if (!isArray && token.kind !== "array") return;
  if (token.kind !== "array") return;
  for (const item of token.items) {
    if (item.kind === "string") {
      collector.push(decodeText(font, item.bytes));
    } else if (item.kind === "number" && item.value <= -120) {
      // Word gaps in `TJ` are negative adjustments; letter kerning is small.
      collector.push(" ");
    }
  }
}

function extractContent(
  reader: PdfReader,
  data: Buffer,
  resources: PdfDict | null,
  collector: TextCollector,
  depth: number,
): void {
  if (depth > MAX_FORM_DEPTH) return;
  const tokens = tokenizeContent(data);
  let font: PdfFont | null = null;
  let fonts: Map<string, PdfFont> | null = null;
  const fontCache = new Map<string, PdfFont>();
  let pending: ContentToken[] = [];
  /** Baseline of the current text line, for "Td with dy=0 is a word gap". */
  let lastBaseline: number | null = null;

  const pendingNumbers = (): number[] =>
    pending.filter((entry): entry is ContentNumber => entry.kind === "number").map((entry) => entry.value);

  const fontsFor = (): Map<string, PdfFont> => {
    if (fonts !== null) return fonts;
    fonts = new Map();
    const fontDict = reader.resolveDict(dictGet(resources, "Font"));
    if (fontDict !== null) {
      for (const [key, value] of fontDict.map) {
        const dict = reader.resolveDict(value);
        if (dict !== null) fonts.set(key, loadFont(reader, dict));
      }
    }
    return fonts;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.kind !== "op") {
      pending.push(token);
      if (pending.length > 64) pending = pending.slice(-64);
      continue;
    }
    const op = token.value;
    if (op === "BI") {
      // Inline image: skip its dictionary and binary data up to `EI`.
      const ei = tokens.findIndex((entry, index) => index > i && entry.kind === "op" && entry.value === "EI");
      if (ei > i) i = ei;
      pending = [];
      continue;
    }
    if (op === "ET") {
      collector.newline();
      lastBaseline = null;
    } else if (op === "T*") {
      collector.newline();
      lastBaseline = null;
    } else if (op === "Td" || op === "TD") {
      const numbers = pendingNumbers();
      const ty = numbers[numbers.length - 1] ?? 0;
      const tx = numbers[numbers.length - 2] ?? 0;
      if (Math.abs(ty) > 0.01) {
        collector.newline();
        lastBaseline = null;
      } else if (tx > 0.01) {
        collector.space();
      }
    } else if (op === "Tm") {
      const numbers = pendingNumbers();
      const y = numbers[numbers.length - 1];
      if (lastBaseline !== null && y !== undefined && Math.abs(y - lastBaseline) > 0.01) {
        collector.newline();
      } else if (lastBaseline !== null && y !== undefined) {
        // Same baseline, new text matrix: producers use this for a font switch
        // or a positioned word, and both need a gap in the plain text.
        collector.space();
      }
      if (y !== undefined) lastBaseline = y;
    } else if (op === "Tf") {
      const nameToken = pending[pending.length - 2];
      if (nameToken !== undefined && nameToken.kind === "name") {
        const cached = fontCache.get(nameToken.value);
        if (cached !== undefined) {
          font = cached;
        } else {
          const loaded = fontsFor().get(nameToken.value) ?? null;
          if (loaded !== null) fontCache.set(nameToken.value, loaded);
          font = loaded;
        }
      }
    } else if (isTextShow(token)) {
      const isArray = op === "TJ";
      showText(collector, font, pending[pending.length - 1], isArray);
      if (op === "T'" || op === "\"") collector.newline();
    } else if (op === "Do") {
      const nameToken = pending[pending.length - 1];
      if (nameToken !== undefined && nameToken.kind === "name") {
        const xobjects = reader.resolveDict(dictGet(resources, "XObject"));
        const xobject = reader.resolveDict(dictGet(xobjects, nameToken.value));
        const subtype = asName(dictGet(xobject, "Subtype"));
        if (subtype === "Image") {
          collector.hasImage = true;
        } else if (subtype === "Form") {
          const ref = dictGet(xobjects, nameToken.value);
          const object = reader.objectStream(ref);
          if (object !== undefined && object.stream !== undefined && !collector.seenForms.has(`${depth}:${object.num}`)) {
            collector.seenForms.add(`${depth}:${object.num}`);
            const formResources = reader.resolveDict(dictGet(xobject, "Resources")) ?? resources;
            const formData = decodeFilters(reader, xobject ?? dictOf([]), object.stream);
            extractContent(reader, formData, formResources, collector, depth + 1);
          }
        }
      }
    }
    if (op === "q" || op === "Q" || op === "cm" || op === "gs") {
      // Graphics state does not change what text is present.
    }
    pending = [];
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

interface PageNode {
  dict: PdfDict;
  resources: PdfDict | null;
}

function collectPages(reader: PdfReader, node: PdfDict | null, inheritedResources: PdfDict | null, depth: number): PageNode[] {
  if (node === null || depth > MAX_PAGE_DEPTH) return [];
  const resources = reader.resolveDict(dictGet(node, "Resources")) ?? inheritedResources;
  const type = asName(reader.resolve(dictGet(node, "Type")));
  if (type === "Page") return [{ dict: node, resources }];
  const kids = asArray(reader.resolve(dictGet(node, "Kids")));
  if (kids === null) return [];
  const pages: PageNode[] = [];
  for (const kid of kids) {
    pages.push(...collectPages(reader, reader.resolveDict(kid), resources, depth + 1));
  }
  return pages;
}

function pageContent(reader: PdfReader, page: PageNode): Buffer {
  // Deliberately *not* resolved: `resolve` would turn a single ref into its
  // dictionary, and `resolveStream` needs the ref to find the stream bytes.
  const contents = dictGet(page.dict, "Contents");
  const parts: Buffer[] = [];
  const list = Array.isArray(contents) ? contents : contents === undefined ? [] : [contents];
  for (const entry of list) {
    const stream = reader.resolveStream(entry);
    if (stream === null) continue;
    parts.push(decodeFilters(reader, stream.dict, stream.bytes));
  }
  return Buffer.concat(parts);
}

function findCatalog(reader: PdfReader): PdfDict | null {
  for (const object of reader.parsed.objects.values()) {
    const dict = asDict(object.value);
    if (asName(dictGet(dict, "Type")) === "Catalog") return dict;
  }
  return null;
}

// ---------------------------------------------------------------------------
// In-tree rung
// ---------------------------------------------------------------------------

interface InTreeResult {
  pages: string[];
  hasImage: boolean;
  pageCount: number;
}

function parseInTree(bytes: Buffer, pageMaxChars: number): InTreeResult {
  const parsed = parsePdf(bytes);
  const reader = new PdfReader(parsed);
  const catalog = findCatalog(reader);
  const root = reader.resolveDict(dictGet(catalog, "Pages"));
  const nodes = collectPages(reader, root, null, 0);
  if (nodes.length === 0) {
    return { pages: [], hasImage: false, pageCount: 0 };
  }
  const pages: string[] = [];
  let hasImage = false;
  for (const node of nodes) {
    const collector = new TextCollector();
    const data = pageContent(reader, node);
    if (data.length > 0) extractContent(reader, data, node.resources, collector, 0);
    const text = collector.finish().replace(/\u0000/g, "");
    hasImage = hasImage || collector.hasImage;
    pages.push(text.length > pageMaxChars ? `${text.slice(0, pageMaxChars)}\n[…]` : text);
  }
  return { pages, hasImage, pageCount: nodes.length };
}

// ---------------------------------------------------------------------------
// Binary fallbacks (rungs 2 and 3, behind capability())
// ---------------------------------------------------------------------------

const realRunner: BinaryRunner = (command, args, input, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
    // The PDF never touches the disk: it is streamed to the extractor's stdin.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });

type Rung = { extractor: PdfExtractor; command: CapabilityName; args: string[] };

const RUNGS: readonly Rung[] = [
  { extractor: "pdftotext", command: "pdftotext", args: ["-layout", "-enc", "UTF-8", "-", "-"] },
  { extractor: "mutool", command: "mutool", args: ["draw", "-F", "txt", "-o", "-", "-"] },
];

async function runLadder(
  bytes: Buffer,
  options: PdfExtractOptions,
  attempted: string[],
): Promise<{ extractor: PdfExtractor; pages: string[] } | null> {
  const resolveCapability = options.capability ?? ((name: CapabilityName) => hostCapability(name));
  const run = options.runBinary ?? realRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (const rung of RUNGS) {
    const binary = resolveCapability(rung.command);
    if (binary === null) {
      attempted.push(`${rung.extractor}:unavailable`);
      continue;
    }
    try {
      const output = await run(binary, rung.args, bytes, timeoutMs);
      const pages = splitBinaryPages(output);
      if (pages.join("").trim().length >= MIN_USEFUL_CHARS) return { extractor: rung.extractor, pages };
      attempted.push(`${rung.extractor}:empty`);
    } catch (error) {
      attempted.push(`${rung.extractor}:failed(${error instanceof Error ? error.name : "error"})`);
    }
  }
  return null;
}

/**
 * `pdftotext` and `mutool` emit a form feed between pages (pdftotext always,
 * mutool usually). Splitting on it gives us the same page shape as the in-tree
 * parser without inventing a page count.
 */
function splitBinaryPages(output: string): string[] {
  const pages = output.split(/\f/);
  if (pages.length > 1 && (pages[pages.length - 1] ?? "").trim() === "") pages.pop();
  return pages.map((page) => page.replace(/\r\n/g, "\n").trim());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function extractPdfText(bytes: Buffer, options: PdfExtractOptions = {}): Promise<PdfExtractResult> {
  if (options.signal?.aborted === true) {
    throw fail("E_CANCELLED", "extract", { message: "PDF extraction was aborted by the caller" });
  }
  if (bytes.length === 0) {
    throw pdfFailure("E_PDF_UNSUPPORTED", "the PDF response was empty");
  }
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw pdfFailure("E_PDF_UNSUPPORTED", "the response is not a PDF (no %PDF- header)");
  }
  const pageMaxChars = Number.isFinite(options.pageMaxChars)
    ? Math.max(1, Math.floor(options.pageMaxChars as number))
    : DEFAULT_PAGE_MAX_CHARS;
  const attempted: string[] = [];

  let pages: string[] = [];
  let hasImage = false;
  let pageCount = 0;
  try {
    const inTree = parseInTree(bytes, pageMaxChars);
    pages = inTree.pages;
    hasImage = inTree.hasImage;
    pageCount = inTree.pageCount;
    if (pages.join("").trim().length >= MIN_USEFUL_CHARS) {
      return finish("in-tree", pages, pageCount, pageMaxChars, attempted);
    }
    attempted.push("in-tree:empty");
  } catch (error) {
    attempted.push(`in-tree:failed(${error instanceof Error ? error.name : "error"})`);
  }

  const fallback = await runLadder(bytes, options, attempted);
  if (fallback !== null) {
    const capped = fallback.pages.map((page) =>
      page.length > pageMaxChars ? `${page.slice(0, pageMaxChars)}\n[…]` : page,
    );
    return finish(fallback.extractor, capped, capped.length, pageMaxChars, attempted);
  }

  if (hasImage) {
    throw pdfFailure(
      "E_PDF_SCANNED",
      "the PDF has image-only pages and no text layer; OCR is out of scope (attempted " +
        `${attempted.join(", ") || "in-tree"})`,
    );
  }
  throw pdfFailure(
    "E_PDF_UNSUPPORTED",
    `no extractor produced text (attempted ${attempted.join(", ") || "in-tree"}); the PDF may use a ` +
      "compressed font encoding without a ToUnicode map",
  );
}

function finish(
  extractor: PdfExtractor,
  pages: string[],
  pageCount: number,
  pageMaxChars: number,
  attempted: string[],
): PdfExtractResult {
  const truncatedPages = pages.filter((page) => page.length > pageMaxChars || page.endsWith("\n[…]")).length;
  return {
    pages,
    pageCount: Math.max(pageCount, pages.length),
    extractor,
    chars: pages.join("").length,
    truncatedPages,
    attempted: [...attempted],
  };
}

function pdfFailure(code: ErrorCode, message: string): WebSearchErrorLike {
  const hint =
    code === "E_PDF_SCANNED"
      ? "the document is a scan; open it in the browser or find an HTML/text version with the same content"
      : "try the HTML version of the document, or install pdftotext (poppler) as an optional fallback";
  return fail(code, "extract", { message, hint });
}

/** Structural type so this module does not import the class just for a return type. */
interface WebSearchErrorLike {
  readonly details: { code: ErrorCode; stage: string; hint: string; retryable: boolean };
}

/**
 * Render pages with `--- p.N ---` markers and one caller window. Markers are
 * part of the text on purpose: a reader (human or agent) can cite a page, and
 * the offset contract keeps working across pages.
 */
export function renderPdfWindow(
  result: PdfExtractResult,
  window: { offset?: number; maxChars: number },
): PdfWindow {
  const full = result.pages
    .map((page, index) => `--- p.${index + 1} ---\n${page.trim()}`)
    .join("\n\n")
    .trimEnd();
  const totalChars = full.length;
  const offset = window.offset ?? 0;
  const maxChars = Math.max(1, window.maxChars);
  const start = Math.min(offset, totalChars);
  const end = Math.min(start + maxChars, totalChars);
  const text = full.slice(start, end);
  const truncated = end < totalChars;
  return {
    text,
    chars: text.length,
    totalChars,
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
    pageCount: result.pageCount,
  };
}
