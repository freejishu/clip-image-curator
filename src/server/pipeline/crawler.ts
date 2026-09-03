import path from 'node:path';
import PQueue from 'p-queue';
import { db } from '../db.js';
import { getSource } from '../sources/index.js';
import type { FetchOpts, ImageMeta } from '../sources/types.js';
import { storage } from '../storage/backend.js';

const running = new Map<number, { paused: boolean }>();

function extOf(url: string, buf?: Buffer): string {
  if (buf && buf.length > 4) {
    if (buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp';
    if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
    if (buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
    if (buf[0] === 0x52 && buf[1] === 0x49) return '.webp';
  }
  const m = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|bmp)$/i);
  return m ? m[0].toLowerCase() : '.jpg';
}

function insertImage(meta: ImageMeta): boolean {
  const r = db.prepare(`
    INSERT OR IGNORE INTO images (source, source_id, page_url, file_url, preview_url, tags, width, height, rating)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    meta.source, meta.sourceId, meta.pageUrl, meta.fileUrl, meta.previewUrl ?? null,
    JSON.stringify(meta.tags), meta.width ?? null, meta.height ?? null, meta.rating ?? null,
  );
  return Number(r.changes) > 0;
}

export async function startTask(taskId: number): Promise<void> {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
    source: string; query: string; proxy: string | null; target: number;
  } | undefined;
  if (!row) throw new Error(`任务不存在: ${taskId}`);

  const state = { paused: false };
  running.set(taskId, state);
  const opts: FetchOpts = { proxy: row.proxy, shouldContinue: () => !state.paused };
  const query = JSON.parse(row.query) as { tags: string[]; limit: number };
  const plugin = getSource(row.source);
  const queue = new PQueue({ concurrency: 3, interval: 1000, intervalCap: 2 }); // 礼貌限速

  const touch = (fields: string, ...vals: (string | number)[]) =>
    db.prepare(`UPDATE tasks SET ${fields}, updated_at = datetime('now') WHERE id = ?`).run(...vals, taskId);

  try {
    for await (const batch of plugin.search({ tags: query.tags, limit: query.limit }, opts)) {
      if (state.paused) { touch(`status = 'paused'`); return; }
      let added = 0;
      for (const meta of batch) {
        if (insertImage(meta)) {
          added++;
          void queue.add(async () => {
            if (state.paused) return;
            let filename = `${meta.source}_${meta.sourceId}`;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const buf = await plugin.fetchImage(meta, opts); const file = filename + extOf(meta.fileUrl, buf);
                const localPath = await storage.saveIncoming(buf, file);
                db.prepare('UPDATE images SET local_path = ? WHERE source = ? AND source_id = ?')
                  .run(localPath, meta.source, meta.sourceId);
                touch('downloaded = downloaded + 1');
                return;
              } catch {
                if (attempt === 2) throw new Error(`下载失败: ${filename}`);
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
              }
            }
          }).catch(() => {/* 单张失败不拖垮任务 */});
        }
      }
      touch('fetched = fetched + ?', added);
    }
    await queue.onIdle();
    touch(`status = '${state.paused ? 'paused' : 'done'}'`);
  } catch (err) {
    touch(`status = 'error', error = ?`, err instanceof Error ? err.message : String(err));
  } finally {
    running.delete(taskId);
  }
}

export function pauseTask(taskId: number): boolean {
  const state = running.get(taskId);
  if (!state) return false;
  state.paused = true;
  return true;
}

export function resumeTask(taskId: number): void {
  db.prepare(`UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ?`).run(taskId);
  void startTask(taskId);
}
