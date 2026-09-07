import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { ImageProcessRule } from '../config.js';
import { ruleFor, defaultImageProcess, COMMON_FORMATS, CONVERT_TARGETS } from '../pipeline/transform.js';
import { reprocessExisting, reprocessState } from '../pipeline/reprocess.js';

const BACKEND_NAMES: Record<string, string> = { local: '本地存储' };

/** 读原始配置文件（优先 config.json，回落 config.example.json），保留全部字段 */
function readRawConfig(): Record<string, unknown> {
  const root = process.cwd();
  const p = ['config.json', 'config.example.json'].map(f => path.join(root, f)).find(f => fs.existsSync(f));
  if (!p) throw new Error('找不到配置文件');
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
}

/** 持久化某后端类型的处理规则到 config.json，并同步内存（立即生效，无需重启） */
function writeImageProcess(type: string, rule: ImageProcessRule): void {
  const raw = readRawConfig();
  const all = { ...((raw.imageProcess ?? {}) as Record<string, unknown>) };
  all[type] = rule;
  raw.imageProcess = all;
  fs.writeFileSync(path.join(process.cwd(), 'config.json'), JSON.stringify(raw, null, 2) + '\n');
  config.imageProcess = { ...(config.imageProcess ?? {}), [type]: rule };
}

export function storageRoutes(app: FastifyInstance) {
  // 存储列表：按后端类型一行（余量 = 数据目录所在盘的可用空间）
  app.get('/api/storages', async () => {
    const type = config.storage.type ?? 'local';
    const st = fs.statfsSync(config.dataDir);
    return [{
      type,
      name: BACKEND_NAMES[type] ?? type,
      incoming: config.storage.incoming,
      favorites: config.storage.favorites,
      freeBytes: Number(st.bavail) * Number(st.bsize),
      totalBytes: Number(st.blocks) * Number(st.bsize),
      process: ruleFor(type),
      formatOptions: { common: COMMON_FORMATS, convertTargets: CONVERT_TARGETS },
    }];
  });

  // 压缩设置：每个后端类型单独配置
  app.put('/api/storages/:type/compression', async (req, reply) => {
    const { type } = req.params as { type: string };
    if (type !== (config.storage.type ?? 'local')) return reply.code(400).send({ error: '后端类型不存在' });
    const b = req.body as Partial<ImageProcessRule['compression']>;
    const enabled = !!b.enabled;
    const mode = b.mode === 'maxSize' ? 'maxSize' : 'scale';
    const scalePercent = Number(b.scalePercent);
    const maxSizeMB = Number(b.maxSizeMB);
    if (enabled && mode === 'scale' && !(scalePercent >= 1 && scalePercent <= 100)) {
      return reply.code(400).send({ error: '比例需为 1-100 的百分比' });
    }
    if (enabled && mode === 'maxSize' && !(maxSizeMB > 0 && maxSizeMB <= 50)) {
      return reply.code(400).send({ error: '最大单张大小需为 0-50 之间的数字（MB）' });
    }
    const cur = ruleFor(type);
    const rule: ImageProcessRule = { ...cur, compression: { enabled, mode, scalePercent, maxSizeMB } };
    writeImageProcess(type, rule);
    return { ok: true, process: rule };
  });

  // 格式设置：启用列表 + 未启用格式自动转换的目标格式（目标必须在启用列表内，不允许 gif）
  app.put('/api/storages/:type/formats', async (req, reply) => {
    const { type } = req.params as { type: string };
    if (type !== (config.storage.type ?? 'local')) return reply.code(400).send({ error: '后端类型不存在' });
    const b = req.body as Partial<ImageProcessRule['formats']>;
    const enabled = Array.isArray(b.enabled) ? b.enabled.filter(f => (COMMON_FORMATS as readonly string[]).includes(f)) : [];
    const convertTo = String(b.convertTo ?? '');
    if (enabled.length === 0) return reply.code(400).send({ error: '至少启用一种格式' });
    if (!(CONVERT_TARGETS as readonly string[]).includes(convertTo)) return reply.code(400).send({ error: `转换目标仅支持：${CONVERT_TARGETS.join(' / ')}（不可转为 gif）` });
    if (!enabled.includes(convertTo)) return reply.code(400).send({ error: '转换目标格式必须在启用列表中' });
    const cur = ruleFor(type);
    const rule: ImageProcessRule = { ...cur, formats: { enabled, convertTo } };
    writeImageProcess(type, rule);
    return { ok: true, process: rule };
  });

  // 存量图片批处理（备份 → 逐张处理 → 同步 favorites → 清缩略图），带进度
  app.post('/api/storages/:type/process-existing', async (req, reply) => {
    const { type } = req.params as { type: string };
    if (type !== (config.storage.type ?? 'local')) return reply.code(400).send({ error: '后端类型不存在' });
    if (reprocessState.running) return reply.code(409).send({ error: '批处理进行中' });
    void reprocessExisting(type);
    return { ok: true };
  });
  app.get('/api/storages/process-status', async () => reprocessState);
}
