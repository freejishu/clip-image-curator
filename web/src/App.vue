<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { api, auth, imgUrl, type NextImage, type Task, type Stats, type StorageRow, type CompressionRule, type FormatRule, type ReprocessStatus, type ApiDocGroup, type LikeResult } from './api';

// ---- 登录与服务器切换 ----
const authed = ref(false);
const authUsername = ref(''); // 当前登录账户名（设置页账户区展示）
const loginForm = ref({ username: '', password: '', remember: false });
const loginErr = ref('');
const loginBusy = ref(false);
// 服务器选择：'' = 本服务器；localStorage「ic-servers」保存历史服务器列表（仅存浏览器）
const serverPick = ref<string>(auth.server);
const serverList = ref<string[]>(JSON.parse(localStorage.getItem('ic-servers') ?? '[]') as string[]);
const newServerUrl = ref('');

function saveServerList() { localStorage.setItem('ic-servers', JSON.stringify(serverList.value)); }
function removeServer(s: string) {
  serverList.value = serverList.value.filter(x => x !== s);
  saveServerList();
  if (serverPick.value === s) serverPick.value = '';
}
async function doLogin() {
  if (loginBusy.value) return;
  const target = serverPick.value === '__new' ? newServerUrl.value.trim() : serverPick.value;
  if (serverPick.value === '__new' && !/^https?:\/\/.+/.test(target)) { loginErr.value = '服务器地址需以 http:// 或 https:// 开头'; return; }
  loginBusy.value = true; loginErr.value = '';
  try {
    auth.setServer(target);
    const r = await api.login(loginForm.value.username.trim(), loginForm.value.password, loginForm.value.remember);
    auth.setToken(r.token, loginForm.value.remember);
    authUsername.value = r.username;
    // 自定义服务器登录成功后自动存进列表
    if (auth.server && !serverList.value.includes(auth.server)) { serverList.value = [...serverList.value, auth.server]; saveServerList(); }
    if (serverPick.value === '__new') serverPick.value = auth.server;
    authed.value = true;
    loginForm.value.password = '';
    await boot();
  } catch (e) {
    loginErr.value = e instanceof Error ? e.message : String(e);
  } finally { loginBusy.value = false; }
}
async function doLogout() {
  try { await api.logout(); } catch { /* token 可能已失效，无所谓 */ }
  auth.clear();
  location.reload(); // 全量重置页面状态与定时器
}

// ---- 设置：账户 ----
const acctUserForm = ref({ username: '', password: '' });
const acctPwForm = ref({ current: '', next: '', confirm: '' });
const acctMsg = ref('');
const acctBusy = ref(false);
async function saveUsername() {
  if (acctBusy.value) return;
  acctBusy.value = true; acctMsg.value = '';
  try {
    const r = await api.changeUsername(acctUserForm.value.password, acctUserForm.value.username);
    authUsername.value = r.username;
    acctUserForm.value = { username: '', password: '' };
    acctMsg.value = '✓ 账户名已修改';
  } catch (e) { acctMsg.value = `✕ ${e instanceof Error ? e.message : String(e)}`; }
  finally { acctBusy.value = false; }
}
async function savePassword() {
  if (acctBusy.value) return;
  if (acctPwForm.value.next !== acctPwForm.value.confirm) { acctMsg.value = '✕ 两次输入的新密码不一致'; return; }
  acctBusy.value = true; acctMsg.value = '';
  try {
    await api.changePassword(acctPwForm.value.current, acctPwForm.value.next);
    alert('密码已修改，所有设备需重新登录');
    auth.clear();
    location.reload();
  } catch (e) { acctMsg.value = `✕ ${e instanceof Error ? e.message : String(e)}`; acctBusy.value = false; }
}

type Tab = 'rate' | 'review' | 'album' | 'tasks' | 'settings';
type SettingsTab = 'base' | 'model' | 'storage' | 'api';

// ---- URL 路由（无 vue-router，手写 history API）：tab 与网址互相同步，复制网址可直接打开对应页 ----
// / → 打分，/review /album /tasks /settings（子页 /settings/model|storage|api）
const TAB_PATHS: Record<Tab, string> = { rate: '/', review: '/review', album: '/album', tasks: '/tasks', settings: '/settings' };
function pathToTab(p: string): { tab: Tab; settingsTab?: SettingsTab } | null {
  const m = /^\/(review|album|tasks|settings)?(?:\/(base|model|storage|api))?\/?$/.exec(p);
  if (!m) return null;
  if (!m[1]) return { tab: 'rate' };
  if (m[1] === 'settings') return { tab: 'settings', settingsTab: (m[2] ?? 'base') as SettingsTab };
  return { tab: m[1] as Tab };
}
const urlTab = pathToTab(window.location.pathname); // URL 优先，裸开 / 以外路径时覆盖 localStorage 记忆
const savedTabRaw = localStorage.getItem('ic-tab'); // 旧版本有 'model' 页签，并入设置
const tab = ref<Tab>((urlTab?.tab ?? (savedTabRaw === 'model' ? 'settings' : savedTabRaw ?? 'rate')) as Tab); // 刷新后回到原页面
const settingsTab = ref<SettingsTab>(urlTab?.settingsTab ?? (savedTabRaw === 'model' ? 'model' : 'base'));
let navFromUrl = false; // popstate 引起的 tab 变化不再 pushState（避免历史记录重复）

// ---- 打分 ----
const mode = ref<'smart' | 'sequential'>('smart');
const current = ref<NextImage | null>(null);
const remaining = ref(0);
const allDone = ref(false);
const loading = ref(false);

async function loadNext() {
  loading.value = true;
  try {
    const r = await api.next(mode.value);
    allDone.value = r.done;
    current.value = r.image ?? null;
    currentGroup.value = r.group ?? [];
    remaining.value = r.remaining ?? 0;
  } finally { loading.value = false; }
}
const currentGroup = ref<NextImage[]>([]); // 当前图的同组成员（不含自身）

async function label(label_: string) {
  if (!current.value || loading.value) return;
  const id = current.value.id;
  loading.value = true; // 防连击
  try {
    const r = await api.label(id, label_);
    if ((label_ === 'like' || label_ === 'dislike') && r.affected.length > 1) {
      likeToast.value = label_ === 'like' ? `♥ 已连带保留组内 ${r.affected.length - 1} 张` : `✕ 已连带不喜欢组内 ${r.affected.length - 1} 张`;
      window.setTimeout(() => { likeToast.value = ''; }, 2500);
    }
  } finally { loading.value = false; }
  await loadNext();
}
const likeToast = ref('');

function onKey(e: KeyboardEvent) {
  if (!authed.value) return;
  if (e.key === 'Escape' && lightbox.value) { lightbox.value = null; return; }
  if (lightbox.value && e.key === 'ArrowLeft') { lbGo(-1); return; }
  if (lightbox.value && e.key === 'ArrowRight') { lbGo(1); return; }
  if (tab.value !== 'rate') return;
  if (e.key === '1') label('like');
  else if (e.key === '2') label('dislike');
  else if (e.key === '3') label('skip');
}

// ---- 任务 ----
const tasks = ref<Task[]>([]);
const pausing = ref<Set<number>>(new Set()); // 点了暂停但状态还没翻转的任务（即时反馈）
async function onPause(id: number) {
  pausing.value = new Set(pausing.value).add(id);
  await api.pauseTask(id);
  await refreshTasks();
}
const sources = ref<{ name: string; enabled: boolean; caps?: { fetchPost: boolean; fetchFamily: boolean } }[]>([]);
/** 某数据源的 optional 能力（驱动灯箱按钮显隐，不再硬编码源名） */
function srcCap(name: string, cap: 'fetchPost' | 'fetchFamily'): boolean {
  return sources.value.find(s => s.name === name)?.caps?.[cap] ?? false;
}
const newTask = ref({ source: 'yandere', tags: '', limit: 100, proxy: '', mode: 'head' as 'head' | 'range', start: 0, end: 200 });
function taskQueryText(q: string): string {
  const p = JSON.parse(q) as { tags: string[]; limit: number; skip?: number };
  return p.skip ? `${p.tags.join(' ')}（范围 ${p.skip}~${p.skip + p.limit}）` : p.tags.join(' ');
}
async function refreshTasks() {
  tasks.value = await api.tasks();
  // 状态已不是 running 的任务，清掉「暂停中…」标记
  const s = new Set(pausing.value);
  for (const t of tasks.value) if (t.status !== 'running') s.delete(t.id);
  pausing.value = s;
}
let taskTimer: number | undefined;
watch(tab, (t) => {
  localStorage.setItem('ic-tab', t);
  if (!navFromUrl) { // 用户点击页签 → 网址同步；popstate 来的不动历史
    const p = t === 'settings' ? `/settings/${settingsTab.value}` : TAB_PATHS[t];
    if (window.location.pathname !== p) window.history.pushState(null, '', p);
  }
  window.clearInterval(taskTimer);
  if (t === 'tasks') { refreshTasks(); taskTimer = window.setInterval(refreshTasks, 2000); } // 自动拉取进度
  if (t === 'rate') loadNext(); // 回到打分页：按最新预测分重新取第一张
  if (t === 'review') refreshReview();
  if (t === 'album') refreshAlbum();
  if (t === 'settings') { refreshModel(); loadSettings(); loadStorages(); }
});
watch(settingsTab, (st) => {
  if (tab.value !== 'settings' || navFromUrl) return;
  const p = `/settings/${st}`;
  if (window.location.pathname !== p) window.history.pushState(null, '', p);
});
// 浏览器前进/后退：按网址还原页签
function onPopState() {
  const r = pathToTab(window.location.pathname);
  if (!r) return;
  navFromUrl = true;
  tab.value = r.tab;
  if (r.settingsTab) settingsTab.value = r.settingsTab;
  navFromUrl = false;
}

