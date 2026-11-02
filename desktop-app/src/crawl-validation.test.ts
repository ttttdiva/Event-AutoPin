import { validateCrawlRequest } from "./crawl-validation";
import type { CrawlSource } from "./crawl-settings";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const source: CrawlSource = {
  name: "公式",
  url: "https://example.test/circles",
  map_urls: [],
  catalog_additional_prompt: "",
};

const fresh = validateCrawlRequest({
  settings: {
    collect_catalogs: false,
    enable_twitter_catalog: false,
    regenerate_coordinates: false,
    skip_circle_images: false,
    days_before: 0,
    days_after: 0,
  },
  sources: [source],
  eventDate: "2026-04-01",
  activeEventSelected: true,
});
assert(fresh.ok, "fresh source crawl must remain executable even when optional jobs are disabled");

const noOpReprocess = validateCrawlRequest({
  settings: {
    reprocess: true,
    collect_catalogs: false,
    enable_twitter_catalog: true,
    skip_circle_images: true,
    regenerate_coordinates: false,
  },
  sources: [],
  eventDate: "2026-04-01",
  activeEventSelected: true,
});
assert(!noOpReprocess.ok && noOpReprocess.errors.some((error) => error.includes("実行する")), "再処理の無処理を拒否できません");

const invalidDays = validateCrawlRequest({
  settings: { days_before: -1, days_after: 3651 },
  sources: [source],
  eventDate: "2026-04-01",
  activeEventSelected: true,
});
assert(!invalidDays.ok && invalidDays.errors.length >= 2, "不正日数をnormalize前に拒否できません");
const invalidFractionAndEmpty = validateCrawlRequest({
  settings: { days_before: 1.5, days_after: "" as unknown as number },
  sources: [source],
  eventDate: "2026-04-01",
  activeEventSelected: true,
});
assert(!invalidFractionAndEmpty.ok && invalidFractionAndEmpty.errors.length >= 2, "小数/空欄の日数を拒否できません");

const invalidSource = validateCrawlRequest({
  settings: {},
  sources: [],
  eventDate: "2026-02-30",
  activeEventSelected: true,
});
assert(!invalidSource.ok && invalidSource.errors.some((error) => error.includes("URL")), "source URL不足を拒否できません");
assert(invalidSource.errors.some((error) => error.includes("イベント日")), "不正イベント日を拒否できません");

const noEvent = validateCrawlRequest({
  settings: {},
  sources: [source],
  eventDate: "2026-04-01",
  activeEventSelected: false,
});
assert(!noEvent.ok && noEvent.errors.some((error) => error.includes("イベントを選択")), "active eventなしを拒否できません");
console.log("crawl-validation tests passed");
