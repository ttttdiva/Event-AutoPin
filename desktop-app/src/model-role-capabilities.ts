export type ModelCapability = "verified" | "unsupported" | "unknown";
export type ModelRole = "text" | "image";
export type ModelPreflightSlot =
  | "text"
  | "text_fallback"
  | "site_structure"
  | "oshinagaki_post"
  | "vision"
  | "vision_fallback";
export type ModelPreflightOperation =
  | "circle_post"
  | "circle_image"
  | "catalog_reprocess"
  | "pipeline"
  | "map_auto";
export type ModelStatus =
  | "available"
  | "stale"
  | "availability_unknown"
  | "retired"
  | "scheduled_retirement"
  | "permission_denied"
  | "unsupported"
  | "unknown";

export type RoleModel = {
  id: string;
  provider?: string;
  availability?: string;
  stale?: boolean;
  capabilities?: Partial<Record<ModelRole, ModelCapability>>;
};

export type ProviderStatus = {
  status?: string;
};

export function modelPreflightSlotsForOperation(
  operation: ModelPreflightOperation,
  twitterEnabled = true,
): ModelPreflightSlot[] {
  const visionSlots: ModelPreflightSlot[] = ["vision", "vision_fallback"];
  switch (operation) {
    case "circle_image":
    case "map_auto":
      return visionSlots;
    case "circle_post":
      return ["oshinagaki_post", ...visionSlots];
    case "catalog_reprocess":
      return ["text", "text_fallback", "oshinagaki_post", ...visionSlots];
    case "pipeline":
      return [
        "text",
        "text_fallback",
        ...visionSlots,
        ...(twitterEnabled ? ["oshinagaki_post" as const] : []),
      ];
  }
}

export function selectActiveModelPreflightChecks<T extends { slot: ModelPreflightSlot }>(
  checks: readonly T[],
  activeSlots: readonly ModelPreflightSlot[],
): T[] {
  const active = new Set(activeSlots);
  return checks.filter((check) => active.has(check.slot));
}

export function modelStatusForRole(
  model: RoleModel,
  role: ModelRole,
  providerStatus?: ProviderStatus,
): ModelStatus {
  if (providerStatus?.status === "permission_denied") return "permission_denied";
  if (model.availability === "retired") return "retired";
  if (model.availability === "scheduled_retirement" || model.availability === "deprecated") {
    return "scheduled_retirement";
  }
  const capability = model.capabilities?.[role] ?? "unknown";
  if (capability === "unsupported") return "unsupported";
  if (capability !== "verified") return "unknown";
  if (
    !model.availability ||
    (model.availability !== "available" &&
      model.availability !== "active" &&
      model.availability !== "stale")
  ) {
    return "availability_unknown";
  }
  return model.stale || model.availability === "stale" ? "stale" : "available";
}

export function modelsForRole<T extends RoleModel>(
  models: T[],
  role: ModelRole,
  providerStatus?: ProviderStatus,
): T[] {
  return models.filter((model) => {
    if (
      model.stale &&
      model.availability !== "retired" &&
      model.capabilities?.[role] === "verified"
    ) {
      return true;
    }
    const status = modelStatusForRole(model, role, providerStatus);
    return status === "available" || status === "stale" || status === "scheduled_retirement";
  });
}

export function modelStatusLabel(status: ModelStatus): string {
  switch (status) {
    case "available":
      return "能力確認済み";
    case "stale":
      return "前回取得（更新失敗）";
    case "availability_unknown":
      return "利用状態未確認";
    case "retired":
      return "提供終了";
    case "scheduled_retirement":
      return "提供終了予定";
    case "permission_denied":
      return "権限エラー";
    case "unsupported":
      return "非対応";
    default:
      return "能力未確認";
  }
}
