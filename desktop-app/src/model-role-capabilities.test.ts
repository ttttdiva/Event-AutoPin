import {
  modelStatusForRole,
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
if (textModels.map((model) => model.id).join(",") !== "gpt-5.6-luna,gemini-current,grok-stale,gpt-5-mini") {
  throw new Error("text role must exclude unknown and retired models while retaining verified stale entries");
}

const imageModels = modelsForRole([...models], "image");
if (imageModels.map((model) => model.id).join(",") !== "gpt-5.6-luna,grok-stale,gpt-5-mini") {
  throw new Error("image role must require verified image input");
}

if (modelStatusForRole(models[0], "text", { status: "permission_denied" }) !== "permission_denied") {
  throw new Error("provider permission failure must remain distinct from unknown capability");
}

if (modelStatusForRole(models[1], "text") !== "unknown") {
  throw new Error("unverified capability must remain unknown");
}

if (modelStatusForRole(models[5], "text") !== "availability_unknown") {
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
if (modelPreflightSlotsForOperation("circle_post").join(",") !== "oshinagaki_post,vision,vision_fallback") {
  throw new Error("post reprocessing must preflight the post and image roles it invokes");
}
if (modelPreflightSlotsForOperation("pipeline", false).includes("oshinagaki_post")) {
  throw new Error("a pipeline with Twitter catalog disabled must not preflight the post role");
}
if (!modelPreflightSlotsForOperation("pipeline", true).includes("oshinagaki_post")) {
  throw new Error("a Twitter-enabled pipeline must preflight the post role");
}

if (modelStatusForRole(models[5], "text") !== "availability_unknown") {
  throw new Error("verified modality and unknown account availability must stay distinct");
}
