# PRD：Twitter/X 数据源接入 + 模型过滤抓取模式

> 状态：已定稿（2026-11-03，Q1~Q3 已确认）
> 背景：现有 `src/server/sources/` 为插件架构（`SourcePlugin` 接口 + registry + `config.sources[name]` 配置），本次接入 X 不改架构；家族补全等能力按 caps 机制对 X 自动禁用。

## 目标

1. 新增 X（Twitter）数据源驱动 `src/server/sources/x.ts`，纳入现有 `SourcePlugin` 插件体系。
2. 解决「关键词扫出来的有限」：X 侧提供多种扫描入口（用户媒体 / 自己的喜欢 / 关键词搜索），不依赖单一搜索。
3. 抓取任务支持两种模式：
   - **全扫（full）**：扫到什么下什么（现状行为，默认）。
   - **模型过滤（filter）**：下载 → CLIP embedding + 现有模型预测 → 达标才正式入库，不达标只留元数据行、不留文件。
4. 访问策略保守：宁可慢、尽量贴 web 端正常浏览的请求形态，不主动触发风控。

## 非目标

- 不做 X 登录流程（OAuth/账号密码），只接受用户手动提供 cookie（`auth_token`）。
- 不做 X 的父子家族补全、parent_id 回填（X 无此概念，caps 机制自动禁用）。
- 不做关注/转推/发帖等任何写操作，只读。
- 不改动现有 yandere 驱动行为。
- 过滤模式不追求速度（用户明确接受慢）。

## 用户故事

1. 作为用户，我在设置页填入 X cookie（auth_token），启用 X 数据源，系统以我的身份只读访问 X。
2. 作为用户，我创建 X 抓取任务时可选扫描入口：
   - **某用户的媒体**：给画师句柄（如 `@artist`），扫 TA 发过的所有带图推文；
   - **我的喜欢**：扫 cookie 所属账号点赞过的带图推文（X 已隐藏他人喜欢页，只支持扫自己）；
   - **关键词搜索**：给搜索词扫结果，排序可选「热门（默认）/ 最新」。
3. 作为用户，创建任务时可选「全扫 / 模型过滤」；过滤模式下只有预测分 ≥ 阈值的图才落盘入库。
4. 作为用户，X 图无 tags/rating 也能正常走打分、审查、相册流程（tags 置空数组）。
5. 作为用户，任务被限流时能看到明确的「限流等待中」状态，而不是卡死或莫名 error。
6. 作为用户，被过滤掉的图留下元数据行（local_path=NULL），resume/重扫时不会重复下载同一张废图。

## 方案概述

### 1. X 驱动（`src/server/sources/x.ts`）

- 实现 `SourcePlugin` 必需能力 `search` + `fetchImage`；不实现 `fetchPost`/`fetchFamily`（caps 自动隐藏家族相关入口）。
- 接入方式：非官方 GraphQL API + 用户 cookie（web 端同款接口，`auth_token` + `ct0` + bearer）。不走官方 API。cookie 存 `config.json` 的 `sources.x`，config.json 本就不入 git。
- `SearchQuery` 语义扩展：任务 query JSON 增加 `kind: 'user-media' | 'user-likes' | 'search'`、`target`（句柄或搜索词）、`sort?: 'top' | 'latest'`（search 用，默认 top）。tasks 表 query 字段本来就是 JSON，向后兼容。
- 分页：GraphQL cursor 翻页；`skip` 映射为「先空翻 cursor 再产出」（空翻只解析不下载，成本低）。
- 只产出含图片的推文；一条推文多图 = 多条 ImageMeta，`sourceId = <tweetId>:<index>`（格式约定写入文档，供未来回填能力解析）。
- 限速：固定 2~3s/请求；遇 429/限流响应指数退避（最长 10 分钟），任务 progress 写「限流等待中」。X 任务下载并发降到 1~2（任务级可配，默认 1）。
- 风控红线：单任务上限沿用 2000 钳制；cookie 失效（401/403）立即置 error，文案明确「cookie 失效需更新」，不做自动重试轰炸。

### 2. 过滤模式（crawler 改造）

