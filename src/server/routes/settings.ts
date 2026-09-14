import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db } from '../db.js';

/** 读原始配置文件（优先 config.json，回落 config.example.json），保留全部字段 */
function readRawConfig(): Record<string, unknown> {
  const root = process.cwd();
  const p = ['config.json', 'config.example.json'].map(f => path.join(root, f)).find(f => fs.existsSync(f));
  if (!p) throw new Error('找不到配置文件');
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
}

/** 把数据目录写入 config.json（覆盖式个人配置，example 不动）。incoming/favorites 原来在旧数据目录下则跟随，否则保留 */
function writeDataDirConfig(newDir: string): void {
  const raw = readRawConfig();
  const oldData = path.resolve(process.cwd(), String(raw.dataDir ?? './data'));
  const storage = { ...((raw.storage ?? {}) as Record<string, unknown>) };
  for (const [key, sub] of [['incoming', 'incoming'], ['favorites', 'favorites']] as const) {
    const cur = path.resolve(process.cwd(), String(storage[key] ?? `./data/${sub}`));
    if (cur.startsWith(oldData)) storage[key] = path.join(newDir, sub);
  }
  raw.dataDir = newDir;
  raw.storage = storage;
  fs.writeFileSync(path.join(process.cwd(), 'config.json'), JSON.stringify(raw, null, 2) + '\n');
}

function validNewDir(p: unknown): p is string {
  return typeof p === 'string' && p.trim().length > 0 && path.isAbsolute(p.trim());
}

export function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async () => ({
    dataDir: config.dataDir,
    incoming: config.storage.incoming,
    favorites: config.storage.favorites,
    thumbs: path.join(config.dataDir, 'thumbs'),
    models: path.join(config.dataDir, 'models'),
  }));

  // 修改数据目录：目标已有有效数据（curator.db）→ 直接切换；没有 → 返回 empty 由前端询问是否迁移
  app.post('/api/settings/data-dir', async (req, reply) => {
    const p = (req.body as { path?: string }).path?.trim();
    if (!validNewDir(p)) return reply.code(400).send({ error: '需要绝对路径，如 E:\\ic-data' });
    const target = path.resolve(p);
    if (target === config.dataDir) return reply.code(400).send({ error: '与当前数据目录相同' });
    if (fs.existsSync(path.join(target, 'curator.db'))) {
      writeDataDirConfig(target);
      return { mode: 'use-existing', needRestart: true };
    }
    return { mode: 'empty' };
  });

  // 迁移当前数据到新目录（复制，旧目录保留可手动删），带进度
  const mig = { running: false, phase: '', done: 0, total: 0, error: '' };
  app.get('/api/settings/migrate-status', async () => mig);
  app.post('/api/settings/migrate', async (req, reply) => {
    if (mig.running) return reply.code(409).send({ error: '迁移进行中' });
    const p = (req.body as { path?: string }).path?.trim();
    if (!validNewDir(p)) return reply.code(400).send({ error: '需要绝对路径' });
    const target = path.resolve(p);
    if (target === config.dataDir) return reply.code(400).send({ error: '与当前数据目录相同' });
    if (fs.existsSync(path.join(target, 'curator.db'))) return reply.code(400).send({ error: '目标已有数据，直接切换即可，无需迁移' });
    if (!target.startsWith(config.dataDir) && fs.existsSync(target) && fs.readdirSync(target).length > 0) {
      return reply.code(400).send({ error: '目标目录非空且无 curator.db，为避免混淆请换一个空目录' });
    }

    mig.running = true; mig.phase = 'checkpoint'; mig.done = 0; mig.total = 0; mig.error = '';
    void (async () => {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // WAL 落盘，保证复制出完整 db
        const files: { src: string; dst: string }[] = [];
        const walk = (srcDir: string, dstDir: string) => {
          if (!fs.existsSync(srcDir)) return;
          for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
            const s = path.join(srcDir, e.name), d = path.join(dstDir, e.name);
            if (e.isDirectory()) walk(s, d); else files.push({ src: s, dst: d });
          }
        };
        files.push({ src: path.join(config.dataDir, 'curator.db'), dst: path.join(target, 'curator.db') });
        walk(config.storage.incoming, path.join(target, 'incoming'));
        walk(config.storage.favorites, path.join(target, 'favorites'));
        walk(path.join(config.dataDir, 'models'), path.join(target, 'models'));
        // thumbs 是缓存，不复制，用到了自动重建
        mig.total = files.length;
        mig.phase = 'copy';
        for (const f of files) {
          fs.mkdirSync(path.dirname(f.dst), { recursive: true });
          await fs.promises.copyFile(f.src, f.dst);
          mig.done++;
        }
        // 重写 local_path 绝对路径前缀（旧 incoming → 新 incoming）
        mig.phase = 'rewrite-paths';
        const oldInc = config.storage.incoming;
        const newInc = path.join(target, 'incoming');
        if (oldInc !== newInc) {
          const ndb = new DatabaseSync(path.join(target, 'curator.db'));
          const r = ndb.prepare('UPDATE images SET local_path = REPLACE(local_path, ?, ?) WHERE local_path LIKE ?')
            .run(oldInc, newInc, oldInc + '%');
          ndb.close();
          console.log(`数据迁移: 重写 local_path ${r.changes} 行`);
        }
        writeDataDirConfig(target);
        mig.phase = 'done';
      } catch (e) {
        mig.error = e instanceof Error ? e.message : String(e);
        mig.phase = 'error';
      } finally { mig.running = false; }
    })();
    return { ok: true };
  });

  // 重启自身：延迟 2s 由独立进程重新拉起 start.bat，然后退出当前进程
  app.post('/api/restart', async () => {
    const cwd = process.cwd().replace(/'/g, "''");
    const ps = `Start-Sleep -Seconds 2; Start-Process -FilePath cmd.exe -ArgumentList '/c','start.bat' -WorkingDirectory '${cwd}'`;
    spawn('powershell.exe', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => process.exit(0), 1000); // 留足响应发送时间，过快 exit 会把客户端连接掐断
    return { ok: true };
  });
}
