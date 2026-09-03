import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';

type ZeroShotPipeline = (image: string, labels: string[]) => Promise<{ score: number; label: string }[]>;
let pipe: ZeroShotPipeline | null = null;
let loading: Promise<ZeroShotPipeline> | null = null;

async function load(): Promise<ZeroShotPipeline> {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = path.join(config.dataDir, 'models');
  const p = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', { dtype: 'q8' });
  return p as unknown as ZeroShotPipeline;
}

function getPipe(): Promise<ZeroShotPipeline> {
  if (pipe) return Promise.resolve(pipe);
  if (!loading) loading = load().then(p => (pipe = p));
  return loading;
}

/** 冷启动：无标注时用 CLIP zero-shot 给未标注图打粗分，写入 pred_score(pred_version=0) */
export async function zeroshotScoreAll(limit = 200, onProgress?: (msg: string) => void): Promise<number> {
  const labels = [...config.zeroshot.positive, ...config.zeroshot.negative];
  const rows = db.prepare(`
    SELECT id, local_path FROM images
    WHERE local_path IS NOT NULL AND user_label IS NULL AND (pred_version IS NULL OR pred_version = 0)
    LIMIT ?
  `).all(limit) as { id: number; local_path: string }[];
  const p = await getPipe();
  let done = 0;
  for (const row of rows) {
    const out = await p(row.local_path, labels);
    const pos = out.filter(o => config.zeroshot.positive.includes(o.label));
    const score = pos.length ? Math.max(...pos.map(o => o.score)) : 0;
    db.prepare('UPDATE images SET pred_score = ?, pred_version = 0 WHERE id = ?').run(score, row.id);
    done++;
    if (done % 10 === 0) onProgress?.(`zeroshot ${done}/${rows.length}`);
  }
  return done;
}
