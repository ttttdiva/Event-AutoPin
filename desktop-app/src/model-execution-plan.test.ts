import {
  applyModelPreflightToPayload,
  formatModelPreflightIssue,
  modelPreflightPlan,
} from "./model-execution-plan";

const plan = modelPreflightPlan(
  [
    {
      slot: "oshinagaki_post",
      selection: { provider: "api:openai", model: "gpt-5.6-luna", effort: "max" },
    },
    {
      slot: "oshinagaki_post",
      fallback: true,
      selection: { provider: "cli:grok", model: "grok-4.7", effort: "none" },
    },
    {
      slot: "vision_fallback",
      fallback: true,
      selection: { provider: "api:openai", model: "gpt-5.6-sol", effort: "none" },
    },
  ],
  (check) => check.fallback ? "認証状態を確認できません" : null,
);

if (!plan.ok || plan.disabledFallbackSlots.join(",") !== "oshinagaki_post,vision_fallback") {
  throw new Error("unusable fallback must warn and be disabled only at runtime");
}
if (!plan.blocked && plan.warnings.length !== 2) {
  throw new Error("fallback warnings must be retained");
}

const original = {
  model: "gpt-5.6-luna",
  text_fallback_llm_enabled: true,
  image_fallback_llm_enabled: true,
  oshinagaki_post: {
    provider: "api:openai",
    model: "gpt-5.6-luna",
    fallback_enabled: true,
    fallback_provider: "cli:grok",
    fallback_model: "grok-4.7",
  },
};
const runtime = applyModelPreflightToPayload(original, plan);
if (runtime === original) throw new Error("runtime payload must be cloned");
if (original.oshinagaki_post.fallback_enabled !== true) {
  throw new Error("saved selection must remain enabled");
}
if (runtime.oshinagaki_post.fallback_enabled !== false) {
  throw new Error("post fallback must be disabled only in runtime payload");
}
if (runtime.image_fallback_llm_enabled !== false) {
  throw new Error("image fallback must be disabled only in runtime payload");
}
if (!formatModelPreflightIssue(plan.warnings[0]).includes("おしながきポスト予備")) {
  throw new Error("preflight issue must name the concrete role");
}

const unknownLive = modelPreflightPlan(
  [
    {
      slot: "oshinagaki_post",
      selection: { provider: "api:openai", model: "gpt-new-live" },
    },
    {
      slot: "oshinagaki_post",
      fallback: true,
      selection: { provider: "api:openai", model: "gpt-new-live-fallback" },
    },
  ],
  (check) => ({
    reason: `${check.selection.model}の能力metadata未確認`,
    warningOnly: true,
  }),
);
if (!unknownLive.ok || unknownLive.blocked || unknownLive.warnings.length !== 2) {
  throw new Error("live API models with unknown capability must warn without blocking primary or disabling fallback");
}
if (unknownLive.disabledFallbackSlots.length !== 0) {
  throw new Error("unknown capability warning must keep the existing fallback enabled");
}

const blocked = modelPreflightPlan(
  [
    { slot: "oshinagaki_post", selection: { provider: "api:openai", model: "retired-model" } },
  ],
  () => "提供終了",
);
if (blocked.ok || blocked.blocked?.fallback !== false) {
  throw new Error("invalid primary must block");
}

const emptyPrimary = modelPreflightPlan(
  [{ slot: "oshinagaki_post", selection: { provider: "api:openai", model: "" } }],
  () => null,
);
if (emptyPrimary.ok || !emptyPrimary.blocked?.reason.includes("未選択")) {
  throw new Error("empty primary must block with a concrete reason");
}

