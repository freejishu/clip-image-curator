import path from 'node:path';
import { config } from '../config.js';

// 国内网络走镜像下载模型
if (!process.env.HF_ENDPOINT && !process.env.HF_HUB_OFFLINE) {
  process.env.HF_ENDPOINT = 'https://hf-mirror.com';
}

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const cacheDir = path.join(config.dataDir, 'models');

type FeaturePipeline = (input: string) => Promise<{ data: Float32Array }>;
let featurePipe: FeaturePipeline | null = null;
let loading: Promise<FeaturePipeline> | null = null;

async function loadFeaturePipeline(): Promise<FeaturePipeline> {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir; env.localModelPath = cacheDir;
  const p = await pipeline('image-feature-extraction', MODEL_ID, { dtype: 'q8' });
  return p as unknown as FeaturePipeline;
}

/** 懒加载 CLIP 特征提取管线（首次触发会下载约 350MB 模型到 data/models）。
 *  加载失败时重置 loading 允许下次重试——否则一次瞬断会让本进程永久无法 embedding（只能重启恢复） */
export function getFeaturePipeline(): Promise<FeaturePipeline> {
  if (featurePipe) return Promise.resolve(featurePipe);
  if (!loading) {
    loading = loadFeaturePipeline().then(p => (featurePipe = p));
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** 计算 L2 归一化的图像 embedding（512 维） */
export async function embedImage(imagePath: string): Promise<Float32Array> {
  const pipe = await getFeaturePipeline();
  const out = await pipe(imagePath);
  return normalize(out.data);
}

/** 从内存 buffer 直接 embedding（不落盘，供过滤模式用）。
 *  注意：此路径会加载 transformers 内嵌的 sharp，必须先于任何顶层 sharp 使用（libvips 加载顺序坑）。 */
export async function embedImageBuffer(buf: Buffer): Promise<Float32Array> {
  const { RawImage } = await import('@huggingface/transformers');
  const img = await RawImage.fromBlob(new Blob([new Uint8Array(buf)]));
  const pipe = await getFeaturePipeline();
  const out = await pipe(img as unknown as string);
  return normalize(out.data);
}

function normalize(data: Float32Array): Float32Array {
  const vec = new Float32Array(data);
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}
