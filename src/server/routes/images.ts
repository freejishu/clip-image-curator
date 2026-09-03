import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import type { ImageRow } from '../db.js';
import { storage } from '../storage/backend.js';

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
    return { done: false, image: { ...row, tags: JSON.parse(row.tags ?? '[]') }, remaining };
  });

  app.get('/api/images/:id/file', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare('SELECT local_path FROM images WHERE id = ?').get(id) as { local_path: string | null } | undefined;
    if (!row?.local_path || !fs.existsSync(row.local_path)) return reply.code(404).send({ error: '文件不存在' });
    const ext = path.extname(row.local_path).toLowerCase();
    reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
    return reply.send(fs.createReadStream(row.local_path));
  });

  app.post('/api/images/:id/label', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { label } = req.body as { label?: string };
    if (!label || !['like', 'dislike', 'skip'].includes(label)) return reply.code(400).send({ error: 'label 必须是 like/dislike/skip' });
    const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageRow | undefined;
    if (!row) return reply.code(404).send({ error: '图片不存在' });

    const wasLike = row.user_label === 'like';
    db.prepare(`UPDATE images SET user_label = ?, labeled_at = datetime('now') WHERE id = ?`).run(label, id);
    if (label === 'like' && row.local_path) {
      await storage.archiveFavorite(row.local_path, favName(row));
    } else if (wasLike && label !== 'like') {
      await storage.removeFavorite(favName(row)); // 修正：取消喜欢 → 移出收藏
    }
    return { ok: true };
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
    const rows = db.prepare(`
      SELECT id, source, source_id, page_url, tags, user_label, pred_score FROM images
      WHERE ${conds.join(' AND ')}
      ORDER BY pred_score IS NULL, pred_score ${q.sort === 'asc' ? 'ASC' : 'DESC'}, id DESC
      LIMIT ? OFFSET ?
    `).all(...args, size, (page - 1) * size) as Partial<ImageRow>[];
    return rows.map(r => ({ ...r, tags: JSON.parse(r.tags ?? '[]') }));
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
