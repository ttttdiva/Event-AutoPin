export type CookieFileSource = "browse" | "drop";

export type CookieExpiryStatus = "session" | "expired" | "future" | "mixed";

export type CookieExpirySummary = Readonly<{
  status: CookieExpiryStatus;
  sessionCount: number;
  expiredCount: number;
  futureCount: number;
}>;

export type CookieValidationMetadata = Readonly<{
  exists: boolean;
  readable: boolean;
  cookieCount: number;
  domainCount: number;
  domains: readonly string[];
  expiry: CookieExpirySummary;
}>;

export type CookieFileValidationResult = CookieValidationMetadata &
  Readonly<{ basename: string }>;

export type CookieFileStageResult = CookieFileValidationResult &
  Readonly<{ path: string }>;

export type CookieFileReason =
  | "missing"
  | "multiple"
  | "directory"
  | "unsupported"
  | "empty_or_invalid"
  | "too_large"
  | "unreadable"
  | "read_error"
  | "stage_error"
  | "choose_error";

export type CookieFileSnapshot = Readonly<{
  state: "idle" | "validating" | "ready" | "error";
  hasSelection: boolean;
  basename?: string;
  source?: CookieFileSource;
  validation?: CookieValidationMetadata;
  reason?: CookieFileReason;
}>;

type CookieSelection = {
  path: string;
  basename: string;
  source: CookieFileSource;
  staged: boolean;
  validation: CookieValidationMetadata;
};

export type CookieFileControllerDependencies = {
  choosePath: () => Promise<string | null>;
  validatePath: (path: string) => Promise<CookieFileValidationResult>;
  stageBytes: (fileName: string, bytes: number[]) => Promise<CookieFileStageResult>;
  cleanupStage: (path: string) => Promise<void>;
  cleanupAllStages: () => Promise<void>;
  onSnapshot: (snapshot: CookieFileSnapshot) => void;
};

export type CookieFileController = {
  select: (path: string, source?: CookieFileSource) => Promise<boolean>;
  stage: (fileName: string, bytes: number[]) => Promise<boolean>;
  choose: () => Promise<boolean>;
  reject: (reason: CookieFileReason) => void;
  clear: () => Promise<void>;
  dispose: () => Promise<void>;
  getSnapshot: () => CookieFileSnapshot;
  getSelectedPathForRun: () => string;
};

function reasonFromError(error: unknown): CookieFileReason {
  const code = String(error ?? "").toLowerCase();
  if (code.includes("cookie_missing")) return "missing";
  if (code.includes("cookie_directory")) return "directory";
  if (code.includes("cookie_unsupported")) return "unsupported";
  if (code.includes("cookie_empty_or_invalid")) return "empty_or_invalid";
  if (code.includes("cookie_too_large")) return "too_large";
  if (code.includes("cookie_unreadable")) return "unreadable";
  if (code.includes("cookie_multiple")) return "multiple";
  if (code.includes("cookie_choose")) return "choose_error";
  return "stage_error";
}

function safeBasename(value: string): string {
  const safe = Array.from(value)
    .filter((character) => !/[\u0000-\u001f\u007f/\\]/.test(character))
    .slice(0, 128)
    .join("");
  return safe || "Cookie file";
}

const COOKIE_DOMAIN_SNAPSHOT_LIMIT = 5;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validationMetadataFromResult(
  result: CookieFileValidationResult,
): CookieValidationMetadata {
  const expiry = result.expiry;
  if (
    result.exists !== true ||
    result.readable !== true ||
    !isNonNegativeSafeInteger(result.cookieCount) ||
    result.cookieCount === 0 ||
    !isNonNegativeSafeInteger(result.domainCount) ||
    result.domainCount === 0 ||
    !Array.isArray(result.domains) ||
    !expiry ||
    !isNonNegativeSafeInteger(expiry.sessionCount) ||
    !isNonNegativeSafeInteger(expiry.expiredCount) ||
    !isNonNegativeSafeInteger(expiry.futureCount)
  ) {
    throw new Error("cookie_empty_or_invalid");
  }

  const domains: string[] = [];
  const seenDomains = new Set<string>();
  for (const candidate of result.domains.slice(0, COOKIE_DOMAIN_SNAPSHOT_LIMIT)) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error("cookie_empty_or_invalid");
    }
    const normalized = candidate.replace(/^\.+/, "").toLowerCase();
    if (
      normalized.length === 0 ||
      Array.from(normalized).length > 253 ||
      /[\u0000-\u0020\u007f/\\]/.test(normalized)
    ) {
      throw new Error("cookie_empty_or_invalid");
    }
    if (!seenDomains.has(normalized)) {
      seenDomains.add(normalized);
      domains.push(normalized);
    }
  }
  if (domains.length === 0 || result.domainCount < domains.length) {
    throw new Error("cookie_empty_or_invalid");
  }

  const expiryKinds = [
    expiry.sessionCount > 0 ? "session" : "",
    expiry.expiredCount > 0 ? "expired" : "",
    expiry.futureCount > 0 ? "future" : "",
  ].filter(Boolean) as Exclude<CookieExpiryStatus, "mixed">[];
  const expectedStatus: CookieExpiryStatus =
    expiryKinds.length > 1 ? "mixed" : expiryKinds[0] || "mixed";
  if (
    expiry.sessionCount + expiry.expiredCount + expiry.futureCount !== result.cookieCount ||
    expiry.status !== expectedStatus
  ) {
    throw new Error("cookie_empty_or_invalid");
  }

  return Object.freeze({
    exists: true,
    readable: true,
    cookieCount: result.cookieCount,
    domainCount: result.domainCount,
    domains: Object.freeze(domains),
    expiry: Object.freeze({
      status: expiry.status,
      sessionCount: expiry.sessionCount,
      expiredCount: expiry.expiredCount,
      futureCount: expiry.futureCount,
    }),
  });
}

