/**
 * クロールパイプライン用の型定義
 */

export interface CrawlEventInfo {
  name: string;
  url: string;
  date?: string | null;
  venue?: string | null;
  organizer?: string | null;
  memo?: string | null;
  source_urls?: string[];
  source_events?: { name: string; url: string; circle_count: number }[];
}

export interface CrawlCircle {
  name: string;
  penname?: string | null;
  space?: string | null;
  hall?: string | null;
  twitter_url?: string | null;
  /** 元のX URL候補がプロフィールURLとして不正だった場合に保持する。 */
  twitter_url_rejected?: boolean;
  website_url?: string | null;
  pixiv_url?: string | null;
  description?: string | null;
  genres?: string[];
  circle_cut_url?: string | null;
  absence_status?: string | null;
  existing_only_status?: string | null;
  tags?: string[];
  source_event_name?: string | null;
  source_event_url?: string | null;
}

export interface CrawlResult {
  event: CrawlEventInfo;
  circles: CrawlCircle[];
  adapterName: string;
  sourceResults?: CrawlResult[];
  // プレビュー用の追加メタデータ
  sampleHtml?: string;
  /** プレビュー承認後にだけ保存する、LLM判定済みの列構造。 */
  pendingTableSchema?: {
    hostname: string;
    headers: string[];
    mapping: Record<string, number>;
  };
}

export interface CrawlOptions {
  url: string;
  eventNameHint?: string;
  cookieHeader?: string;
  downloadImages?: boolean;
  analyzeCircleCuts?: boolean;
  fetchTwitterCatalog?: boolean;
}

export interface CrawlProgress {
  phase: "fetch" | "parse" | "preview" | "images" | "analyze" | "save" | "done";
  current?: number;
  total?: number;
  message?: string;
}

export interface TwitterProcessingDetail {
  circleName: string;
  status: "success" | "not_found" | "skipped" | "error";
  reason?: string;
}

export interface TwitterProcessingSummary {
  targetCount: number;
  successCount: number;
  notFoundCount: number;
  skippedCount: number;
  errorCount: number;
  invalidUrlCount: number;
  details: TwitterProcessingDetail[];
}

export interface CrawlCommitResult {
  eventId: number;
  twitterProcessing: TwitterProcessingSummary | null;
}

export type ProgressCallback = (progress: CrawlProgress) => void;
