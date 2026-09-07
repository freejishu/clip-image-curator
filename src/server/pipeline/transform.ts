import { config } from '../config.js';
import type { CompressionRule, FormatRule, ImageProcessRule } from '../config.js';

export type { CompressionRule, FormatRule, ImageProcessRule };

/** 可供启用的常见格式（jpg = jpeg） */
export const COMMON_FORMATS = ['jpg', 'png', 'webp', 'gif', 'bmp', 'avif'] as const;
/** 转换目标可选格式：不允许转为 gif（动图语义不同） */
export const CONVERT_TARGETS = ['webp', 'jpg', 'png', 'avif'] as const;

const FMT_TO_EXT: Record<string, string> = { jpg: '.jpg', png: '.png', webp: '.webp', gif: '.gif', avif: '.avif' };

const QUALITY = 80;      // 有损输出统一质量
const TOLERANCE = 1.05;  // 最大体积模式允许 5% 误差

export function defaultImageProcess(): ImageProcessRule {
  return {
    compression: { enabled: false, mode: 'scale', scalePercent: 80, maxSizeMB: 2 },
    formats: { enabled: ['jpg', 'png', 'webp', 'gif', 'bmp'], convertTo: 'webp' },
  };
}

/** 取某后端类型的处理规则（无配置 → 全默认 = 不处理）；每次调用实时读 config，改设置无需重启 */
export function ruleFor(backendType: string): ImageProcessRule {
  const d = defaultImageProcess();
  const r = config.imageProcess?.[backendType];
  if (!r) return d;
  return {
    compression: { ...d.compression, ...r.compression },
    formats: { ...d.formats, ...r.formats },
  };
}

/** 规则指纹：批量处理幂等标记（同一指纹不重复处理，规则变更才会重处理） */
export function ruleFingerprint(rule: ImageProcessRule): string {
  return JSON.stringify(rule);
}

export interface ProcessResult { buf: Buffer; filename: string; changed: boolean; steps: string[] }

/**
 * 入库前统一处理（全程内存完成，调用方负责一次性写盘）：
 * 1) 格式转换：不在启用列表 → 转为 convertTo；2) 压缩：尺寸固定比例 / 最大单张体积
 * 动图（多帧 gif/webp）不处理；无法解码/无法编码时保留原图，绝不丢数据
 */
export async function processImage(buf: Buffer, filename: string, rule: ImageProcessRule): Promise<ProcessResult> {
  const sharp = (await import('sharp')).default;
  const steps: string[] = [];
  let meta: import('sharp').Metadata;
  try { meta = await sharp(buf).metadata(); } catch { return { buf, filename, changed: false, steps: ['无法解码，跳过'] }; }
  if (!meta.format || (meta.pages ?? 1) > 1) return { buf, filename, changed: false, steps }; // 动图不处理
  const srcFmt = meta.format === 'jpeg' ? 'jpg' : meta.format;
  let fmt = srcFmt;
  let out = buf;
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;

  // 1. 格式转换
  if (!rule.formats.enabled.includes(fmt)) {
    const target = rule.formats.convertTo;
    if (target !== 'gif' && (CONVERT_TARGETS as readonly string[]).includes(target) && target !== fmt) {
      try {
        out = await encode(sharp(buf), target);
        fmt = target;
        steps.push(`格式 ${srcFmt} → ${target}`);
      } catch { out = buf; steps.push(`格式转换失败，保留 ${srcFmt}`); }
    }
  }

  // 2. 压缩
  if (rule.compression.enabled && w > 0 && h > 0) {
    if (rule.compression.mode === 'scale') {
      const p = Math.min(Math.max(rule.compression.scalePercent, 1), 100) / 100;
      if (p < 1) {
        try {
          out = await encode(sharp(out).resize(Math.max(1, Math.round(w * p)), Math.max(1, Math.round(h * p))), fmt);
          steps.push(`尺寸 ×${rule.compression.scalePercent}%`);
        } catch { steps.push('压缩失败，保留压缩前结果'); }
      }
    } else {
      const target = rule.compression.maxSizeMB * 1024 * 1024;
      if (out.length > target) {
        // 同格式同质量下体积 ≈ k·像素数 → 缩放比 = √(目标/现体积)；实测修正，最多 3 次编码（达标即停，不空耗 CPU）
        let scale = Math.sqrt(target / out.length) * 0.98; // 留 2% 余量抵消估计偏差
        try {
          for (let i = 0; i < 3; i++) {
            const cand = await encode(sharp(out).resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))), fmt);
            if (cand.length <= target * TOLERANCE || i === 2) { out = cand; break; }
            scale *= Math.sqrt(target / cand.length) * 0.98;
          }
          steps.push(`限 ${rule.compression.maxSizeMB}MB → ${(out.length / 1048576).toFixed(2)}MB`);
        } catch { steps.push('压缩失败，保留压缩前结果'); }
      }
    }
  }

  const changed = out !== buf;
  const newName = changed && fmt !== srcFmt && FMT_TO_EXT[fmt]
    ? filename.replace(/\.[^.]+$/, '') + FMT_TO_EXT[fmt]
    : filename;
  return { buf: out, filename: newName, changed, steps };
}

/** 按目标格式编码（质量 80）；不支持的输出格式（如 bmp）抛错，由调用方保留原图 */
async function encode(p: import('sharp').Sharp, fmt: string): Promise<Buffer> {
  switch (fmt) {
    case 'jpg': return p.jpeg({ quality: QUALITY }).toBuffer();
    case 'webp': return p.webp({ quality: QUALITY }).toBuffer();
    case 'avif': return p.avif({ quality: QUALITY }).toBuffer();
    case 'png': return p.png({ compressionLevel: 9 }).toBuffer();
    case 'gif': return p.gif().toBuffer();
    default: throw new Error(`不支持编码为 ${fmt}`);
  }
}
