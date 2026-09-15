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
export interface ApiDocParam { name: string; in: 'path' | 'query' | 'body'; type: string; required?: boolean; desc: string }
export interface ApiDocEndpoint { method: string; path: string; desc: string; params?: ApiDocParam[]; response?: string; notes?: string }
export interface ApiDocGroup { name: string; desc?: string; endpoints: ApiDocEndpoint[] }
export interface LikeResult { score: number; like: boolean; model_version: number }

// ---- 鉴权与服务器切换 ----
// Bearer token 方案（不用 Cookie：跨服务器登录时 Cookie 被 SameSite 挡死，http 下 SameSite=None 又是死路）。
// 不勾「记住我」→ sessionStorage（浏览器/标签页关即失效）；勾 → localStorage + 180 天到期时间戳。
// apiBase 为空串 = 本服务器（相对路径）；否则是用户输入的其他服务器地址（localStorage 持久化）。
const REMEMBER_MS = 180 * 86400_000;

let apiBase = localStorage.getItem('ic-server') ?? '';
let token = sessionStorage.getItem('ic-token') ?? '';
if (!token) {
  const t = localStorage.getItem('ic-token') ?? '';
  const exp = Number(localStorage.getItem('ic-token-exp') ?? 0);
  if (t && exp > Date.now()) token = t; // 记住我的 token 且未过期
  else { localStorage.removeItem('ic-token'); localStorage.removeItem('ic-token-exp'); }
}

let unauthorizedHandler: (() => void) | null = null;

export const auth = {
  get server(): string { return apiBase; },
  get token(): string { return token; },
  /** 401 时回调（App.vue 注册：清状态回登录页） */
  onUnauthorized(fn: () => void): void { unauthorizedHandler = fn; },
  /** 切换目标服务器（'' = 本服务器）。会持久化，下次打开仍是这台 */
  setServer(url: string): void {
    apiBase = url.trim().replace(/\/+$/, '');
    if (apiBase) localStorage.setItem('ic-server', apiBase);
    else localStorage.removeItem('ic-server');
  },
  setToken(t: string, remember: boolean): void {
    token = t;
    sessionStorage.removeItem('ic-token');
    localStorage.removeItem('ic-token');
    localStorage.removeItem('ic-token-exp');
    if (remember) {
      localStorage.setItem('ic-token', t);
      localStorage.setItem('ic-token-exp', String(Date.now() + REMEMBER_MS));
    } else {
      sessionStorage.setItem('ic-token', t);
    }
  },
  clear(): void {
    token = '';
    sessionStorage.removeItem('ic-token');
    localStorage.removeItem('ic-token');
    localStorage.removeItem('ic-token-exp');
  },
};

