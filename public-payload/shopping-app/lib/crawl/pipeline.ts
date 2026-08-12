/**
 * クロールパイプライン
 *
 * - プレビュー（adapter実行 → 結果を返すだけ）
 * - 確定実行（画像DL・画像解析・Grok補助 → DB投入）
 */
import * as FileSystem from "expo-file-system/legacy";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type {
  CrawlCircle,
  CrawlResult,
  CrawlOptions,
  ProgressCallback,
  CrawlCommitResult,
  TwitterProcessingSummary,
} from "./types";
import { runAdapter } from "./adapter-factory";
import { downloadImage, guessExt } from "./image-downloader";
import { analyzeCircleCut } from "./vision-analyzer";
import { fetchOshinagaki } from "./twitter-grok";
import { getDatabase, registerDefaultCutFromImage } from "../database";
import { normalizeXProfileUrl } from "./url-validation";
import {
  saveTableSchema,
  type CircleColumnMapping,
} from "./site-schema-store";

const KEEP_AWAKE_TAG = "crawl-pipeline";

export function getCrawlUrls(options: CrawlOptions): string[] {
  const matches = options.url.match(/https?:\/\/[^\s,]+/g) ?? [];
  const urls: string[] = [];
  for (const rawUrl of matches) {
    const url = rawUrl.trim().replace(/[,\]\)\};]+$/, "");
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function sourceLabelFor(result: CrawlResult, url: string, index: number): string {
  const name = result.event.name?.trim();
  if (name) return name;
  try {
    return new URL(url).hostname;
  } catch {
    return `event-${index + 1}`;
  }
}

function sameOrFirst(values: Array<string | null | undefined>): string | null {
  const filtered = values.filter((v): v is string => !!v);
  if (!filtered.length) return null;
  return filtered[0];
}

function mergeCrawlResults(
  results: CrawlResult[],
  urls: string[],
  eventNameHint?: string,
): CrawlResult {
  const sourceEvents = results.map((result, index) => ({
    name: sourceLabelFor(result, urls[index], index),
    url: urls[index],
    circle_count: result.circles.length,
  }));
  const eventName =
    eventNameHint?.trim() || sourceEvents.map((event) => event.name).join(" / ");
  const circles: CrawlCircle[] = [];

  for (const [resultIndex, result] of results.entries()) {
    const sourceEvent = sourceEvents[resultIndex];
    const sourceTag = `併催:${sourceEvent.name}`;
    for (const circle of result.circles) {
      const tags = circle.tags ?? [];
      circles.push({
        ...circle,
        tags: tags.includes(sourceTag) ? tags : [...tags, sourceTag],
        source_event_name: sourceEvent.name,
        source_event_url: sourceEvent.url,
      });
    }
  }

  return {
    event: {
      name: eventName,
      url: urls[0] ?? "",
      date: sameOrFirst(results.map((result) => result.event.date)),
      venue: sameOrFirst(results.map((result) => result.event.venue)),
      organizer: sameOrFirst(results.map((result) => result.event.organizer)),
      memo: `併催イベント:\n${sourceEvents
        .map((event) => `- ${event.name}: ${event.url}`)
        .join("\n")}`,
      source_urls: urls,
      source_events: sourceEvents,
    },
    circles,
    adapterName: Array.from(new Set(results.map((result) => result.adapterName))).join(
      " + ",
    ),
    sourceResults: results,
  };
}

async function saveApprovedTableSchemas(result: CrawlResult): Promise<void> {
  if (result.pendingTableSchema) {
    await saveTableSchema(
      result.pendingTableSchema.hostname,
      result.pendingTableSchema.headers,
      result.pendingTableSchema.mapping as CircleColumnMapping,
    );
  }
  for (const source of result.sourceResults ?? []) {
    await saveApprovedTableSchemas(source);
  }
}

/** Phase 1: プレビュー用クロール（DB書き込みなし） */
export async function crawlPreview(
  options: CrawlOptions,
  onProgress?: ProgressCallback,
): Promise<CrawlResult> {
  const urls = getCrawlUrls(options);
  if (!urls.length) {
    throw new Error("URLが指定されていません");
  }
  if (urls.length > 1) {
    const results: CrawlResult[] = [];
    for (let i = 0; i < urls.length; i++) {
      onProgress?.({
        phase: "fetch",
        current: i + 1,
        total: urls.length,
        message: `イベント ${i + 1}/${urls.length} を取得中...`,
      });
      results.push(
        await runAdapter({
          url: urls[i],
          eventNameHint: undefined,
          cookieHeader: options.cookieHeader,
        }),
      );
    }
    const merged = mergeCrawlResults(results, urls, options.eventNameHint);
    onProgress?.({
      phase: "preview",
      message: `${urls.length} 件のイベントから ${merged.circles.length} 件のサークルを検出`,
    });
    return merged;
  }
  onProgress?.({ phase: "fetch", message: "サイトを取得中..." });
  const result = await runAdapter({
    url: urls[0],
    eventNameHint: options.eventNameHint,
    cookieHeader: options.cookieHeader,
  });
  onProgress?.({
    phase: "preview",
    message: `${result.circles.length} 件のサークルを検出`,
  });
  return result;
}

