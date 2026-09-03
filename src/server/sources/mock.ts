import type { SourcePlugin, ImageMeta, SearchQuery, FetchOpts } from './types.js';

/** 生成 64x64 纯色 24-bit BMP */
export function makeBmp(seed: number): Buffer {
  const w = 64, h = 64, rowSize = w * 3, imgSize = rowSize * h, fileSize = 54 + imgSize;
  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(imgSize, 34);
  const r = (seed * 97) % 256, g = (seed * 57) % 256, b = (seed * 37) % 256;
  for (let i = 54; i < fileSize; i += 3) { buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; }
  return buf;
}

const TAG_POOL = ['seifuku', 'skirt', 'bare_legs', 'thighhighs', 'black_thighhighs'];

export const mock: SourcePlugin = {
  name: 'mock',
  async *search(query: SearchQuery, opts: FetchOpts) {
    const batch: ImageMeta[] = [];
    for (let i = 0; i < query.limit; i++) {
      if (opts.shouldContinue && !opts.shouldContinue()) { if (batch.length) yield batch; return; }
      // 一半带目标 tag，制造可学习的信号
      const tags = [...TAG_POOL.filter(() => Math.random() < 0.3)];
      if (i % 2 === 0) tags.push(...query.tags);
      batch.push({
        source: 'mock', sourceId: `${Date.now()}_${i}`,
        pageUrl: `mock://local/${i}`, fileUrl: `mock://img/${i}`,
        tags, width: 64, height: 64, rating: 's',
      });
      if (batch.length >= 50) { yield batch.splice(0); }
    }
    if (batch.length) yield batch;
  },
  async fetchImage(meta: ImageMeta) {
    const seed = Number(meta.sourceId.split('_').pop() ?? 0);
    return makeBmp(seed);
  },
};
