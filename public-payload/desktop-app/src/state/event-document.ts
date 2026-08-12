import { cloneJsonSnapshot } from "./revisioned-save-queue";

export type TableState = {
  headers: string[];
  rows: Record<string, string>[];
};

export type EventJsonData = {
  circles?: any[];
  [key: string]: any;
};

export type EventMapImage = {
  name: string;
  path: string;
  modified_ms?: number;
};

function mapNumberFromImageName(name: string): number | null {
  const match = name.match(/^map_(\d+)/i);
  if (!match) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedMapReference(reference: string): string {
  return reference
    .replace(/\\/g, "/")
    .split("/")
    .filter((component) => component && component !== ".")
    .join("/")
    .toLowerCase();
}

/**
 * 旧extensionを孤児として保持しても、各map番号につきactive画像を1件に絞る。
 * 明示preferredを最優先し、それ以外はmtime、同値なら名前順で決定する。
 */
export function selectActiveMapImages(
  images: EventMapImage[],
  preferredReferences: string[] = [],
): EventMapImage[] {
  const preferred = preferredReferences.map(normalizedMapReference).filter(Boolean);
  const isPreferred = (image: EventMapImage): boolean => {
    const name = image.name.toLowerCase();
    const path = normalizedMapReference(image.path);
    return preferred.some((reference) =>
      reference.includes("/")
        ? path === reference || path.endsWith(`/${reference}`)
        : name === reference,
    );
  };
  const active = new Map<number, EventMapImage>();
  for (const image of images) {
    const number = mapNumberFromImageName(image.name);
    if (!number) continue;
    const current = active.get(number);
    if (!current) {
      active.set(number, image);
      continue;
    }
    const imagePreferred = isPreferred(image);
    const currentPreferred = isPreferred(current);
    const imageModified = Number.isFinite(image.modified_ms) ? Number(image.modified_ms) : 0;
    const currentModified = Number.isFinite(current.modified_ms)
      ? Number(current.modified_ms)
      : 0;
    if (
      (imagePreferred && !currentPreferred) ||
      (imagePreferred === currentPreferred &&
        (imageModified > currentModified ||
          (imageModified === currentModified && image.name.localeCompare(current.name) > 0)))
    ) {
      active.set(number, image);
    }
  }
  return Array.from(active.entries())
    .sort(([left], [right]) => left - right)
    .map(([, image]) => image);
}

function rowValue(row: Record<string, string> | undefined, key: string): string {
  return String(row?.[key] ?? "");
}

function hasEditedCell(
  row: Record<string, string>,
  baselineRow: Record<string, string> | undefined,
  key: string,
): boolean {
  return rowValue(row, key) !== rowValue(baselineRow, key);
}

function parseMemoUrls(value: string): {
  twitterUrl: string;
  websiteUrl: string;
  pixivUrl: string;
} {
  let twitterUrl = "";
  let websiteUrl = "";
  let pixivUrl = "";
  const extraUrls: string[] = [];
  for (const line of value
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)) {
    if (line.includes("twitter.com") || line.includes("x.com")) {
      twitterUrl = twitterUrl || line;
    } else if (line.includes("pixiv.net")) {
      pixivUrl = pixivUrl || line;
    } else if (!websiteUrl) {
      websiteUrl = line;
    } else {
      extraUrls.push(line);
    }
  }
  if (extraUrls.length) {
    websiteUrl = [websiteUrl, ...extraUrls].filter(Boolean).join("\n");
  }
  return { twitterUrl, websiteUrl, pixivUrl };
}

function imageEntryPath(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "path" in value) {
    return String((value as { path?: unknown }).path ?? "").trim();
  }
  return "";
}

function normalizedAssetReference(value: unknown): string {
  return imageEntryPath(value).replace(/\\/g, "/");
}

