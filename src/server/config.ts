import fs from 'node:fs';
import path from 'node:path';

export interface SourceConfig { enabled: boolean; proxy?: string | null; cookie?: string | null }
export interface CompressionRule { enabled: boolean; mode: 'scale' | 'maxSize'; scalePercent: number; maxSizeMB: number }
export interface FormatRule { enabled: string[]; convertTo: string }
export interface ImageProcessRule { compression: CompressionRule; formats: FormatRule }
export interface AppConfig {
  port: number;
  host?: string;
  dataDir: string;
  proxy: string | null;
  trainThreshold: number;
  storage: { type: string; incoming: string; favorites: string };
  sources: Record<string, SourceConfig>;
  archiveRules?: { folder: string; tags: string[] }[];
  zeroshot: { positive: string[]; negative: string[] };
  /** 按后端类型（local/webdav...）分别配置的图片转换+压缩规则，缺省 = 不处理 */
  imageProcess?: Record<string, ImageProcessRule>;
}

function readJson(p: string): AppConfig {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')) as AppConfig;
}

const root = process.cwd();
const cfgPath = path.join(root, 'config.json');
const examplePath = path.join(root, 'config.example.json');
const raw = readJson(fs.existsSync(cfgPath) ? cfgPath : examplePath);

export const config: AppConfig = {
  ...raw,
  dataDir: path.resolve(root, raw.dataDir),
  storage: {
    ...raw.storage,
    incoming: path.resolve(root, raw.storage.incoming),
    favorites: path.resolve(root, raw.storage.favorites),
  },
};

for (const dir of [config.dataDir, config.storage.incoming, config.storage.favorites]) {
  fs.mkdirSync(dir, { recursive: true });
}
