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
import { settingsRoutes } from './routes/settings.js';
import { storageRoutes } from './routes/storages.js';
import { likeRoutes } from './routes/like.js';
import { authRoutes } from './routes/auth.js';
import { ensureAuthSeed, resetAuth, validateToken, extractToken } from './auth.js';

// CLI 子命令：强制重置账户为默认 admin/admin（打包成单文件后同样适用：image-curator.exe reset-password）
// ⚠️ 推荐在服务停止时执行；实测 WAL 空闲时服务运行中也能成功，但若报 SQLITE_BUSY 请先停服务再执行。
//    重置后需重启服务（ensureAuthSeed 在启动时重播种 admin/admin），重置即刻生效：所有已发 token 立即失效
if (process.argv[2] === 'reset-password') {
  try {
    resetAuth();
    console.log('✓ 已清除账户凭据与全部登录态。下次启动服务时将重新初始化默认账户 admin/admin');
  } catch (e) {
    console.error(`✕ 重置失败: ${e instanceof Error ? e.message : String(e)}`);
    console.error('  若提示数据库被锁定（SQLITE_BUSY），请先停止正在运行的 image-curator 服务再执行本命令');
    process.exitCode = 1;
  }
  process.exit();
}

ensureAuthSeed();

const app = Fastify({ logger: true });

// 豁免鉴权的路径（仅 /api/* 参与判定；静态页面与 /like 本来就不要求登录）
const AUTH_EXEMPT = new Set(['/api/auth/login', '/api/auth/status', '/api/like']);

app.addHook('onRequest', async (req, reply) => {
  const url = req.url.split('?')[0];
  // CORS：支持「前端连其他服务器」场景（Bearer token 方案无 Cookie，不涉及 credentials，可放心 *）
  if (url.startsWith('/api/')) {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return reply.code(204).send(); // 预检放行
  if (!url.startsWith('/api/')) return; // 静态资源与 /like 公开
  if (AUTH_EXEMPT.has(url)) return;
  const token = extractToken(req);
  const username = validateToken(token);
  if (!username) return reply.code(401).send({ error: 'unauthorized' });
  req.authUser = username;
  req.authToken = token;
});

// 收藏夹按归档规则重整理（幂等：规则变更/新增后重启即生效）
{
  const rows = db.prepare(`SELECT source, source_id, local_path, tags FROM images WHERE user_label = 'like' AND local_path IS NOT NULL`).all() as
    { source: string; source_id: string; local_path: string; tags: string }[];
  // 子目录列表只读一次（原来每张喜欢图都 readdir 一次）
  const favSubdirs = fs.readdirSync(config.storage.favorites, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  let moved = 0;
  for (const row of rows) {
    const filename = `${row.source}_${row.source_id}${path.extname(row.local_path) || '.jpg'}`;
    const folder = resolveArchiveFolder(row.tags);
    const targetDir = folder ? path.join(config.storage.favorites, folder) : config.storage.favorites;
    const target = path.join(targetDir, filename);
    if (fs.existsSync(target)) continue;
    const candidates = [path.join(config.storage.favorites, filename)];
    for (const sub of favSubdirs) candidates.push(path.join(config.storage.favorites, sub, filename));
    const existing = candidates.find(p => fs.existsSync(p));
    if (existing) { fs.mkdirSync(targetDir, { recursive: true }); fs.renameSync(existing, target); moved++; }
  }
  if (moved) console.log(`收藏夹重整理: 移动 ${moved} 个文件`);
}

// 进程重启后，上次仍在 running 的任务标记为 paused（可手动「继续」断点续跑）；落定 finished_at 防止耗时虚增
const stale = db.prepare(`UPDATE tasks SET status = 'paused', finished_at = datetime('now') WHERE status = 'running'`).run();
if (stale.changes > 0) console.log(`恢复提示: ${stale.changes} 个中断任务已标记为 paused`);

taskRoutes(app);
imageRoutes(app);
trainRoutes(app);
settingsRoutes(app);
storageRoutes(app);
likeRoutes(app);
authRoutes(app);

// 生产模式：托管前端构建产物（cwd 容错：优先 cwd/web/dist，兜底模块相对路径）
let webDist = path.resolve(process.cwd(), 'web/dist');
if (!fs.existsSync(webDist)) {
  const alt = path.resolve(import.meta.dirname, '../../web/dist');
  if (fs.existsSync(alt)) webDist = alt;
}
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
} else {
  console.warn(`[warn] 未找到前端构建产物 ${webDist}，仅提供 /api 服务。请先执行 npm run build:web`);
}

await app.listen({ port: config.port, host: config.host ?? '127.0.0.1' });
console.log(`image-curator 已启动: http://127.0.0.1:${config.port}`);
