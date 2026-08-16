import {
  formatCoordinateGenerationFailure,
  formatOcrDiagnostics,
} from "./coordinate-diagnostics";

function assertIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`expected ${JSON.stringify(actual)} to include ${expected}`);
  }
}

const catalogFailure = formatCoordinateGenerationFailure({
  status: "failed",
  stage: "event_catalog",
  map_number: 1,
  error: {
    code: "event_catalog_empty",
    message: "対象マップに割り当て可能なスペースがありません",
  },
  event_catalog: {
    requested_map_number: 1,
    circle_count: 4,
    space_blank_count: 1,
    space_unparseable_count: 1,
    map_unassigned_excluded_count: 2,
    map_mismatch_excluded_count: 0,
    target_space_count: 0,
  },
  ocr: { attempted: false, runner_started: false },
});
assertIncludes(catalogFailure, "段階: event_catalog");
assertIncludes(catalogFailure, "対象Map: 1");
assertIncludes(catalogFailure, "未割当Mapで除外: 2");
assertIncludes(catalogFailure, "OCR: 未実行");
if (catalogFailure.includes("専用venv:")) {
  throw new Error("catalog failure must not render an OCR venv diagnosis");
}

const runnerFailure = formatCoordinateGenerationFailure({
  status: "failed",
  stage: "ocr",
  error: { code: "runner_failed", message: "runner failed" },
  ocr: { attempted: true, runner_started: true },
  ocr_diagnostics: {
    error_code: "runner_failed",
    error_message: "runner failed",
    returncode: 2,
    model: "org/model",
    device: "cuda",
    venv: { configured: true },
    recovery_hint: "再実行してください",
  },
});
assertIncludes(runnerFailure, "段階: ocr");
assertIncludes(runnerFailure, "OCR returncode: 2");
assertIncludes(runnerFailure, "専用venv: 設定済み");

assertIncludes(
  formatOcrDiagnostics({ attempted: false, venv: { configured: false } }),
  "OCR: 未実行",
);

const inputFailure = formatCoordinateGenerationFailure({
  status: "failed",
  stage: "input",
  error: { code: "image_read_failed", message: "マップ画像を読み込めませんでした" },
  ocr: { attempted: true, runner_started: true, candidate_count: 12 },
  ocr_diagnostics: {
    error_code: "image_read_failed",
    model: "org/should-not-render",
    device: "cuda",
    venv: { configured: true },
  },
});
assertIncludes(inputFailure, "段階: input");
assertIncludes(inputFailure, "OCR: 実行済み");
if (
  inputFailure.includes("OCRモデル:") ||
  inputFailure.includes("実行デバイス:") ||
  inputFailure.includes("専用venv:")
) {
  throw new Error("input failure must not render OCR configuration details");
}

const invalidCatalogFailure = formatCoordinateGenerationFailure({
  status: "failed",
  stage: "event_catalog",
  error: {
    code: "event_catalog_invalid",
    message: "event.json の形式を解析できませんでした",
  },
  event_catalog: {
    circle_count: 3,
    target_space_count: 0,
  },
  ocr: { attempted: false, runner_started: false },
});
assertIncludes(invalidCatalogFailure, "event.json の形式を解析できませんでした");
if (invalidCatalogFailure.includes("対象マップに割り当て可能なスペースがありません")) {
  throw new Error("invalid catalog must not claim empty target spaces");
}

console.log("coordinate diagnostics tests passed");
