import { config } from '../config.js';
import type { SourcePlugin } from './types.js';
import { yandere } from './yandere.js';
import { mock } from './mock.js';

const registry: Record<string, SourcePlugin> = { yandere, mock };

export function getSource(name: string): SourcePlugin {
  const plugin = registry[name];
  if (!plugin) throw new Error(`未知数据源: ${name}`);
  const cfg = config.sources[name];
  if (cfg && !cfg.enabled) throw new Error(`数据源未启用: ${name}`);
  return plugin;
}

export interface SourceInfo {
  name: string;
  enabled: boolean;
  /** 可选能力：parent_id 回填（fetchPost）、补全父子家族（fetchFamily） */
  caps: { fetchPost: boolean; fetchFamily: boolean };
}

function capsOf(p: SourcePlugin): SourceInfo['caps'] {
  return { fetchPost: typeof p.fetchPost === 'function', fetchFamily: typeof p.fetchFamily === 'function' };
}

export function listSources(): SourceInfo[] {
  return Object.entries(registry).map(([name, p]) => ({ name, enabled: config.sources[name]?.enabled ?? true, caps: capsOf(p) }));
}

/** 具备某可选能力的已启用数据源名列表（如 backfill 只处理支持 fetchPost 的源） */
export function sourcesWith(cap: keyof SourceInfo['caps']): string[] {
  return Object.entries(registry)
    .filter(([name, p]) => (config.sources[name]?.enabled ?? true) && capsOf(p)[cap])
    .map(([name]) => name);
}
