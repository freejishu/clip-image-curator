import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { config } from '../config.js';
import { getSource, listSources } from '../sources/index.js';
import { startTask, pauseTask, resumeTask } from '../pipeline/crawler.js';
import { loadModel } from '../ml/classifier.js';

export function taskRoutes(app: FastifyInstance) {
  app.get('/api/sources', async () => listSources());

  app.post('/api/tasks', async (req, reply) => {
    const body = req.body as {
      source?: string; tags?: string[]; limit?: number; proxy?: string | null; start?: number; end?: number;
      // X 专用
      kind?: 'user-media' | 'user-likes' | 'search'; target?: string; sort?: 'top' | 'latest';
      // 过滤模式
      mode?: 'full' | 'filter'; threshold?: number;
    };
    if (!body.source) return reply.code(400).send({ error: '需要 source' });
    getSource(body.source); // 校验存在且启用

    const isX = body.source === 'x';
    if (!isFilterTags(body)) {
      // yandere 需要 tags；X 需要 kind+target（user-likes 除外）
      if (!body.kind) return reply.code(400).send({ error: 'X 数据源需要 kind（user-media / user-likes / search）' });
      if (body.kind !== 'user-likes' && !body.target?.trim()) return reply.code(400).send({ error: `kind=${body.kind} 需要 target` });
    }

    // 过滤模式校验：必须有已训练模型
    const mode = body.mode ?? 'full';
    if (mode === 'filter' && !loadModel()) {
      return reply.code(409).send({ error: '过滤模式需要先训练模型（当前无已训练模型）' });
    }

    // 两种扫描方式：从头扫（limit 条）/ 范围扫（跳过 start 条，扫 start..end，单任务最多 2000 条）
    let limit = Math.min(Math.max(body.limit ?? 100, 1), 2000);
    let skip = 0;
    if (body.end != null) {
      const start = Number(body.start ?? 0);
      const end = Number(body.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        return reply.code(400).send({ error: '范围需满足 0 ≤ 开始 < 结束' });
      }
      skip = Math.floor(start);
      limit = Math.min(Math.floor(end) - skip, 2000);
    }
    const proxy = body.proxy || config.sources[body.source]?.proxy || config.proxy || null; // null/空串都回落到默认代理
    const query: Record<string, unknown> = { tags: body.tags ?? [], limit, skip };
    if (isX) {
      query.kind = body.kind;
      if (body.target) query.target = body.target.trim();
      if (body.sort) query.sort = body.sort;
    }
    const r = db.prepare('INSERT INTO tasks (source, query, proxy, target, mode, threshold) VALUES (?, ?, ?, ?, ?, ?)')
      .run(body.source, JSON.stringify(query), proxy ?? null, limit, mode, body.threshold ?? 0.5);
    const id = Number(r.lastInsertRowid);
    void startTask(id);
    return { id };
  });

  app.get('/api/tasks', async () =>
    db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 50').all());

  app.post('/api/tasks/:id/pause', async (req) => {
    const id = Number((req.params as { id: string }).id);
    return { ok: pauseTask(id) };
  });

  app.post('/api/tasks/:id/resume', async (req) => {
    const id = Number((req.params as { id: string }).id);
    resumeTask(id);
    return { ok: true };
  });
}

function isFilterTags(body: { tags?: string[] }): boolean {
  return Array.isArray(body.tags) && body.tags.length > 0;
}
