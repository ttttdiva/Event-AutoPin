import type { ModelPreflightSlot } from "./model-role-capabilities";

/** 実行時に使うモデル設定。保存用の設定とは分離して扱う。 */
export type RuntimeModelSelection = {
  provider: string;
  model: string;
  effort?: string;
};

export type ModelPreflightCheck = {
  slot: ModelPreflightSlot;
  selection: RuntimeModelSelection;
  /** 予備モデルは、使えなくても主モデルを止めずruntimeだけ無効化する。 */
  fallback?: boolean;
  enabled?: boolean;
};

export type ModelPreflightIssue = {
  slot: ModelPreflightSlot;
  provider: string;
  model: string;
  reason: string;
  fallback: boolean;
};

/**
 * 選択可だが、能力metadata未確認などの理由を共通警告欄へ表示する評価。
 * warningOnlyはprimary/fallbackのどちらでも実行を止めず、実要求の失敗時に
 * 既存fallbackへ委ねるためのもの。
 */
export type ModelPreflightEvaluation = {
  reason: string;
  warningOnly?: boolean;
};

export type ModelPreflightPlan = {
  ok: boolean;
  warnings: ModelPreflightIssue[];
  blocked?: ModelPreflightIssue;
  /** runtime payloadで予備を無効化するslot。保存済み選択値は変更しない。 */
  disabledFallbackSlots: ModelPreflightSlot[];
};

export function modelPreflightPlan(
  checks: readonly ModelPreflightCheck[],
  evaluate: (check: ModelPreflightCheck) => string | ModelPreflightEvaluation | null,
): ModelPreflightPlan {
  const warnings: ModelPreflightIssue[] = [];
  const disabledFallbackSlots: ModelPreflightSlot[] = [];

  for (const check of checks) {
    if (check.enabled === false) continue;
    const evaluation = check.selection.model
      ? evaluate(check)
      : "モデルが未選択です";
    const warningOnly =
      typeof evaluation === "object" && evaluation !== null && evaluation.warningOnly === true;
    const reason =
      typeof evaluation === "string"
        ? evaluation
        : evaluation?.reason ?? null;
    if (!reason) continue;
    const issue: ModelPreflightIssue = {
      slot: check.slot,
      provider: check.selection.provider,
      model: check.selection.model,
      reason,
      fallback: check.fallback === true,
    };
    if (warningOnly) {
      warnings.push(issue);
      continue;
    }
    if (check.fallback) {
      warnings.push(issue);
      if (!disabledFallbackSlots.includes(check.slot)) {
        disabledFallbackSlots.push(check.slot);
      }
    } else {
      return {
        ok: false,
        warnings,
        blocked: issue,
        disabledFallbackSlots,
      };
    }
  }

  return { ok: true, warnings, disabledFallbackSlots };
}

/**
 * preflightで使えないと判定された予備だけを、実行payloadから除外する。
 * 元のobjectを変更しないため、保存YAML/localStorageの選択は維持される。
 */
export function applyModelPreflightToPayload<
  T extends Record<string, unknown>,
>(payload: T, plan: ModelPreflightPlan): T {
  const next = { ...payload } as Record<string, unknown>;
  const disabled = new Set(plan.disabledFallbackSlots);

  if (disabled.has("text_fallback")) {
    next["text_fallback_llm_enabled"] = false;
  }
  if (disabled.has("vision_fallback")) {
    next["image_fallback_llm_enabled"] = false;
  }

  const post = next["oshinagaki_post"];
  if (
    disabled.has("oshinagaki_post") &&
    post &&
    typeof post === "object" &&
    !Array.isArray(post)
  ) {
    next["oshinagaki_post"] = {
      ...(post as Record<string, unknown>),
      fallback_enabled: false,
    };
  }
  return next as T;
}

export function formatModelPreflightIssue(issue: ModelPreflightIssue): string {
  const role = issue.slot === "vision" || issue.slot === "vision_fallback"
    ? "画像"
    : issue.slot === "oshinagaki_post"
      ? "おしながきポスト"
      : issue.slot === "text" || issue.slot === "text_fallback"
        ? "テキスト"
        : issue.slot;
  const kind = issue.fallback ? "予備" : "主";
  return `${role}${kind} ${issue.provider}/${issue.model}: ${issue.reason}`;
}