function predText(s: number | null | undefined): string {
  return s == null ? '无预测分' : `预测 ${(s * 100).toFixed(1)}%`;
}
function predClass(s: number | null | undefined): string {
  if (s == null) return 'pred-none';
  if (s >= 0.7) return 'pred-high';
  if (s >= 0.4) return 'pred-mid';
  return 'pred-low';
}
async function createTask() {
  const tags = newTask.value.tags.split(/\s+/).filter(Boolean);
  if (!tags.length) return alert('请输入至少一个 tag');
  const t = newTask.value;
  if (t.mode === 'range' && !(t.start >= 0 && t.end > t.start)) return alert('范围需满足 0 ≤ 开始 < 结束');
  await api.createTask(t.source, tags, t.limit, t.proxy, t.mode === 'range' ? { start: t.start, end: t.end } : undefined);
  newTask.value.tags = '';
  await refreshTasks();
}

// ---- 相册 ----
type AlbumItem = NextImage & { parent_id: number | null; labeled_at: string | null; created_at: string; group_key: string | null; in_manual: boolean; is_cover: boolean };
interface AlbumGroup { key: string; items: AlbumItem[] }
const albumGroups = ref<AlbumGroup[]>([]);
const backfilling = ref(false);
const backfillDone = ref(0);
const backfillTotal = ref(0);
let backfillTimer: number | undefined;
async function refreshAlbum() {
  const rows = await api.album();
  const map = new Map<string, AlbumItem[]>();
  for (const r of rows) {
    const key = r.group_key ?? `s${r.id}`;
    const arr = map.get(key) ?? [];
    arr.push(r);
    map.set(key, arr);
  }
  albumGroups.value = [...map.entries()].map(([key, items]) => {
    items.sort((a, b) => {
      const ac = a.is_cover ? 0 : 1, bc = b.is_cover ? 0 : 1;
      if (ac !== bc) return ac - bc; // 用户指定封面作主图，优先于父子/入库顺序
      const ap = (a.parent_id ?? -1) > 0 ? 1 : 0, bp = (b.parent_id ?? -1) > 0 ? 1 : 0;
      if (ap !== bp) return ap - bp; // 父投稿作主图（parent_id>0 的是子图）
      return (a.created_at ?? '').localeCompare(b.created_at ?? '');
    });
    return { key, items };
  }).sort((a, b) => (b.items[0].created_at ?? '').localeCompare(a.items[0].created_at ?? '')); // 按主图入库时间倒序
  // 回填若在跑（比如重启前触发的），恢复进度显示
  const s = await api.backfillStatus();
  backfillDone.value = s.done; backfillTotal.value = s.total;
  if (s.running && !backfilling.value) pollBackfill();
}