function assetReferenceIdentity(value: unknown): string {
  const normalized = normalizedAssetReference(value);
  const lowered = normalized.toLowerCase();
  if (
    !normalized ||
    lowered.includes("://") ||
    lowered.startsWith("file:") ||
    lowered.startsWith("data:") ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized)
  ) {
    return `!invalid:${normalized}`;
  }
  const components: string[] = [];
  for (const component of normalized.split("/")) {
    if (!component || component === ".") continue;
    // Rust safe_relative_pathと同様にparent/prefix/rootをfail closedにする。
    if (component === "..") return `!invalid:${normalized}`;
    components.push(component.toLowerCase());
  }
  return components.length ? components.join("/") : `!invalid:${normalized}`;
}

export function imageColumnAssetReferences(value: string): string[] {
  return value
    .split("\n")
    .map((part) => normalizedAssetReference(part))
    .filter(
      (part) =>
        part && part !== "0.0" && part !== "0" && !/^\d+(\.\d+)?$/.test(part),
    );
}

/** event.json内で画像ファイルを所有しうる既知の全参照を集計する。 */
export function collectEventAssetReferences(data: EventJsonData): Set<string> {
  const references = new Set<string>();
  const add = (value: unknown) => {
    const reference = assetReferenceIdentity(value);
    if (reference) references.add(reference);
  };
  const circles = Array.isArray(data.circles) ? data.circles : [];
  for (const circle of circles) {
    add(circle?.circle_cut_filename);
    if (Array.isArray(circle?.item_images)) {
      circle.item_images.forEach(add);
    }
    if (Array.isArray(circle?.items)) {
      circle.items.forEach((item: any) => add(item?.image));
    }
  }
  return references;
}

export async function runImageDeletionTransaction(options: {
  removedReferences: string[];
  applyClear: () => void;
  save: () => Promise<boolean>;
  rollbackIfCurrent: () => boolean;
  currentDocument: () => EventJsonData | null;
  deleteAsset: (reference: string) => Promise<void>;
}): Promise<boolean> {
  options.applyClear();
  let saved = false;
  try {
    saved = await options.save();
  } catch {
    saved = false;
  }
  if (!saved) {
    // 新しい編集・save revisionが存在する場合は、古いsnapshotで全体を
    // 上書きせず、新しいstateを維持する。いずれの場合も物理削除しない。
    options.rollbackIfCurrent();
    return false;
  }

  const document = options.currentDocument();
  // 保存後に所有イベントが切り替わっていたら、旧documentの参照有無を
  // 判定できないため物理削除はfail closedにする。
  if (!document) return true;
  const remaining = collectEventAssetReferences(document);
  const candidates = new Map<string, string>();
  for (const reference of options.removedReferences) {
    const normalized = normalizedAssetReference(reference);
    if (normalized) candidates.set(assetReferenceIdentity(normalized), normalized);
  }
  for (const [identity, reference] of candidates) {
    if (!remaining.has(identity)) await options.deleteAsset(reference);
  }
  return true;
}

function patchItemImages(circle: any, value: string): void {
  const paths = imageColumnAssetReferences(value);
  const desiredPaths = new Set(paths.map(assetReferenceIdentity));
  const items = Array.isArray(circle.items) ? circle.items : [];
  const retainedItemPaths = new Set<string>();
  for (const item of items) {
    const itemPath = imageEntryPath(item?.image);
    if (!itemPath) continue;
    const itemIdentity = assetReferenceIdentity(itemPath);
    if (desiredPaths.has(itemIdentity)) {
      retainedItemPaths.add(itemIdentity);
    } else {
      // 合成表示から明示削除されたitems[].image参照も同時に解除する。
      item.image = "";
    }
  }

  const existing = Array.isArray(circle.item_images) ? circle.item_images : [];
  circle.item_images = paths.flatMap((path) => {
    const pathIdentity = assetReferenceIdentity(path);
    const retained = existing.find(
      (entry: unknown) => assetReferenceIdentity(entry) === pathIdentity,
    );
    // 両保存元に同じpathがあった場合は、metadataを持つitem_images側を優先する。
    if (retained !== undefined) return [retained];
    // items[].imageだけに残るpathはitem_imagesへ重複格納しない。
    if (retainedItemPaths.has(pathIdentity)) return [];
    return [{ path }];
  });
}

