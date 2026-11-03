import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { SourcePlugin, ImageMeta, SearchQuery, FetchOpts } from './types.js';
import { config } from '../config.js';

/**
 * X (Twitter) 数据源：非官方 GraphQL API + 用户 cookie。
 *
 * ⚠️ 脆弱性：queryId / bearer / 返回 JSON 路径都是 X 私有格式，X 改版即失效。
 *    失效时任务报「X 接口可能已变更」，需手动从浏览器开发者工具挖新值更新本文件。
 * ⚠️ 风控：非官方 API 无保证，只能贴 web 端正常浏览形态 + 保守限速（2~3s/请求）。
 *
 * cookie 配置：config.json → sources.x.cookie，从浏览器 F12 复制整条 Cookie 头，
 * 驱动自行解析 auth_token / ct0。
 */

// ---- 硬编码的 web 端常量（X 改版后需手动更新）----
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const QUERY_IDS = {
  UserMedia: 'frYNjZhGZmtrgXmi_tIMkA',
  Likes: 'a6ZbplAY_XzbVtjy_Ko_Q',
  SearchTimeline: '3fEctOs2-FvTB7_mvm1hrQ',
} as const;
const GRAPHQL_BASE = 'https://x.com/i/api/graphql';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randSleep = (min: number, max: number) => sleep(min + Math.random() * (max - min));

// ---- cookie 解析 ----
interface XAuth { authToken: string; ct0: string }

function parseCookie(raw: string): XAuth {
  const map = new Map<string, string>();
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const authToken = map.get('auth_token');
  const ct0 = map.get('ct0');
  if (!authToken || !ct0) throw new Error('cookie 中缺少 auth_token 或 ct0，请从浏览器复制完整 Cookie 头');
  return { authToken, ct0 };
}

function client(auth: XAuth, proxy?: string | null): AxiosInstance {
  let agent: HttpsProxyAgent<string> | SocksProxyAgent | undefined;
  if (proxy) {
    agent = proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy);
  }
  return axios.create({
    timeout: 30_000,
    httpAgent: agent,
    httpsAgent: agent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Authorization': `Bearer ${decodeURIComponent(BEARER)}`,
      'x-csrf-token': auth.ct0,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'zh-cn',
      'Cookie': `auth_token=${auth.authToken}; ct0=${auth.ct0}`,
      'Referer': 'https://x.com/',
      'Origin': 'https://x.com',
    },
  });
}

// ---- 限流状态（跨调用共享，供 crawler 写 progress）----
export const xRateLimit = { waiting: false, until: 0 };

// ---- GraphQL 请求 ----
interface GqlResp { data?: Record<string, unknown>; errors?: { message: string; code?: number }[] }

async function gql(http: AxiosInstance, op: keyof typeof QUERY_IDS, variables: Record<string, unknown>, retries = 4): Promise<Record<string, unknown>> {
  const queryId = QUERY_IDS[op];
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await http.get<GqlResp>(`${GRAPHQL_BASE}/${queryId}/${op}`, {
        params: {
          variables: JSON.stringify(variables),
          features: JSON.stringify(FEATURES),
        },
      });
      if (resp.data?.errors?.length) {
        const msg = resp.data.errors.map(e => e.message).join('; ');
        throw new Error(`X GraphQL 错误: ${msg}`);
      }
      return resp.data?.data ?? {};
    } catch (e) {
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      if (status === 401 || status === 403) {
        throw new Error('X cookie 失效（401/403），请在设置页更新 cookie');
      }
      if (status === 429) {
        // 指数退避，最长 10 分钟
        const wait = Math.min(30_000 * Math.pow(2, attempt), 600_000);
        xRateLimit.waiting = true;
        xRateLimit.until = Date.now() + wait;
        console.warn(`[x] 429 限流，等待 ${(wait / 1000).toFixed(0)}s（第 ${attempt + 1} 次）`);
        await sleep(wait);
        xRateLimit.waiting = false;
        continue;
      }
      if (status === 404) {
        throw new Error('X 接口 404（queryId 可能已失效），需更新 sources/x.ts');
      }
      if (attempt < retries) {
        console.warn(`[x] 请求失败(${attempt + 1}/${retries + 1}): ${e instanceof Error ? e.message : e}`);
        await randSleep(3000, 6000);
        continue;
      }
      throw e;
    }
  }
  throw new Error('unreachable');
}

