export const GPT_56_API_MODELS = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "openai",
    source_label: "候補",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai",
    source_label: "候補",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    source_label: "候補",
  },
] as const;

export const GPT_56_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const OPENAI_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const OPENAI_LATEST_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
];

const OPENAI_51_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
];

const OPENAI_PRE_51_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
];

export function isGpt56GeneralModel(modelId: string): boolean {
  const normalized = String(modelId || "").trim().toLowerCase();

  if (normalized === "gpt-5.6") {
    return true;
  }

  return GPT_56_API_MODELS.some(({ id }) => {
    return normalized === id || normalized.startsWith(`${id}-`);
  });
}

export function openAiEffortsForModel(modelId: string): string[] {
  const normalized = String(modelId || "").trim().toLowerCase();

  if (isGpt56GeneralModel(normalized)) {
    return [...GPT_56_REASONING_EFFORTS];
  }

  if (normalized === "gpt-5-pro" || normalized === "gpt-5.2-pro") {
    return ["high"];
  }

  if (normalized.startsWith("gpt-5.2")) {
    return [...OPENAI_LATEST_REASONING_EFFORTS];
  }

  if (normalized.startsWith("gpt-5.1")) {
    return [...OPENAI_51_REASONING_EFFORTS];
  }

  if (normalized.startsWith("gpt-5")) {
    return [...OPENAI_PRE_51_REASONING_EFFORTS];
  }

  return [...OPENAI_REASONING_EFFORTS];
}
