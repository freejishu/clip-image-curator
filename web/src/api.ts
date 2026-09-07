export interface NextImage {
  id: number; source: string; source_id: string; page_url: string;
  tags: string[]; pred_score: number | null;
}
export interface Task {
  id: number; source: string; query: string; status: string;
  fetched: number; downloaded: number; target: number; seen: number; error: string | null; updated_at: string;
  created_at?: string; finished_at?: string | null;
}
export interface Stats {
  total: number; downloaded: number; liked: number; disliked: number;
  skipped: number; unlabeled: number; withEmbedding: number;
}
export interface CompressionRule { enabled: boolean; mode: 'scale' | 'maxSize'; scalePercent: number; maxSizeMB: number }
export interface FormatRule { enabled: string[]; convertTo: string }
export interface StorageRow {
  type: string; name: string; incoming: string; favorites: string;
  freeBytes: number; totalBytes: number;
  process: { compression: CompressionRule; formats: FormatRule };
  formatOptions: { common: string[]; convertTargets: string[] };
}
export interface ReprocessStatus {
  running: boolean; phase: string; done: number; total: number;
  processed: number; skipped: number; failed: number; savedBytes: number; error: string;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  next: (mode: string) => req<{ done: boolean; image?: NextImage; remaining?: number; group?: NextImage[] }>(`/api/images/next?mode=${mode}`),
  label: (id: number, label: string) => req<{ ok: boolean; affected: number[] }>(`/api/images/${id}/label`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) }),
  tasks: () => req<Task[]>('/api/tasks'),
  sources: () => req<{ name: string; enabled: boolean; caps: { fetchPost: boolean; fetchFamily: boolean } }[]>('/api/sources'),
  createTask: (source: string, tags: string[], limit: number, proxy: string) =>
    req<{ id: number }>('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, tags, limit, proxy: proxy || null }) }),
  pauseTask: (id: number) => req(`/api/tasks/${id}/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  resumeTask: (id: number) => req(`/api/tasks/${id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  stats: () => req<Stats>('/api/stats'),
  train: () => req('/api/train', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  zeroshot: () => req('/api/zeroshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  trainStatus: () => req<{ status: string; progress: string; result?: { version?: number; samples?: number; scored?: number }; error?: string }>('/api/train/status'),
  preferences: () => req<{ trained: boolean; version?: number; samples?: number; positive?: [string, number][]; negative?: [string, number][] }>('/api/preferences'),
  album: () => req<(NextImage & { parent_id: number | null; labeled_at: string | null; created_at: string; group_key: string | null; in_manual: boolean; is_cover: boolean })[]>('/api/album'),
  setCover: (imageId: number) => req<{ ok: boolean; members: number[] }>('/api/groups/cover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_id: imageId }) }),
  bindGroup: (imageIds: number[]) => req<{ ok: boolean; group_id: number }>('/api/groups/bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_ids: imageIds }) }),
  unbindGroup: (imageId: number) => req<{ ok: boolean }>('/api/groups/unbind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_id: imageId }) }),
  fetchSiblings: (id: number) => req<{ ok: boolean; family: number; added: number; liked: number; failed: number; message?: string }>(`/api/images/${id}/fetch-siblings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  backfillParents: () => req('/api/backfill-parents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  backfillStatus: () => req<{ running: boolean; done: number; total: number }>('/api/backfill-status'),
  cleanupNopath: () => req<{ deleted: number }>('/api/cleanup-nopath', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  list: (params: string) => req<{ total: number; page: number; size: number; rows: (NextImage & { user_label: string | null })[] }>(`/api/images?${params}`),
  settings: () => req<{ dataDir: string; incoming: string; favorites: string; thumbs: string; models: string }>('/api/settings'),
  setDataDir: (p: string) => req<{ mode: 'use-existing' | 'empty'; needRestart?: boolean }>('/api/settings/data-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) }),
  migrateDataDir: (p: string) => req<{ ok: boolean }>('/api/settings/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) }),
  migrateStatus: () => req<{ running: boolean; phase: string; done: number; total: number; error: string }>('/api/settings/migrate-status'),
  restart: () => req<{ ok: boolean }>('/api/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  storages: () => req<StorageRow[]>('/api/storages'),
  saveCompression: (type: string, c: CompressionRule) => req<{ ok: boolean }>(`/api/storages/${type}/compression`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) }),
  saveFormats: (type: string, f: FormatRule) => req<{ ok: boolean }>(`/api/storages/${type}/formats`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) }),
  processExisting: (type: string) => req<{ ok: boolean }>(`/api/storages/${type}/process-existing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  processStatus: () => req<ReprocessStatus>('/api/storages/process-status'),
};
