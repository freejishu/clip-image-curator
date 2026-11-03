import path from 'node:path';
import PQueue from 'p-queue';
import { db } from '../db.js';
import { getSource } from '../sources/index.js';
import type { FetchOpts, ImageMeta } from '../sources/types.js';
import { storage } from '../storage/backend.js';
import { loadModel, scoreUnscored, predictExternal } from '../ml/classifier.js';
import { embedImageBuffer } from '../ml/embed.js';
import { zeroshotScoreAll } from '../ml/zeroshot.js';
import { config } from '../config.js';
import { ruleFor, ruleFingerprint } from './transform.js';

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
// 新下载的图在入库时已按当前规则处理过，记录指纹避免存量批处理二次压缩
const markProcessedStmt = db.prepare('UPDATE images SET imgproc = ? WHERE source = ? AND source_id = ?');

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
    mode: string; threshold: number;
  } | undefined;
  if (!row) throw new Error(`任务不存在: ${taskId}`);
  if (running.has(taskId)) return; // 已在运行：resume 连点/旧实例未退出时不得再起并发实例（否则旧实例退出会误删新实例状态）

  const state = { paused: false };
  running.set(taskId, state);
  // 代理回落到当前配置：老任务（proxy 存了 NULL）resume 时也能吃到新配置里的默认代理，而不是永久直连
  const proxy = row.proxy || config.sources[row.source]?.proxy || config.proxy || null;
  const opts: FetchOpts = { proxy, shouldContinue: () => !state.paused };
  const query = JSON.parse(row.query) as { tags: string[]; limit: number; skip?: number; kind?: string; target?: string; sort?: string };
  const plugin = getSource(row.source);
  const isFilter = row.mode === 'filter';
  const queue = new PQueue({ concurrency: 3, interval: 1000, intervalCap: 2 }); // 礼貌限速

  const touch = (fields: string, ...vals: (string | number)[]) =>
    db.prepare(`UPDATE tasks SET ${fields}, updated_at = datetime('now') WHERE id = ?`).run(...vals, taskId);

  /** 过滤模式：下载→embedding→模型预测→达标才入库，不达标留 local_path=NULL 行 */
  const processFiltered = async (meta: ImageMeta): Promise<void> => {
    const filename = `${meta.source}_${meta.sourceId.replace(':', '_')}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (state.paused) return;
      try {
        const buf = await plugin.fetchImage(meta, opts);
        // embedding 先于顶层 sharp（libvips 加载顺序坑：先 embed 后 sharp 可共存，反向会炸）
        const vec = await embedImageBuffer(buf);
        const pred = predictExternal(vec);
        if (!pred) throw new Error('无已训练模型，过滤模式不可用');
        if (pred.score >= row.threshold) {
          // 达标：正式入库 + 直接写入本次算出的分数
          const localPath = await storage.saveIncoming(buf, filename + extOf(meta.fileUrl, buf));
          setLocalPathStmt.run(localPath, meta.source, meta.sourceId);
          markProcessedStmt.run(ruleFingerprint(ruleFor(config.storage.type ?? 'local')), meta.source, meta.sourceId);
          db.prepare('UPDATE images SET pred_score = ?, pred_version = ?, embedding = ? WHERE source = ? AND source_id = ?')
            .run(pred.score, pred.version, Buffer.from(vec.buffer), meta.source, meta.sourceId);
          touch('downloaded = downloaded + 1');
        } else {
          // 不达标：只留元数据行（local_path=NULL），不重复下载
          touch('filtered_out = filtered_out + 1');
        }
        return;
      } catch (e) {
        if (attempt === 2) {
          console.warn(`[task ${taskId}] 过滤模式处理失败 ${filename}: ${e instanceof Error ? e.message : e}`);
          throw e;
        }
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  };

  /** 全扫模式（原有逻辑）：下载即入库 */
  const processFull = async (meta: ImageMeta): Promise<void> => {
    let filename = `${meta.source}_${meta.sourceId}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (state.paused) return; // 重试中途被暂停也要立即停
      try {
        const buf = await plugin.fetchImage(meta, opts); const file = filename + extOf(meta.fileUrl, buf);
        const localPath = await storage.saveIncoming(buf, file);
        setLocalPathStmt.run(localPath, meta.source, meta.sourceId);
        markProcessedStmt.run(ruleFingerprint(ruleFor(config.storage.type ?? 'local')), meta.source, meta.sourceId);
        touch('downloaded = downloaded + 1');
        return;
      } catch (e) {
        if (attempt === 2) {
          console.warn(`[task ${taskId}] 下载失败 ${filename}: ${e instanceof Error ? e.message : e}`); // 不再静默吞错，失败必须可见
          throw new Error(`下载失败: ${filename}`);
        }
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  };

  try {
    for await (const batch of plugin.search({ tags: query.tags, limit: query.limit, skip: query.skip, kind: query.kind as never, target: query.target, sort: query.sort as never }, opts)) {
      if (state.paused) { touch(`status = 'paused', finished_at = datetime('now')`); return; }
      touch('seen = seen + ?', batch.length);
      let added = 0;
      for (const meta of batch) {
        const inserted = insertImage(meta);
        if (inserted) added++;
        if (inserted || missingFile(meta)) { // 新图 + 历史缺文件图都补下载（过滤模式跳过已过滤图）
          // 过滤模式下 local_path IS NULL 的行 = 已过滤废图，不重复下载
          if (isFilter && !inserted && missingFile(meta)) continue;
          void queue.add(async () => {
            if (state.paused) return;
            if (isFilter) await processFiltered(meta);
            else await processFull(meta);
          }).catch(() => {/* 单张失败不拖垮任务 */});
        }
      }
      touch('fetched = fetched + ?', added);
    }
    await queue.onIdle();
    // 只有「自己仍是登记在册的实例」才落终态：旧实例退出不得覆盖新实例的 running 状态
    if (running.get(taskId) === state) {
      touch(`status = '${state.paused ? 'paused' : 'done'}', finished_at = datetime('now')`);
      // 新图自动打分：有已训练模型→按模型预测；无模型→zero-shot 粗筛
      if (!state.paused) {
        try {
          const n = loadModel() ? await scoreUnscored() : await zeroshotScoreAll(200);
          if (n > 0) console.log(`任务 ${taskId} 完成，自动打分 ${n} 张新图`);
        } catch (e) { console.warn(`任务 ${taskId} 自动打分失败:`, e instanceof Error ? e.message : e); }
      }
    }
  } catch (err) {
    touch(`status = 'error', finished_at = datetime('now'), error = ?`, err instanceof Error ? err.message : String(err));
  } finally {
    if (running.get(taskId) === state) running.delete(taskId); // 只删自己，防旧实例误删新实例
  }
}

export function pauseTask(taskId: number): boolean {
  const state = running.get(taskId);
  if (state) state.paused = true;
  // 立即落库：UI 马上翻转为「继续」（后台排空在途下载是异步的，但不接受新工作了）；
  // 不在 running 表里的 running 残留行也借此自愈
  const r = db.prepare(`UPDATE tasks SET status = 'paused', finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'running'`).run(taskId);
  return !!state || Number(r.changes) > 0;
}

export function resumeTask(taskId: number): void {
  // finished_at 清空：续跑期间耗时继续累计，到终态再落定；同时清掉上一轮残留的 error 文案
  db.prepare(`UPDATE tasks SET status = 'running', finished_at = NULL, error = NULL, updated_at = datetime('now') WHERE id = ?`).run(taskId);
  void startTask(taskId);
}
