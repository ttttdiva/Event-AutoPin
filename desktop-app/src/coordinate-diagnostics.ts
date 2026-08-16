export type CoordinateDiagnosticsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is CoordinateDiagnosticsRecord {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): CoordinateDiagnosticsRecord {
  return isRecord(value) ? value : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * OCR details are intentionally rendered only when OCR was attempted.  A
 * missing/legacy diagnostics object is therefore not treated as
 * "専用venv未設定"; the backend's unknown state remains hidden unless OCR
 * actually reached the runner.
 */
export function formatOcrDiagnostics(value: unknown): string {
  if (!isRecord(value)) return "";
  const diagnostics = value;
  const coordinateOcr = asRecord(diagnostics.ocr);
  const attempted =
    coordinateOcr.attempted === true ||
    diagnostics.attempted === true ||
    diagnostics.runner_started === true;
  if (!attempted) return "\nOCR: 未実行";

  const runnerStarted =
    coordinateOcr.runner_started === true || diagnostics.runner_started === true;
  if (!runnerStarted) {
    // OCR extraction was entered, but the external runner never started (for
    // example, image/input or venv-resolution failure).  Do not turn raw
    // config values into a misleading model/device/venv diagnosis.
    return "\nOCR runner: 未起動";
  }

  const lines: string[] = [];
  const code = text(diagnostics.error_code);
  const message = text(diagnostics.error_message);
  const returncode = diagnostics.returncode;
  const model = text(diagnostics.model);
  const device = text(diagnostics.device);
  const venv = asRecord(diagnostics.venv);
  const venvState = asRecord(diagnostics.venv_state);
  const stderr = text(diagnostics.stderr);
  const hint = text(diagnostics.recovery_hint);
  if (code) lines.push(`診断コード: ${code}`);
  if (message) lines.push(`診断メッセージ: ${message}`);
  if (returncode !== null && returncode !== undefined && text(returncode) !== "") {
    lines.push(`OCR returncode: ${String(returncode)}`);
  }
  if (model) lines.push(`OCRモデル: ${model}`);
  if (device) lines.push(`実行デバイス: ${device}`);
  const state = text(venv.state || venvState.state);
  const configured = venv.configured;
  if (state === "unknown" || configured === null) {
    lines.push("専用venv: 状態不明");
  } else if (state === "not_configured" || configured === false) {
    lines.push("専用venv: 未設定");
  } else if (configured === true || state === "configured") {
    lines.push("専用venv: 設定済み");
  }
  if (stderr) lines.push(`stderr要約: ${stderr}`);
  if (hint) lines.push(`復旧方法: ${hint}`);
  return lines.length
    ? `\n\n--- OCR診断（安全な要約） ---\n${lines.join("\n")}`
    : "\nOCR: 実行済み（詳細診断なし）";
}

function eventCatalogLines(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const diagnostics = value;
  const requested =
    diagnostics.requested_map_number ?? diagnostics.map_number ?? "?";
  return [
    `Circle総数: ${number(diagnostics.circle_count)}`,
    `space空欄: ${number(diagnostics.space_blank_count)}`,
    `space解析不能: ${number(diagnostics.space_unparseable_count)}`,
    `未割当Mapで除外: ${number(diagnostics.map_unassigned_excluded_count)}`,
    `別Mapのため除外: ${number(diagnostics.map_mismatch_excluded_count)}`,
    `対象space数: ${number(diagnostics.target_space_count)}`,
    `対象Map: ${String(requested)}`,
  ];
}

/** Stage-aware Japanese explanation for a coordinate-generation failure. */
export function formatCoordinateGenerationFailure(
  value: unknown,
  fallbackMapNumber?: unknown,
): string {
  if (!isRecord(value)) return "座標生成失敗\nOCR: 未実行";
  const source = isRecord(value.coordinate_generation)
    ? asRecord(value.coordinate_generation)
    : value;
  const error = asRecord(source.error);
  const code = text(error.code || source.error_code) || "unexpected_coordinate_failure";
  const message =
    text(error.message || source.error_message || value.error) ||
    "座標生成に失敗しました";
  const stage = text(source.stage || value.stage) || "unknown";
  const mapNumber = source.map_number ?? value.map_number ?? fallbackMapNumber;
  const lines = [
    "座標生成失敗",
    `段階: ${stage}`,
    `原因: ${message}`,
    `診断コード: ${code}`,
  ];
  if (mapNumber !== undefined && mapNumber !== null && text(mapNumber)) {
    lines.push(`対象Map: ${String(mapNumber)}`);
  }
  if (code === "event_catalog_empty") {
    lines.push("原因補足: 対象マップに割り当て可能なスペースがありません");
    lines.push(...eventCatalogLines(source.event_catalog || source.catalog));
  } else if (stage === "event_catalog") {
    lines.push(...eventCatalogLines(source.event_catalog || source.catalog));
  }

  const ocrStageCodes = new Set([
    "ocr_runner_failed",
    "ocr_no_numbers",
    "ocr_failed",
    "ocr_timeout",
    "runner_failed",
    "timeout",
  ]);
  const showDetailedOcrDiagnostics =
    stage === "ocr" || ocrStageCodes.has(code);
  const ocr = isRecord(source.ocr)
    ? source.ocr
    : isRecord(value.ocr)
      ? value.ocr
      : source.ocr_diagnostics || value.ocr_diagnostics;
  const ocrRecord = asRecord(ocr);
  const attempted =
    ocrRecord.attempted === true ||
    ocrRecord.runner_started === true ||
    asRecord(source.ocr).attempted === true;
  if (attempted) {
    if (showDetailedOcrDiagnostics) {
      const rawDetails = asRecord(source.ocr_diagnostics || value.ocr_diagnostics);
      lines.push(
        formatOcrDiagnostics({
          ...rawDetails,
          ocr: ocrRecord,
          attempted: true,
        }),
      );
    } else {
      lines.push("OCR: 実行済み");
    }
  } else {
    lines.push("OCR: 未実行");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