/** JSONへシリアライズしたときに同じ文書になるかを判定する。 */
export function eventJsonDocumentsEqual(
  left: EventJsonData | null,
  right: EventJsonData | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * eventJsonDataとtableStateの現在の境界。
 * baselineTableStateから明示的に変わったセルだけをJSONへ反映し、
 * 未編集フィールドの欠落状態や未知フィールドをそのまま保持する。
 */
export function buildEventJsonSnapshot(
  eventJsonData: EventJsonData,
  tableState: TableState,
  baselineTableState: TableState,
): EventJsonData {
  const next = cloneJsonSnapshot(eventJsonData);
  const circles: any[] = Array.isArray(next.circles) ? next.circles : [];

  tableState.rows.forEach((row, i) => {
    if (i >= circles.length || !circles[i] || typeof circles[i] !== "object") return;
    const circle = circles[i];
    const baselineRow = baselineTableState.rows[i];

    if (hasEditedCell(row, baselineRow, "ホール")) {
      circle.hall = rowValue(row, "ホール") || null;
    }
    if (hasEditedCell(row, baselineRow, "スペース")) {
      circle.space = rowValue(row, "スペース");
    }
    if (hasEditedCell(row, baselineRow, "サークル名")) {
      circle.name = rowValue(row, "サークル名");
    }
    if (hasEditedCell(row, baselineRow, "色")) {
      circle.priority_color = parseFloat(rowValue(row, "色") || "5") || 5;
    }
    if (hasEditedCell(row, baselineRow, "マップ番号")) {
      circle.map_number = parseFloat(rowValue(row, "マップ番号") || "0") || null;
    }
    if (hasEditedCell(row, baselineRow, "ピンX")) {
      circle.pin_x = parseFloat(rowValue(row, "ピンX") || "0") || null;
    }
    if (hasEditedCell(row, baselineRow, "ピンY")) {
      circle.pin_y = parseFloat(rowValue(row, "ピンY") || "0") || null;
    }
    if (hasEditedCell(row, baselineRow, "サークル画像")) {
      circle.circle_cut_filename = rowValue(row, "サークル画像");
    }
    if (hasEditedCell(row, baselineRow, "チェック")) {
      circle.checked = parseInt(rowValue(row, "チェック") || "0") || 0;
    }

    if (hasEditedCell(row, baselineRow, "サークルメモ")) {
      const urls = parseMemoUrls(rowValue(row, "サークルメモ"));
      circle.twitter_url = urls.twitterUrl;
      circle.website_url = urls.websiteUrl;
      circle.pixiv_url = urls.pixivUrl;
    }

    if (hasEditedCell(row, baselineRow, "アイテムメモ")) {
      circle.memo = rowValue(row, "アイテムメモ").trim();
    }

    if (hasEditedCell(row, baselineRow, "アイテムタグ")) {
      const tags = rowValue(row, "アイテムタグ")
        .split(/[,、]/)
        .map((part) => part.trim())
        .filter(Boolean);
      if (!Array.isArray(circle.items)) circle.items = [];
      tags.forEach((tag, index) => {
        if (index < circle.items.length) {
          circle.items[index].type = tag;
        } else {
          circle.items.push({
            name: "",
            type: tag,
            price: 0,
            description: "",
            checked: 0,
          });
        }
      });
      for (let index = tags.length; index < circle.items.length; index += 1) {
        circle.items[index].type = "";
      }
    }

    if (hasEditedCell(row, baselineRow, "アイテム画像")) {
      patchItemImages(circle, rowValue(row, "アイテム画像").trim());
    }

    if (hasEditedCell(row, baselineRow, "ペンネーム")) {
      circle.penname = rowValue(row, "ペンネーム").trim();
    }
    if (hasEditedCell(row, baselineRow, "ジャンル")) {
      const genre = rowValue(row, "ジャンル").trim();
      circle.genres = genre
        ? genre
            .split(/[,、]/)
            .map((part) => part.trim())
            .filter(Boolean)
        : [];
    }
  });

  return next;
}
