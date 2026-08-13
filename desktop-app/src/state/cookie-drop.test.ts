import { COOKIE_DROP_MAX_BYTES, decideCookieDrop } from "./cookie-drop";
import {
  createCookieFileController,
  type CookieFileStageResult,
  type CookieValidationMetadata,
} from "../features/cookie-file";

const mixedValidation: CookieValidationMetadata = {
  exists: true,
  readable: true,
  cookieCount: 3,
  domainCount: 2,
  domains: ["example.com", "x.com"],
  expiry: {
    status: "mixed",
    sessionCount: 1,
    expiredCount: 1,
    futureCount: 1,
  },
};

const accepted = decideCookieDrop([{ name: "cookies.txt", size: 128 }]);
if (!accepted.accepted || accepted.candidate.name !== "cookies.txt") {
  throw new Error("valid DOM cookie file was not accepted");
}

for (const [label, candidates, expected] of [
  ["missing", [], "missing"],
  [
    "multiple",
    [
      { name: "a.txt", size: 1 },
      { name: "b.txt", size: 1 },
    ],
    "multiple",
  ],
  ["directory", [{ name: "cookies", size: 0, isDirectory: true }], "directory"],
  ["unsupported", [{ name: "cookies.json", size: 10 }], "unsupported"],
  ["too large", [{ name: "cookies.txt", size: COOKIE_DROP_MAX_BYTES + 1 }], "too_large"],
] as const) {
  const decision = decideCookieDrop(candidates);
  if (decision.accepted || decision.reason !== expected) {
    throw new Error(`${label} DOM cookie drop was not rejected`);
  }
}

async function testCookieControllerLifecycle() {
  const snapshots: string[] = [];
  const cleaned: string[] = [];
  let cleanupAllCount = 0;
  let stageCount = 0;
  let stageFailure = false;
  let chooseResult: string | null = null;
  const browsedResult = {
    basename: "browsed.txt",
    ...mixedValidation,
    path: "C:" + "/private/browsed.txt",
    cookieName: "SECRET_COOKIE_NAME",
    cookieValue: "SECRET_COOKIE_VALUE",
  };
  const controller = createCookieFileController({
    choosePath: async () => chooseResult,
    validatePath: async () => browsedResult,
    stageBytes: async () => {
      if (stageFailure) throw new Error("cookie_empty_or_invalid");
      stageCount += 1;
      return {
        path: "C:" + `/test/stage-${stageCount}.txt`,
        basename: "dropped.txt",
        ...mixedValidation,
      };
    },
    cleanupStage: async (path) => {
      cleaned.push(path);
    },
    cleanupAllStages: async () => {
      cleanupAllCount += 1;
    },
    onSnapshot: (snapshot) => snapshots.push(JSON.stringify(snapshot)),
  });

  if (!(await controller.select("C:" + "/test/cookies.txt"))) {
    throw new Error("valid browsed cookie was not selected");
  }
  if (controller.getSelectedPathForRun() !== "C:" + "/test/cookies.txt") {
    throw new Error("browse path was not retained privately for the run");
  }
  if (snapshots.some((snapshot) => snapshot.includes("C:" + "/test"))) {
    throw new Error("snapshot exposed a full browsed path");
  }
  const browsedSnapshot = JSON.stringify(controller.getSnapshot());
  if (
    browsedSnapshot.includes("C:" + "/private") ||
    browsedSnapshot.includes("SECRET_COOKIE_NAME") ||
    browsedSnapshot.includes("SECRET_COOKIE_VALUE")
  ) {
    throw new Error("snapshot exposed validator-only Cookie secrets");
  }
  if (
    controller.getSnapshot().validation?.expiry.status !== "mixed" ||
    controller.getSnapshot().validation?.domains.join(",") !== "example.com,x.com"
  ) {
    throw new Error("browse validation summary was not retained");
  }

  if (!(await controller.stage("cookies.txt", [1, 2, 3]))) {
    throw new Error("valid dropped cookie was not staged");
  }
  const stagedPath = controller.getSelectedPathForRun();
  if (!stagedPath.includes("stage-1.txt")) throw new Error("stage path was not retained");
  if (cleaned.length !== 0) throw new Error("browsed user path was cleanup-targeted");
  if (snapshots.some((snapshot) => snapshot.includes("test/stage"))) {
    throw new Error("snapshot exposed a staged path");
  }
  if (controller.getSnapshot().validation?.expiry.status !== "mixed") {
    throw new Error("drop validation summary did not match browse plumbing");
  }

  stageFailure = true;
  if (await controller.stage("bad.txt", [4])) {
    throw new Error("invalid dropped cookie was selected");
  }
  if (controller.getSelectedPathForRun() !== stagedPath) {
    throw new Error("invalid replacement discarded the prior selection");
  }
  chooseResult = null;
  if (await controller.choose()) throw new Error("cancelled chooser reported selection");
  if (controller.getSelectedPathForRun() !== stagedPath) {
    throw new Error("cancelled chooser discarded the prior selection");
  }

  await controller.clear();
  if (controller.getSelectedPathForRun() !== "") throw new Error("clear retained a path");
  if (cleaned.slice().length !== 1 || cleaned[0] !== stagedPath) {
    throw new Error("clear did not cleanup exactly the staged selection");
  }
  await controller.dispose();
  if (cleanupAllCount !== 1) throw new Error("dispose did not cleanup the stage root");

  let resolveStage!: (value: CookieFileStageResult) => void;
  const staleCleaned: string[] = [];
  const staleController = createCookieFileController({
    choosePath: async () => null,
    validatePath: async () => ({ basename: "unused.txt", ...mixedValidation }),
    stageBytes: async () =>
      new Promise((resolve) => {
        resolveStage = resolve;
      }),
    cleanupStage: async (path) => {
      staleCleaned.push(path);
    },
    cleanupAllStages: async () => undefined,
    onSnapshot: () => undefined,
  });
  const staleStage = staleController.stage("cookies.txt", [1]);
  staleController.reject("multiple");
  resolveStage({
    path: "C:" + "/test/stale.txt",
    basename: "cookies.txt",
    ...mixedValidation,
  });
  if (await staleStage) throw new Error("stale stage result was selected");
  if (
    staleController.getSelectedPathForRun() !== "" ||
    staleCleaned[0] !== "C:" + "/test/stale.txt"
  ) {
    throw new Error("stale stage result was not allowlist-cleaned");
  }
}

void testCookieControllerLifecycle().then(() => {
  console.log("cookie-drop tests passed");
});
