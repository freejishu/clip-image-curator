export interface ImageMeta {
  source: string;
  sourceId: string;
  pageUrl: string;
  fileUrl: string;
  previewUrl?: string;
  tags: string[];
  width?: number;
  height?: number;
  rating?: string;
  parentId?: number | null;
}

export interface SearchQuery {
  tags: string[];
  limit: number;
  /** 范围扫描：跳过前 N 条结果再开始产出（缺省/0 = 从头扫） */
  skip?: number;
  /** X 专用：扫描入口类型（user-media=某用户媒体 / user-likes=我的喜欢 / search=关键词搜索） */
  kind?: 'user-media' | 'user-likes' | 'search';
  /** X 专用：扫描目标（user-media 填句柄，search 填搜索词；user-likes 留空） */
  target?: string;
  /** X 专用：search 的排序（top=热门 / latest=最新），默认 top */
  sort?: 'top' | 'latest';
}

export interface FetchOpts {
  proxy?: string | null;
  /** 每次调用检查，返回 false 表示任务被要求暂停 */
  shouldContinue?: () => boolean;
}

/** 数据源插件接口：新增站点只需实现此接口并放入 sources/ 后在 config 启用。
 *  search/fetchImage 是必需能力；fetchPost/fetchFamily 是可选能力，
 *  路由层按能力自动启用对应功能（parent_id 回填、补全家族），新站点不实现即自动隐藏。 */
export interface SourcePlugin {
  readonly name: string;
  /** 分页产出搜索结果，直到达到 limit 或没有更多结果 */
  search(query: SearchQuery, opts: FetchOpts): AsyncGenerator<ImageMeta[]>;
  /** 下载图片二进制 */
  fetchImage(meta: ImageMeta, opts: FetchOpts): Promise<Buffer>;
  /** 可选：按 sourceId 精确查单帖（用于 parent_id 回填；查不到返回 null） */
  fetchPost?(sourceId: string, opts: FetchOpts): Promise<ImageMeta | null>;
  /** 可选：查某帖的父子家族全部成员（含自身；无家族时返回仅自身或空）。
   *  parentIdHint 为库中已知的 parent_id，fetchPost 查不到自身时用于兜底定位家族根。 */
  fetchFamily?(sourceId: string, parentIdHint: number | null, opts: FetchOpts): Promise<ImageMeta[]>;
}
