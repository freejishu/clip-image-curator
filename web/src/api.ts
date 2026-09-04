export interface NextImage {
  id: number; source: string; source_id: string; page_url: string;
  tags: string[]; pred_score: number | null;
}
export interface Task {
  id: number; source: string; query: string; status: string;
  fetched: number; downloaded: number; target: number; seen: number; error: string | null; updated_at: string;
}
export interface Stats {
  total: number; downloaded: number; liked: number; disliked: number;
  skipped: number; unlabeled: number; withEmbedding: number;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  next: (mode: string) => req<{ done: boolean; image?: NextImage; remaining?: number }>(`/api/images/next?mode=${mode}`),
  label: (id: number, label: string) => req(`/api/images/${id}/label`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) }),
  tasks: () => req<Task[]>('/api/tasks'),
  sources: () => req<{ name: string; enabled: boolean }[]>('/api/sources'),
  createTask: (source: string, tags: string[], limit: number, proxy: string) =>
    req<{ id: number }>('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, tags, limit, proxy: proxy || null }) }),
  pauseTask: (id: number) => req(`/api/tasks/${id}/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  resumeTask: (id: number) => req(`/api/tasks/${id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  stats: () => req<Stats>('/api/stats'),
  train: () => req('/api/train', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  zeroshot: () => req('/api/zeroshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  trainStatus: () => req<{ status: string; progress: string; result?: { version?: number; samples?: number; scored?: number }; error?: string }>('/api/train/status'),
  preferences: () => req<{ trained: boolean; version?: number; samples?: number; positive?: [string, number][]; negative?: [string, number][] }>('/api/preferences'),
  list: (params: string) => req<(NextImage & { user_label: string | null })[]>(`/api/images?${params}`),
};
