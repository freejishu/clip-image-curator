# image-curator

图片「**爬取 → 人工打分 → AI 自动学习筛选**」本地流水线工具。

从图站批量抓图，用键盘高速标注「喜欢 / 不喜欢」，程序基于 CLIP 图像特征 + 站点 tag 训练一个**只属于你**的轻量分类器，自动把未标注的图按「你可能喜欢的程度」排序——标得越多，推得越准。想收集什么类型的图完全由你自己的标注决定，工具本身不预设任何偏好。

- 设计文档：[docs/PRD.md](docs/PRD.md)
- 使用说明（图文流程 / FAQ）：[docs/使用说明.md](docs/使用说明.md)

## 功能一览

| 模块 | 说明 |
|---|---|
| ⬇️ 抓取任务 | 可插拔数据源（内置 yande.re + mock 测试源），按 tag 搜索、去重、礼貌限速，任务可暂停/断点续跑，支持 HTTP/SOCKS 代理 |
| 🖊️ 打分 | 单图浏览 + 键盘 `1` 喜欢 / `2` 不喜欢 / `3` 跳过，预加载下一张；喜欢的图自动归档到收藏目录（可按 tag 规则自动分子目录） |
| 🧠 模型与偏好 | CLIP zero-shot 冷启动粗筛（提示词可配置）；标注 ≥10 条即可训练逻辑回归个人分类器；训练后可查看模型学到的正/负权重 tag 偏好榜 |
| 🔍 审查修正 | 按「未标注·预测喜欢 / 预测不喜欢」等视图核对模型预测，一键 ♥/✕ 修正，修正自动回流下次训练 |
| 📷 相册 | 收藏浏览，同构图的 parent/child 子投稿自动成组、悬浮切换变体 |
| 🔗 分享 | 「我喜欢这个图片！」公开分享页 `/like`，免登录 |
| 🔐 账户 | 登录鉴权（默认 admin/admin，首次登录后请改密码）、多服务器切换、Bearer Token API |
| ⚙️ 设置 | 端口/代理/存储目录/图片压缩与格式转换/zero-shot 提示词均可在 `config.json` 配置，内置 API 文档页 |

## 运行环境

- **Node.js ≥ 22.5**（使用了内置的 `node:sqlite`，低版本跑不起来）
- 操作系统：Windows / Linux / macOS 均可（纯 Node 应用，无平台专属代码）
- 内存：建议 ≥ 8GB（CLIP 推理为 CPU 运行，单图 embedding 约 0.3s）
- 首次使用 AI 功能会自动下载 CLIP 模型（约 350MB，默认走 hf-mirror.com 镜像）到 `data/models/`

## 快速开始

### 方式一：下载预打包版本（推荐，无需安装 Node）

从 [Releases](../../releases) 下载对应平台的压缩包（Windows / Linux / macOS），解压后：

- Windows：双击 `start.bat`
- Linux / macOS：`./start.sh`

包内已自带便携 Node.js 22 和全部依赖，解压即可运行（不建 `config.json` 时自动按 `config.example.json` 的默认值跑，需要改配置就复制一份再改）。访问 http://127.0.0.1:30041 。

### 方式二：源码运行

```bash
npm install
cp config.example.json config.json   # Windows: Copy-Item config.example.json config.json

npm run dev        # 启动后端 + 托管前端，访问 http://127.0.0.1:30041
```

前端改动的开发模式（热更新）：

```bash
npm run dev:web    # Vite 开发服务器 http://localhost:5175（代理 /api 到 30041）
```

生产模式（后端直接托管构建产物）：

```bash
npm run build:web  # 构建前端到 web/dist
npm run dev        # 只跑这一个即可
```

Windows 用户也可以直接双击 `start.bat`（会自动注入项目自带便携 Node 的 PATH 并打开浏览器）。