// 大部分查询共用的 features（X web 端当前版本）
const FEATURES = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_profile_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

// ---- 从 GraphQL 响应提取带图推文 ----
interface TweetMedia { type: string; media_url_https?: string; original_info?: { width?: number; height?: number }; video_info?: unknown }

interface TweetResult {
  rest_id?: string;
  core?: { user_results?: { result?: { core?: { screen_name?: string } } } };
  legacy?: {
    extended_entities?: { media?: TweetMedia[] };
    entities?: { media?: TweetMedia[] };
  };
  // UserMedia 返回结构略有不同
  [k: string]: unknown;
}

function extractTweets(data: Record<string, unknown>): { tweets: TweetResult[]; cursor: string | null } {
  // 尝试多种路径（UserMedia / Likes / SearchTimeline 结构不同）
  const paths = [
    ['user', 'result', 'timeline_v2', 'timeline'],
    ['user', 'result', 'timeline', 'timeline'],
    ['search_by_raw_query', 'search_timeline', 'timeline'],
    ['viewer', 'timeline_v2', 'timeline'],
    ['viewer', 'timeline'],
  ];
  let timeline: Record<string, unknown> | undefined;
  for (const p of paths) {
    let cur: unknown = data;
    for (const k of p) cur = (cur as Record<string, unknown>)?.[k];
    if (cur && typeof cur === 'object' && 'instructions' in (cur as Record<string, unknown>)) {
      timeline = cur as Record<string, unknown>;
      break;
    }
  }
  if (!timeline) return { tweets: [], cursor: null };

  const instructions = (timeline as { instructions?: { type?: string; entries?: unknown[] }[] }).instructions ?? [];
  const tweets: TweetResult[] = [];
  let cursor: string | null = null;

  for (const inst of instructions) {
    if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
      for (const entry of inst.entries) {
        const e = entry as { entryId?: string; content?: Record<string, unknown> };
        // 提取 cursor
        if (e.entryId?.startsWith('cursor-bottom')) {
          const val = (e.content as { value?: string })?.value;
          if (val) cursor = val;
          continue;
        }
        // 提取推文
        const result = findTweetResult(e.content);
        if (result) tweets.push(result);
      }
    }
  }
  return { tweets, cursor };
}

function findTweetResult(content: unknown): TweetResult | null {
  if (!content || typeof content !== 'object') return null;
  const c = content as Record<string, unknown>;
  // TimelineTweet → itemContent → tweet_results → result
  const item = c.itemContent as Record<string, unknown> | undefined;
  const result = (item?.tweet_results as Record<string, unknown>)?.result ?? c.result;
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  // 有可能是 tweet 套 tweet（retweet），取内层
  if (r.__typename === 'TweetWithVisibilityResults' && r.tweet) return findTweetResult(r.tweet);
  if (r.rest_id || r.legacy) return r as TweetResult;
  return null;
}

function tweetToMeta(tweet: TweetResult): ImageMeta[] {
  const id = tweet.rest_id;
  if (!id) return [];
  const screenName = tweet.core?.user_results?.result?.core?.screen_name ?? 'unknown';
  const media = tweet.legacy?.extended_entities?.media ?? tweet.legacy?.entities?.media ?? [];
  const photos = media.filter(m => m.type === 'photo' && m.media_url_https);
  const pageUrl = `https://x.com/${screenName}/status/${id}`;
  return photos.map((m, i) => ({
    source: 'x',
    sourceId: photos.length > 1 ? `${id}:${i}` : id,
    pageUrl,
    fileUrl: `${m.media_url_https}?name=orig`,
    previewUrl: `${m.media_url_https}?name=small`,
    tags: [],
    width: m.original_info?.width,
    height: m.original_info?.height,
    rating: undefined,
  }));
}

