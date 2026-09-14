import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { embedImage } from '../ml/embed.js';
import { loadModel, predictExternal } from '../ml/classifier.js';
import { apiDocs } from '../api-docs.js';

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * 魔数嗅探图片格式 + 动图检测（按 PNG/WebP chunk 规范解析，不是子串猜测）。
 * ⚠️ 本文件禁止使用顶层 sharp：它与 @huggingface/transformers 内嵌的 sharp 是两套 libvips，
 *    顶层 sharp 先初始化会把后者的 VipsInterpretation 枚举注册撞坏（"colourspace: parameter space not set"），
 *    导致同进程 CLIP embedding 全部失败。反向顺序（先 embed 后用顶层 sharp）则共存无碍。
 */
function sniffImage(buf: Buffer): { format: 'jpeg' | 'png' | 'webp'; animated: boolean } | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF（无动图形态）
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { format: 'jpeg', animated: false };
  // PNG: 8 字节签名后迭代 chunk（length 4B + type 4B + data），acTL = APNG 动图
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('latin1', off + 4, off + 8);
      if (type === 'acTL') return { format: 'png', animated: true };
      if (type === 'IDAT' || type === 'IEND') break; // 图像数据开始后不会再有 acTL
      off += 12 + len;
    }
    return { format: 'png', animated: false };
  }
  // WebP: RIFF + WEBP，迭代 chunk（fourcc 4B + size 4B LE），ANIM = 动图
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    let off = 12;
    while (off + 8 <= buf.length) {
      const fourcc = buf.toString('latin1', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (fourcc === 'ANIM') return { format: 'webp', animated: true };
      off += 8 + size + (size & 1); // chunk 按偶数对齐
    }
    return { format: 'webp', animated: false };
  }
  return null; // gif 及其他一律不支持
}

export function likeRoutes(app: FastifyInstance) {
  app.register(multipart, { limits: { fileSize: MAX_BYTES, files: 1 } });

  // 内置 API 文档（设置页「API → 接口文档」渲染源）
  app.get('/api/docs', async () => apiDocs);

  // 「我喜欢这个图片！」：multipart 文件上传 或 JSON base64；纯计算不留痕，临时文件算完即删
  app.post('/api/like', { bodyLimit: Math.ceil(MAX_BYTES * 1.5) }, async (req, reply) => {
    let buf: Buffer;
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: '缺少图片文件（multipart 字段名 file）' });
      try {
        buf = await file.toBuffer();
      } catch {
        return reply.code(413).send({ error: '图片超过 20MB 上限' });
      }
    } else {
      const raw = (req.body as { image?: string } | undefined)?.image ?? '';
      const b64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
      if (!b64) return reply.code(400).send({ error: '需要 image 字段（base64 字符串或 data URL）' });
      buf = Buffer.from(b64, 'base64');
      if (buf.length === 0) return reply.code(400).send({ error: 'base64 解码结果为空' });
      if (buf.length > MAX_BYTES) return reply.code(413).send({ error: '图片超过 20MB 上限' });
    }

    // 先查模型，避免白加载 CLIP（首次加载数百 MB）
    if (!loadModel()) return reply.code(409).send({ error: '模型尚未训练，请先在「模型与偏好」页训练' });

    // 格式校验：仅静态 jpg/png/webp，拒绝 gif 与动图（与站内「动图永不处理」一致）
    const sniffed = sniffImage(buf);
    if (!sniffed) return reply.code(400).send({ error: '仅支持静态 jpg / png / webp（不支持 gif 与其他格式）' });
    if (sniffed.animated) return reply.code(400).send({ error: '不支持动图' });

    const tmpDir = path.join(config.dataDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `like-${crypto.randomUUID()}.${sniffed.format === 'jpeg' ? 'jpg' : sniffed.format}`);
    fs.writeFileSync(tmp, buf);
    try {
      const vec = await embedImage(tmp);
      const r = predictExternal(vec);
      if (!r) return reply.code(409).send({ error: '模型尚未训练，请先在「模型与偏好」页训练' });
      return { score: r.score, like: r.score >= 0.5, model_version: r.version };
    } catch (err) {
      return reply.code(422).send({ error: `图片处理失败: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
}
