import {
  DEFAULT_CRAWL_SETTINGS,
  normalizeCrawlSettings,
  normalizeCrawlSources,
  promptForSource,
  serializePromptSections,
  splitPromptSections,
} from "./crawl-settings";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const settings = normalizeCrawlSettings({
  collect_catalogs: "false",
  enable_twitter_catalog: false,
  grok_search_mode: "build",
  days_before: "15.8",
  days_after: -1,
});
assert(settings.collect_catalogs === false, "文字列booleanを復元できません");
assert(settings.enable_twitter_catalog === false, "booleanを復元できません");
assert(settings.grok_search_mode === "build", "Grok modeを復元できません");
assert(settings.days_before === 15, "日数を整数へ補完できません");
assert(settings.days_after === DEFAULT_CRAWL_SETTINGS.days_after, "不正日数のfallbackが必要です");

const sources = normalizeCrawlSources([
  { name: "公式", url: "https://example.test/circles", map_url: "https://example.test/map" },
  { url: "https://example.test/catalog", map_urls: ["https://example.test/map2"] },
]);
assert(sources.length === 2, "sourceを正規化できません");
assert(sources[0].name === "公式", "source名を保持できません");
assert(sources[0].map_urls[0] === "https://example.test/map", "legacy map_urlを移行できません");

const prompt = "共通指示\n\n[https://example.test/circles]\n個別指示";
const split = splitPromptSections(prompt, ["https://example.test/circles"]);
assert(split.common === "共通指示", "common promptを分離できません");
assert(split.sourcePrompts["https://example.test/circles"] === "個別指示", "source promptを分離できません");
assert(promptForSource(split.common, split.sourcePrompts["https://example.test/circles"]) === "共通指示\n\n個別指示", "実効promptを合成できません");
const serialized = serializePromptSections(split.common, [{
  name: "公式",
  url: "https://example.test/circles",
  map_urls: [],
  catalog_additional_prompt: "個別指示",
}]);
assert(serialized.includes("[https://example.test/circles]"), "source sectionをlossless保存できません");
console.log("crawl-settings tests passed");
