import { mergeCommittedEventMetaPreservingUnknown } from "./event-meta-merge";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const documentData = {
  event: {
    name: "old",
    date: "2026-01-01",
    future_field: { preserve: true },
  },
};
mergeCommittedEventMetaPreservingUnknown(documentData, { name: "new" });
assert(documentData.event.name === "new", "既知metaがmergeされません");
assert(documentData.event.date === undefined, "削除された既知metaが残っています");
assert((documentData.event.future_field as { preserve: boolean }).preserve, "未知event fieldが失われました");
const cleared = { event: { event_image: "event_image/cover.jpg", future: 1 } };
mergeCommittedEventMetaPreservingUnknown(cleared, { event_image: null });
assert(cleared.event.event_image === null, "nullによるevent_image明示削除が保持されません");
assert(cleared.event.future === 1, "event_image削除で未知fieldが失われました");
const clearedCrawlMeta = {
  event: {
    date: "2026-01-01",
    event_url: "https://old.example/event",
    event_urls: ["https://old.example/event"],
    url: "https://old.example/event",
    map_url: "https://old.example/map.png",
    map_config: "https://old.example/map.png",
    additional_prompt: "old prompt",
    future_crawl_field: { preserve: true },
  },
};
mergeCommittedEventMetaPreservingUnknown(clearedCrawlMeta, {
  date: null,
  event_url: null,
  event_urls: null,
  url: null,
  map_url: null,
  map_config: null,
  additional_prompt: null,
});
assert(clearedCrawlMeta.event.date === null, "date null clear payloadが保持されません");
assert(clearedCrawlMeta.event.event_url === null, "event_url null clear payloadが保持されません");
assert(clearedCrawlMeta.event.event_urls === null, "event_urls null clear payloadが保持されません");
assert(clearedCrawlMeta.event.url === null, "url alias null clear payloadが保持されません");
assert(clearedCrawlMeta.event.map_url === null, "map_url null clear payloadが保持されません");
assert(clearedCrawlMeta.event.map_config === null, "map_config null clear payloadが保持されません");
assert(clearedCrawlMeta.event.additional_prompt === null, "additional_prompt null clear payloadが保持されません");
assert(
  (clearedCrawlMeta.event.future_crawl_field as { preserve: boolean }).preserve,
  "既知crawl metadata clearで未知fieldが失われました",
);

// startInlineEditと同じ既知meta patchも、空欄(null)を保持したまま
// unknown fieldを失わないことを確認する。
const clearedInlineMeta = {
  event: {
    name: "旧イベント",
    date: "2026-01-02",
    venue: "旧会場",
    inline_future_field: { preserve: true },
  },
};
mergeCommittedEventMetaPreservingUnknown(clearedInlineMeta, {
  name: "新イベント",
  date: null,
  venue: null,
});
assert(clearedInlineMeta.event.name === "新イベント", "inline name patchが反映されません");
assert(clearedInlineMeta.event.date === null, "inline date null clearが保持されません");
assert(clearedInlineMeta.event.venue === null, "inline venue null clearが保持されません");
assert(
  (clearedInlineMeta.event.inline_future_field as { preserve: boolean }).preserve,
  "inline metadata clearで未知fieldが失われました",
);
console.log("event-meta-merge tests passed");
