import zlib from 'node:zlib';
import type { SourcePlugin, ImageMeta, SearchQuery, FetchOpts } from './types.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 生成 128x128 渐变 PNG（不同 seed 不同颜色），无需任何原生依赖 */
export function makePng(seed: number): Buffer {
  const w = 128, h = 128;
  const raw = Buffer.alloc(h * (1 + w * 3));
  const r0 = (seed * 97) % 256, g0 = (seed * 57) % 256, b0 = (seed * 37) % 256;
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[o++] = (r0 + x) % 256;
      raw[o++] = (g0 + y) % 256;
      raw[o++] = b0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TAG_POOL = ['seifuku', 'skirt', 'bare_legs', 'landscape', 'cat_girl'];

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
        tags, width: 128, height: 128, rating: 's',
      });
      if (batch.length >= 50) { yield batch.splice(0); }
    }
    if (batch.length) yield batch;
  },
  async fetchImage(meta: ImageMeta) {
    const seed = Number(meta.sourceId.split('_').pop() ?? 0);
    return makePng(seed);
  },
};
