import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { processImage, ruleFor, ruleFingerprint } from './transform.js';
import { resolveStoredPath, toStoredPath, storage, resolveArchiveFolder } from '../storage/backend.js';

export const reprocessState = {
  running: false, phase: '', done: 0, total: 0,
  processed: 0, skipped: 0, failed: 0, savedBytes: 0, error: '',
};

function resetState(): void {
  Object.assign(reprocessState, { running: true, phase: '', done: 0, total: 0, processed: 0, skipped: 0, failed: 0, savedBytes: 0, error: '' });
}

/**
 * 存量图片批处理（零丢失流程）：
 * 备份 DB → 逐张「内存处理 → 写临时文件 → 校验可解码 → 替换原文件 → 改 DB」→ 同步 favorites → 清缩略图缓存
 * 幂等：imgproc 记录规则指纹，同指纹的行跳过；任何单张失败都保留原图并计入 failed
 */
export async function reprocessExisting(backendType: string): Promise<void> {
  resetState();
  try {
    const rule = ruleFor(backendType);
    const fp = ruleFingerprint(rule);

    // 1. 备份 DB（含 WAL 的完整快照；VACUUM INTO 不允许覆盖，先删旧备份——新备份在任何修改前完成）
    reprocessState.phase = 'backup';
    const backupPath = path.join(config.dataDir, 'curator-backup-before-reprocess.db');
    await fs.promises.rm(backupPath, { force: true });
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

    // 2. 逐张处理（同指纹跳过 → 中断重跑/重复点击不会二次压缩）
    reprocessState.phase = 'process';
    const rows = db.prepare(
      `SELECT id, source, source_id, local_path, tags, user_label FROM images
       WHERE local_path IS NOT NULL AND (imgproc IS NULL OR imgproc != ?) ORDER BY id`
    ).all(fp) as { id: number; source: string; source_id: string; local_path: string; tags: string; user_label: string | null }[];
    reprocessState.total = rows.length;
    const markStmt = db.prepare('UPDATE images SET imgproc = ? WHERE id = ?');
    const pathStmt = db.prepare('UPDATE images SET local_path = ?, imgproc = ? WHERE id = ?');

    for (const row of rows) {
      try {
        const abs = resolveStoredPath(row.local_path);
        const buf = await fs.promises.readFile(abs);
        const r = await processImage(buf, path.basename(abs), rule);
        if (r.changed) {
          const newAbs = path.join(path.dirname(abs), r.filename);
          const tmp = newAbs + '.tmp';
          await fs.promises.writeFile(tmp, r.buf);
          // 校验：能解码才替换原文件
          const sharp = (await import('sharp')).default;
          await sharp(tmp).metadata();
          await fs.promises.rename(tmp, newAbs);
          if (newAbs !== abs) await fs.promises.rm(abs, { force: true });
          pathStmt.run(toStoredPath(newAbs), fp, row.id);
          reprocessState.savedBytes += buf.length - r.buf.length;
          reprocessState.processed++;
        } else {
          markStmt.run(fp, row.id);
          reprocessState.skipped++;
        }
      } catch (e) {
        reprocessState.failed++;
        console.warn(`[reprocess] 跳过 id=${row.id}: ${e instanceof Error ? e.message : e}`);
      }
      reprocessState.done++;
    }

    // 3. 同步 favorites：扩展名/内容以处理后的 incoming 为准（旧扩展名副本删除）
    reprocessState.phase = 'favorites';
    const favFiles = new Map<string, string>(); // 无扩展名 basename → 完整路径
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else favFiles.set(e.name.replace(/\.[^.]+$/, ''), p);
      }
    };
    walk(config.storage.favorites);
    const liked = db.prepare(
      `SELECT id, source, source_id, local_path, tags FROM images WHERE user_label = 'like' AND local_path IS NOT NULL`
    ).all() as { id: number; source: string; source_id: string; local_path: string; tags: string }[];
    for (const row of liked) {
      const base = `${row.source}_${row.source_id}`;
      const expected = base + (path.extname(row.local_path) || '.jpg');
      const folder = resolveArchiveFolder(row.tags);
      const targetDir = folder ? path.join(config.storage.favorites, folder) : config.storage.favorites;
      const target = path.join(targetDir, expected);
      const existing = favFiles.get(base);
      try {
        if (existing && existing !== target) await fs.promises.rm(existing, { force: true }); // 旧扩展名/旧位置副本
        if (!fs.existsSync(target)) {
          fs.mkdirSync(targetDir, { recursive: true });
          await storage.archiveFavorite(row.local_path, expected, folder);
        }
      } catch (e) {
        console.warn(`[reprocess] favorites 同步失败 id=${row.id}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // 4. 缩略图缓存作废（用到时自动重建）
    reprocessState.phase = 'thumbs';
    const thumbs = path.join(config.dataDir, 'thumbs');
    if (fs.existsSync(thumbs)) {
      for (const f of fs.readdirSync(thumbs)) await fs.promises.rm(path.join(thumbs, f), { force: true });
    }

    reprocessState.phase = 'done';
  } catch (e) {
    reprocessState.error = e instanceof Error ? e.message : String(e);
    reprocessState.phase = 'error';
  } finally {
    reprocessState.running = false;
  }
}
