<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { api, type NextImage, type Task, type Stats } from './api';

const savedTab = localStorage.getItem('ic-tab') as Tab | null;
type Tab = 'rate' | 'review' | 'album' | 'tasks' | 'model';
const tab = ref<Tab>(savedTab ?? 'rate'); // 刷新后回到原页面

// ---- 打分 ----
const mode = ref<'smart' | 'sequential'>('smart');
const current = ref<NextImage | null>(null);
const remaining = ref(0);
const allDone = ref(false);
const loading = ref(false);
let preload: string | null = null;

async function loadNext() {
  loading.value = true;
  try {
    const r = await api.next(mode.value);
    allDone.value = r.done;
    current.value = r.image ?? null;
    remaining.value = r.remaining ?? 0;
    if (current.value) preload = `/api/images/${current.value.id}/file`;
  } finally { loading.value = false; }
}

async function label(label_: string) {
  if (!current.value || loading.value) return;
  const id = current.value.id;
  loading.value = true; // 防连击
  try { await api.label(id, label_); } finally { loading.value = false; }
  await loadNext();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && lightbox.value) { lightbox.value = null; return; }
  if (tab.value !== 'rate') return;
  if (e.key === '1') label('like');
  else if (e.key === '2') label('dislike');
  else if (e.key === '3') label('skip');
}

// ---- 任务 ----
const tasks = ref<Task[]>([]);
const sources = ref<{ name: string; enabled: boolean }[]>([]);
const newTask = ref({ source: 'yandere', tags: '', limit: 100, proxy: '' });
async function refreshTasks() { tasks.value = await api.tasks(); }
let taskTimer: number | undefined;
watch(tab, (t) => {
  localStorage.setItem('ic-tab', t);
  window.clearInterval(taskTimer);
  if (t === 'tasks') { refreshTasks(); taskTimer = window.setInterval(refreshTasks, 2000); } // 自动拉取进度
  if (t === 'rate') loadNext(); // 回到打分页：按最新预测分重新取第一张
  if (t === 'review') refreshReview();
  if (t === 'album') refreshAlbum();
  if (t === 'model') refreshModel();
});

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
  await api.createTask(newTask.value.source, tags, newTask.value.limit, newTask.value.proxy);
  newTask.value.tags = '';
  await refreshTasks();
}

// ---- 相册 ----
type AlbumItem = NextImage & { parent_id: number | null; labeled_at: string | null };
interface AlbumGroup { key: string; items: AlbumItem[]; hoverIdx: number }
const albumGroups = ref<AlbumGroup[]>([]);
const backfilling = ref(false);
const backfillDone = ref(0);
const backfillTotal = ref(0);
let backfillTimer: number | undefined;
async function refreshAlbum() {
  const rows = await api.album();
  const map = new Map<string, AlbumItem[]>();
  for (const r of rows) {
    const key = r.parent_id && r.parent_id > 0 ? `${r.source}_p${r.parent_id}` : `${r.source}_${r.source_id}`;
    const arr = map.get(key) ?? [];
    arr.push(r);
    map.set(key, arr);
  }
  albumGroups.value = [...map.entries()].map(([key, items]) => ({ key, items, hoverIdx: 0 })).sort((a, b) => b.items.length - a.items.length); // 多变体组排前面
  // 回填若在跑（比如重启前触发的），恢复进度显示
  const s = await api.backfillStatus();
  backfillDone.value = s.done; backfillTotal.value = s.total;
  if (s.running && !backfilling.value) pollBackfill();
}
function albumHover(g: AlbumGroup, on: boolean) {
  if (!on) { g.hoverIdx = 0; return; }
  if (g.items.length > 1) g.hoverIdx = (g.hoverIdx + 1) % g.items.length; // 悬浮切换到透视变体
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
async function startTrain() { trainState.value = { status: 'running', progress: '已启动，正在准备…（首次向量化较慢）' }; await api.train(); pollTrain(); }
async function startZeroshot() { trainState.value = { status: 'running', progress: '已启动，正在加载模型…' }; await api.zeroshot(); pollTrain(); }
function pollTrain() {
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(async () => {
    trainState.value = await api.trainStatus();
    if (trainState.value.status !== 'running') { window.clearInterval(pollTimer); await refreshModel(); }
  }, 1500);
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

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  sources.value = await api.sources();
  await Promise.all([loadNext(), refreshTasks(), refreshModel(), refreshReview(), refreshAlbum()]);
});
type LbImage = NextImage & { user_label?: string | null; parent_id?: number | null; labeled_at?: string | null };
interface LightboxState { items: LbImage[]; mainIdx: number; peekIdx: number }
const lightbox = ref<LightboxState | null>(null);
const lens = ref({ on: false, x: 0, y: 0 });
let savedScroll = 0;

