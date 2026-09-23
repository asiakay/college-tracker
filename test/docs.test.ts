import { describe, expect, it } from "vitest";
import { DocError, extractDocument, pdfLinks } from "../src/docs";
import { lectureHomeworkDocx, makeZip } from "./docx";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("extractDocument", () => {
  it("reads docx paragraphs, tabs, page breaks and hyperlinks", async () => {
    const doc = await extractDocument(await lectureHomeworkDocx(), DOCX, "SCI151Lecture#1&HW#1.docx");
    expect(doc.kind).toBe("text");
    if (doc.kind !== "text") return;
    expect(doc.text).toContain("Review Lecture Slides Scientific Method (13 Slides Total)");
    expect(doc.text).toContain("Slides (https://www.slideshare.net/mrmularella/scientific-method-95777)");
    expect(doc.text).toContain("Answer worksheet page 3 & 4 (22 Questions Total)\tthen upload");
    expect(doc.text).toContain("[page break]\nScientific Method Worksheet");
    expect(doc.linkItems).toEqual([
      { url: "https://www.slideshare.net/mrmularella/scientific-method-95777", label: "Slides" },
      { url: "https://www.khanacademy.org/science/v/the-scientific-method", label: "Review Scientific Method Video (11:48 Total)" },
    ]);
    expect(doc.links).toEqual([
      "https://www.slideshare.net/mrmularella/scientific-method-95777",
      "https://www.khanacademy.org/science/v/the-scientific-method",
    ]);
  });

  it("passes PDFs through and strips HTML", async () => {
    const pdf = await extractDocument(new Uint8Array([37, 80, 68, 70]), "application/pdf", "hw.pdf");
    expect(pdf.kind).toBe("pdf");
    const html = await extractDocument(new TextEncoder().encode(`<p>Watch <a href="https://x.edu/v">this</a></p><script>bad()</script>`), "text/html", "p.html");
    expect(html).toEqual({
      kind: "text", text: "Watch this (https://x.edu/v)", links: ["https://x.edu/v"],
      linkItems: [{ url: "https://x.edu/v", label: "Watch this" }],
    });
  });

  it("finds links in PDF annotations and compressed streams", async () => {
    const enc = new TextEncoder();
    const packed = new Uint8Array(await new Response(
      new Blob([enc.encode("BT (Watch https://www.khanacademy.org/v/sci) Tj ET")]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer());
    const parts = [
      enc.encode("%PDF-1.4\n1 0 obj << /Type /Annot /Subtype /Link /A << /S /URI /URI (https://slides.example/sci\\(1\\)) >> >> endobj\n"),
      enc.encode(`2 0 obj << /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`), packed, enc.encode("\nendstream endobj\n%%EOF"),
    ];
    const pdf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { pdf.set(p, o); o += p.length; }
    expect(await pdfLinks(pdf)).toEqual(expect.arrayContaining(["https://slides.example/sci(1)", "https://www.khanacademy.org/v/sci"]));
    expect((await extractDocument(pdf, "application/pdf", "hw.pdf")).links).toContain("https://www.khanacademy.org/v/sci");
  });

  it("decodes HTML entities in links", async () => {
    const html = await extractDocument(new TextEncoder().encode(`<p><a href="https://v.example/watch?a=1&amp;b=2">Video</a></p>`), "text/html", "p.html");
    expect(html.links).toEqual(["https://v.example/watch?a=1&b=2"]);
    expect(html.linkItems).toEqual([{ url: "https://v.example/watch?a=1&b=2", label: "Video" }]);
  });

  it("labels links from their own text, the line above, or the host", async () => {
    const { labelLinks } = await import("../src/docs");
    const text = "Slides: Week 1 deck (https://a.example/1)\n\n• Watch the demo video:\nhttps://b.example/2\nhttps://c.example/3";
    expect(labelLinks(text, ["https://c.example/3", "https://a.example/1", "https://b.example/2", "https://www.d.example/4"])).toEqual([
      { url: "https://a.example/1", label: "Slides: Week 1 deck" },
      { url: "https://b.example/2", label: "Watch the demo video" },
      { url: "https://c.example/3", label: "Watch the demo video" },
      { url: "https://www.d.example/4", label: "d.example" },
    ]);
    const many = Array.from({ length: 25 }, (_, i) => `https://e.example/${i}`);
    expect(labelLinks(many.join("\n"), many)).toHaveLength(20);
  });

  it("rejects files it can't read", async () => {
    await expect(extractDocument(new TextEncoder().encode("not a zip"), DOCX, "x.docx")).rejects.toBeInstanceOf(DocError);
    await expect(extractDocument(await makeZip({ "a.txt": "hi" }), DOCX, "x.docx")).rejects.toThrow("Not a valid .docx file");
    await expect(extractDocument(new Uint8Array([1, 2]), "image/png", "x.png")).rejects.toBeInstanceOf(DocError);
  });
});
