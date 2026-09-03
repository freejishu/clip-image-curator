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

export function listSources(): { name: string; enabled: boolean }[] {
  return Object.keys(registry).map(name => ({ name, enabled: config.sources[name]?.enabled ?? true }));
}
