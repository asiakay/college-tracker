import { describe, expect, it } from "vitest";
import { DocError, extractDocument } from "../src/docs";
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
    expect(doc.links).toEqual([
      "https://www.slideshare.net/mrmularella/scientific-method-95777",
      "https://www.khanacademy.org/science/v/the-scientific-method",
    ]);
  });

  it("passes PDFs through and strips HTML", async () => {
    const pdf = await extractDocument(new Uint8Array([37, 80, 68, 70]), "application/pdf", "hw.pdf");
    expect(pdf.kind).toBe("pdf");
    const html = await extractDocument(new TextEncoder().encode(`<p>Watch <a href="https://x.edu/v">this</a></p><script>bad()</script>`), "text/html", "p.html");
    expect(html).toEqual({ kind: "text", text: "Watch this (https://x.edu/v)", links: ["https://x.edu/v"] });
  });

  it("rejects files it can't read", async () => {
    await expect(extractDocument(new TextEncoder().encode("not a zip"), DOCX, "x.docx")).rejects.toBeInstanceOf(DocError);
    await expect(extractDocument(await makeZip({ "a.txt": "hi" }), DOCX, "x.docx")).rejects.toThrow("Not a valid .docx file");
    await expect(extractDocument(new Uint8Array([1, 2]), "image/png", "x.png")).rejects.toBeInstanceOf(DocError);
  });
});
