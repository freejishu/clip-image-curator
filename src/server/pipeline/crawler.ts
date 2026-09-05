import path from 'node:path';
import PQueue from 'p-queue';
import { db } from '../db.js';
import { getSource } from '../sources/index.js';
import type { FetchOpts, ImageMeta } from '../sources/types.js';
import { storage } from '../storage/backend.js';
import { loadModel, scoreUnscored } from '../ml/classifier.js';
import { zeroshotScoreAll } from '../ml/zeroshot.js';

const running = new Map<number, { paused: boolean }>();

export function extOf(url: string, buf?: Buffer): string {
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

// 预编译语句：抓取热循环里每条 meta 都会用到，避免反复 prepare
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO images (source, source_id, page_url, file_url, preview_url, tags, width, height, rating, parent_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const localPathStmt = db.prepare('SELECT local_path FROM images WHERE source = ? AND source_id = ?');
const setLocalPathStmt = db.prepare('UPDATE images SET local_path = ? WHERE source = ? AND source_id = ?');

function insertImage(meta: ImageMeta): boolean {
  const r = insertStmt.run(
    meta.source, meta.sourceId, meta.pageUrl, meta.fileUrl, meta.previewUrl ?? null,
    JSON.stringify(meta.tags), meta.width ?? null, meta.height ?? null, meta.rating ?? null, meta.parentId ?? null,
  );
  return Number(r.changes) > 0;
}

/** 已入库但文件缺失（上次暂停/下载失败留下的）→ 本次任务应补下载 */
function missingFile(meta: ImageMeta): boolean {
  const r = localPathStmt.get(meta.source, meta.sourceId) as { local_path: string | null } | undefined;
  return !!r && r.local_path == null;
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
      if (state.paused) { touch(`status = 'paused', finished_at = datetime('now')`); return; }
      touch('seen = seen + ?', batch.length);
      let added = 0;
      for (const meta of batch) {
        const inserted = insertImage(meta);
        if (inserted) added++;
        if (inserted || missingFile(meta)) { // 新图 + 历史缺文件图都补下载
          void queue.add(async () => {
            if (state.paused) return;
            let filename = `${meta.source}_${meta.sourceId}`;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const buf = await plugin.fetchImage(meta, opts); const file = filename + extOf(meta.fileUrl, buf);
                const localPath = await storage.saveIncoming(buf, file);
                setLocalPathStmt.run(localPath, meta.source, meta.sourceId);
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
    touch(`status = '${state.paused ? 'paused' : 'done'}', finished_at = datetime('now')`);
    // 新图自动打分：有已训练模型→按模型预测；无模型→zero-shot 粗筛
    if (!state.paused) {
      try {
        const n = loadModel() ? await scoreUnscored() : await zeroshotScoreAll(200);
        if (n > 0) console.log(`任务 ${taskId} 完成，自动打分 ${n} 张新图`);
      } catch (e) { console.warn(`任务 ${taskId} 自动打分失败:`, e instanceof Error ? e.message : e); }
    }
  } catch (err) {
    touch(`status = 'error', finished_at = datetime('now'), error = ?`, err instanceof Error ? err.message : String(err));
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
  // finished_at 清空：续跑期间耗时继续累计，到终态再落定
  db.prepare(`UPDATE tasks SET status = 'running', finished_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(taskId);
  void startTask(taskId);
}