- tasks 表加列 `mode TEXT DEFAULT 'full'`（`'full' | 'filter'`）、`threshold REAL DEFAULT 0.5`、`filtered_out INTEGER DEFAULT 0`。老任务默认 full，行为不变。
- 过滤模式流程（串行，慢但稳）：
  1. `fetchImage` 下载到内存 buffer；
  2. 建任务时校验：无已训练模型 → 409「过滤模式需要先训练模型」（zero-shot 粗分不用于过滤，口径太粗误杀率高）；
  3. CLIP embedding + `predictWith`（tags 传空数组，与 `predictExternal` 同口径）；
  4. `score ≥ threshold` → `storage.saveIncoming` 正式入库；否则丢弃 buffer，images 行保留但 `local_path = NULL`，`filtered_out++`；
  5. 入库图直接写入本次算出的 `pred_score/pred_version`，省掉任务结束后的全量 scoreUnscored。
- ⚠️ libvips 加载顺序坑：过滤路径里 embedding 必须先于顶层 sharp 加载，或干脆不 import 顶层 sharp（用魔数嗅探，`routes/like.ts` 已有先例）。
- 已知口径问题：现有模型特征是 CLIP+tags 混合，X 图 tags 全空 = 纯视觉特征，0.5 阈值对 X 图可能系统性偏移——阈值做成任务级可调，后续按实际分布调默认值。

### 3. 前端 / 配置

- 任务创建表单：数据源选 X 时出现「扫描类型 + 目标」输入；search 类型附「热门/最新」切换（默认热门）；模式单选「全扫/模型过滤」+ 阈值滑杆（0.3~0.9，步进 0.05）。
- 设置页数据源区加 X cookie 配置项（密码式遮蔽显示）。
- 任务列表：显示 mode 徽标 + filtered_out 计数；限流退避时 progress 显示「限流等待中」。
- 移动端断点照常过一遍（`@media max-width:640px`）。
- 同步更新 `src/server/api-docs.ts`。

## 验收标准

1. `npm run typecheck` + `npm run build:web` 通过。
2. 配置有效 cookie 后，创建 `@某画师` 的 user-media 全扫任务：能翻页、能入库，tags 为 `[]` 时打分/审查/相册页正常。
3. 创建 filter 模式任务（阈值 0.5）：库中只出现达标图；`downloaded = 入库数 + filtered_out`；被过滤图磁盘无残留文件、库中留 `local_path = NULL` 行。
4. cookie 改无效值 → 任务 error 且文案明确指出 cookie 失效；改回有效值后 resume 可续跑，且已过滤的废图不重复下载。
5. yandere 任务回归：全扫/打分/家族补全行为与改造前一致。
6. 设置页数据源列表中 X 的 caps 无 fetchPost/fetchFamily，X 图的家族补全入口自动隐藏。
7. 暂停/恢复：filter 模式中途暂停，buffer 未落盘图直接丢弃无残留；resume 从断点 cursor 继续（允许重复扫已 INSERT OR IGNORE 的条目，但不重复下载已过滤图）。

## 风险与开放问题

| # | 事项 | 说明 |
|---|------|------|
| R1 | X 风控不可控 | 非官方 API 随时可能变字段/封 cookie。「不触发风控」无法绝对保证，只能贴 web 端正常浏览形态 + 保守限速。cookie 对应账号有受限风险，需用户知情自担。 |
| R2 | 无 tags 的分数口径漂移 | X 图纯视觉特征打分，阈值默认值后续按实际分布再校准。 |
| R3 | filter 模式 CPU 成本 | 每张 +~0.33s embedding（本机基线），2000 张 ≈ 额外 11 分钟。串行执行，避免与训练/打分抢 CPU。 |
| R4 | 多图推文 sourceId 拼接 | `tweetId:index` 为自定义格式，未来若做按推文回填需能解析，已在文档注明。 |
| ~~Q1~~ | ~~喜欢入口扫谁的~~ | 已定：只扫 cookie 所属账号自己的喜欢。 |
| ~~Q2~~ | ~~被过滤图是否留行~~ | 已定：留（local_path=NULL），避免 resume 重复下载。 |
| ~~Q3~~ | ~~搜索默认排序~~ | 已定：默认「热门」，可切换「最新」。 |
