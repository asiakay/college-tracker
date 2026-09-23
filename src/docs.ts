/**
 * Text and links from an assignment's instruction file, without a library:
 * .docx (a zip of XML, inflated with DecompressionStream), PDF (passed through
 * for Claude to read), and plain text / HTML.
 */

export const MAX_TEXT_CHARS = 40_000;
const MAX_ENTRY_BYTES = 20_000_000;

export interface LinkItem { url: string; label: string }

export type ExtractedDoc =
  | { kind: "text"; text: string; links: string[]; linkItems: LinkItem[] }
  | { kind: "pdf"; bytes: Uint8Array; links: string[]; linkItems: LinkItem[] };

const MAX_LINK_ITEMS = 20;
const MAX_LABEL = 60;

function hostLabel(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Link"; }
}

function cleanLabel(s: string): string {
  const t = s.replace(/\s+/g, " ").replace(/^[\s•\-–*·>]+|[\s:–-]+$/g, "").trim();
  return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1).trimEnd()}…` : t;
}

/**
 * Each link with a readable label, in document order: the text written just
 * before it on its line ("Watch this (url)"), else the nearest line above it
 * ("Review Scientific Method Video (11:48 Total)" then the URL on its own line),
 * else the host name. Links not in the text come last.
 */
export function labelLinks(text: string, links: string[]): LinkItem[] {
  const lines = text.split("\n");
  const found: Array<{ at: number; item: LinkItem }> = [];
  for (const url of links) {
    const at = text.indexOf(url);
    let label = "";
    if (at >= 0) {
      const lineNo = text.slice(0, at).split("\n").length - 1;
      const before = (lines[lineNo] ?? "").slice(0, at - text.lastIndexOf("\n", at - 1) - 1).replace(/\(\s*$/, "");
      label = cleanLabel(before);
      for (let i = lineNo - 1; !label && i >= 0 && i >= lineNo - 3; i--) {
        const prev = (lines[i] ?? "").trim();
        if (prev && !/^https?:\/\//.test(prev)) label = cleanLabel(prev);
      }
    }
    found.push({ at: at >= 0 ? at : Number.MAX_SAFE_INTEGER, item: { url, label: label || hostLabel(url) } });
  }
  return found.sort((a, b) => a.at - b.at).slice(0, MAX_LINK_ITEMS).map((f) => f.item);
}

export class DocError extends Error {}

// ── Zip ──────────────────────────────────────────────────────────────────────

function u16(b: Uint8Array, o: number): number { return b[o]! | (b[o + 1]! << 8); }
function u32(b: Uint8Array, o: number): number { return (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0; }

async function inflateRaw(data: Uint8Array, limit: number, format: "deflate" | "deflate-raw" = "deflate-raw"): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new DocError("File is too large to read"); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

/** The named entries of a zip archive, decompressed. Missing names are simply absent. */
export async function readZipEntries(zip: Uint8Array, names: string[]): Promise<Map<string, Uint8Array>> {
  // End of central directory: the last "PK\x05\x06" within the final 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (u32(zip, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new DocError("Not a valid .docx file");
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  const wanted = new Set(names);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (u32(zip, p) !== 0x02014b50) throw new DocError("Not a valid .docx file");
    const method = u16(zip, p + 10);
    const compSize = u32(zip, p + 20);
    const size = u32(zip, p + 24);
    const nameLen = u16(zip, p + 28);
    const next = p + 46 + nameLen + u16(zip, p + 30) + u16(zip, p + 32);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    const local = u32(zip, p + 42);
    p = next;
    if (!wanted.has(name)) continue;
    if (u32(zip, local) !== 0x04034b50) throw new DocError("Not a valid .docx file");
    const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    const data = zip.subarray(start, start + compSize);
    if (size > MAX_ENTRY_BYTES) throw new DocError("File is too large to read");
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, await inflateRaw(data, MAX_ENTRY_BYTES));
    else throw new DocError("Unsupported .docx compression");
  }
  return out;
}

// ── XML helpers ──────────────────────────────────────────────────────────────

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`));
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
}

