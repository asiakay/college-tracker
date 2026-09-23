/** Builds a minimal .docx (zip of deflated XML) for tests. CRCs are left 0; the reader ignores them. */

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const buf = await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
  return new Uint8Array(buf);
}

export async function makeZip(files: Record<string, string>): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(content);
    const data = await deflateRaw(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, 8, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(10, 8, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, Object.keys(files).length, true);
  eocd.setUint16(10, Object.keys(files).length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

/** A docx shaped like the SCI151 lecture homework file. */
export function lectureHomeworkDocx(): Promise<Uint8Array> {
  const p = (inner: string) => `<w:p><w:pPr><w:jc w:val="left"/></w:pPr>${inner}</w:p>`;
  const r = (t: string) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${p(r("Lecture #1 (Homework #1) Questions Due 2/9/26"))}
${p(r("Review Lecture Slides Scientific Method (13 Slides Total)"))}
${p(`<w:hyperlink r:id="rId5" w:history="1">${r("Slides")}</w:hyperlink>`)}
${p(r("Review Scientific Method Video (11:48 Total) https://www.khanacademy.org/science/v/the-scientific-method"))}
${p(r("Answer worksheet page 3 &amp; 4 (22 Questions Total)") + `<w:r><w:tab/></w:r>` + r("then upload"))}
${p(`<w:r><w:br w:type="page"/></w:r>` + r("Scientific Method Worksheet"))}
</w:body></w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Target="https://www.slideshare.net/mrmularella/scientific-method-95777" TargetMode="External" Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"/>
</Relationships>`;
  return makeZip({ "[Content_Types].xml": "<Types/>", "word/document.xml": document, "word/_rels/document.xml.rels": rels });
}
