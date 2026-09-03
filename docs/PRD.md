# PRD：图片爬取-评价-筛选流水线（爬取 → 人工打分 → 自动学习筛选）

日期：2026-09-03
状态：待评审（澄清问题已回答）

## 决策表（澄清问题 → 决策）

| # | 问题 | 决策 |
|---|------|------|
| 1 | 目标网站与爬取方式 | 爬虫做成可插拔「数据源模块」，多个来源可自由启用/组合，统一送进评价流水线；首发 yande.re（有公开 JSON API，较友好）；代理（HTTP/SOCKS）作为模块级可配置项；后续可扩展 Pixiv、Danbooru 等 |
| 2 | 运行形态与技术栈 | Node.js（TypeScript）本地 Web 应用：Fastify 后端 + 浏览器打分界面（Vue 3，用户熟悉）。不引入 Electron 壳（减重），保留后续包装选项 |
| 3 | 打分交互 | 三键二值标注：喜欢 / 不喜欢 / 跳过（键盘 1/2/3）。对训练分类器而言，二值 + 大量样本优于细粒度星级；收集目标明确为「白色裤袜相关二次元图片」 |
| 4 | 自动筛选方案 | CLIP 图像 embedding + 站点 tag 特征 → 轻量个人分类器（逻辑回归）；冷启动阶段用 CLIP zero-shot 文本提示（如 "white thighhighs/kneesocks, anime illustration"）先粗筛；用户修正回流为训练样本，迭代变准 |
| 5 | 规模与存储 | 图片存本地磁盘，元数据/embedding/评分存 SQLite（better-sqlite3）；存储层抽象为 StorageBackend 接口，预留 WebDAV/OpenList 后端 |

## 目标

- 可插拔的多来源图片爬虫：数据源以模块形式接入，统一输出到评价流水线；首发支持 yande.re，支持按 tag/关键词抓取，支持代理
- 高效人工打分：单图浏览 + 键盘快捷键（喜欢/不喜欢/跳过），追求每小时数百张的标注速度
- 自动筛选：基于历史评分对未标注图片打预测分并排序，把"大概率喜欢"的排在前面；用户可修正，修正回流训练，逐步逼近真实喜好（如识别出用户偏好"白裤袜"这一元素）
- 喜欢的图片自动归档保存到本地收藏目录

## 非目标

- 多用户 / 账号权限体系（纯单机单用户）
- 云端部署、移动端
- 视频 / GIF 处理（首期仅静态图片）
- 大规模分布式爬取、对目标站的高并发压力（礼貌限速）
- 训练重型深度学习模型（只用预训练 CLIP 提特征 + 轻量分类器，不搞微调）

## 用户故事

| 编号 | 角色 | 故事 | 优先级 |
|------|------|------|--------|
| US-1 | 用户 | 配置数据源（选择站点、tag/关键词、代理、抓取数量）并启动抓取任务，可暂停/恢复 | P0 |
| US-2 | 用户 | 在打分界面用键盘 1/2/3 快速完成 喜欢/不喜欢/跳过，单张操作 ≤1 秒 | P0 |
| US-3 | 用户 | 标为"喜欢"的图片自动复制/移动到收藏目录，目录里只有喜欢的图 | P0 |
| US-4 | 用户 | 系统自动给未标注图片打预测分，打分界面按预测分降序展示，优先看到可能喜欢的 | P0 |
| US-5 | 用户 | 修正系统预测错误的图片，修正样本自动进入训练集，重新训练后同类错误减少 | P0 |
| US-6 | 用户 | 查看"模型学到的偏好"（如高权重 tag 列表：white_thighhighs 等），直观理解模型认为我喜欢什么 | P1 |
| US-7 | 开发者 | 新增数据源只需实现统一插件接口并放入插件目录，无需改动流水线核心 | P1 |
| US-8 | 用户 | 将存储后端从本地磁盘切换为 OpenList/WebDAV | P2 |

## 方案概述

### 架构

Node.js（TypeScript）单体本地应用，浏览器访问 `http://localhost:<port>` 使用：

```
┌────────────┐   统一 ImageMeta   ┌──────────────┐
│ 数据源插件层 │ ───────────────▶ │  抓取流水线    │
│ yande.re …  │                  │ 去重/下载/限速 │
└────────────┘                  └──────┬───────┘
                                        ▼
┌────────────┐   标注/修正      ┌──────────────┐      ┌──────────────┐
│ Web 打分界面│ ◀────────────▶ │ Fastify API   │ ──▶ │ SQLite        │
│ Vue3+快捷键 │   预测分排序     │              │     │ 元数据/embedding│
└────────────┘                └──────┬───────┘     │ /人工分/预测分  │
                                      ▼             └──────────────┘
                              ┌──────────────┐      ┌──────────────┐
                              │ 特征与分类器   │      │ StorageBackend│
                              │ CLIP emb + LR │      │ LocalFS(WebDAV预留)│
                              └──────────────┘      └──────────────┘
```

