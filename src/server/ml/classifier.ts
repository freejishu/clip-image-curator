import { db, getMeta, setMeta } from '../db.js';
import { embedImage } from './embed.js';
import { resolveStoredPath } from '../storage/backend.js';

/** 逻辑回归模型（纯 TS 实现，梯度下降） */
export interface Model {
  version: number;
  vocab: string[];          // tag one-hot 词表
  dim: number;              // embedding 维度
  weights: number[];        // dim + vocab.length
  bias: number;
  trainedAt: string;
  samples: number;
}

const TAG_VOCAB_SIZE = 200;

function buildVocab(): string[] {
  const rows = db.prepare(`
    SELECT tags FROM images WHERE user_label IN ('like','dislike')
  `).all() as { tags: string }[];
  const freq = new Map<string, number>();
  for (const r of rows) {
    for (const t of JSON.parse(r.tags) as string[]) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, TAG_VOCAB_SIZE).map(([t]) => t);
}

function featurize(embedding: Float32Array, tags: string[], vocab: string[], dim: number): number[] {
  const feat = new Array<number>(dim + vocab.length).fill(0);
  for (let i = 0; i < dim && i < embedding.length; i++) feat[i] = embedding[i];
  const tagSet = new Set(tags);
  vocab.forEach((t, i) => { if (tagSet.has(t)) feat[dim + i] = 1; });
  return feat;
}

function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