// UserByScreenName 的 queryId（user-media 模式需要先解析用户 ID）
const USER_BY_SCREEN_NAME_ID = 'AMIBMjtxEEATh4z8V9GtRg';

async function getUserId(http: AxiosInstance, handle: string): Promise<string> {
  const screenName = handle.replace(/^@/, '');
  const resp = await http.get<{ data?: { user?: { result?: { rest_id?: string } } }; errors?: { message: string }[] }>(
    `${GRAPHQL_BASE}/${USER_BY_SCREEN_NAME_ID}/UserByScreenName`,
    {
      params: {
        variables: JSON.stringify({ screen_name: screenName }),
        features: JSON.stringify(FEATURES),
      },
    },
  );
  const id = resp.data?.data?.user?.result?.rest_id;
  if (!id) throw new Error(`找不到用户 @${screenName}（可能不存在或 cookie 失效）`);
  return id;
}

// ---- 插件实现 ----
export const x: SourcePlugin = {
  name: 'x',

  async *search(query: SearchQuery, opts: FetchOpts) {
    const raw = config.sources.x?.cookie;
    if (!raw) throw new Error('X cookie 未配置，请在设置页填写');
    const auth = parseCookie(raw);
    const http = client(auth, opts.proxy);
    const kind = query.kind ?? 'user-media';
    const limit = query.limit;
    let yielded = 0;
    let cursor: string | null = null;

    // skip 语义：空翻 cursor（只解析不下载）
    let skipRemaining = Math.max(query.skip ?? 0, 0);

    // user-media 需要先解析用户 ID
    let userId: string | null = null;
    if (kind === 'user-media') {
      if (!query.target) throw new Error('user-media 模式需要提供目标用户句柄');
      userId = await getUserId(http, query.target);
    }

    while (yielded < limit) {
      if (opts.shouldContinue && !opts.shouldContinue()) return;
      await randSleep(2000, 3000); // 保守限速

      let variables: Record<string, unknown>;
      let op: keyof typeof QUERY_IDS;

      if (kind === 'user-media') {
        op = 'UserMedia';
        variables = { userId, count: 20, includePromotedContent: false, withClientEventToken: false, withBirdwatchNotes: false, withVoice: true, ...(cursor ? { cursor } : {}) };
      } else if (kind === 'user-likes') {
        op = 'Likes';
        // Likes 需要当前用户 rest_id，从 cookie 里解不出，用 viewer 查询
        // 实际上 Likes 端点不需要 userId，用 viewer 身份即可
        variables = { count: 20, includePromotedContent: false, ...(cursor ? { cursor } : {}) };
      } else {
        op = 'SearchTimeline';
        variables = {
          rawQuery: query.target,
          count: 20,
          querySource: 'typed_query',
          product: query.sort === 'latest' ? 'Latest' : 'Top',
          ...(cursor ? { cursor } : {}),
        };
      }

      const data = await gql(http, op, variables);
      const { tweets, cursor: nextCursor } = extractTweets(data);

      const batch: ImageMeta[] = [];
      for (const t of tweets) {
        for (const meta of tweetToMeta(t)) {
          if (skipRemaining > 0) { skipRemaining--; continue; }
          if (yielded >= limit) break;
          batch.push(meta);
          yielded++;
        }
      }
      if (batch.length) yield batch;

      if (!nextCursor || tweets.length === 0) return; // 没有更多了
      cursor = nextCursor;
    }
  },

  async fetchImage(meta: ImageMeta, opts: FetchOpts) {
    const raw = config.sources.x?.cookie;
    if (!raw) throw new Error('X cookie 未配置');
    const auth = parseCookie(raw);
    const http = client(auth, opts.proxy);
    await randSleep(1000, 2000); // 图片下载也限速
    const resp = await http.get<ArrayBuffer>(meta.fileUrl, { responseType: 'arraybuffer', timeout: 60_000 });
    return Buffer.from(resp.data as ArrayBuffer);
  },
};