### 模块清单

| 模块 | 技术选型 | 说明 |
|------|---------|------|
| 数据源插件接口 | TS interface `SourcePlugin` | `search(query, opts): ImageMeta[]`、`fetchImage(meta): Buffer`、`name`、`supportsProxy`；插件放 `sources/` 目录，配置文件启用 |
| yande.re 插件 | axios + 官方 `post.json` API | 支持 tag 搜索、分页、代理（HTTP/SOCKS，socks-proxy-agent）；礼貌限速 |
| 抓取流水线 | p-queue | 按 `source+source_id` 去重，失败重试，任务可暂停恢复（任务状态入库） |
| Web 前端 | Vue 3 + Vite | 单图打分视图，键盘 1/2/3，预加载下一张；预测分排序开关；修正入口 |
| 后端 API | Fastify | `/api/tasks`、`/api/images/next`、`/api/images/:id/label`、`/api/train`、`/api/preferences` |
| 特征提取 | transformers.js（`Xenova/clip-vit-base-patch32`，ONNX，CPU 可跑） | 下载完成即算 embedding 入库 |
| 个人分类器 | 逻辑回归（embedding + 站点 tag one-hot） | 标注 ≥100 条后可训练；增量重训；导出 tag 权重供 US-6 |
| 冷启动粗筛 | CLIP zero-shot | 文本提示对比（如 "white thighhighs anime" vs 负面提示），无标注时也可排序 |
| 存储层 | `StorageBackend` 接口 | `LocalFSBackend` 首期实现；`WebDavBackend`（OpenList）预留接口 |

### 数据表（SQLite，核心字段）

`images(id, source, source_id, page_url, file_url, tags_json, local_path, embedding_blob, user_label[like|dislike|skip|null], pred_score, pred_version, created_at, labeled_at)`
`tasks(id, source, query_json, proxy, status, fetched, total, created_at)`

### 关键流程

1. 用户创建抓取任务 → 插件拉元数据 → 去重入库 → 队列下载原图 → CLIP embedding 入库
2. 打分界面请求"下一张"：有人工标注任务时优先推送；开启智能排序时按 `pred_score` 降序
3. 标注数达阈值（默认 100）→ 可点/自动触发训练 → 全量未标注图更新 `pred_score`
4. 用户修正（把预测喜欢改为不喜欢等）→ 直接作为新标注 → 下次训练生效
5. "喜欢"图片由 StorageBackend 归档到收藏目录

## 验收标准

| 编号 | 标准 |
|------|------|
| AC-1 | 配置 yande.re 数据源（tag + 代理）启动任务，能抓取 ≥100 条元数据并下载原图到本地，重复运行不产生重复文件 |
| AC-2 | 代理配置错误/网络中断时任务进入可恢复的错误态，修复后可续跑不重来 |
| AC-3 | 打分界面键盘 1/2/3 分别对应 喜欢/不喜欢/跳过，按键后 ≤1s 加载下一张（预加载） |
| AC-4 | 标"喜欢"的图出现在收藏目录；标"不喜欢/跳过"的不出现 |
| AC-5 | 累计标注 ≥100 条后可触发训练，训练完成后未标注图均有 `pred_score` 且界面可按其排序 |
| AC-6 | 修正预测错误的图后重新训练，该修正样本可在训练集中查到，且同类样本预测分有可见变化 |
| AC-7 | 偏好页能列出模型学到的 top 正/负权重 tag（如 white_thighhighs 应为正权重） |
| AC-8 | 新增数据源只需在 `sources/` 新增一个实现插件接口的文件并在配置中启用，核心流水线零改动（以 mock 插件验证） |

## 风险与开放问题

- **模型下载（国内网络）**：CLIP 模型约 350MB，HuggingFace 直连不稳；需支持 `HF_ENDPOINT=https://hf-mirror.com` 镜像配置
- **冷启动体验**：前 ~100 张全靠人工 + zero-shot 粗排，zero-shot 对"白裤袜"这类细粒度元素效果需实测调提示词（开放问题：提示词组合待定）
- **站点合规与反爬**：yande.re 有公开 API 相对友好；Pixiv 等需登录的站点后续单独评估，统一限速避免给目标站造成压力；图片版权仅限个人收藏用途
- **Node 端 CLIP 性能**：CPU 推理单张约百毫秒级，万级图量可接受；如成为瓶颈再评估 ONNX GPU 或批处理
- **开放问题**：
  - 是否需要 Electron/Tauri 桌面壳（默认：不需要，浏览器够用）
  - 是否内置 NSFW 分级过滤（yande.re 本身分级，默认透传站点分级配置）
  - "喜欢"的判定未来是否要加"超级喜欢"档（默认：不加，保持二值利于训练）
  - 存储扩展到 OpenList 的排期（默认：P2，接口先行）