export async function ensureEmbedding(imageId: number): Promise<Float32Array | null> {
  const row = db.prepare('SELECT embedding, local_path FROM images WHERE id = ?').get(imageId) as
    { embedding: Buffer | null; local_path: string | null } | undefined;
  if (!row?.local_path) return null;
  if (row.embedding) return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4);
  try {
    const vec = await embedImage(resolveStoredPath(row.local_path));
    db.prepare('UPDATE images SET embedding = ? WHERE id = ?').run(Buffer.from(vec.buffer), imageId);
    return vec;
  } catch (err) {
    // 坏图（CMYK/损坏 JPEG 等 libvips 无法解码的）跳过，不拖垮整轮训练
    console.warn(`[embed] 跳过无法解码的图片 id=${imageId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export interface TrainResult { version: number; samples: number; likes: number; dislikes: number; scored: number }

export async function train(onProgress?: (msg: string) => void): Promise<TrainResult> {
  onProgress?.('加载 CLIP 模型并准备样本…'); // 模型加载（数百 MB）期间给前端一个真实状态
  const labeled = db.prepare(`
    SELECT id, tags, user_label FROM images
    WHERE user_label IN ('like','dislike') AND local_path IS NOT NULL
  `).all() as { id: number; tags: string; user_label: string }[];

  const vocab = buildVocab();
  const X: number[][] = [];
  const y: number[] = [];
  let dim = 0;
  for (const row of labeled) {
    const vec = await ensureEmbedding(row.id);
    if (!vec) continue;
    dim = vec.length;
    X.push(featurize(vec, JSON.parse(row.tags) as string[], vocab, dim));
    y.push(row.user_label === 'like' ? 1 : 0);
    onProgress?.(`embedding ${X.length}/${labeled.length}`);
    await new Promise(r => setImmediate(r)); // 让出事件循环：HTTP 轮询不被向量化的重计算饿死
  }
  if (X.length < 10) throw new Error(`标注样本不足（${X.length}），至少需要 10 条喜欢/不喜欢标注`);

  const n = X.length, d = X[0].length;
  const weights = new Array<number>(d).fill(0);
  let bias = 0;
  const lr = 0.5, l2 = 1e-4, epochs = 400;
  for (let e = 0; e < epochs; e++) {
    const grad = new Array<number>(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      const xi = X[i];
      for (let j = 0; j < d; j++) z += weights[j] * xi[j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) grad[j] += err * xi[j];
      gb += err;
    }
    for (let j = 0; j < d; j++) weights[j] -= lr * (grad[j] / n + l2 * weights[j]);
    bias -= lr * gb / n;
  }

  const version = Number(getMeta('model_version') ?? '0') + 1;
  const model: Model = {
    version, vocab, dim, weights, bias,
    trainedAt: new Date().toISOString(), samples: n,
  };
  setMeta('model', JSON.stringify(model));
  setMeta('model_version', String(version));

  // 全量重打分（未标注 + 已标注都更新，便于审查页）
  const all = db.prepare('SELECT id, tags FROM images WHERE local_path IS NOT NULL').all() as { id: number; tags: string }[];
  let scored = 0;
  for (const row of all) {
    const vec = await ensureEmbedding(row.id);
    if (!vec) continue;
    const p = predictWith(model, featurize(vec, JSON.parse(row.tags) as string[], vocab, dim));
    db.prepare('UPDATE images SET pred_score = ?, pred_version = ? WHERE id = ?').run(p, version, row.id);
    scored++;
    if (scored % 50 === 0) onProgress?.(`scoring ${scored}/${all.length}`);
    await new Promise(r => setImmediate(r)); // 让出事件循环
  }

  const likes = y.filter(v => v === 1).length;
  return { version, samples: n, likes, dislikes: n - likes, scored };
}

function predictWith(model: Model, feat: number[]): number {
  let z = model.bias;
  for (let j = 0; j < model.weights.length; j++) z += model.weights[j] * (feat[j] ?? 0);
  return sigmoid(z);
}

/** 任务完成后自动给新图/旧模型版本图打分（有模型时） */
export async function scoreUnscored(onProgress?: (msg: string) => void): Promise<number> {
  const model = loadModel();
  if (!model) return 0;
  const rows = db.prepare(`
    SELECT id, tags FROM images
    WHERE local_path IS NOT NULL AND (pred_version IS NULL OR pred_version < ?)
  `).all(model.version) as { id: number; tags: string }[];
  let scored = 0;
  for (const row of rows) {
    const vec = await ensureEmbedding(row.id);
    if (!vec) continue;
    const p = predictWith(model, featurize(vec, JSON.parse(row.tags) as string[], model.vocab, model.dim));
    db.prepare('UPDATE images SET pred_score = ?, pred_version = ? WHERE id = ?').run(p, model.version, row.id);
    scored++;
    if (scored % 20 === 0) onProgress?.(`auto-scoring ${scored}/${rows.length}`);
    await new Promise(r => setImmediate(r)); // 让出事件循环
  }
  return scored;
}

export function loadModel(): Model | null {
  const raw = getMeta('model');
  return raw ? (JSON.parse(raw) as Model) : null;
}

/** 导出模型（迁移/备份用）：模型本体 + 版本号；未训练返回 null */
export function exportModel(): { model: Model; model_version: string } | null {
  const raw = getMeta('model');
  if (!raw) return null;
  const model = JSON.parse(raw) as Model;
  return { model, model_version: getMeta('model_version') ?? String(model.version) };
}

/** 导入模型（覆盖现有模型，立即生效）：结构校验后写入 meta；数据非法抛错 */
export function importModel(payload: unknown): { version: number; samples: number } {
  const m = (payload as { model?: unknown } | null)?.model ?? payload;
  const fail = (msg: string): never => { throw new Error(msg); };
  if (!m || typeof m !== 'object') fail('不是有效的模型文件');
  const model = m as Partial<Model>;
  if (!Number.isFinite(model.version) || (model.version as number) <= 0) fail('缺少有效的 version');
  if (!Number.isFinite(model.dim) || (model.dim as number) <= 0) fail('缺少有效的 dim');
  if (!Array.isArray(model.vocab) || model.vocab.some(t => typeof t !== 'string')) fail('vocab 必须是字符串数组');
  if (!Array.isArray(model.weights) || model.weights.some(w => typeof w !== 'number' || !Number.isFinite(w))) fail('weights 必须是数字数组');
  if ((model.weights as number[]).length !== (model.dim as number) + (model.vocab as string[]).length)
    fail(`weights 长度 ${(model.weights as number[]).length} 与 dim(${model.dim})+vocab(${(model.vocab as string[]).length}) 不符`);
  if (typeof model.bias !== 'number' || !Number.isFinite(model.bias)) fail('缺少有效的 bias');
  const normalized: Model = {
    version: model.version as number,
    vocab: model.vocab as string[],
    dim: model.dim as number,
    weights: model.weights as number[],
    bias: model.bias as number,
    trainedAt: typeof model.trainedAt === 'string' ? model.trainedAt : new Date().toISOString(),
    samples: Number.isFinite(model.samples) ? (model.samples as number) : 0,
  };
  setMeta('model', JSON.stringify(normalized));
  setMeta('model_version', String(normalized.version));
  return { version: normalized.version, samples: normalized.samples };
}

/** 外置预测（「我喜欢这个图片！」API）：外部图片无 tags，tag one-hot 特征全 0；模型未训练返回 null */
export function predictExternal(embedding: Float32Array): { score: number; version: number } | null {
  const model = loadModel();
  if (!model) return null;
  return { score: predictWith(model, featurize(embedding, [], model.vocab, model.dim)), version: model.version };
}

/** 偏好解释：tag 特征权重排行 */
export function tagPreferences(model: Model, top = 20): { positive: [string, number][]; negative: [string, number][] } {
  const tagWeights = model.weights.slice(model.dim).map((w, i) => [model.vocab[i], w] as [string, number]);
  tagWeights.sort((a, b) => b[1] - a[1]);
  return {
    positive: tagWeights.filter(([, w]) => w > 0).slice(0, top),
    negative: tagWeights.filter(([, w]) => w < 0).slice(-top).reverse(),
  };
}