/** Phase 2: プレビュー承認後の本実行（DB投入） */
export async function crawlCommit(
  preview: CrawlResult,
  options: CrawlOptions,
  onProgress?: ProgressCallback,
): Promise<CrawlCommitResult> {
  await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
  try {
    const db = await getDatabase();
    const urls = getCrawlUrls(options);
    const eventMemo =
      preview.event.memo ??
      (preview.event.source_events?.length
        ? `併催イベント:\n${preview.event.source_events
            .map((event) => `- ${event.name}: ${event.url}`)
            .join("\n")}`
        : "");

    // イベント作成
    const evResult = await db.runAsync(
      `INSERT INTO events (
        name, url, date, venue, organizer, memo, raw_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      preview.event.name,
      preview.event.url ?? urls[0] ?? options.url,
      preview.event.date ?? null,
      preview.event.venue ?? null,
      preview.event.organizer ?? null,
      eventMemo,
      JSON.stringify(preview.event),
      JSON.stringify({
        generated_at: new Date().toISOString(),
        format_version: "1.0",
        source: "mobile_crawl",
      }),
    );
    const eventId = evResult.lastInsertRowId;

    // 画像保存ディレクトリ
    const imgDir = `${FileSystem.documentDirectory}images/${eventId}/`;
    const cutsDir = `${imgDir}cuts/`;
    if (options.downloadImages !== false) {
      await FileSystem.makeDirectoryAsync(cutsDir, { intermediates: true });
    }

    const circles = preview.circles;
    const total = circles.length;
    const twitterSummary: TwitterProcessingSummary | null = options.fetchTwitterCatalog
      ? {
          targetCount: total,
          successCount: 0,
          notFoundCount: 0,
          skippedCount: 0,
          errorCount: 0,
          invalidUrlCount: 0,
          details: [],
        }
      : null;

    for (let i = 0; i < total; i++) {
      const c = circles[i];
      const normalizedTwitterUrl = normalizeXProfileUrl(c.twitter_url);
      if (
        (c.twitter_url_rejected || (c.twitter_url && !normalizedTwitterUrl)) &&
        twitterSummary
      ) {
        twitterSummary.invalidUrlCount++;
      }
      onProgress?.({
        phase: "save",
        current: i + 1,
        total,
        message: `${i + 1}/${total} ${c.name}`,
      });

      // サークルカット画像DL
      let cutFilename: string | null = null;
      if (options.downloadImages !== false && c.circle_cut_url) {
        const ext = guessExt(c.circle_cut_url);
        const fn = `cut_${i + 1}.${ext === "jpg" ? "jpg" : ext}`;
        const dl = await downloadImage(c.circle_cut_url, cutsDir, fn, {
          maxWidth: 800,
        });
        if (dl) cutFilename = dl.localPath;
      }

      // DB挿入
      const circleRes = await db.runAsync(
        `INSERT INTO circles (
          event_id, name, penname, space, hall,
          twitter_url, website_url, pixiv_url,
          description, genres, tags,
          circle_cut_filename, priority_color, memo,
          absence_status, existing_only_status, catalog_status, checked, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        c.name,
        c.penname ?? null,
        c.space ?? null,
        c.hall ?? null,
        normalizedTwitterUrl,
        c.website_url ?? null,
        c.pixiv_url ?? null,
        c.description ?? null,
        JSON.stringify(c.genres ?? []),
        JSON.stringify(c.tags ?? []),
        cutFilename,
        5,
        "",
        c.absence_status ?? null,
        c.existing_only_status ?? null,
        null,
        0,
        JSON.stringify(c),
      );
      const circleId = circleRes.lastInsertRowId;

      // 画像解析（ジャンル推定）
      if (options.analyzeCircleCuts && cutFilename) {
        onProgress?.({
          phase: "analyze",
          current: i + 1,
          total,
          message: `画像解析: ${c.name}`,
        });
        const vision = await analyzeCircleCut(cutFilename);
        if (vision) {
          const merged = Array.from(
            new Set([...(c.genres ?? []), ...vision.genres]),
          );
          await db.runAsync(
            "UPDATE circles SET genres = ?, description = COALESCE(NULLIF(description, ''), ?) WHERE id = ?",
            JSON.stringify(merged),
            vision.description ?? null,
            circleId,
          );
        }
      }

      // Grokでおしながき取得
      if (options.fetchTwitterCatalog) {
        onProgress?.({
          phase: "analyze",
          current: i + 1,
          total,
          message: `おしながき検索: ${c.name}`,
        });
        const outcome = await fetchOshinagaki(
          c.name,
          normalizedTwitterUrl,
          c.source_event_name ?? preview.event.name,
        );
        let finalStatus: "success" | "not_found" | "skipped" | "error" =
          outcome.status;
        let finalReason =
          outcome.status === "error" || outcome.status === "skipped"
            ? outcome.reason
            : undefined;
        if (outcome.status === "success") {
          const osh = outcome.data;
          try {
          const catalogStatus =
            osh.items?.length || osh.imageUrls?.length
              ? "confirmed"
              : osh.tweetUrl
                ? "no_extractable_items"
                : null;
          const memoLines = [osh.tweetUrl].filter(Boolean).join("\n");
          if (catalogStatus || memoLines) {
            await db.runAsync(
              "UPDATE circles SET catalog_status = COALESCE(?, catalog_status), memo = CASE WHEN ? != '' THEN ? ELSE memo END WHERE id = ?",
              catalogStatus,
              memoLines,
              memoLines,
              circleId,
            );
          }
          for (const item of osh.items ?? []) {
            if (!item?.name) continue;
            await db.runAsync(
              "INSERT INTO items (circle_id, name, price, type, description, purchase_status) VALUES (?, ?, ?, ?, ?, ?)",
              circleId,
              String(item.name),
              typeof item.price === "number" ? item.price : null,
              item.type ?? null,
              null,
              3,
            );
          }
          // おしながき画像
          if (osh.imageUrls?.length) {
            const itemsDir = `${imgDir}items/`;
            const itemsDirInfo = await FileSystem.getInfoAsync(itemsDir);
            if (!itemsDirInfo.exists) {
              await FileSystem.makeDirectoryAsync(itemsDir, {
                intermediates: true,
              });
            }
            let firstCatalogImageFilename: string | null = null;
            for (let j = 0; j < osh.imageUrls.length; j++) {
              const u = osh.imageUrls[j];
              const ext = guessExt(u);
              const fn = `item_${circleId}_${j + 1}.${ext === "jpg" ? "jpg" : ext}`;
              const dl = await downloadImage(u, itemsDir, fn, {
                maxWidth: 1200,
              });
              if (dl) {
                firstCatalogImageFilename ??= dl.localPath;
                await db.runAsync(
                  "INSERT INTO item_images (circle_id, filename, source) VALUES (?, ?, ?)",
                  circleId,
                  dl.localPath,
                  "x_grok",
                );
              }
            }
            if (!cutFilename && firstCatalogImageFilename) {
              cutFilename = firstCatalogImageFilename;
              await db.runAsync(
                "UPDATE circles SET circle_cut_filename = ? WHERE id = ?",
                cutFilename,
                circleId,
              );
              await registerDefaultCutFromImage(
                c.name,
                c.penname ?? "",
                firstCatalogImageFilename,
              );
            }
          }
          } catch (error) {
            finalStatus = "error";
            const reason = error instanceof Error ? error.message : String(error);
            finalReason = `お品書き保存失敗: ${reason}`;
            console.warn("お品書き保存失敗:", c.name, reason);
          }
        }
        if (twitterSummary) {
          if (finalStatus === "success") twitterSummary.successCount++;
          else if (finalStatus === "not_found") twitterSummary.notFoundCount++;
          else if (finalStatus === "skipped") twitterSummary.skippedCount++;
          else twitterSummary.errorCount++;
          twitterSummary.details.push({
            circleName: c.name,
            status: finalStatus,
            ...(finalReason ? { reason: finalReason } : {}),
          });
        }
      }
    }

    if (twitterSummary) {
      await db.runAsync(
        "UPDATE events SET metadata_json = ? WHERE id = ?",
        JSON.stringify({
          generated_at: new Date().toISOString(),
          format_version: "1.0",
          source: "mobile_crawl",
          twitter_processing: twitterSummary,
        }),
        eventId,
      );
    }
    const doneMessage = twitterSummary
      ? `完了（X: 成功${twitterSummary.successCount}・未検出${twitterSummary.notFoundCount}・失敗${twitterSummary.errorCount}・スキップ${twitterSummary.skippedCount}）`
      : "完了";
    try {
      await saveApprovedTableSchemas(preview);
    } catch (error) {
      console.warn("承認済み列構造の保存失敗:", error);
    }
    onProgress?.({ phase: "done", message: doneMessage });
    return { eventId, twitterProcessing: twitterSummary };
  } finally {
    deactivateKeepAwake(KEEP_AWAKE_TAG);
  }
}
