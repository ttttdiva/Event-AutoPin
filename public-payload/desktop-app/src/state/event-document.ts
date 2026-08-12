import { cloneJsonSnapshot } from "./revisioned-save-queue";

export type TableState = {
  headers: string[];
  rows: Record<string, string>[];
};

export type EventJsonData = {
  circles?: any[];
  [key: string]: any;
};

/**
 * eventJsonDataとtableStateの現在の境界。
 * DOMやmain.tsのグローバル状態を参照せず、保存用の次スナップショットを作る。
 * 将来tableStateを廃止するときは、この関数の呼び出し元を置き換えればよい。
 */
export function buildEventJsonSnapshot(
  eventJsonData: EventJsonData,
  tableState: TableState,
): EventJsonData {
  const next = cloneJsonSnapshot(eventJsonData);
  const circles: any[] = Array.isArray(next.circles) ? next.circles : [];

  tableState.rows.forEach((row, i) => {
    if (i >= circles.length) return;
    const c = circles[i];

    c.hall = row["ホール"] || null;
    c.space = row["スペース"] || "";
    c.name = row["サークル名"] || c.name;
    c.priority_color = parseFloat(row["色"] || "5") || 5;
    c.map_number = parseFloat(row["マップ番号"] || "0") || null;
    c.pin_x = parseFloat(row["ピンX"] || "0") || null;
    c.pin_y = parseFloat(row["ピンY"] || "0") || null;
    c.circle_cut_filename = row["サークル画像"] || c.circle_cut_filename;
    c.checked = parseInt(row["チェック"] || "0") || 0;

    const memoLines = (row["サークルメモ"] || "")
      .split("\n")
      .map((s: string) => s.trim())
      .filter(Boolean);
    c.twitter_url = "";
    c.website_url = "";
    c.pixiv_url = "";
    const extraUrls: string[] = [];
    for (const line of memoLines) {
      if (line.includes("twitter.com") || line.includes("x.com")) {
        c.twitter_url = c.twitter_url || line;
      } else if (line.includes("pixiv.net")) {
        c.pixiv_url = c.pixiv_url || line;
      } else if (!c.website_url) {
        c.website_url = line;
      } else {
        extraUrls.push(line);
      }
    }
    if (extraUrls.length && c.website_url) {
      c.website_url = [c.website_url, ...extraUrls].join("\n");
    } else if (extraUrls.length) {
      c.website_url = extraUrls.join("\n");
    }

    const itemMemoVal = (row["アイテムメモ"] || "").trim();
    c.memo = itemMemoVal || "";

    const itemTagVal = (row["アイテムタグ"] || "").trim();
    const tagParts = itemTagVal
      ? itemTagVal
          .split(/[,、]/)
          .map((s: string) => s.trim())
          .filter(Boolean)
      : [];
    if (!c.items) c.items = [];
    tagParts.forEach((tag: string, idx: number) => {
      if (idx < c.items.length) {
        c.items[idx].type = tag;
      } else {
        c.items.push({
          name: "",
          type: tag,
          price: 0,
          description: "",
          checked: 0,
        });
      }
    });
    for (let idx = tagParts.length; idx < c.items.length; idx++) {
      c.items[idx].type = "";
    }

    const itemImgVal = (row["アイテム画像"] || "").trim();
    if (itemImgVal && itemImgVal !== "0.0" && itemImgVal !== "0") {
      const imgPaths = itemImgVal
        .split("\n")
        .map((s: string) => s.trim())
        .filter(Boolean);
      c.item_images = imgPaths.map((p: string) => ({ path: p }));
    } else {
      c.item_images = [];
    }

    c.penname = (row["ペンネーム"] || "").trim();
    const genreVal = (row["ジャンル"] || "").trim();
    c.genres = genreVal
      ? genreVal
          .split(/[,、]/)
          .map((s: string) => s.trim())
          .filter(Boolean)
      : [];
  });

  return next;
}
