// 特征消融实验：纯画面(CLIP) vs 纯tag vs 混合，80/20 留出准确率
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/curator.db');
const rows = db.prepare(`
  SELECT id, tags, user_label, embedding FROM images
  WHERE user_label IN ('like','dislike') AND embedding IS NOT NULL
`).all();
console.log(`带向量的标注样本: ${rows.length}`);

const dim = 512;
const freq = new Map();
for (const r of rows) for (const t of JSON.parse(r.tags)) freq.set(t, (freq.get(t) ?? 0) + 1);
const vocab = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([t]) => t);

function featurize(row, mode) {
  const emb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4);
  const tags = new Set(JSON.parse(row.tags));
  const feat = [];
  if (mode !== 'tags') for (let i = 0; i < dim; i++) feat.push(emb[i]);
  if (mode !== 'clip') for (const t of vocab) feat.push(tags.has(t) ? 1 : 0);
  return feat;
}

function trainLR(X, y, epochs = 400, lr = 0.5, l2 = 1e-4) {
  const d = X[0].length, n = X.length;
  const w = new Array(d).fill(0); let b = 0;
  const sig = z => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
  for (let e = 0; e < epochs; e++) {
    const g = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = sig(z) - y[i];
      for (let j = 0; j < d; j++) g[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / n + l2 * w[j]);
    b -= lr * gb / n;
  }
  return { w, b };
}

function evalMode(mode, seed) {
  const idx = rows.map((_, i) => i);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const cut = Math.floor(idx.length * 0.8);
  const train = idx.slice(0, cut), test = idx.slice(cut);
  const Xtr = train.map(i => featurize(rows[i], mode)), ytr = train.map(i => rows[i].user_label === 'like' ? 1 : 0);
  const { w, b } = trainLR(Xtr, ytr);
  const sig = z => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
  let correct = 0;
  for (const i of test) {
    const x = featurize(rows[i], mode);
    let z = b; for (let j = 0; j < x.length; j++) z += w[j] * x[j];
    if ((sig(z) >= 0.5 ? 1 : 0) === (rows[i].user_label === 'like' ? 1 : 0)) correct++;
  }
  return correct / test.length;
}

for (const mode of ['clip', 'tags', 'both']) {
  const accs = [1, 2, 3].map(s => evalMode(mode, s));
  console.log(`${mode.padEnd(5)} 准确率: ${accs.map(a => (a * 100).toFixed(1) + '%').join(' / ')}  平均 ${(accs.reduce((a, b) => a + b) / 3 * 100).toFixed(1)}%`);
}
