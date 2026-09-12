import {
  eventJsonPathForDir,
  eventPathsEqual,
  externalEventOwnerMatches,
  normalizeEventPath,
  shouldSaveBeforeEventReload,
  type ExternalEventReloadOwner,
  type EventOwnerMapping,
} from "./event-reload-ownership";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const windowsEventDir = ["D:", "events", "event-2026"].join("/");
const owner: ExternalEventReloadOwner = {
  slug: "event-2026",
  dir: windowsEventDir,
  eventJsonPath: `${windowsEventDir}/event.json`,
  revision: 12,
  ["session"]: {
    slug: "event-2026",
    eventDir: windowsEventDir,
    eventJsonPath: `${windowsEventDir}/event.json`,
  },
};

// 通常の同一slug reloadはsave-firstを維持し、external reloadだけsaveNowを
// 必要としない。呼出側がこの判定をsaveNowの分岐に使う。
assert(
  shouldSaveBeforeEventReload("manual"),
  "通常の同一slug reloadがsave-firstではありません",
);
assert(
  !shouldSaveBeforeEventReload("external-authoritative"),
  "external reloadがsaveNow前提になっています",
);

const diskDocument = {
  circles: [{ items: [{ name: "Pythonが書いたitem" }] }],
};
const reloadWithoutSave = (
  mode: "manual" | "external-authoritative",
  captured: ExternalEventReloadOwner,
  listed: EventOwnerMapping,
  disk: typeof diskDocument,
): typeof diskDocument | null => {
  let saveNowCalls = 0;
  if (shouldSaveBeforeEventReload(mode)) saveNowCalls += 1;
  if (saveNowCalls !== 0 && mode === "external-authoritative") {
    throw new Error("external reloadがsaveNowを呼びました");
  }
  return externalEventOwnerMatches(captured, listed) ? disk : null;
};

const listedOwner = { slug: owner.slug, dir: owner.dir };
const reloaded = reloadWithoutSave(
  "external-authoritative",
  owner,
  listedOwner,
  diskDocument,
);
assert(
  reloaded?.circles[0].items[0].name === "Pythonが書いたitem",
  "Pythonが書いたitemをexternal reload後も保持できません",
);

let writes = 0;
const mismatchedDir = ["D:", "events", "other"].join("/");
const mismatchedOwner = { ...listedOwner, dir: mismatchedDir };
if (externalEventOwnerMatches(owner, mismatchedOwner)) writes += 1;
assert(writes === 0, "slug同一/path不一致でreloadまたはwriteを許可しました");
assert(
  !externalEventOwnerMatches(owner, {
    slug: owner.slug,
    dir: mismatchedDir,
  }),
  "slug同一/path不一致をowner mismatchとして検出できません",
);

// Windows extended prefixの表記揺れは比較上同一、I/O用のnormalize結果は
// lowercaseせず元のcaseを保持する。
const windowsPath = "\\\\?\\" + windowsEventDir + "\\";
assert(
  normalizeEventPath(windowsPath) === windowsEventDir,
  "\\\\?\\D: prefixを正規化できません",
);
assert(
  normalizeEventPath(`//?/${windowsEventDir}/`) === windowsEventDir,
  "//?/D: prefixを正規化できません",
);
assert(
  eventPathsEqual(windowsPath, eventJsonPathForDir(owner.dir).replace("/event.json", "/")),
  "Windows extended prefixをpath比較で同一視できません",
);
assert(
  normalizeEventPath("/tmp/Event") !== normalizeEventPath("/tmp/event"),
  "Linuxのcase-sensitive pathをlowercase化しました",
);
assert(
  eventPathsEqual(
    ["D:", "Events", "Event-2026"].join("/"),
    ["d:", "events", "event-2026"].join("/"),
  ),
  "Windows drive pathのcase-insensitive比較に失敗しました",
);

console.log("event-reload-ownership tests passed");
