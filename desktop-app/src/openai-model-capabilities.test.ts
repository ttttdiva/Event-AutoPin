import {
  GPT_56_API_MODELS,
  GPT_56_REASONING_EFFORTS,
  isGpt56GeneralModel,
  openAiEffortsForModel,
} from "./openai-model-capabilities";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqualStrings(actual: string[], expected: readonly string[], message: string): void {
  assert(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const expectedGpt56Models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
for (const expectedId of expectedGpt56Models) {
  assert(
    GPT_56_API_MODELS.some(({ id }) => id === expectedId),
    `GPT-5.6候補に${expectedId}が必要です`,
  );
}

const expectedGpt56Efforts = ["none", "low", "medium", "high", "xhigh", "max"];
for (const modelId of [
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6-sol-dummy-snapshot",
  "gpt-5.6-terra-dummy-snapshot",
  "gpt-5.6-luna-dummy-snapshot",
]) {
  assert(isGpt56GeneralModel(modelId), `${modelId}はGPT-5.6 general familyである必要があります`);
  assertEqualStrings(
    openAiEffortsForModel(modelId),
    expectedGpt56Efforts,
    `${modelId}のreasoning effortが不正です`,
  );
}

assertEqualStrings(GPT_56_REASONING_EFFORTS.slice(), expectedGpt56Efforts, "GPT-5.6 effort契約が不正です");
assert(!openAiEffortsForModel("gpt-5.6-luna").includes("minimal"), "GPT-5.6にminimalを表示してはいけません");
assert(openAiEffortsForModel("gpt-5.6-luna").includes("xhigh"), "GPT-5.6にxhighが必要です");
assert(openAiEffortsForModel("gpt-5.6-luna").includes("max"), "GPT-5.6にmaxが必要です");
assert(!isGpt56GeneralModel("gpt-5.6-cyber"), "specialized GPT-5.6 modelをgeneral family扱いしてはいけません");
assertEqualStrings(
  openAiEffortsForModel("gpt-5"),
  ["minimal", "low", "medium", "high"],
  "旧GPT-5のminimal互換性が失われています",
);

console.log("OpenAI model capability tests passed");
