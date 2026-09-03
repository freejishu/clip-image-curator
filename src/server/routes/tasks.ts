import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { config } from '../config.js';
import { getSource, listSources } from '../sources/index.js';
import { startTask, pauseTask, resumeTask } from '../pipeline/crawler.js';

export function taskRoutes(app: FastifyInstance) {
  app.get('/api/sources', async () => listSources());

  app.post('/api/tasks', async (req, reply) => {
    const body = req.body as { source?: string; tags?: string[]; limit?: number; proxy?: string | null };
    if (!body.source || !Array.isArray(body.tags) || body.tags.length === 0) {
      return reply.code(400).send({ error: '需要 source 和 tags' });
    }
    getSource(body.source); // 校验存在且启用
    const limit = Math.min(Math.max(body.limit ?? 100, 1), 2000);
    const proxy = body.proxy !== undefined ? body.proxy : (config.sources[body.source]?.proxy ?? config.proxy);
    const r = db.prepare('INSERT INTO tasks (source, query, proxy, target) VALUES (?, ?, ?, ?)')
      .run(body.source, JSON.stringify({ tags: body.tags, limit }), proxy ?? null, limit);
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
