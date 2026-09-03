import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { SourcePlugin, ImageMeta, SearchQuery, FetchOpts } from './types.js';

export function makeAgent(proxy?: string | null) {
  if (!proxy) return undefined;
  if (proxy.startsWith('socks')) return new SocksProxyAgent(proxy);
  return new HttpsProxyAgent(proxy);
}

function client(proxy?: string | null): AxiosInstance {
  const agent = makeAgent(proxy);
  return axios.create({
    baseURL: 'https://yande.re',
    timeout: 30_000,
    httpAgent: agent,
    httpsAgent: agent,
    headers: { 'User-Agent': 'image-curator/0.1 (personal use)' },
  });
}

interface YanderePost {
  id: number;
  file_url: string;
  preview_url?: string;
  tags: string;
  image_width?: number;
  image_height?: number;
  rating?: string;
}

export const yandere: SourcePlugin = {
  name: 'yandere',

  async *search(query: SearchQuery, opts: FetchOpts) {
    const http = client(opts.proxy);
    const perPage = 100;
    let page = 1;
    let yielded = 0;
    while (yielded < query.limit) {
      if (opts.shouldContinue && !opts.shouldContinue()) return;
      const { data } = await http.get<YanderePost[]>('/post.json', {
        params: { tags: query.tags.join(' '), limit: perPage, page },
      });
      if (!Array.isArray(data)) {
        const reason = (data as { reason?: string; error?: string })?.reason ?? (data as { error?: string })?.error ?? JSON.stringify(data).slice(0, 200);
        throw new Error(`yande.re API 返回错误: ${reason}`);
      }
      if (data.length === 0) return;
      const batch: ImageMeta[] = [];
      for (const p of data) {
        if (yielded >= query.limit) break;
        if (!p.file_url) continue;
        batch.push({
          source: 'yandere',
          sourceId: String(p.id),
          pageUrl: `https://yande.re/post/show/${p.id}`,
          fileUrl: p.file_url,
          previewUrl: p.preview_url,
          tags: (p.tags ?? '').split(/\s+/).filter(Boolean),
          width: p.image_width,
          height: p.image_height,
          rating: p.rating,
        });
        yielded++;
      }
      yield batch;
      if (data.length < perPage) return;
      page++;
      await new Promise(r => setTimeout(r, 1200)); // 礼貌限速
    }
  },

  async fetchImage(meta: ImageMeta, opts: FetchOpts) {
    const http = client(opts.proxy);
    const resp = await http.get<ArrayBuffer>(meta.fileUrl, { responseType: 'arraybuffer', timeout: 60_000 });
    return Buffer.from(resp.data as ArrayBuffer);
  },
};
