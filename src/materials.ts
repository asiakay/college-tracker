/**
 * Links inside an assignment's linked Canvas module file (slides, videos, …),
 * saved so they can be shown as Materials without re-reading the file.
 */

import { CanvasError, type CanvasClient } from "./canvas/client";
import { DocError, extractDocument, type LinkItem } from "./docs";

/** The Canvas file id in a download URL we built (`<origin>/courses/<c>/files/<id>/download…`). */
export function fileIdFromDownloadUrl(origin: string, downloadUrl: string | null): string | null {
  if (!downloadUrl) return null;
  const o = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Canvas ids may be sharded ("123~456"), as CANVAS_ID accepts in the routes.
  return downloadUrl.match(new RegExp(`^${o}/courses/\\d+(?:~\\d+)?/files/(\\d+(?:~\\d+)?)/download`))?.[1] ?? null;
}

/** Replaces the saved links; false before migration 0015. */
export async function saveMaterialLinks(db: D1Database, assignmentId: string, items: LinkItem[]): Promise<boolean> {
  try {
    await db.batch([
      db.prepare(`DELETE FROM canvas_material_links WHERE assignment_id = ?`).bind(assignmentId),
      ...items.map((l, i) => db.prepare(
        `INSERT OR IGNORE INTO canvas_material_links (assignment_id, position, url, label) VALUES (?, ?, ?, ?)`,
      ).bind(assignmentId, i + 1, l.url, l.label)),
      db.prepare(`UPDATE canvas_materials SET links_read_at = ? WHERE assignment_id = ?`).bind(new Date().toISOString(), assignmentId),
    ]);
    return true;
  } catch (e) {
    if (e instanceof Error && /no such (table: canvas_material_links|column: links_read_at)|no column named links_read_at/.test(e.message)) return false;
    throw e;
  }
}

/** Forgets the saved links (e.g. the linked item changed); no-op before migration 0015. */
export async function clearMaterialLinks(db: D1Database, assignmentId: string): Promise<void> {
  try {
    await db.batch([
      db.prepare(`DELETE FROM canvas_material_links WHERE assignment_id = ?`).bind(assignmentId),
      db.prepare(`UPDATE canvas_materials SET links_read_at = NULL WHERE assignment_id = ?`).bind(assignmentId),
    ]);
  } catch (e) {
    if (!(e instanceof Error && /no such (table: canvas_material_links|column: links_read_at)/.test(e.message))) throw e;
  }
}

/** Reads the linked file from Canvas (read-only) and saves the links in it. */
export async function readMaterialLinks(
  db: D1Database, client: CanvasClient, origin: string, assignmentId: string,
): Promise<{ links: LinkItem[] } | { error: string; status: number }> {
  let material: { download_url: string | null } | null;
  try {
    material = await db.prepare(`SELECT download_url FROM canvas_materials WHERE assignment_id = ?`)
      .bind(assignmentId).first<{ download_url: string | null }>();
  } catch (e) {
    if (e instanceof Error && /no such (table|column)/.test(e.message)) material = null;
    else throw e;
  }
  if (!material) return { error: "Link a Canvas module file to this assignment first", status: 422 };

  const fileId = fileIdFromDownloadUrl(origin, material.download_url);
  if (!fileId) {
    await saveMaterialLinks(db, assignmentId, []); // a page or link item: nothing to read
    return { links: [] };
  }
  try {
    const file = await client.downloadFile(fileId);
    const doc = await extractDocument(file.bytes, file.contentType, file.name);
    await saveMaterialLinks(db, assignmentId, doc.linkItems);
    return { links: doc.linkItems };
  } catch (e) {
    if (e instanceof DocError) return { error: e.message, status: 422 };
    if (e instanceof CanvasError) return { error: e.message, status: e.kind === "not_found" ? 404 : 502 };
    throw e;
  }
}