function openLightbox(items: LbImage[], mainIdx = 0) {
  lightbox.value = { items, mainIdx, peekIdx: items.length > 1 ? (mainIdx === 0 ? 1 : 0) : 0 };
  lens.value.on = false;
}
function lbMain(): LbImage { const l = lightbox.value!; return l.items[l.mainIdx]; }
function lbPeek(): LbImage { const l = lightbox.value!; return l.items[l.peekIdx]; }
function nextIdx(cur: number, skip: number, n: number): number { let i = cur; do { i = (i + 1) % n; } while (i === skip); return i; }
function lbSwap() { const l = lightbox.value!; [l.mainIdx, l.peekIdx] = [l.peekIdx, l.mainIdx]; }
function lbMainNext() { const l = lightbox.value!; l.mainIdx = nextIdx(l.mainIdx, l.peekIdx, l.items.length); lens.value.on = false; }
function lbPeekNext() { const l = lightbox.value!; l.peekIdx = nextIdx(l.peekIdx, l.mainIdx, l.items.length); }
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
onUnmounted(() => { window.removeEventListener('keydown', onKey); window.clearInterval(pollTimer); window.clearInterval(taskTimer); });
</script>

<template>
  <div class="app">
    <header>
      <h1>image-curator</h1>
      <nav class="menu">
        <button :class="{ on: tab === 'rate' }" @click="tab = 'rate'">🖊️ 打分</button>
        <button :class="{ on: tab === 'review' }" @click="tab = 'review'">🔍 审查修正</button>
        <button :class="{ on: tab === 'album' }" @click="tab = 'album'">📷 相册</button>
        <button :class="{ on: tab === 'tasks' }" @click="tab = 'tasks'">⬇️ 抓取任务</button>
        <button :class="{ on: tab === 'model' }" @click="tab = 'model'">🧠 模型与偏好</button>
      </nav>
    </header>

    <!-- 打分 -->
    <section v-if="tab === 'rate'" class="rate">
      <div class="toolbar">
        <label><input type="checkbox" :checked="mode === 'smart'" @change="mode = ($event.target as HTMLInputElement).checked ? 'smart' : 'sequential'; loadNext()"> 智能排序（按预测分）</label>
        <span>待标注: {{ remaining }}</span>
        <span class="pred-badge" :class="predClass(current?.pred_score)">{{ predText(current?.pred_score) }}</span>
      </div>
      <div v-if="allDone" class="empty">🎉 全部标注完成</div>
      <div v-else-if="current" class="stage">
        <img :src="`/api/images/${current.id}/file`" :key="current.id" alt="">
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
        <figure v-for="img in reviewList" :key="img.id">
          <img :src="`/api/images/${img.id}/thumb`" loading="lazy" alt="" style="cursor:zoom-in" @click="openLightbox([img])">
          <figcaption>
            <span v-if="img.pred_score != null">{{ img.pred_score.toFixed(2) }}</span>
            <span class="lbl">{{ img.user_label ?? '未标注' }}</span>
            <button @click="relabel(img.id, 'like')">♥</button>
            <button @click="relabel(img.id, 'dislike')">✕</button>
          </figcaption>
        </figure>
      </div>
    </section>

    <!-- 大图灯箱（含透镜透视） -->
    <div v-if="lightbox" class="lightbox" @click="lightbox = null">
      <div class="lb-stage" @click.stop
           @pointermove="lensMove" @pointerdown="lensMove" @pointerup="lensEnd" @pointerleave="lensEnd">
        <img class="lb-main" :src="`/api/images/${lbMain().id}/file`" alt="" draggable="false">
        <img v-if="lightbox.items.length > 1" class="lb-peek" :src="`/api/images/${lbPeek().id}/file`" alt="" draggable="false"
             :style="{ clipPath: lens.on ? `circle(130px at ${lens.x}px ${lens.y}px)` : 'circle(0px at 0px 0px)' }">
      </div>
      <div class="lb-bar" @click.stop>
        <span class="pred-badge" :class="predClass(lbMain().pred_score)">{{ predText(lbMain().pred_score) }}</span>
        <button class="like" @click="relabel(lbMain().id, 'like'); lightbox = null">♥ 喜欢</button>
        <button class="dislike" @click="relabel(lbMain().id, 'dislike'); lightbox = null">✕ 不喜欢</button>
        <template v-if="lightbox.items.length > 1">
          <button class="lb-btn" @click="lbSwap">⇄ 主/里互换</button>
          <template v-if="lightbox.items.length > 2">
            <button class="lb-btn" @click="lbMainNext">主图 ▸</button>
            <button class="lb-btn" @click="lbPeekNext">里图 ▸</button>
          </template>
          <span class="lb-hint">{{ lightbox.mainIdx + 1 }}/{{ lightbox.items.length }} · 按住图片移动查看透视</span>
        </template>
        <a :href="lbMain().page_url" target="_blank">原页面 ↗</a>
        <span class="lb-hint">ESC 关闭</span>
      </div>
    </div>

    <!-- 相册 -->
    <section v-else-if="tab === 'album'">
      <div class="toolbar">
        <span>{{ albumGroups.length }} 组 · {{ albumGroups.reduce((s, g) => s + g.items.length, 0) }} 张喜欢</span>
        <span class="lb-hint">带 ⇄ 角标的组有透视变体，鼠标悬浮查看</span>
        <button :disabled="backfilling" @click="backfill">{{ backfilling ? `回填中 ${backfillDone}/${backfillTotal}` : '回填老数据的透视关系' }}</button>
        <span v-if="!backfilling && backfillTotal > 0" class="c-ok">✓ 上次回填 {{ backfillTotal }} 张</span>
      </div>
      <div class="grid">
        <figure v-for="g in albumGroups" :key="g.key" class="stack">
          <img :src="`/api/images/${g.items[0].id}/thumb`" loading="lazy" alt="" class="shown" style="cursor:zoom-in" @click="openLightbox(g.items, 0)">
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
        <input v-model="newTask.tags" placeholder="tags（空格分隔），如 white_thighhighs rating:s">
        <input v-model.number="newTask.limit" type="number" min="1" max="2000" style="width:90px">
        <input v-model="newTask.proxy" placeholder="代理（留空用默认）" style="width:200px">
        <button type="submit">开始抓取</button>
      </form>
      <table>
        <thead><tr><th>ID</th><th>源</th><th>查询</th><th>状态</th><th>搜到/新增/下载</th><th>错误</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in tasks" :key="t.id">
            <td>{{ t.id }}</td><td>{{ t.source }}</td><td>{{ JSON.parse(t.query).tags.join(' ') }}</td>
            <td>{{ t.status }}</td><td>搜到 {{ t.seen ?? 0 }} · 新增 {{ t.fetched }} · 下载 {{ t.downloaded }}/{{ t.target }}</td><td>{{ t.error }}</td>
            <td>
              <button v-if="t.status === 'running'" @click="api.pauseTask(t.id).then(refreshTasks)">暂停</button>
              <button v-if="t.status === 'paused' || t.status === 'error'" @click="api.resumeTask(t.id).then(refreshTasks)">继续</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 模型与偏好 -->
    <section v-else>
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
    </section>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #14161a; color: #e6e6e6; }
