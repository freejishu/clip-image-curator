import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import type { ImageRow } from '../db.js';
import { storage, resolveArchiveFolder, resolveStoredPath } from '../storage/backend.js';
import { config } from '../config.js';
import { propagateGroupIds, bindImages, unbindImage, albumGroupKeys, albumGroupMembers, invalidateGroupCache } from '../groups.js';
import { getSource, sourcesWith } from '../sources/index.js';
import { extOf } from '../pipeline/crawler.js';
import { ruleFor, ruleFingerprint } from '../pipeline/transform.js';
import type { ImageMeta } from '../sources/types.js';

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

function favName(row: ImageRow): string {
  return `${row.source}_${row.source_id}${path.extname(row.local_path ?? '') || '.jpg'}`;
}

export function imageRoutes(app: FastifyInstance) {
  // 下一张待标注：smart 模式按预测分降序，否则按入库顺序
  app.get('/api/images/next', async (req) => {
    const mode = (req.query as { mode?: string }).mode ?? 'smart';
    const order = mode === 'smart'
      ? 'ORDER BY pred_score IS NULL, pred_score DESC, id'
      : 'ORDER BY id';
    const row = db.prepare(`
      SELECT id, source, source_id, page_url, tags, pred_score, local_path FROM images
      WHERE user_label IS NULL AND local_path IS NOT NULL ${order} LIMIT 1
    `).get() as Partial<ImageRow> | undefined;
    if (!row) return { done: true };
    const remaining = (db.prepare('SELECT COUNT(*) c FROM images WHERE user_label IS NULL AND local_path IS NOT NULL').get() as { c: number }).c;
    // 同组（yande.re 父子 ∪ 手动绑定）成员，供打分页预览
    const memberIds = propagateGroupIds(row.id!).filter(i => i !== row.id);
    let group: unknown[] = [];
    if (memberIds.length > 0) {
      const ph = memberIds.map(() => '?').join(',');
      group = (db.prepare(`SELECT id, source, source_id, page_url, tags, pred_score, parent_id FROM images WHERE id IN (${ph}) AND local_path IS NOT NULL`).all(...memberIds) as Partial<ImageRow>[])
        .map(m => ({ ...m, tags: JSON.parse(m.tags ?? '[]') }));
    }
    return { done: false, image: { ...row, tags: JSON.parse(row.tags ?? '[]') }, remaining, group };
  });

  // 缩略图：列表网格专用，320px JPEG，落盘缓存
  const thumbDir = path.join(config.dataDir, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  app.get('/api/images/:id/thumb', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare('SELECT local_path FROM images WHERE id = ?').get(id) as { local_path: string | null } | undefined;
    const filePath = row?.local_path ? resolveStoredPath(row.local_path) : null;
    if (!filePath || !fs.existsSync(filePath)) return reply.code(404).send({ error: '文件不存在' });
    const thumbPath = path.join(thumbDir, `${id}.jpg`);
    if (!fs.existsSync(thumbPath)) {
      const sharp = (await import('sharp')).default;
      await sharp(filePath).resize(320, 320, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toFile(thumbPath);
    }
    reply.header('Content-Type', 'image/jpeg');
    reply.header('Cache-Control', 'max-age=86400');
    return reply.send(fs.createReadStream(thumbPath));
  });

  app.get('/api/images/:id/file', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare('SELECT local_path FROM images WHERE id = ?').get(id) as { local_path: string | null } | undefined;
    const filePath = row?.local_path ? resolveStoredPath(row.local_path) : null;
    if (!filePath || !fs.existsSync(filePath)) return reply.code(404).send({ error: '文件不存在' });
    const ext = path.extname(filePath).toLowerCase();
    reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
    return reply.send(fs.createReadStream(filePath));
  });

  app.post('/api/images/:id/label', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { label } = req.body as { label?: string };
    if (!label || !['like', 'dislike', 'skip'].includes(label)) return reply.code(400).send({ error: 'label 必须是 like/dislike/skip' });
    const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageRow | undefined;
    if (!row) return reply.code(404).send({ error: '图片不存在' });

    const wasLike = row.user_label === 'like';
    const folder = resolveArchiveFolder(row.tags); // 按 tag 规则分类归档
    db.prepare(`UPDATE images SET user_label = ?, labeled_at = datetime('now') WHERE id = ?`).run(label, id);
    if (label === 'like' && row.local_path) {
      await storage.archiveFavorite(row.local_path, favName(row), folder);
    } else if (wasLike && label !== 'like') {
      await storage.removeFavorite(favName(row), folder); // 修正：取消喜欢 → 移出收藏
    }
    // 组传播（yande.re 父子 ∪ 手动绑定）：
    // like → 组内未标注成员一并保留（尊重显式不喜欢）；dislike → 整组覆盖为不喜欢（含已喜欢的，移出收藏）
    const affected: number[] = [id];
    if (label === 'like' || label === 'dislike') {
      for (const gid of propagateGroupIds(id)) {
        if (gid === id) continue;
        const m = db.prepare('SELECT * FROM images WHERE id = ?').get(gid) as ImageRow | undefined;
        if (!m || !m.local_path) continue; // 无文件跳过
        if (m.user_label === label) continue;
        if (label === 'like' && m.user_label != null) continue;
        const mWasLike = m.user_label === 'like';
        db.prepare(`UPDATE images SET user_label = ?, labeled_at = datetime('now') WHERE id = ?`).run(label, gid);
        if (label === 'like') await storage.archiveFavorite(m.local_path, favName(m), resolveArchiveFolder(m.tags));
        else if (mWasLike) await storage.removeFavorite(favName(m), resolveArchiveFolder(m.tags));
        affected.push(gid);
      }
    }
    return { ok: true, affected };
  });

  // 审查/修正列表
  app.get('/api/images', async (req) => {
    const q = req.query as { label?: string; minScore?: string; maxScore?: string; sort?: string; page?: string };
    const page = Math.max(Number(q.page ?? 1), 1);
    const size = 60;
    const conds: string[] = ['local_path IS NOT NULL'];
    const args: (string | number)[] = [];
    if (q.label === 'none') { conds.push('user_label IS NULL'); } else if (q.label) { conds.push('user_label = ?'); args.push(q.label); }
    if (q.minScore) { conds.push('pred_score >= ?'); args.push(Number(q.minScore)); }
    if (q.maxScore) { conds.push('pred_score IS NOT NULL AND pred_score <= ?'); args.push(Number(q.maxScore)); }
    const total = (db.prepare(`SELECT COUNT(*) c FROM images WHERE ${conds.join(' AND ')}`).get(...args) as { c: number }).c;
    const rows = db.prepare(`
      SELECT id, source, source_id, page_url, tags, user_label, pred_score FROM images
      WHERE ${conds.join(' AND ')}
      ORDER BY pred_score IS NULL, pred_score ${q.sort === 'asc' ? 'ASC' : 'DESC'}, id DESC
      LIMIT ? OFFSET ?
    `).all(...args, size, (page - 1) * size) as Partial<ImageRow>[];
    return { total, page, size, rows: rows.map(r => ({ ...r, tags: JSON.parse(r.tags ?? '[]') })) };
  });

  // 相册：喜欢的图，按标记时间倒序（fallback 入库时间）
  app.get('/api/album', async () => {
    const rows = db.prepare(`
      SELECT id, source, source_id, page_url, tags, pred_score, parent_id, labeled_at, created_at, embedding
      FROM images
      WHERE user_label = 'like' AND local_path IS NOT NULL
      ORDER BY labeled_at IS NULL, labeled_at DESC, id DESC
    `).all() as (Partial<ImageRow> & { parent_id: number | null; embedding: Buffer | null })[];
    // 展示分组：yande.re 父子 ∪ 手动绑定 ∪ CLIP 近重复（groups.ts 统一并查）
    const keys = albumGroupKeys(rows as { id: number; source: string; source_id: string; parent_id: number | null; embedding: Buffer | null }[]);
    const manualIds = new Set((db.prepare('SELECT image_id FROM image_group_members').all() as { image_id: number }[]).map(r => r.image_id));
    const coverIds = new Set((db.prepare('SELECT image_id FROM group_covers').all() as { image_id: number }[]).map(r => r.image_id));
    return rows.map(r => ({ ...r, embedding: undefined, tags: JSON.parse(r.tags ?? '[]'), group_key: keys.get(r.id!) ?? null, in_manual: manualIds.has(r.id!), is_cover: coverIds.has(r.id!) }));
  });

  // 手动设置组封面：同组旧封面清除，标记新封面（全站按组展示时以封面为主图）
  app.post('/api/groups/cover', async (req, reply) => {
    const { image_id } = req.body as { image_id?: number };
    if (!image_id) return reply.code(400).send({ error: '需要 image_id' });
    const row = db.prepare('SELECT id FROM images WHERE id = ?').get(image_id);
    if (!row) return reply.code(404).send({ error: '图片不存在' });
    const members = albumGroupMembers(image_id);
    const ph = members.map(() => '?').join(',');
    db.prepare(`DELETE FROM group_covers WHERE image_id IN (${ph})`).run(...members);
    db.prepare('INSERT INTO group_covers (image_id) VALUES (?)').run(image_id);
    return { ok: true, members };
  });

  // 手动绑定组：多图并为一组（已有手动组自动合并）
  app.post('/api/groups/bind', async (req, reply) => {
    const { image_ids } = req.body as { image_ids?: number[] };
    if (!Array.isArray(image_ids) || image_ids.length < 2) return reply.code(400).send({ error: '至少选择 2 张图片' });
    const gid = bindImages(image_ids);
    invalidateGroupCache();
    return { ok: true, group_id: gid };
  });

  // 解绑：仅手动绑定关系可解（yande.re 父子关系不可解）
  app.post('/api/groups/unbind', async (req, reply) => {
    const { image_id } = req.body as { image_id?: number };
    if (!image_id) return reply.code(400).send({ error: '需要 image_id' });
    const ok = unbindImage(image_id);
    invalidateGroupCache();
    if (!ok) return reply.code(404).send({ error: '该图没有手动绑定关系' });
    return { ok: true };
  });

  // 回填 parent_id（老数据没有）：对支持 fetchPost 能力的源逐张查单帖，限速
  const backfillState = { running: false, done: 0, total: 0 };
  app.get('/api/backfill-status', async () => backfillState);
  app.post('/api/backfill-parents', async (_req, reply) => {
    if (backfillState.running) return reply.code(409).send({ error: '回填进行中' });
    backfillState.running = true;
    void (async () => {
      try {
        const srcNames = sourcesWith('fetchPost');
        const rows = (srcNames.length
          ? db.prepare(`SELECT id, source, source_id FROM images WHERE parent_id IS NULL AND source IN (${srcNames.map(() => '?').join(',')})`).all(...srcNames)
          : []) as { id: number; source: string; source_id: string }[];
        backfillState.total = rows.length;
        backfillState.done = 0;
        let done = 0;
        for (const row of rows) {
          try {
            const m = await getSource(row.source).fetchPost!(row.source_id, { proxy: config.proxy });
            if (m) db.prepare('UPDATE images SET parent_id = ? WHERE id = ?').run(m.parentId ?? -1, row.id); // -1 = 已确认无父
          } catch { /* 单张失败跳过 */ }
          done++;
          backfillState.done = done;
          if (done % 20 === 0) console.log(`parent_id 回填 ${done}/${rows.length}`);
          await new Promise(r => setTimeout(r, 800)); // 礼貌限速
        }
        console.log(`parent_id 回填完成: ${done}/${rows.length}`);
      } finally { backfillState.running = false; }
    })();
    return { ok: true };
  });

  // 补全家族（父子投稿）：数据源实现 fetchFamily 能力才可用；缺失成员下载并整组视为喜欢
  app.post('/api/images/:id/fetch-siblings', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageRow | undefined;
    if (!row) return reply.code(404).send({ error: '图片不存在' });
    const plugin = getSource(row.source);
    if (!plugin.fetchFamily) return reply.code(400).send({ error: `数据源 ${row.source} 不支持补全家族` });

    const opts = { proxy: config.proxy };
    let family: ImageMeta[];
    try {
      family = await plugin.fetchFamily(row.source_id, row.parent_id, opts);
    } catch (e) {
      return reply.code(502).send({ error: `${row.source} 查询失败: ${e instanceof Error ? e.message : String(e)}` });
    }
    // 顺手回填自身 parent_id
    const self = family.find(m => m.sourceId === row.source_id);
    if (self && row.parent_id == null) {
      db.prepare('UPDATE images SET parent_id = ? WHERE id = ?').run(self.parentId ?? -1, id);
    }
    if (family.length <= 1) return { ok: true, family: family.length, added: 0, liked: 0, failed: 0, message: '该投稿没有父子关联的其他投稿' };

    // 逐成员：不在库→入库+下载；在库无文件→补下载；最终整组视为喜欢
    let added = 0, liked = 0, failed = 0;
    for (const meta of family) {
      try {
        let cur = db.prepare('SELECT * FROM images WHERE source = ? AND source_id = ?').get(meta.source, meta.sourceId) as ImageRow | undefined;
        if (!cur) {
          db.prepare(`INSERT OR IGNORE INTO images (source, source_id, page_url, file_url, preview_url, tags, width, height, rating, parent_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            meta.source, meta.sourceId, meta.pageUrl, meta.fileUrl, meta.previewUrl ?? null,
            JSON.stringify(meta.tags), meta.width ?? null, meta.height ?? null, meta.rating ?? null, meta.parentId ?? null);
          cur = db.prepare('SELECT * FROM images WHERE source = ? AND source_id = ?').get(meta.source, meta.sourceId) as unknown as ImageRow;
          added++;
        }
        if (cur.parent_id == null && meta.parentId != null) {
          db.prepare('UPDATE images SET parent_id = ? WHERE id = ?').run(meta.parentId, cur.id); // 回填
        }
        if (!cur.local_path) {
          const buf = await plugin.fetchImage(meta, opts);
          const localPath = await storage.saveIncoming(buf, `${meta.source}_${meta.sourceId}${extOf(meta.fileUrl, buf)}`);
          db.prepare('UPDATE images SET local_path = ?, imgproc = ? WHERE id = ?')
            .run(localPath, ruleFingerprint(ruleFor(config.storage.type ?? 'local')), cur.id); // 入库时已按当前规则处理，记录指纹
          cur = { ...cur, local_path: localPath };
        }
        if (cur.user_label !== 'like') {
          db.prepare(`UPDATE images SET user_label = 'like', labeled_at = datetime('now') WHERE id = ?`).run(cur.id);
          await storage.archiveFavorite(cur.local_path!, favName(cur), resolveArchiveFolder(cur.tags));
          liked++;
        }
        invalidateGroupCache();
        await new Promise(r => setTimeout(r, 600)); // 礼貌限速
      } catch { failed++; }
    }
    return { ok: true, family: family.length, added, liked, failed };
  });

  // 清理"抓到链接但从未下载成功"的脏记录（不影响已标注数据）
  app.post('/api/cleanup-nopath', async () => {
    const r = db.prepare('DELETE FROM images WHERE local_path IS NULL AND user_label IS NULL').run();
    return { deleted: Number(r.changes) };
  });

  app.get('/api/stats', async () => {
    const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    return {
      total: one('SELECT COUNT(*) c FROM images'),
      downloaded: one('SELECT COUNT(*) c FROM images WHERE local_path IS NOT NULL'),
      liked: one(`SELECT COUNT(*) c FROM images WHERE user_label = 'like'`),
      disliked: one(`SELECT COUNT(*) c FROM images WHERE user_label = 'dislike'`),
      skipped: one(`SELECT COUNT(*) c FROM images WHERE user_label = 'skip'`),
      unlabeled: one('SELECT COUNT(*) c FROM images WHERE user_label IS NULL AND local_path IS NOT NULL'),
      withEmbedding: one('SELECT COUNT(*) c FROM images WHERE embedding IS NOT NULL'),
    };
  });
}