// ---- 手动编组 ----
const bindMode = ref(false);
const bindSel = ref<Set<number>>(new Set());
const bindMsg = ref('');
function toggleBindMode() {
  bindMode.value = !bindMode.value;
  bindSel.value = new Set();
  bindMsg.value = '';
}
function albumCardClick(g: AlbumGroup, gi: number) {
  if (!bindMode.value) { openLightbox(g.items, 0, albumGroups.value.map(x => x.items), gi); return; }
  const id = g.items[0].id;
  const s = new Set(bindSel.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  bindSel.value = s;
}
async function confirmBind() {
  if (bindSel.value.size < 2) { bindMsg.value = '至少选 2 组'; return; }
  // 选中的是卡片主图 id；把整组成员一起绑定
  const ids: number[] = [];
  for (const g of albumGroups.value) if (bindSel.value.has(g.items[0].id)) ids.push(...g.items.map(i => i.id));
  const r = await api.bindGroup(ids);
  bindMsg.value = `✓ 已绑定为组 #${r.group_id}`;
  bindMode.value = false;
  bindSel.value = new Set();
  await refreshAlbum();
}
async function unbindCurrent() {
  const img = lbMain();
  if (!img.in_manual) return;
  await api.unbindGroup(img.id);
  lightbox.value = null;
  await refreshAlbum();
}

// ---- 设置组封面 ----
const coverMsg = ref('');
async function setCoverCurrent() {
  const img = lbMain();
  if (img.is_cover) return;
  const r = await api.setCover(img.id);
  for (const it of lightbox.value!.items) it.is_cover = it.id === img.id; // 本地即时反映
  coverMsg.value = `✓ 已设为组封面（组内 ${r.members.length} 张）`;
  window.setTimeout(() => { coverMsg.value = ''; }, 2500);
  await refreshAlbum();
}

// ---- 补全子投稿 ----
const siblingState = ref<{ running: boolean; msg: string }>({ running: false, msg: '' });
async function fetchSiblings() {
  const img = lbMain();
  if (siblingState.value.running) return;
  siblingState.value = { running: true, msg: '查询 yande.re 中…' };
  try {
    const r = await api.fetchSiblings(img.id);
    siblingState.value = {
      running: false,
      msg: r.message ?? `家族 ${r.family} 张 · 新增下载 ${r.added} · 标记喜欢 ${r.liked}${r.failed ? ` · 失败 ${r.failed}` : ''}`,
    };
    await Promise.all([refreshAlbum(), refreshModel()]);
  } catch (e) {
    siblingState.value = { running: false, msg: `✕ ${e instanceof Error ? e.message : String(e)}` };
  }
}
async function backfill() {
  await api.backfillParents();
  pollBackfill();
}
function pollBackfill() {
  backfilling.value = true;
  window.clearInterval(backfillTimer);
  backfillTimer = window.setInterval(async () => {
    const s = await api.backfillStatus();
    backfillDone.value = s.done;
    backfillTotal.value = s.total;
    backfilling.value = s.running;
    if (!s.running) { window.clearInterval(backfillTimer); await refreshAlbum(); }
  }, 2000);
}

// ---- 清理脏数据 ----
const cleanupMsg = ref('');
async function cleanupNopath() {
  const r = await api.cleanupNopath();
  cleanupMsg.value = `已清理 ${r.deleted} 条「抓到链接但未下载」的记录`;
  await Promise.all([refreshTasks(), refreshModel()]);
}

// ---- 时间格式化 ----
function fmtTime(s?: string | null): string {
  if (!s) return '-';
  return new Date(s.replace(' ', 'T') + 'Z').toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(t: Task): string {
  if (!t.created_at) return '-';
  const start = new Date(t.created_at.replace(' ', 'T') + 'Z').getTime();
  const end = t.finished_at ? new Date(t.finished_at.replace(' ', 'T') + 'Z').getTime() : Date.now();
  let s = Math.max(0, Math.round((end - start) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  s = s % 60;
  return (h ? `${h}h` : '') + (m || h ? `${m}m` : '') + `${s}s`;
}

// ---- 统计与模型 ----
const stats = ref<Stats | null>(null);
const prefs = ref<{ trained: boolean; version?: number; samples?: number; positive?: [string, number][]; negative?: [string, number][] } | null>(null);
const trainState = ref<{ status: string; progress: string; error?: string; result?: { version?: number; samples?: number; scored?: number } }>({ status: 'idle', progress: '' });
let pollTimer: number | undefined;

async function refreshModel() {
  stats.value = await api.stats();
  prefs.value = await api.preferences();
  trainState.value = await api.trainStatus();
}
async function startTrain() { trainState.value = { status: 'running', progress: '已启动，正在加载模型…' }; await api.train(); pollTrain(); }
async function startZeroshot() { trainState.value = { status: 'running', progress: '已启动，正在加载模型…' }; await api.zeroshot(); pollTrain(); }
function pollTrain() {
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(async () => {
    trainState.value = await api.trainStatus();
    if (trainState.value.status !== 'running') { window.clearInterval(pollTimer); await refreshModel(); }
  }, 1500);
}

// ---- 设置：数据目录 ----
interface SettingsInfo { dataDir: string; incoming: string; favorites: string; thumbs: string; models: string }
const settingsInfo = ref<SettingsInfo | null>(null);
const newDir = ref('');
const setMsg = ref('');
const savingDir = ref(false);
const needRestart = ref(false);
const restarting = ref(false);
const migrating = ref({ running: false, phase: '', done: 0, total: 0, error: '' });
let migTimer: number | undefined;

async function loadSettings() { settingsInfo.value = await api.settings(); }

async function saveDataDir() {
  const p = newDir.value.trim();
  if (!p || savingDir.value) return;
  savingDir.value = true; setMsg.value = ''; needRestart.value = false;
  try {
    const r = await api.setDataDir(p);
    if (r.mode === 'use-existing') {
      setMsg.value = '✓ 新路径下已有数据，已切换（不迁移当前数据）';
      needRestart.value = true;
    } else if (window.confirm(`新路径下没有数据。\n\n是否把当前数据（数据库 + 图库 + CLIP 模型，体积可能较大）迁移到 ${p}？\n\n旧目录会保留，确认无误后可手动删除。`)) {
      await api.migrateDataDir(p);
      pollMigrate();
    } else {
      setMsg.value = '已取消，未做任何修改';
    }
  } catch (e) { setMsg.value = `✕ ${e instanceof Error ? e.message : String(e)}`; }
  finally { savingDir.value = false; }
}

function pollMigrate() {
  migrating.value = { running: true, phase: 'starting', done: 0, total: 0, error: '' };
  window.clearInterval(migTimer);
  migTimer = window.setInterval(async () => {
    migrating.value = await api.migrateStatus();
    if (!migrating.value.running) {
      window.clearInterval(migTimer);
      if (migrating.value.phase === 'done') { setMsg.value = `✓ 迁移完成（${migrating.value.total} 个文件），重启后使用新目录`; needRestart.value = true; }
      else if (migrating.value.error) setMsg.value = `✕ 迁移失败: ${migrating.value.error}`;
    }
  }, 1000);
}

async function restartNow() {
  if (restarting.value) return;
  restarting.value = true;
  api.restart().catch(() => { /* 进程退出可能截断响应，正常 */ }); // 不回等，直接开始轮询
  const timer = window.setInterval(async () => {
    try {
      const r = await fetch(imgUrl('/api/stats')); // imgUrl 会带上 apiBase 与 token query
      if (r.ok) { window.clearInterval(timer); location.reload(); }
    } catch { /* 还没起来，继续等 */ }
  }, 1000);
}

// ---- 设置：存储 ----
const storages = ref<StorageRow[]>([]);
const storeMsg = ref('');
const editing = ref<{ type: string; kind: 'compression' | 'formats' } | null>(null);
const compForm = ref<CompressionRule>({ enabled: false, mode: 'scale', scalePercent: 80, maxSizeMB: 2 });
const fmtForm = ref<FormatRule>({ enabled: [], convertTo: 'webp' });
const savingStore = ref(false);
const repro = ref<ReprocessStatus | null>(null);
let reproTimer: number | undefined;

async function loadStorages() { storages.value = await api.storages(); }

// ---- 设置：API（接口文档 + 「我喜欢这个图片！」在线测试） ----
type ApiTab = 'docs' | 'like';
const apiTab = ref<ApiTab>('docs');
const docGroups = ref<ApiDocGroup[]>([]);
let docsLoaded = false;
async function loadDocs() {
  if (docsLoaded) return;
  docGroups.value = await api.docs();
  docsLoaded = true;
}
const likeFile = ref<File | null>(null);
const likePreview = ref('');
const likeResult = ref<LikeResult | null>(null);
const likeErr = ref('');
const likeTesting = ref(false);
function onLikeFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null;
  likeFile.value = f; likeResult.value = null; likeErr.value = '';
  if (likePreview.value) URL.revokeObjectURL(likePreview.value);
  likePreview.value = f ? URL.createObjectURL(f) : '';
}
async function testLike() {
  if (!likeFile.value || likeTesting.value) return;
  likeTesting.value = true; likeErr.value = ''; likeResult.value = null;
  try { likeResult.value = await api.like(likeFile.value); }
  catch (e) { likeErr.value = e instanceof Error ? e.message : String(e); }
  finally { likeTesting.value = false; }
}
// 分享页链接（公开访问，无需进后台）
const likeShareUrl = window.location.origin + '/like';
const likeShareMsg = ref('');
async function copyLikeLink() {
  try {
    await navigator.clipboard.writeText(likeShareUrl);
    likeShareMsg.value = '✓ 已复制';
    window.setTimeout(() => { likeShareMsg.value = ''; }, 2000);
  } catch {
    likeShareMsg.value = '复制失败，请手动复制'; // 非安全上下文（http://IP 直连）时剪贴板 API 不可用
  }
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
  return (n / 1024).toFixed(0) + ' KB';
}

function openStoreEdit(s: StorageRow, kind: 'compression' | 'formats') {
  editing.value = { type: s.type, kind };
  storeMsg.value = '';
  compForm.value = { ...s.process.compression };
  fmtForm.value = { enabled: [...s.process.formats.enabled], convertTo: s.process.formats.convertTo };
}

async function saveCompression() {
  if (!editing.value || savingStore.value) return;
  savingStore.value = true; storeMsg.value = '';
  try {
    await api.saveCompression(editing.value.type, compForm.value);
    storeMsg.value = '✓ 压缩设置已保存，新下载的图片立即生效';
    editing.value = null;
    await loadStorages();
  } catch (e) { storeMsg.value = `✕ ${e instanceof Error ? e.message : String(e)}`; }
  finally { savingStore.value = false; }
}

async function saveFormats() {
  if (!editing.value || savingStore.value) return;
  savingStore.value = true; storeMsg.value = '';
  try {
    await api.saveFormats(editing.value.type, fmtForm.value);
    storeMsg.value = '✓ 格式设置已保存，新下载的图片立即生效';
    editing.value = null;
    await loadStorages();
  } catch (e) { storeMsg.value = `✕ ${e instanceof Error ? e.message : String(e)}`; }
  finally { savingStore.value = false; }
}

async function runReprocess(s: StorageRow) {
  if (repro.value?.running) return;
  const c = s.process.compression;
  const desc = c.enabled
    ? (c.mode === 'scale' ? `尺寸缩放到 ${c.scalePercent}%` : `单张不超过 ${c.maxSizeMB}MB`)
    : '仅按格式规则转换（压缩未启用）';
  if (!window.confirm(`将按当前规则处理「${s.name}」中的全部存量图片：\n\n格式：保留 [${s.process.formats.enabled.join(', ')}]，其余转为 ${s.process.formats.convertTo}\n压缩：${desc}\n\n处理前会自动备份数据库；每张图处理成功后才替换原文件，失败保留原图。动图不受影响。是否继续？`)) return;
  try {
    await api.processExisting(s.type);
    repro.value = { running: true, phase: 'starting', done: 0, total: 0, processed: 0, skipped: 0, failed: 0, savedBytes: 0, error: '' };
    window.clearInterval(reproTimer);
    reproTimer = window.setInterval(async () => {
      repro.value = await api.processStatus();
      if (!repro.value.running) {
        window.clearInterval(reproTimer);
        if (repro.value.phase === 'done') storeMsg.value = `✓ 存量处理完成：压缩/转换 ${repro.value.processed} 张，跳过 ${repro.value.skipped} 张，失败 ${repro.value.failed} 张，节省 ${fmtBytes(repro.value.savedBytes)}`;
        else if (repro.value.error) storeMsg.value = `✕ 存量处理失败: ${repro.value.error}`;
      }
    }, 1000);
  } catch (e) { storeMsg.value = `✕ ${e instanceof Error ? e.message : String(e)}`; }
}

// ---- 审查/修正 ----
type ReviewFilter = 'predNewLike' | 'predNewDislike' | 'predAllLike' | 'predAllDislike' | 'like';
const reviewFilter = ref<ReviewFilter>('predNewLike');
const reviewList = ref<(NextImage & { user_label: string | null })[]>([]);
const reviewPage = ref(1);
const REVIEW_PARAMS: Record<ReviewFilter, string> = {
  predNewLike: 'minScore=0.5&label=none&sort=desc',
  predNewDislike: 'maxScore=0.5&label=none&sort=asc',
  predAllLike: 'minScore=0.5&sort=desc',
  predAllDislike: 'maxScore=0.5&sort=asc',
  like: 'label=like',
};
const reviewTotal = ref(0);
const REVIEW_SIZE = 60;
async function refreshReview() {
  const r = await api.list(`${REVIEW_PARAMS[reviewFilter.value]}&page=${reviewPage.value}`);
  reviewList.value = r.rows;
  reviewTotal.value = r.total;
}
function setReviewFilter(f: ReviewFilter) { reviewFilter.value = f; reviewPage.value = 1; refreshReview(); }
async function relabel(id: number, label_: string) {
  await api.label(id, label_);
  await Promise.all([refreshReview(), refreshAlbum()]);
}

/** 登录成功后的数据引导（原 onMounted 内容拆分出来，登录页不应提前打 API） */
async function boot() {
  sources.value = await api.sources();
  await Promise.all([loadNext(), refreshTasks(), refreshModel(), refreshReview(), refreshAlbum()]);
  if (tab.value === 'tasks') taskTimer = window.setInterval(refreshTasks, 2000); // 直接落在任务页时 watch 不触发，需手动补开定时器
}
onMounted(async () => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('popstate', onPopState);
  auth.onUnauthorized(() => { authed.value = false; }); // 任何 API 401 → 回登录页
  if (!auth.token) return; // 无 token，显示登录页
  try {
    const s = await api.authStatus();
    if (s.authenticated) { authed.value = true; authUsername.value = s.username ?? ''; await boot(); return; }
  } catch { /* 服务器不可达，按未登录处理 */ }
  auth.clear();
});
type LbImage = NextImage & { user_label?: string | null; parent_id?: number | null; labeled_at?: string | null; in_manual?: boolean; is_cover?: boolean };
interface LightboxState { items: LbImage[]; mainIdx: number; peekIdx: number; frames: LbImage[][]; frameIdx: number }
const lightbox = ref<LightboxState | null>(null);
const lens = ref({ on: false, x: 0, y: 0 });
// 透镜圆孔与黑色遮罩同径，大/中/小三档，localStorage 记忆；移动端屏小，整体缩小一档
const LENS_SIZES = { S: 90, M: 130, L: 190 } as const;
const LENS_SIZES_MOBILE = { S: 55, M: 85, L: 125 } as const;
type LensSize = keyof typeof LENS_SIZES;
const savedLens = localStorage.getItem('ic-lens-size') as LensSize | null;
const lensSize = ref<LensSize>(savedLens && savedLens in LENS_SIZES ? savedLens : 'M');
const isMobile = ref(window.matchMedia('(max-width: 640px)').matches);
window.matchMedia('(max-width: 640px)').addEventListener('change', e => { isMobile.value = e.matches; });
const lensR = computed(() => (isMobile.value ? LENS_SIZES_MOBILE : LENS_SIZES)[lensSize.value]);
watch(lensSize, v => localStorage.setItem('ic-lens-size', v));
let savedScroll = 0;

function openLightbox(items: LbImage[], mainIdx = 0, frames?: LbImage[][], frameIdx?: number) {
  const fr = frames ?? [items];
  lightbox.value = { items, mainIdx, peekIdx: items.length > 1 ? (mainIdx === 0 ? 1 : 0) : 0, frames: fr, frameIdx: frameIdx ?? 0 };
  lens.value.on = false;
}
function lbGo(delta: number) {
  const l = lightbox.value;
  if (!l || l.frames.length <= 1) return;
  const n = (l.frameIdx + delta + l.frames.length) % l.frames.length;
  const items = l.frames[n];
  lightbox.value = { items, mainIdx: 0, peekIdx: items.length > 1 ? 1 : 0, frames: l.frames, frameIdx: n };
  lens.value.on = false;
}
function lbMain(): LbImage { const l = lightbox.value!; return l.items[l.mainIdx]; }
function lbPeek(): LbImage { const l = lightbox.value!; return l.items[l.peekIdx]; }
function nextIdx(cur: number, skip: number, n: number): number { let i = cur; do { i = (i + 1) % n; } while (i === skip); return i; }
function lbSwap() { const l = lightbox.value!; [l.mainIdx, l.peekIdx] = [l.peekIdx, l.mainIdx]; }
function lbPickMain(i: number) { const l = lightbox.value!; l.mainIdx = i; if (l.peekIdx === i) l.peekIdx = nextIdx(i, i, l.items.length); lens.value.on = false; }
function lbPickPeek(i: number) { const l = lightbox.value!; l.peekIdx = i; if (l.mainIdx === i) l.mainIdx = nextIdx(i, i, l.items.length); }
function lensMove(e: PointerEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  lens.value = { on: true, x: e.clientX - r.left, y: e.clientY - r.top };
}
function lensEnd() { lens.value.on = false; }

// 灯箱开关时锁定/还原页面滚动（修复关闭后回到顶部）
watch(lightbox, (val) => {
  if (val) { savedScroll = window.scrollY; document.body.style.overflow = 'hidden'; }
  else { document.body.style.overflow = ''; requestAnimationFrame(() => window.scrollTo(0, savedScroll)); }
});
onUnmounted(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('popstate', onPopState); window.clearInterval(pollTimer); window.clearInterval(taskTimer); window.clearInterval(migTimer); });
</script>

<template>
  <!-- 登录页（未鉴权时整页替换；服务器列表仅存浏览器 localStorage） -->
  <div v-if="!authed" class="login-wrap">
    <form class="login-box" @submit.prevent="doLogin">
      <h1>image-curator</h1>
      <label class="login-row">
        <span>服务器</span>
        <select v-model="serverPick">
          <option value="">本服务器（当前）</option>
          <option v-for="s in serverList" :key="s" :value="s">{{ s }}</option>
          <option value="__new">＋ 新服务器…</option>
        </select>
      </label>
      <div v-if="serverPick === '__new'" class="login-row">
        <span></span>
        <input v-model="newServerUrl" placeholder="http://192.168.x.x:30041" autocapitalize="off" autocorrect="off">
      </div>
      <div v-if="serverPick && serverPick !== '__new'" class="login-row login-svr-op">
        <span></span>
        <button type="button" class="login-svr-del" @click="removeServer(serverPick)">从列表删除该服务器</button>
      </div>
      <label class="login-row">
        <span>账户</span>
        <input v-model="loginForm.username" autocomplete="username" autocapitalize="off" placeholder="admin">
      </label>
      <label class="login-row">
        <span>密码</span>
        <input v-model="loginForm.password" type="password" autocomplete="current-password" placeholder="admin">
      </label>
      <label class="login-remember"><input type="checkbox" v-model="loginForm.remember"> 记住我（180 天免登录；不勾选则关闭浏览器后需重新登录）</label>
      <button class="login-btn" type="submit" :disabled="loginBusy || !loginForm.username || !loginForm.password">{{ loginBusy ? '登录中…' : '登 录' }}</button>
      <p v-if="loginErr" class="c-dislike login-err">✕ {{ loginErr }}</p>
    </form>
  </div>

  <div v-else class="app">
    <header>
      <h1>image-curator</h1>
      <nav class="menu">
        <button :class="{ on: tab === 'rate' }" @click="tab = 'rate'">🖊️ 打分</button>
        <button :class="{ on: tab === 'review' }" @click="tab = 'review'">🔍 审查修正</button>
        <button :class="{ on: tab === 'album' }" @click="tab = 'album'">📷 相册</button>
        <button :class="{ on: tab === 'tasks' }" @click="tab = 'tasks'">⬇️ 抓取任务</button>
        <button :class="{ on: tab === 'settings' }" @click="tab = 'settings'">⚙️ 设置</button>
      </nav>
    </header>

    <!-- 打分 -->
    <section v-if="tab === 'rate'" class="rate">
      <div class="toolbar">
        <label><input type="checkbox" :checked="mode === 'smart'" @change="mode = ($event.target as HTMLInputElement).checked ? 'smart' : 'sequential'; loadNext()"> 智能排序（按预测分）</label>
        <span>待标注: {{ remaining }}</span>
        <span class="pred-badge" :class="predClass(current?.pred_score)">{{ predText(current?.pred_score) }}</span>
        <button v-if="current && currentGroup.length > 0" class="grp-btn" @click="openLightbox([current, ...currentGroup], 0)">⇄ 同组 {{ currentGroup.length + 1 }} 张，点击查看</button>
        <span v-if="likeToast" class="c-ok">{{ likeToast }}</span>
      </div>
      <div v-if="allDone" class="empty">🎉 全部标注完成</div>
      <div v-else-if="current" class="stage">
        <img :src="imgUrl(`/api/images/${current.id}/file`)" :key="current.id" alt="">
        <div class="meta">
          <a :href="current.page_url" target="_blank">{{ current.source }} #{{ current.source_id }}</a>
          <div class="tags">{{ current.tags.slice(0, 12).join(' ') }}</div>
        </div>
        <div class="actions">
          <button class="like" @click="label('like')">1 喜欢 ♥</button>
          <button class="dislike" @click="label('dislike')">2 不喜欢 ✕</button>
          <button class="skip" @click="label('skip')">3 跳过 →</button>
        </div>
      </div>
      <div v-else class="empty">加载中…</div>
    </section>

    <!-- 审查修正 -->
    <section v-else-if="tab === 'review'">
      <div class="toolbar">
        <button :class="{ on: reviewFilter === 'predNewLike' }" @click="setReviewFilter('predNewLike')">未标注·预测喜欢</button>
        <button :class="{ on: reviewFilter === 'predNewDislike' }" @click="setReviewFilter('predNewDislike')">未标注·预测不喜欢</button>
        <button :class="{ on: reviewFilter === 'predAllLike' }" @click="setReviewFilter('predAllLike')">全盘·预测喜欢</button>
        <button :class="{ on: reviewFilter === 'predAllDislike' }" @click="setReviewFilter('predAllDislike')">全盘·预测不喜欢</button>
        <button :class="{ on: reviewFilter === 'like' }" @click="setReviewFilter('like')">已喜欢</button>
        <button :disabled="reviewPage <= 1" @click="if (reviewPage > 1) { reviewPage--; refreshReview(); }">上一页</button>
        <span>第 {{ reviewPage }} / {{ Math.max(Math.ceil(reviewTotal / REVIEW_SIZE), 1) }} 页 · 共 {{ reviewTotal }} 条</span>
        <button :disabled="reviewPage * REVIEW_SIZE >= reviewTotal" @click="reviewPage++; refreshReview()">下一页</button>
      </div>
      <div class="grid">
        <figure v-for="(img, ri) in reviewList" :key="img.id">
          <img :src="imgUrl(`/api/images/${img.id}/thumb`)" loading="lazy" alt="" style="cursor:zoom-in" @click="openLightbox([img], 0, reviewList.map(x => [x]), ri)">
          <figcaption>
            <span v-if="img.pred_score != null">{{ img.pred_score.toFixed(2) }}</span>
            <span class="lbl">{{ img.user_label ?? '未标注' }}</span>
            <button @click="relabel(img.id, 'like')">♥</button>
            <button @click="relabel(img.id, 'dislike')">✕</button>
          </figcaption>
        </figure>
      </div>
    </section>

    <!-- 相册 -->
    <section v-else-if="tab === 'album'">
      <div class="toolbar">
        <span>{{ albumGroups.length }} 组 · {{ albumGroups.reduce((s, g) => s + g.items.length, 0) }} 张喜欢</span>
        <span class="lb-hint">带 ⇄ 角标的组有多张变体，点击进入灯箱透视查看</span>
        <button :class="{ on: bindMode }" @click="toggleBindMode">{{ bindMode ? '退出编组' : '🔗 编组' }}</button>
        <template v-if="bindMode">
          <span>已选 {{ bindSel.size }} 组</span>
          <button :disabled="bindSel.size < 2" @click="confirmBind">绑定为一组</button>
          <span v-if="bindMsg" class="c-ok">{{ bindMsg }}</span>
        </template>
        <button :disabled="backfilling" @click="backfill">{{ backfilling ? `回填中 ${backfillDone}/${backfillTotal}` : '回填老数据的透视关系' }}</button>
        <span v-if="!backfilling && backfillTotal > 0" class="c-ok">✓ 上次回填 {{ backfillTotal }} 张</span>
      </div>
      <div class="grid">
        <figure v-for="(g, gi) in albumGroups" :key="g.key" class="stack" :class="{ 'bind-sel': bindMode && bindSel.has(g.items[0].id) }">
          <img :src="imgUrl(`/api/images/${g.items[0].id}/thumb`)" loading="lazy" alt="" class="shown" style="cursor:zoom-in" @click="albumCardClick(g, gi)">
          <span v-if="g.items.length > 1" class="layers">⇄ {{ g.items.length }}</span>
        </figure>
      </div>
    </section>

    <!-- 抓取任务 -->
    <section v-else-if="tab === 'tasks'">
      <form class="new-task" @submit.prevent="createTask">
        <select v-model="newTask.source">
          <option v-for="s in sources" :key="s.name" :value="s.name" :disabled="!s.enabled">{{ s.name }}</option>
        </select>
        <input v-model="newTask.tags" placeholder="tags（空格分隔），如 landscape rating:s">
        <label style="white-space:nowrap"><input type="radio" value="head" v-model="newTask.mode">从头扫</label>
        <label style="white-space:nowrap"><input type="radio" value="range" v-model="newTask.mode">范围</label>
        <input v-if="newTask.mode === 'head'" v-model.number="newTask.limit" type="number" min="1" max="2000" style="width:90px" title="扫描条数">
        <template v-else>
          <input v-model.number="newTask.start" type="number" min="0" style="width:80px" title="开始位置（跳过前 N 条）">
          <span style="align-self:center">~</span>
          <input v-model.number="newTask.end" type="number" min="1" style="width:80px" title="结束位置">
        </template>
        <input v-model="newTask.proxy" placeholder="代理（留空用默认）" style="width:200px">
        <button type="submit">开始抓取</button>
      </form>
      <p v-if="newTask.mode === 'range'" class="lb-hint">范围 = 搜索结果的第「开始」到「结束」条（从 0 计，最新的在前），单任务最多扫 2000 条；更大范围请分段创建。</p>
      <div class="toolbar" style="margin:8px 0">
        <button @click="cleanupNopath">🧹 清理「抓到链接但未下载」的记录</button>
        <span v-if="cleanupMsg" class="c-ok">{{ cleanupMsg }}</span>
      </div>
      <table>
        <thead><tr><th>ID</th><th>源</th><th>查询</th><th>状态</th><th>搜到/新增/下载</th><th>开始时间</th><th>耗时</th><th>错误</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in tasks" :key="t.id">
            <td>{{ t.id }}</td><td>{{ t.source }}</td><td>{{ taskQueryText(t.query) }}</td>
            <td>{{ t.status }}</td><td>搜到 {{ t.seen ?? 0 }} · 新增 {{ t.fetched }} · 下载 {{ t.downloaded }}/{{ t.target }}</td><td>{{ fmtTime(t.created_at) }}</td><td>{{ fmtDuration(t) }}</td><td>{{ t.error }}</td>
            <td>
              <button v-if="t.status === 'running'" :disabled="pausing.has(t.id)" @click="onPause(t.id)">{{ pausing.has(t.id) ? '暂停中…' : '暂停' }}</button>
              <button v-if="t.status === 'paused' || t.status === 'error'" @click="api.resumeTask(t.id).then(refreshTasks)">继续</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 设置（基础设置 / 模型与偏好 / 存储设置） -->
    <section v-else-if="tab === 'settings'">
      <div class="toolbar">
        <button :class="{ on: settingsTab === 'base' }" @click="settingsTab = 'base'">基础设置</button>
        <button :class="{ on: settingsTab === 'model' }" @click="settingsTab = 'model'">模型与偏好</button>
        <button :class="{ on: settingsTab === 'storage' }" @click="settingsTab = 'storage'; loadStorages()">存储设置</button>
        <button :class="{ on: settingsTab === 'api' }" @click="settingsTab = 'api'; loadDocs()">API</button>
      </div>

      <!-- 基础设置：数据目录 -->
      <div v-if="settingsTab === 'base'" class="settings-base">
        <h3>数据目录</h3>
        <p class="lb-hint">数据库、抓取图片、收藏归档、缩略图与 CLIP 模型都存放在数据目录下；修改后需重启生效。</p>
        <div v-if="settingsInfo" class="path-list">
          <div><span>数据目录</span><code>{{ settingsInfo.dataDir }}</code></div>
          <div><span>抓取图片</span><code>{{ settingsInfo.incoming }}</code></div>
          <div><span>收藏归档</span><code>{{ settingsInfo.favorites }}</code></div>
          <div><span>CLIP 模型</span><code>{{ settingsInfo.models }}</code></div>
        </div>
        <div class="new-task">
          <input v-model="newDir" placeholder="新数据目录（绝对路径），如 E:\ic-data">
          <button :disabled="savingDir || !newDir.trim()" @click="saveDataDir">{{ savingDir ? '检查中…' : '保存' }}</button>
        </div>
        <div v-if="migrating.running" class="running">⏳ 迁移中{{ migrating.phase === 'copy' ? `（复制文件 ${migrating.done}/${migrating.total}）` : '…' }}，模型文件较大，请勿关闭页面</div>
        <span v-if="setMsg" :class="setMsg.startsWith('✕') ? 'c-dislike' : 'c-ok'">{{ setMsg }}</span>
        <div v-if="needRestart && !restarting" style="margin-top:12px">
          <button class="restart-btn" @click="restartNow">🔄 立即重启生效</button>
        </div>
        <div v-if="restarting" class="running">⏳ 服务重启中，恢复后自动刷新页面…</div>

        <h3 style="margin-top:24px">账户</h3>
        <p class="lb-hint">
          当前登录：<b class="acct-name">{{ authUsername }}</b>
          <template v-if="auth.server">（服务器：{{ auth.server }}）</template>
          <template v-else>（本服务器）</template>
          。修改账户名/密码均需输入当前密码确认；修改密码后所有设备需重新登录。
          忘记密码：在服务器上停止服务后执行 <code>npm run reset-password</code>（打包版：<code>image-curator.exe reset-password</code>），重启后恢复默认 admin/admin。
        </p>
        <div class="acct-grid">
          <div class="store-panel">
            <h3>修改账户名</h3>
            <label class="store-row">新账户名：<input v-model="acctUserForm.username" class="acct-input" autocapitalize="off"></label>
            <label class="store-row">当前密码：<input v-model="acctUserForm.password" type="password" class="acct-input" autocomplete="current-password"></label>
            <div class="store-ops"><button :disabled="acctBusy || !acctUserForm.username.trim() || !acctUserForm.password" @click="saveUsername">保存账户名</button></div>
          </div>
          <div class="store-panel">
            <h3>修改密码</h3>
            <label class="store-row">当前密码：<input v-model="acctPwForm.current" type="password" class="acct-input" autocomplete="current-password"></label>
            <label class="store-row">新密码：<input v-model="acctPwForm.next" type="password" class="acct-input" autocomplete="new-password"></label>
            <label class="store-row">确认新密码：<input v-model="acctPwForm.confirm" type="password" class="acct-input" autocomplete="new-password"></label>
            <div class="store-ops"><button :disabled="acctBusy || !acctPwForm.current || !acctPwForm.next" @click="savePassword">修改密码</button></div>
          </div>
        </div>
        <div class="store-ops" style="margin-top:10px">
          <button class="restart-btn" @click="doLogout">退出登录</button>
          <span v-if="acctMsg" :class="acctMsg.startsWith('✕') ? 'c-dislike' : 'c-ok'">{{ acctMsg }}</span>
        </div>
      </div>

      <!-- 模型与偏好 -->
      <template v-else-if="settingsTab === 'model'">
        <div v-if="stats" class="stats">
          <span>总数 {{ stats.total }}</span><span>已下载 {{ stats.downloaded }}</span>
          <span class="c-like">喜欢 {{ stats.liked }}</span><span class="c-dislike">不喜欢 {{ stats.disliked }}</span>
          <span>跳过 {{ stats.skipped }}</span><span>待标注 {{ stats.unlabeled }}</span><span>已向量化 {{ stats.withEmbedding }}</span>
        </div>
        <div class="train-box">
          <button @click="startTrain" :disabled="trainState.status === 'running' || (stats?.liked ?? 0) + (stats?.disliked ?? 0) < 10">训练模型（需 ≥10 条标注）</button>
          <button @click="startZeroshot" :disabled="trainState.status === 'running'">Zero-shot 冷启动粗筛</button>
          <span v-if="trainState.status === 'running'" class="running">⏳ {{ trainState.progress || '进行中…' }}</span>
          <span v-else-if="trainState.status === 'error'" class="c-dislike">✕ {{ trainState.error }}</span>
          <span v-else-if="trainState.status === 'done'" class="c-ok">✓ 完成<template v-if="trainState.result?.version">：模型 v{{ trainState.result.version }} · {{ trainState.result.samples }} 样本 · 出分 {{ trainState.result.scored }} 张</template><template v-else-if="trainState.result?.scored != null">：粗筛 {{ trainState.result.scored }} 张</template></span>
        </div>
        <div v-if="prefs?.trained" class="prefs">
          <p>模型 v{{ prefs.version }} · {{ prefs.samples }} 条样本</p>
          <div class="pref-cols">
            <div><h3>喜欢的元素</h3><ol><li v-for="[t, w] in prefs.positive" :key="t">{{ t }} <em>{{ w.toFixed(2) }}</em></li></ol></div>
            <div><h3>不喜欢的元素</h3><ol><li v-for="[t, w] in prefs.negative" :key="t">{{ t }} <em>{{ w.toFixed(2) }}</em></li></ol></div>
          </div>
        </div>
        <p v-else>尚未训练。先标注一批图片（或先跑 zero-shot 粗筛提高标注效率），然后点"训练模型"。</p>
      </template>

      <!-- 存储设置 -->
      <div v-else-if="settingsTab === 'storage'" class="settings-base">
        <h3>存储设置</h3>
        <p class="lb-hint">压缩与格式规则按存储类型独立配置，保存后对新下载的图片立即生效；「处理存量」按当前规则批量处理已有图片。动图（GIF / 动图 WebP）不参与转换与压缩，转换目标不可选 GIF。</p>
        <table>
          <thead><tr><th>名称</th><th>位置</th><th>剩余空间</th><th>压缩</th><th>格式</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="s in storages" :key="s.type">
              <td>{{ s.name }}（{{ s.type }}）</td>
              <td><code>{{ s.incoming }}</code></td>
              <td>{{ fmtBytes(s.freeBytes) }} / {{ fmtBytes(s.totalBytes) }}</td>
              <td>{{ s.process.compression.enabled ? (s.process.compression.mode === 'scale' ? `尺寸 ×${s.process.compression.scalePercent}%` : `≤ ${s.process.compression.maxSizeMB}MB/张`) : '未启用' }}</td>
              <td>保留 [{{ s.process.formats.enabled.join(', ') }}] → {{ s.process.formats.convertTo }}</td>
              <td class="store-ops">
                <button @click="openStoreEdit(s, 'compression')">图片压缩</button>
                <button @click="openStoreEdit(s, 'formats')">格式设置</button>
                <button :disabled="repro?.running" @click="runReprocess(s)">处理存量</button>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- 压缩设置面板 -->
        <div v-if="editing?.kind === 'compression'" class="store-panel">
          <h3>图片压缩（{{ editing.type }}）</h3>
          <label class="store-row"><input type="checkbox" v-model="compForm.enabled"> 启用压缩</label>
          <template v-if="compForm.enabled">
            <label class="store-row">
              <input type="radio" value="scale" v-model="compForm.mode"> 固定比例（按尺寸）：缩放到原图的
              <input type="number" v-model.number="compForm.scalePercent" min="1" max="100" class="num"> %
            </label>
            <label class="store-row">
              <input type="radio" value="maxSize" v-model="compForm.mode"> 最大单张大小：超过
              <input type="number" v-model.number="compForm.maxSizeMB" min="0.1" max="50" step="0.1" class="num"> MB 时压缩到该值以内（质量 80，自动估算缩放，±5% 误差）
            </label>
          </template>
          <div class="store-ops">
            <button :disabled="savingStore" @click="saveCompression">保存</button>
            <button @click="editing = null">取消</button>
          </div>
        </div>

        <!-- 格式设置面板 -->
        <div v-else-if="editing?.kind === 'formats'" class="store-panel">
          <h3>格式设置（{{ editing.type }}）</h3>
          <div class="store-row">
            启用的格式：
            <label v-for="f in storages.find(x => x.type === editing!.type)?.formatOptions.common ?? []" :key="f" style="margin-right:10px">
              <input type="checkbox" :value="f" v-model="fmtForm.enabled"> {{ f }}
            </label>
          </div>
          <label class="store-row">
            不在启用范围内的图片自动转换为：
            <select v-model="fmtForm.convertTo">
              <option v-for="f in storages.find(x => x.type === editing!.type)?.formatOptions.convertTargets ?? []" :key="f" :value="f">{{ f }}</option>
            </select>
          </label>
          <p class="lb-hint">转换目标必须在启用列表内；不支持转换为 GIF。</p>
          <div class="store-ops">
            <button :disabled="savingStore" @click="saveFormats">保存</button>
            <button @click="editing = null">取消</button>
          </div>
        </div>

        <div v-if="repro?.running" class="running">⏳ 存量处理中{{ repro.phase === 'process' ? `（${repro.done}/${repro.total}）` : '…' }}，请勿关闭页面</div>
        <span v-if="storeMsg" :class="storeMsg.startsWith('✕') ? 'c-dislike' : 'c-ok'">{{ storeMsg }}</span>
      </div>

      <!-- API（接口文档 / 我喜欢这个图片！） -->
      <div v-else-if="settingsTab === 'api'" class="settings-base">
        <div class="api-tabs">
          <button :class="{ on: apiTab === 'docs' }" @click="apiTab = 'docs'">接口文档</button>
          <button :class="{ on: apiTab === 'like' }" @click="apiTab = 'like'">我喜欢这个图片！</button>
        </div>

        <!-- 接口文档 -->
        <div v-if="apiTab === 'docs'">
          <p class="lb-hint">本页列出程序全部内部接口（{{ docGroups.reduce((n, g) => n + g.endpoints.length, 0) }} 个），随版本持续更新；点击分组展开。</p>
          <details v-for="g in docGroups" :key="g.name" class="doc-group">
            <summary><b>{{ g.name }}</b><span class="doc-count">{{ g.endpoints.length }} 个接口</span><span v-if="g.desc" class="doc-gdesc">{{ g.desc }}</span></summary>
            <div v-for="e in g.endpoints" :key="e.method + e.path" class="doc-ep">
              <div class="doc-head">
                <span class="doc-method" :class="'m-' + e.method.toLowerCase()">{{ e.method }}</span>
                <code class="doc-path">{{ e.path }}</code>
              </div>
              <p class="doc-desc">{{ e.desc }}</p>
              <table v-if="e.params?.length" class="doc-params">
                <thead><tr><th>参数</th><th>位置</th><th>类型</th><th>说明</th></tr></thead>
                <tbody>
                  <tr v-for="p in e.params" :key="p.name">
                    <td>{{ p.name }}<em v-if="p.required" class="doc-req">*</em></td>
                    <td>{{ p.in }}</td>
                    <td><code>{{ p.type }}</code></td>
                    <td>{{ p.desc }}</td>
                  </tr>
                </tbody>
              </table>
              <pre v-if="e.response" class="doc-resp">{{ e.response }}</pre>
              <p v-if="e.notes" class="doc-notes">{{ e.notes }}</p>
            </div>
          </details>
        </div>

        <!-- 我喜欢这个图片！ -->
        <div v-else-if="apiTab === 'like'">
          <h3>我喜欢这个图片！</h3>
          <p class="lb-hint">
            <code>POST /api/like</code> — 上传一张图片，按当前训练的模型预测喜欢概率。两种方式：multipart/form-data（字段名 <code>file</code>）或 JSON base64（字段 <code>image</code>，支持 data URL）。
            限制：≤20MB，仅静态 jpg / png / webp（拒绝 gif 与动图）；纯计算不留痕，图片不入库、算完即删。
          </p>
          <pre class="doc-resp">// 返回示例（like = score ≥ 0.5）
{ "score": 0.83, "like": true, "model_version": 7 }

// 错误码：400 格式不支持/动图/缺参数 · 409 模型未训练 · 413 超 20MB · 422 无法解码</pre>
          <div class="like-share">
            <span>分享链接：</span><code>{{ likeShareUrl }}</code>
            <button @click="copyLikeLink">复制</button>
            <a :href="likeShareUrl" target="_blank">打开 ↗</a>
            <span v-if="likeShareMsg" class="c-ok">{{ likeShareMsg }}</span>
          </div>
          <p class="lb-hint">把这个链接发给朋友，对方无需进入后台就能上传图片、看你的模型喜不喜欢它。链接无鉴权，只在可信网络内分享。</p>
          <div class="like-test">
            <input type="file" accept="image/jpeg,image/png,image/webp" @change="onLikeFile">
            <button :disabled="!likeFile || likeTesting" @click="testLike">{{ likeTesting ? '预测中…' : '试试看' }}</button>
          </div>
          <div v-if="likePreview" class="like-result">
            <img :src="likePreview" alt="">
            <div v-if="likeResult" class="like-verdict">
              <span class="pred-badge" :class="likeResult.like ? 'pred-high' : 'pred-low'">{{ likeResult.like ? '♥ 喜欢' : '✕ 不喜欢' }}</span>
              <span class="like-score">{{ (likeResult.score * 100).toFixed(1) }}% · 模型 v{{ likeResult.model_version }}</span>
            </div>
          </div>
          <span v-if="likeErr" class="c-dislike">✕ {{ likeErr }}</span>
        </div>
      </div>
    </section>

<!-- 大图灯箱（含透镜透视） -->
    <div v-if="lightbox" class="lightbox" @click="lightbox = null">
      <div class="lb-stage" @click.stop
           @pointermove="lensMove" @pointerdown="lensMove" @pointerup="lensEnd" @pointerleave="lensEnd">
        <img class="lb-main" :src="imgUrl(`/api/images/${lbMain().id}/file`)" alt="" draggable="false">
        <img v-if="lightbox.items.length > 1" class="lb-peek" :src="imgUrl(`/api/images/${lbPeek().id}/file`)" alt="" draggable="false"
             :style="{ clipPath: lens.on ? `circle(${lensR}px at ${lens.x}px ${lens.y}px)` : 'circle(0px at 0px 0px)' }">
        <div v-if="lightbox.items.length > 1 && lens.on" class="lb-dim"
             :style="{ WebkitMaskImage: `radial-gradient(circle ${lensR}px at ${lens.x}px ${lens.y}px, transparent 96%, black 99%)`, maskImage: `radial-gradient(circle ${lensR}px at ${lens.x}px ${lens.y}px, transparent 96%, black 99%)` }"></div>
      </div>
      <div class="lb-bar" @click.stop>
        <span class="pred-badge" :class="predClass(lbMain().pred_score)">{{ predText(lbMain().pred_score) }}</span>
        <span v-if="lbMain().is_cover" style="color:#ffd479;font-size:12px">★ 封面</span>
        <button class="like" @click="relabel(lbMain().id, 'like'); lightbox = null">♥ 喜欢</button>
        <button class="dislike" @click="relabel(lbMain().id, 'dislike'); lightbox = null">✕ 不喜欢</button>
        <template v-if="lightbox.items.length > 1">
          <button class="lb-btn" @click="lbSwap">⇄ 互换</button>
          <span class="lb-pick"><span class="lb-pick-label">主图</span>
            <button v-for="(it, i) in lightbox.items" :key="'m' + it.id" class="lb-num" :class="{ on: i === lightbox.mainIdx }" @click="lbPickMain(i)">{{ i + 1 }}</button>
          </span>
          <span class="lb-pick"><span class="lb-pick-label">里图</span>
            <button v-for="(it, i) in lightbox.items" :key="'p' + it.id" class="lb-num" :class="{ on: i === lightbox.peekIdx }" @click="lbPickPeek(i)">{{ i + 1 }}</button>
          </span>
          <span class="lb-pick"><span class="lb-pick-label">透镜</span>
            <button class="lb-num" :class="{ on: lensSize === 'S' }" @click="lensSize = 'S'">小</button>
            <button class="lb-num" :class="{ on: lensSize === 'M' }" @click="lensSize = 'M'">中</button>
            <button class="lb-num" :class="{ on: lensSize === 'L' }" @click="lensSize = 'L'">大</button>
          </span>
          <span class="lb-hint">按住图片移动查看透视</span>
        </template>
        <a :href="lbMain().page_url" target="_blank">原页面 ↗</a>
        <button v-if="srcCap(lbMain().source, 'fetchFamily')" class="lb-btn" :disabled="siblingState.running" @click="fetchSiblings">{{ siblingState.running ? '补全中…' : '⬇ 补全子投稿' }}</button>
        <span v-if="siblingState.msg" class="c-ok">{{ siblingState.msg }}</span>
        <button v-if="lightbox.items.length > 1 && lbMain().is_cover === false" class="lb-btn" @click="setCoverCurrent">★ 设为封面</button>
        <span v-if="coverMsg" class="c-ok">{{ coverMsg }}</span>
        <button v-if="lbMain().in_manual" class="lb-btn" @click="unbindCurrent">解除手动绑定</button>
        <template v-if="lightbox.frames.length > 1">
          <button class="lb-btn" @click="lbGo(-1)">◀ 上一组</button>
          <span class="lb-frame-no">{{ lightbox.frameIdx + 1 }}/{{ lightbox.frames.length }}</span>
          <button class="lb-btn" @click="lbGo(1)">下一组 ▶</button>
        </template>
        <span class="lb-hint">ESC 关闭 · ←/→ 切换</span>
      </div>
    </div>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #14161a; color: #e6e6e6; }
.app { max-width: 1100px; margin: 0 auto; padding: 12px; }
header { display: flex; align-items: center; gap: 16px; position: sticky; top: 0; z-index: 60; background: #14161a; padding: 10px 0; }
h1 { font-size: 18px; margin: 0; }
.menu { display: flex; gap: 8px; background: #1d2026; padding: 6px; border-radius: 12px; }
.menu button { background: transparent; color: #9ba1a6; border: none; padding: 9px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; transition: all .15s; }
.menu button:hover { color: #e6e6e6; background: #2a2d34; }
.menu button.on { background: #3b82f6; color: #fff; font-weight: 600; }
.toolbar button { background: #23262d; color: #ccc; border: 1px solid #333; padding: 6px 14px; border-radius: 6px; cursor: pointer; }
.toolbar button.on { background: #3b82f6; color: #fff; border-color: #3b82f6; }
.pred-badge { display: inline-block; padding: 4px 14px; border-radius: 999px; font-weight: 600; font-size: 14px; }
.pred-high { background: #1f6f43; color: #a7f3c9; }
.pred-mid { background: #6b5b1f; color: #f3e3a7; }
.pred-low { background: #4a2326; color: #f3a7a7; }
.pred-none { background: #23262d; color: #888; }
section { margin-top: 16px; }
.toolbar { display: flex; gap: 14px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; position: sticky; top: 70px; z-index: 55; background: #14161a; padding: 8px 0; }
thead th { position: sticky; top: 118px; background: #14161a; z-index: 50; }
.stage img { max-width: 100%; max-height: 62vh; display: block; margin: 0 auto; border-radius: 8px; background: #000; }
.meta { text-align: center; margin: 8px 0; color: #999; }
.meta a { color: #7ab3ff; }
.tags { font-size: 12px; }
.actions { display: flex; justify-content: center; gap: 16px; margin-top: 10px; }
.actions button { font-size: 18px; padding: 12px 32px; border-radius: 8px; border: none; cursor: pointer; }
.like { background: #e5484d; color: #fff; } .dislike { background: #697177; color: #fff; } .skip { background: #23262d; color: #ccc; border: 1px solid #444 !important; }
.empty { text-align: center; padding: 80px 0; color: #888; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.grid figure { margin: 0; background: #1d2026; border-radius: 6px; overflow: hidden; }
.grid img { width: 100%; height: 150px; object-fit: cover; display: block; }
.grid figcaption { display: flex; gap: 6px; padding: 4px 6px; font-size: 12px; align-items: center; }
.grid .lbl { flex: 1; color: #888; }
.new-task { display: flex; gap: 8px; margin-bottom: 14px; }
.new-task input, .new-task select { background: #1d2026; border: 1px solid #333; color: #eee; padding: 8px; border-radius: 6px; flex: 1; }
.new-task button, .train-box button { background: #3b82f6; border: none; color: #fff; padding: 8px 18px; border-radius: 6px; cursor: pointer; }
.train-box button:disabled { opacity: .4; cursor: not-allowed; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { border-bottom: 1px solid #2a2d34; padding: 6px 8px; text-align: left; }
.stats { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 14px; }
.c-like { color: #ff8a8e; } .c-dislike { color: #9ba1a6; }
.train-box { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
.pref-cols { display: flex; gap: 40px; }
.pref-cols em { color: #888; font-size: 12px; }
.running { color: #7ab3ff; animation: pulse 1.2s ease-in-out infinite; }
.c-ok { color: #7ee2a8; }
.settings-base h3 { margin: 4px 0 6px; font-size: 15px; }
.path-list { margin: 10px 0 14px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.store-panel { margin: 14px 0; padding: 12px 14px; background: #1d2026; border: 1px solid #2a2d34; border-radius: 8px; }
.store-row { display: block; margin: 8px 0; font-size: 13px; }
.store-row .num { width: 70px; background: #14161a; border: 1px solid #333; color: #eee; padding: 4px 6px; border-radius: 4px; }
.store-row select { background: #14161a; border: 1px solid #333; color: #eee; padding: 4px 8px; border-radius: 4px; }
.store-ops { display: flex; gap: 8px; }
.store-ops button { background: #23262d; color: #ccc; border: 1px solid #333; padding: 5px 12px; border-radius: 6px; cursor: pointer; }
.store-ops button:hover { color: #fff; border-color: #3b82f6; }
.store-ops button:disabled { opacity: .4; cursor: not-allowed; }
.path-list span { display: inline-block; width: 90px; color: #888; }
.path-list code { color: #7ab3ff; word-break: break-all; }
.restart-btn { background: #e5484d; border: none; color: #fff; padding: 8px 18px; border-radius: 6px; cursor: pointer; font-size: 14px; }
/* API 页：接口文档 + 我喜欢这个图片！ */
.api-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
.api-tabs button { background: #1d2026; color: #9ba1a6; border: 1px solid #2a2d34; padding: 6px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; }
.api-tabs button.on { background: #3b82f6; color: #fff; border-color: #3b82f6; }
.doc-group { background: #1d2026; border: 1px solid #2a2d34; border-radius: 8px; margin-bottom: 8px; }
.doc-group summary { padding: 10px 14px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.doc-count { color: #888; font-size: 12px; }
.doc-gdesc { color: #666; font-size: 12px; }
.doc-ep { border-top: 1px solid #2a2d34; padding: 10px 14px; }
.doc-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.doc-method { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
.m-get { background: #1f6f43; color: #a7f3c9; }
.m-post { background: #1f4e79; color: #a7d3f3; }
.m-put { background: #6b5b1f; color: #f3e3a7; }
.m-delete { background: #4a2326; color: #f3a7a7; }
.doc-path { color: #7ab3ff; word-break: break-all; }
.doc-desc { margin: 8px 0; font-size: 13px; color: #ccc; }
.doc-params { font-size: 12px; margin: 6px 0; }
.doc-req { color: #e5484d; font-style: normal; }
.doc-resp { background: #14161a; border: 1px solid #2a2d34; border-radius: 6px; padding: 8px 10px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; color: #a7f3c9; }
.doc-notes { font-size: 12px; color: #888; margin: 6px 0 2px; }
.like-test { display: flex; gap: 8px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
.like-share { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 10px 0 4px; font-size: 13px; }
.like-share code { color: #7ab3ff; word-break: break-all; }
.like-share button { background: #23262d; color: #ccc; border: 1px solid #333; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.like-share a { color: #7ab3ff; text-decoration: none; }
.like-test input[type=file] { color: #999; font-size: 13px; max-width: 100%; }
.like-test button { background: #3b82f6; border: none; color: #fff; padding: 8px 18px; border-radius: 6px; cursor: pointer; }
.like-test button:disabled { opacity: .4; cursor: not-allowed; }
.like-result img { max-width: 260px; max-height: 260px; border-radius: 8px; display: block; margin-bottom: 8px; }
.like-verdict { display: flex; gap: 12px; align-items: center; }
.like-score { color: #999; font-size: 13px; }
@keyframes pulse { 50% { opacity: .45; } }
figure.stack { position: relative; height: 150px; }
figure.stack img { position: absolute; inset: 0; opacity: 0; transition: opacity .22s ease; cursor: zoom-in; }
figure.stack img.shown { opacity: 1; }
figure.stack .layers { position: absolute; right: 4px; top: 4px; z-index: 2; background: rgba(0,0,0,.65); color: #ffd479; font-size: 11px; padding: 1px 7px; border-radius: 999px; pointer-events: none; }
figure.stack.bind-sel { outline: 3px solid #3b82f6; outline-offset: -3px; }
.grp-btn { background: #2a2d34; color: #ffd479; border: 1px solid #444; padding: 4px 12px; border-radius: 999px; cursor: pointer; font-size: 13px; }
figure.stack.bind-sel::after { content: '✓'; position: absolute; left: 4px; top: 4px; z-index: 2; background: #3b82f6; color: #fff; font-size: 12px; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.88); z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
.lb-stage { position: relative; max-width: 94vw; max-height: 82vh; touch-action: none; user-select: none; }
.lb-main { max-width: 94vw; max-height: 82vh; border-radius: 8px; display: block; }
.lb-peek { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; border-radius: 8px; transition: clip-path .08s linear; pointer-events: none; }
.lb-btn { background: #2a2d34; color: #ffd479; border: 1px solid #444; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
.lb-stage { overflow: hidden; border-radius: 8px; }
.lb-dim { position: absolute; inset: 0; background: rgba(0,0,0,.25); pointer-events: none; border-radius: 8px; }
.lb-pick { display: inline-flex; align-items: center; gap: 4px; color: #aaa; font-size: 13px; }
.lb-num { width: 30px; height: 30px; border-radius: 6px; border: 1px solid #444; background: #2a2d34; color: #ccc; cursor: pointer; font-size: 13px; }
.lb-num.on { background: #ffd479; color: #1a1a1a; font-weight: 700; border-color: #ffd479; }
/* 移动端适配 */
@media (max-width: 640px) {
  .app { padding: 8px; }
  header { flex-direction: column; align-items: stretch; gap: 8px; }
  h1 { text-align: center; }
  .menu { overflow-x: auto; justify-content: flex-start; }
  .menu button { padding: 8px 14px; font-size: 13px; white-space: nowrap; }
  .stage img { max-height: 48vh; }
  .actions { position: sticky; bottom: 0; background: #14161a; padding: 10px 0; gap: 8px; }
  .actions button { font-size: 16px; padding: 14px 18px; flex: 1; }
  .grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 6px; }
  .grid img, figure.stack { height: 110px; }
  .new-task { flex-wrap: wrap; }
  .new-task input, .new-task select { flex: 1 1 45%; }
  .lb-bar { flex-wrap: wrap; justify-content: center; max-width: 94vw; }
  .lb-stage, .lb-main { max-height: 62vh; }
  .toolbar { font-size: 13px; top: 100px; }
  thead th { top: 148px; }
  table { font-size: 12px; }
}
.lb-bar { display: flex; gap: 12px; align-items: center; background: #1d2026; padding: 10px 18px; border-radius: 10px; }
.lb-bar button { border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; }
.lb-bar a { color: #7ab3ff; }
.lb-hint { color: #666; font-size: 12px; }
.lb-frame-no { color: #888; font-size: 12px; }
/* 登录页 */
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
.login-box { width: 100%; max-width: 380px; background: #1d2026; border: 1px solid #2a2d34; border-radius: 12px; padding: 28px 24px; display: flex; flex-direction: column; gap: 14px; }
.login-box h1 { text-align: center; margin-bottom: 6px; }
.login-row { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.login-row > span { width: 52px; flex-shrink: 0; color: #9ba1a6; text-align: right; }
.login-row input, .login-row select { flex: 1; min-width: 0; background: #14161a; border: 1px solid #333; color: #eee; padding: 9px 10px; border-radius: 6px; font-size: 14px; }
.login-svr-op { margin-top: -8px; }
.login-svr-del { background: transparent; border: none; color: #9ba1a6; font-size: 12px; cursor: pointer; text-decoration: underline; padding: 0; }
.login-svr-del:hover { color: #f3a7a7; }
.login-remember { font-size: 13px; color: #9ba1a6; display: flex; gap: 8px; align-items: flex-start; line-height: 1.5; }
.login-remember input { margin-top: 3px; }
.login-btn { background: #3b82f6; border: none; color: #fff; padding: 11px; border-radius: 8px; font-size: 15px; cursor: pointer; }
.login-btn:disabled { opacity: .4; cursor: not-allowed; }
.login-err { margin: 0; font-size: 13px; text-align: center; }
/* 设置页账户区 */
.acct-name { color: #7ab3ff; }
.acct-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
.acct-input { background: #14161a; border: 1px solid #333; color: #eee; padding: 6px 8px; border-radius: 4px; width: 220px; max-width: 100%; }
@media (max-width: 640px) {
  .acct-grid { grid-template-columns: 1fr; }
  .acct-input { width: 100%; }
}
/* 移动端灯箱工具栏紧凑化：藏提示文字与选择器标签，缩小按钮 */
@media (max-width: 640px) {
  .lb-bar { gap: 6px; padding: 6px 10px; }
  .lb-bar button { padding: 6px 10px; font-size: 13px; }
  .lb-bar .lb-num { width: 26px; height: 26px; padding: 0; }
  .lb-bar .lb-hint, .lb-bar .lb-pick-label { display: none; }
  .lb-bar .pred-badge { padding: 3px 10px; font-size: 12px; }
}
</style>