首次访问用默认账户 **admin / admin** 登录，登录后请立即在「设置 → 基础设置 → 账户」修改密码。忘记密码：停止服务后执行 `npm run reset-password`，重启后恢复默认账户。

## 使用流程

```
抓取任务（补货） → 打分（键盘标注） → 训练模型 → 审查修正（抓错） → 再训练 → 越来越准
```

1. **抓取任务**页：选数据源，填 tags（如 `landscape rating:s`）和数量，开始抓取
2. **打分**页：键盘 `1` / `2` / `3` 快速标注
3. **模型与偏好**页：标注 ≥10 条后点「训练模型」；训练后打分页可开「智能排序」，按预测分从高到低喂图
4. **审查修正**页：检查模型预测，修正自动进入下次训练

更详细的操作说明见 [docs/使用说明.md](docs/使用说明.md)。

## 配置（config.json）

复制 `config.example.json` 为 `config.json` 后按需修改：

| 字段 | 说明 |
|---|---|
| `port` / `host` | 监听端口与地址（默认 30041 / 0.0.0.0，局域网可访问） |
| `proxy` | 全局代理（如 `http://127.0.0.1:7890`），抓取需要代理的站点时使用；不需要代理则设为 `null` |
| `trainThreshold` | 建议的训练样本数门槛 |
| `storage` | 存储后端（目前为本地磁盘，WebDAV/OpenList 接口已预留） |
| `archiveRules` | 收藏归档规则：按 tag 匹配自动归入子目录，**按自己收藏的主题自定义** |
| `sources` | 各数据源启用开关与独立代理 |
| `zeroshot` | 冷启动粗筛的正/负面文本提示词，**按自己想筛的主题自定义** |
| `imageProcess` | 入库图片处理：压缩（缩放比例/体积上限）与格式转换（如统一转 jpg），动图永不处理 |

## 架构

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

- `src/server/sources/` — 数据源插件（实现 `SourcePlugin` 接口即可新增站点，核心零改动）
- `src/server/pipeline/` — 抓取流水线（去重、限速、暂停/恢复）与存量批处理（规则指纹幂等）
- `src/server/ml/` — CLIP embedding（transformers.js，ONNX CPU）+ 逻辑回归个人分类器 + zero-shot 冷启动
- `src/server/storage/` — 存储后端接口 + 入库图片处理装饰器（统一转格式/压缩）
- `web/` — Vue 3 + Vite 打分界面（适配手机浏览器，可经 Tailscale 等内网穿透在外使用）
- 数据：SQLite（`node:sqlite`，零原生依赖）@ `data/curator.db`；图片 @ `data/incoming`、`data/favorites`

## 数据都在哪

| 位置 | 内容 |
|---|---|
| `data/curator.db` | SQLite 数据库（元数据、标注、预测分、模型权重） |
| `data/incoming/` | 抓回来的全部原图 |
| `data/favorites/` | 标「喜欢」的图（按归档规则自动分子目录） |
| `data/thumbs/` | 缩略图缓存（可删，会重建） |
| `data/models/` | CLIP 模型缓存 ~350MB（别删，删了要重下） |

以上 `data/` 整体已被 `.gitignore` 排除，不会进入代码库。

## 常见问题

- **yande.re 连不上 / 报 ETIMEDOUT**：该站在部分网络环境需要代理，在 `config.json` 配置 `proxy`。
- **训练按钮是灰的**：喜欢+不喜欢标注合计不足 10 条，先去打分页标注。
- **预测分不变**：预测分只在「训练模型」时全量刷新，标注一批新图后再点一次训练。

更多 FAQ 见 [docs/使用说明.md](docs/使用说明.md)。

## 声明

- 抓取的图片版权归原作者与站点所有，本工具仅供个人收藏与学习使用，请勿二次分发图片。
- 请遵守目标站点的 robots 协议与使用条款，工具已内置礼貌限速，请勿调高并发对站点造成压力。

## 许可证

[MIT](LICENSE)