const URL_RE = /https?:\/\/[^\s<>"'()\\]+[^\s<>"'().,;:!?\\]/g;

function httpUrl(s: string): string | null {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch { return null; }
}

function collectLinks(...sources: string[]): string[] {
  const out = new Set<string>();
  for (const s of sources) for (const m of s.matchAll(URL_RE)) { const u = httpUrl(m[0]); if (u) out.add(u); }
  return [...out];
}

// ── PDF ──────────────────────────────────────────────────────────────────────

const MAX_PDF_STREAMS = 300;
const MAX_PDF_INFLATED = 10_000_000;

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

/**
 * URLs in a PDF: link annotations (/URI (...)) and URLs written out in the
 * file, including inside Flate-compressed streams. Claude reads the PDF itself;
 * this only tells us which links really are in it. Text drawn with custom font
 * encodings can't be seen here, so a link shown only as text may be missed.
 */
export async function pdfLinks(bytes: Uint8Array): Promise<string[]> {
  const raw = latin1(bytes);
  const texts = [raw];
  let inflated = 0;
  let streams = 0;
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    if (++streams > MAX_PDF_STREAMS || inflated > MAX_PDF_INFLATED) break;
    const start = m.index! + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const header = raw.slice(Math.max(0, m.index! - 300), m.index!);
    if (!/\/FlateDecode/.test(header)) continue;
    // Use /Length when it is a direct number; otherwise drop the EOL before "endstream".
    const length = Number([...header.matchAll(/\/Length\s+(\d+)(?!\s+\d+\s+R)/g)].pop()?.[1]);
    let stop = end;
    if (Number.isInteger(length) && start + length <= end) stop = start + length;
    else while (stop > start && (raw[stop - 1] === "\n" || raw[stop - 1] === "\r")) stop--;
    try {
      const out = await inflateRaw(bytes.subarray(start, stop), MAX_PDF_INFLATED - inflated, "deflate");
      inflated += out.byteLength;
      texts.push(latin1(out));
    } catch { /* truncated or not really Flate — skip */ }
  }
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/\/URI\s*\(((?:\\.|[^\\)])*)\)/g)) {
      const u = httpUrl(m[1]!.replace(/\\([()\\])/g, "$1"));
      if (u) out.add(u);
    }
  }
  for (const u of collectLinks(...texts)) out.add(u);
  return [...out];
}

// ── docx ─────────────────────────────────────────────────────────────────────

/** Paragraph text of word/document.xml, with hyperlinks written as "text (url)". */
export function docxText(documentXml: string, relsXml: string): { text: string; links: string[] } {
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    const url = target ? httpUrl(target) : null;
    if (id && url) rels.set(id, url);
  }

  let text = "";
  let inText = false;
  let inInstr = false;
  let instr = "";
  const linkStack: Array<string | null> = [];
  const tokens = /<(\/?)(w:p|w:hyperlink|w:t|w:instrText|w:tab|w:br|w:cr)\b([^>]*?)(\/?)>|<[^>]+>|([^<]+)/g;
  for (const m of documentXml.matchAll(tokens)) {
    const [, close, tag, attrs, selfClose, chars] = m;
    if (chars !== undefined) {
      if (inText) text += decodeEntities(chars);
      else if (inInstr) instr += ` ${decodeEntities(chars)}`;
      continue;
    }
    if (!tag) continue;
    if (tag === "w:t") inText = !close && !selfClose;
    else if (tag === "w:instrText") inInstr = !close && !selfClose;
    else if (tag === "w:tab" && !close) text += "\t";
    else if ((tag === "w:br" || tag === "w:cr") && !close) text += /w:type\s*=\s*"page"/.test(attrs ?? "") ? "\n[page break]\n" : "\n";
    else if (tag === "w:p" && close) text += "\n";
    else if (tag === "w:hyperlink" && !selfClose) {
      if (!close) linkStack.push(rels.get(attr(` ${attrs}`, "r:id") ?? "") ?? null);
      else {
        const url = linkStack.pop();
        if (url && !text.includes(url)) text += ` (${url})`;
      }
    }
  }
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const links = [...new Set([...rels.values(), ...collectLinks(text, instr)])];
  return { text, links };
}

function stripHtml(html: string): string {
  return decodeEntities(
    html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
      .replace(/<(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[…truncated]` : text;
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Reads a downloaded instruction file. Throws DocError for formats it can't read. */
export async function extractDocument(bytes: Uint8Array, contentType: string, name: string): Promise<ExtractedDoc> {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const lower = name.toLowerCase();
  const isZip = bytes.length > 4 && u32(bytes, 0) === 0x04034b50;
  if (type === DOCX || lower.endsWith(".docx") || (isZip && type === "application/octet-stream")) {
    if (!isZip) throw new DocError("Not a valid .docx file");
    const entries = await readZipEntries(bytes, ["word/document.xml", "word/_rels/document.xml.rels"]);
    const doc = entries.get("word/document.xml");
    if (!doc) throw new DocError("Not a valid .docx file");
    const dec = new TextDecoder();
    const { text, links } = docxText(dec.decode(doc), dec.decode(entries.get("word/_rels/document.xml.rels") ?? new Uint8Array()));
    return { kind: "text", text: truncate(text), links, linkItems: labelLinks(text, links) };
  }
  if (type === "application/pdf" || lower.endsWith(".pdf")) {
    const links = await pdfLinks(bytes);
    return { kind: "pdf", bytes, links, linkItems: labelLinks("", links) };
  }
  if (type.startsWith("text/") || /\.(txt|md|html?)$/.test(lower)) {
    const raw = new TextDecoder().decode(bytes);
    const text = type === "text/html" || /\.html?$/.test(lower) ? stripHtml(raw) : raw;
    const links = collectLinks(raw);
    return { kind: "text", text: truncate(text), links, linkItems: labelLinks(text, links) };
  }
  throw new DocError(`Can't read ${name || "this file"} — link a .docx, PDF or text file`);
}