.app { max-width: 1100px; margin: 0 auto; padding: 12px; }
header { display: flex; align-items: center; gap: 16px; }
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
.toolbar { display: flex; gap: 14px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
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
@keyframes pulse { 50% { opacity: .45; } }
figure.stack { position: relative; height: 150px; }
figure.stack img { position: absolute; inset: 0; opacity: 0; transition: opacity .22s ease; cursor: zoom-in; }
figure.stack img.shown { opacity: 1; }
figure.stack .layers { position: absolute; right: 4px; top: 4px; z-index: 2; background: rgba(0,0,0,.65); color: #ffd479; font-size: 11px; padding: 1px 7px; border-radius: 999px; pointer-events: none; }
.lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.88); z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
.lb-stage { position: relative; max-width: 94vw; max-height: 82vh; touch-action: none; user-select: none; }
.lb-main { max-width: 94vw; max-height: 82vh; border-radius: 8px; display: block; }
.lb-peek { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; border-radius: 8px; transition: clip-path .08s linear; pointer-events: none; }
.lb-btn { background: #2a2d34; color: #ffd479; border: 1px solid #444; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
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
  .toolbar { font-size: 13px; }
  table { font-size: 12px; }
}
.lb-bar { display: flex; gap: 12px; align-items: center; background: #1d2026; padding: 10px 18px; border-radius: 10px; }
.lb-bar button { border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; }
.lb-bar a { color: #7ab3ff; }
.lb-hint { color: #666; font-size: 12px; }
</style>
