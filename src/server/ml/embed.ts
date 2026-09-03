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

/** 懒加载 CLIP 特征提取管线（首次触发会下载约 350MB 模型到 data/models） */
export function getFeaturePipeline(): Promise<FeaturePipeline> {
  if (featurePipe) return Promise.resolve(featurePipe);
  if (!loading) loading = loadFeaturePipeline().then(p => (featurePipe = p));
  return loading;
}

/** 计算 L2 归一化的图像 embedding（512 维） */
export async function embedImage(imagePath: string): Promise<Float32Array> {
  const pipe = await getFeaturePipeline();
  const out = await pipe(imagePath);
  const vec = new Float32Array(out.data);
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}
