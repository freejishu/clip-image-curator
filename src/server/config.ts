import fs from 'node:fs';
import path from 'node:path';

export interface SourceConfig { enabled: boolean; proxy?: string | null }
export interface AppConfig {
  port: number;
  dataDir: string;
  proxy: string | null;
  trainThreshold: number;
  storage: { type: string; incoming: string; favorites: string };
  sources: Record<string, SourceConfig>;
  zeroshot: { positive: string[]; negative: string[] };
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