export function createCookieFileController(
  dependencies: CookieFileControllerDependencies,
): CookieFileController {
  let operationSerial = 0;
  let selection: CookieSelection | null = null;
  let snapshot: CookieFileSnapshot = Object.freeze({
    state: "idle",
    hasSelection: false,
  });

  const publish = (
    state: CookieFileSnapshot["state"],
    reason?: CookieFileReason,
  ) => {
    snapshot = Object.freeze({
      state,
      hasSelection: selection !== null,
      ...(selection
        ? {
            basename: selection.basename,
            source: selection.source,
            validation: selection.validation,
          }
        : {}),
      ...(reason ? { reason } : {}),
    });
    dependencies.onSnapshot(snapshot);
  };

  const cleanupQuietly = async (candidate: CookieSelection | null) => {
    if (!candidate?.staged) return;
    try {
      await dependencies.cleanupStage(candidate.path);
    } catch {
      // The Rust allowlist remains authoritative; process shutdown cleanup is
      // the fallback. Never expose a staged path through an error message.
    }
  };

  const replaceSelection = async (next: CookieSelection) => {
    const previous = selection;
    selection = next;
    publish("ready");
    if (previous?.path !== next.path) await cleanupQuietly(previous);
  };

  const select = async (
    path: string,
    source: CookieFileSource = "browse",
  ): Promise<boolean> => {
    if (!path.trim()) {
      operationSerial += 1;
      publish("error", "missing");
      return false;
    }
    const serial = ++operationSerial;
    publish("validating");
    try {
      const result = await dependencies.validatePath(path);
      if (serial !== operationSerial) return false;
      await replaceSelection({
        path,
        basename: safeBasename(result.basename),
        source,
        staged: false,
        validation: validationMetadataFromResult(result),
      });
      return true;
    } catch (error) {
      if (serial !== operationSerial) return false;
      publish("error", reasonFromError(error));
      return false;
    }
  };

  const stage = async (fileName: string, bytes: number[]): Promise<boolean> => {
    const serial = ++operationSerial;
    publish("validating");
    let staged: CookieFileStageResult | null = null;
    try {
      staged = await dependencies.stageBytes(fileName, bytes);
      if (!staged.path.trim()) throw new Error("cookie_stage_unavailable");
      const next: CookieSelection = {
        path: staged.path,
        basename: safeBasename(staged.basename),
        source: "drop",
        staged: true,
        validation: validationMetadataFromResult(staged),
      };
      if (serial !== operationSerial) {
        await cleanupQuietly(next);
        return false;
      }
      await replaceSelection(next);
      return true;
    } catch (error) {
      if (staged?.path) {
        try {
          await dependencies.cleanupStage(staged.path);
        } catch {
          // The staged path is private and must not appear in UI errors.
        }
      }
      if (serial !== operationSerial) return false;
      publish("error", reasonFromError(error));
      return false;
    }
  };

  const choose = async (): Promise<boolean> => {
    const serial = ++operationSerial;
    publish("validating");
    let path: string | null;
    try {
      path = await dependencies.choosePath();
    } catch (error) {
      if (serial !== operationSerial) return false;
      publish("error", reasonFromError(error));
      return false;
    }
    if (serial !== operationSerial) return false;
    if (path === null) {
      publish(selection ? "ready" : "idle");
      return false;
    }
    return select(path, "browse");
  };

  const reject = (reason: CookieFileReason) => {
    operationSerial += 1;
    publish("error", reason);
  };

  const clear = async () => {
    operationSerial += 1;
    const previous = selection;
    selection = null;
    publish("idle");
    await cleanupQuietly(previous);
  };

  const dispose = async () => {
    operationSerial += 1;
    const previous = selection;
    selection = null;
    publish("idle");
    await cleanupQuietly(previous);
    try {
      await dependencies.cleanupAllStages();
    } catch {
      // Managed Rust state also removes its private stage root on shutdown.
    }
  };

  dependencies.onSnapshot(snapshot);
  return {
    select,
    stage,
    choose,
    reject,
    clear,
    dispose,
    getSnapshot: () => snapshot,
    getSelectedPathForRun: () => selection?.path || "",
  };
}
