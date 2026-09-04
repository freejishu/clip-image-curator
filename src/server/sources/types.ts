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
}

export interface FetchOpts {
  proxy?: string | null;
  /** 每次调用检查，返回 false 表示任务被要求暂停 */
  shouldContinue?: () => boolean;
}

/** 数据源插件接口：新增站点只需实现此接口并放入 sources/ 后在 config 启用 */
export interface SourcePlugin {
  readonly name: string;
  /** 分页产出搜索结果，直到达到 limit 或没有更多结果 */
  search(query: SearchQuery, opts: FetchOpts): AsyncGenerator<ImageMeta[]>;
  /** 下载图片二进制 */
  fetchImage(meta: ImageMeta, opts: FetchOpts): Promise<Buffer>;
}