/** 图片等 <img> 标签用 URL：拼上 apiBase 与 ?token=（img 带不了 Authorization 头，服务端认 query token） */
export function imgUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${apiBase}${path}${sep}token=${encodeURIComponent(token)}`;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const r = await fetch(apiBase + url, { ...init, headers });
  if (r.status === 401) {
    auth.clear();
    unauthorizedHandler?.();
    throw new Error('未登录或登录已过期');
  }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

const post = (body?: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const put = (body: unknown) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  login: (username: string, password: string, remember: boolean) =>
    req<{ token: string; username: string; remember_days: number }>('/api/auth/login', post({ username, password, remember })),
  authStatus: () => req<{ authenticated: boolean; username?: string }>('/api/auth/status'),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', post()),
  changeUsername: (currentPassword: string, username: string) =>
    req<{ ok: boolean; username: string }>('/api/auth/username', put({ current_password: currentPassword, username })),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: boolean; relogin: boolean }>('/api/auth/password', put({ current_password: currentPassword, new_password: newPassword })),
  next: (mode: string) => req<{ done: boolean; image?: NextImage; remaining?: number; group?: NextImage[] }>(`/api/images/next?mode=${mode}`),
  label: (id: number, label: string) => req<{ ok: boolean; affected: number[] }>(`/api/images/${id}/label`, post({ label })),
  tasks: () => req<Task[]>('/api/tasks'),
  sources: () => req<{ name: string; enabled: boolean; caps: { fetchPost: boolean; fetchFamily: boolean } }[]>('/api/sources'),
  createTask: (source: string, tags: string[], limit: number, proxy: string, range?: { start: number; end: number }) =>
    req<{ id: number }>('/api/tasks', post({ source, tags, limit, proxy: proxy || null, ...(range ?? {}) })),
  pauseTask: (id: number) => req(`/api/tasks/${id}/pause`, post()),
  resumeTask: (id: number) => req(`/api/tasks/${id}/resume`, post()),
  stats: () => req<Stats>('/api/stats'),
  train: () => req('/api/train', post()),
  zeroshot: () => req('/api/zeroshot', post()),
  trainStatus: () => req<{ status: string; progress: string; result?: { version?: number; samples?: number; scored?: number }; error?: string }>('/api/train/status'),
  preferences: () => req<{ trained: boolean; version?: number; samples?: number; positive?: [string, number][]; negative?: [string, number][] }>('/api/preferences'),
  exportModel: () => req<{ model: { version: number; samples: number; trainedAt: string }; model_version: string }>('/api/model/export'),
  importModel: (data: unknown) => req<{ ok: boolean; version: number; samples: number }>('/api/model/import', post(data)),
  album: () => req<(NextImage & { parent_id: number | null; labeled_at: string | null; created_at: string; group_key: string | null; in_manual: boolean; is_cover: boolean })[]>('/api/album'),
  setCover: (imageId: number) => req<{ ok: boolean; members: number[] }>('/api/groups/cover', post({ image_id: imageId })),
  bindGroup: (imageIds: number[]) => req<{ ok: boolean; group_id: number }>('/api/groups/bind', post({ image_ids: imageIds })),
  unbindGroup: (imageId: number) => req<{ ok: boolean }>('/api/groups/unbind', post({ image_id: imageId })),
  fetchSiblings: (id: number) => req<{ ok: boolean; family: number; added: number; liked: number; failed: number; message?: string }>(`/api/images/${id}/fetch-siblings`, post()),
  backfillParents: () => req('/api/backfill-parents', post()),
  backfillStatus: () => req<{ running: boolean; done: number; total: number }>('/api/backfill-status'),
  cleanupNopath: () => req<{ deleted: number }>('/api/cleanup-nopath', post()),
  list: (params: string) => req<{ total: number; page: number; size: number; rows: (NextImage & { user_label: string | null })[] }>(`/api/images?${params}`),
  settings: () => req<{ dataDir: string; incoming: string; favorites: string; thumbs: string; models: string }>('/api/settings'),
  setDataDir: (p: string) => req<{ mode: 'use-existing' | 'empty'; needRestart?: boolean }>('/api/settings/data-dir', post({ path: p })),
  migrateDataDir: (p: string) => req<{ ok: boolean }>('/api/settings/migrate', post({ path: p })),
  migrateStatus: () => req<{ running: boolean; phase: string; done: number; total: number; error: string }>('/api/settings/migrate-status'),
  restart: () => req<{ ok: boolean }>('/api/restart', post()),
  storages: () => req<StorageRow[]>('/api/storages'),
  saveCompression: (type: string, c: CompressionRule) => req<{ ok: boolean }>(`/api/storages/${type}/compression`, put(c)),
  saveFormats: (type: string, f: FormatRule) => req<{ ok: boolean }>(`/api/storages/${type}/formats`, put(f)),
  processExisting: (type: string) => req<{ ok: boolean }>(`/api/storages/${type}/process-existing`, post()),
  processStatus: () => req<ReprocessStatus>('/api/storages/process-status'),
  docs: () => req<ApiDocGroup[]>('/api/docs'),
  like: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<LikeResult>('/api/like', { method: 'POST', body: fd });
  },
};
