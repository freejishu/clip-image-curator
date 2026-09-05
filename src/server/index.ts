import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { db } from './db.js';
import { resolveArchiveFolder } from './storage/backend.js';
import { taskRoutes } from './routes/tasks.js';
import { imageRoutes } from './routes/images.js';
import { trainRoutes } from './routes/train.js';

const app = Fastify({ logger: true });

// 收藏夹按归档规则重整理（幂等：规则变更/新增后重启即生效）
{
  const rows = db.prepare(`SELECT source, source_id, local_path, tags FROM images WHERE user_label = 'like' AND local_path IS NOT NULL`).all() as
    { source: string; source_id: string; local_path: string; tags: string }[];
  let moved = 0;
  for (const row of rows) {
    const filename = `${row.source}_${row.source_id}${path.extname(row.local_path) || '.jpg'}`;
    const folder = resolveArchiveFolder(row.tags);
    const targetDir = folder ? path.join(config.storage.favorites, folder) : config.storage.favorites;
    const target = path.join(targetDir, filename);
    if (fs.existsSync(target)) continue;
    const candidates = [path.join(config.storage.favorites, filename)];
    for (const sub of fs.readdirSync(config.storage.favorites, { withFileTypes: true })) {
      if (sub.isDirectory()) candidates.push(path.join(config.storage.favorites, sub.name, filename));
    }
    const existing = candidates.find(p => fs.existsSync(p));
    if (existing) { fs.mkdirSync(targetDir, { recursive: true }); fs.renameSync(existing, target); moved++; }
  }
  if (moved) console.log(`收藏夹重整理: 移动 ${moved} 个文件`);
}

// 进程重启后，上次仍在 running 的任务标记为 paused（可手动「继续」断点续跑）
const stale = db.prepare(`UPDATE tasks SET status = 'paused' WHERE status = 'running'`).run();
if (stale.changes > 0) console.log(`恢复提示: ${stale.changes} 个中断任务已标记为 paused`);

taskRoutes(app);
imageRoutes(app);
trainRoutes(app);

// 生产模式：托管前端构建产物
const webDist = path.resolve(process.cwd(), 'web/dist');
if (fs.existsSync(webDist)) {
  // index.html 禁止缓存（hash 资源可强缓存，html 必须每次回源取最新引用）
  app.addHook('onSend', async (req, reply, payload) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url.endsWith('.html')) reply.header('Cache-Control', 'no-cache, must-revalidate');
    return payload;
  });
  await app.register(fastifyStatic, { root: webDist, setHeaders: (res: unknown, p: string) => {
    const r = res as { header?: (k: string, v: string) => void; setHeader?: (k: string, v: string) => void };
    const set = (k: string, v: string) => { if (r.header) r.header(k, v); else r.setHeader?.(k, v); };
    if (p.includes(`${path.sep}assets${path.sep}`)) set('Cache-Control', 'public, max-age=31536000, immutable');
    else set('Cache-Control', 'no-cache, must-revalidate');
  } });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

await app.listen({ port: config.port, host: config.host ?? '127.0.0.1' });
console.log(`image-curator 已启动: http://127.0.0.1:${config.port}`);
