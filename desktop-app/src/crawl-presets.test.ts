import {
  filterCrawlModelPresetForm,
  parseCrawlPresets,
  removeCrawlPreset,
  serializeCrawlPresets,
  upsertCrawlPreset,
} from "./crawl-presets";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const first = upsertCrawlPreset([], "  標準  ", { model: "gpt-5.6-luna" }, new Date("2026-01-01T00:00:00Z"));
assert(first.length === 1 && first[0].name === "標準", "プリセット名を正規化できません");
const replaced = upsertCrawlPreset(first, "標準", { model: "gpt-5.6-sol" }, new Date("2026-01-02T00:00:00Z"));
assert(replaced.length === 1 && replaced[0].value.model === "gpt-5.6-sol", "同名プリセットを上書きできません");
const parsed = parseCrawlPresets<{ model: string }>(serializeCrawlPresets(replaced));
assert(parsed[0].value.model === "gpt-5.6-sol", "プリセットJSONをroundtripできません");
assert(removeCrawlPreset(replaced, "標準").length === 0, "プリセットを削除できません");
assert(parseCrawlPresets("invalid").length === 0, "破損したlocalStorageを許容できません");

const modelPreset = filterCrawlModelPresetForm({
  modelProvider: "api:openai",
  model: "gpt-5.6-luna",
  textReasoningEffort: "max",
  textFallbackEnabled: "true",
  reprocess: "true",
  regen: "true",
  backup: "true",
  collectCatalogs: "false",
});
assert(modelPreset.model === "gpt-5.6-luna", "AIモデルpresetの主モデルを保持できません");
assert(!("reprocess" in modelPreset), "AIモデルpresetが再処理オプションを変更してはいけません");
assert(!("regen" in modelPreset), "AIモデルpresetが座標再生成を変更してはいけません");
assert(!("backup" in modelPreset), "AIモデルpresetがバックアップを変更してはいけません");
assert(!("collectCatalogs" in modelPreset), "AIモデルpresetが収集オプションを変更してはいけません");
console.log("crawl-presets tests passed");
