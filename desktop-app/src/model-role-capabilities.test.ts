import {
  modelStatusForRole,
  modelStatusLabel,
  modelPreflightSlotsForOperation,
  modelsForRole,
  selectActiveModelPreflightChecks,
} from "./model-role-capabilities";

const models = [
  {
    id: "gpt-5.6-luna",
    capabilities: { text: "verified", image: "verified" },
    availability: "available",
  },
  {
    id: "gpt-live-transcribe",
    capabilities: { text: "unknown", image: "unknown" },
    availability: "available",
  },
  {
    id: "gpt-new-live",
    source: "provider-api",
    capabilities: { text: "unknown", image: "unknown" },
    availability: "available",
  },
  {
    id: "gpt-new-stale",
    source: "stale-cache",
    capabilities: { text: "unknown", image: "unknown" },
    availability: "available",
    stale: true,
  },
  {
    id: "text-embedding-live",
    source: "provider-api",
    capabilities: { text: "unsupported", image: "unsupported" },
    availability: "available",
  },
  {
    id: "gemini-current",
    capabilities: { text: "verified", image: "unknown" },
    availability: "available",
  },
  {
    id: "claude-retired",
    capabilities: { text: "verified", image: "verified" },
    availability: "retired",
  },
  {
    id: "grok-stale",
    capabilities: { text: "verified", image: "verified" },
    availability: "available",
    stale: true,
  },
  {
    id: "saved-model-no-live-list",
    capabilities: { text: "verified", image: "verified" },
    availability: "unknown",
  },
  {
    id: "gpt-5-mini",
    capabilities: { text: "verified", image: "verified" },
    availability: "scheduled_retirement",
  },
  {
    id: "saved-model-no-live-list",
    capabilities: { text: "verified", image: "verified" },
    availability: "unknown",
  },
] as const;

const textModels = modelsForRole([...models], "text");
if (textModels.map((model) => model.id).join(",") !== "gpt-5.6-luna,gpt-new-live,gemini-current,grok-stale,gpt-5-mini") {
  throw new Error("text role must include live unknown API models, exclude saved/stale unknown models, and retain verified stale entries");
}

if (modelStatusForRole(models[4], "text") !== "unsupported") {
  throw new Error("known specialized API models must remain unsupported");
}

const imageModels = modelsForRole([...models], "image");
if (imageModels.map((model) => model.id).join(",") !== "gpt-5.6-luna,gpt-new-live,grok-stale,gpt-5-mini") {
  throw new Error("image role must include live unknown API models while excluding saved/stale unknown models");
}

const cliModels = [
  {
    id: "codex-current",
    source: "cli-suggested",
    capabilities: { text: "unknown", image: "unknown" },
    availability: "unknown",
  },
  {
    id: "claude-retired-cli",
    source: "cli-suggested",
    capabilities: { text: "unknown", image: "unknown" },
    availability: "retired",
  },
] as const;
if (modelsForRole([...cliModels], "text", undefined, true).map((model) => model.id).join(",") !== "codex-current") {
  throw new Error("CLI text candidates with unverified metadata must remain selectable");
}
if (modelsForRole([...cliModels], "image", undefined, true).length !== 0) {
  throw new Error("CLI unknown image candidates must not bypass image capability checks");
}

if (modelStatusForRole(models[0], "text", { status: "permission_denied" }) !== "permission_denied") {
  throw new Error("provider permission failure must remain distinct from unknown capability");
}

if (modelStatusForRole(models[1], "text") !== "unknown") {
  throw new Error("unverified capability must remain unknown");
}

if (modelStatusForRole(models[2], "text") !== "unknown") {
  throw new Error("live API model with unverified capability must stay selectable with a warning status");
}
if (modelStatusLabel(modelStatusForRole(models[2], "image")) !== "能力未確認") {
  throw new Error("live API model with unknown image capability must keep the explicit unknown label");
}

if (modelStatusForRole(models[3], "text") !== "unknown") {
  throw new Error("stale unknown API model must not be treated as a live selectable model");
}

const savedNoLive = models.find((model) => model.id === "saved-model-no-live-list")!;
if (modelStatusForRole(savedNoLive, "text") !== "availability_unknown") {
  throw new Error("verified modality and unknown account availability must stay distinct");
}

const preflightChecks = selectActiveModelPreflightChecks(
  [
    { slot: "text", status: "configured" },
    { slot: "text_fallback", status: "not_configured" },
    { slot: "site_structure", status: "not_configured" },
    { slot: "oshinagaki_post", status: "not_configured" },
    { slot: "vision", status: "configured" },
    { slot: "vision_fallback", status: "not_configured" },
  ] as const,
  ["vision"],
);
if (preflightChecks.length !== 1 || preflightChecks[0].slot !== "vision") {
  throw new Error("an image-only operation must not be blocked by unused API roles or fallbacks");
}

if (modelPreflightSlotsForOperation("circle_image").join(",") !== "vision,vision_fallback") {
  throw new Error("image-only circle reprocessing must preflight image roles only");
}
if (modelPreflightSlotsForOperation("circle_post").join(",") !== "oshinagaki_post") {
  throw new Error("URL post reprocessing must preflight only the post role");
}
if (modelPreflightSlotsForOperation("pipeline", false).includes("oshinagaki_post")) {
  throw new Error("a pipeline with Twitter catalog disabled must not preflight the post role");
}
if (!modelPreflightSlotsForOperation("pipeline", true).includes("oshinagaki_post")) {
  throw new Error("a Twitter-enabled pipeline must preflight the post role");
}
if (!modelPreflightSlotsForOperation("pipeline", true).includes("site_structure")) {
  throw new Error("a pipeline must preflight the site structure role it invokes");
}
if (modelPreflightSlotsForOperation("catalog_reprocess").join(",") !== "oshinagaki_post") {
  throw new Error("catalog reprocess must preflight only the post joint role");
}

if (modelStatusForRole(savedNoLive, "text") !== "availability_unknown") {
  throw new Error("verified modality and unknown account availability must stay distinct");
}
