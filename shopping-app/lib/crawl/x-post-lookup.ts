/** Xの公開埋め込みデータから投稿本文と写真を取得する。 */
export interface XPostDetail { text: string; imageUrls: string[] }
export async function fetchXPostDetail(id: string): Promise<XPostDetail> {
  if (!/^\d+$/.test(id)) throw new Error("投稿IDが不正です");
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    let response: Response;
    try { response = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=ja&token=${token}`, { signal: controller.signal }); }
    catch { throw new Error(timedOut ? "X投稿の取得がタイムアウトしました" : "X投稿への接続に失敗しました"); }
    if (!response.ok) throw new Error(`X公開投稿を取得できませんでした (HTTP ${response.status})`);
    let data: any;
    try { data = await response.json(); } catch { throw new Error(timedOut ? "X投稿の取得がタイムアウトしました" : "X投稿の応答を解析できませんでした"); }
    if (String(data?.id_str ?? data?.id ?? "") !== id || typeof data?.text !== "string") {
      throw new Error("X公開投稿を取得できませんでした。非公開・削除済み、または埋め込み非対応の可能性があります");
    }
    const fullText = data.note_tweet?.text ?? data.note_tweet?.note_tweet_results?.result?.text ?? data.full_text ?? data.extended_tweet?.full_text;
    if ((data.truncated === true || data.note_tweet != null) && (typeof fullText !== "string" || !fullText.trim())) {
      throw new Error("X投稿の全文を取得できませんでした");
    }
    const lists = [data.mediaDetails, data.photos].filter(list => list != null);
    if (lists.some(list => !Array.isArray(list))) throw new Error("X投稿の画像一覧が不正です");
    const photoLists = lists.map(list => list.filter((entry: any) => !entry?.type || entry.type === "photo").map((entry: any) => {
      const url = entry?.media_url_https ?? entry?.url;
      if (typeof url !== "string" || !/^https:\/\/pbs\.twimg\.com\//i.test(url)) throw new Error("X投稿の画像URLを確認できませんでした");
      return url.split("?")[0];
    }));
    if (photoLists.length === 2 && (photoLists[0].length !== photoLists[1].length || photoLists[0].some((url: string) => !photoLists[1].includes(url)))) {
      throw new Error("X投稿の写真をすべて確認できませんでした");
    }
    return { text: typeof fullText === "string" ? fullText : data.text, imageUrls: [...new Set<string>(photoLists[0] ?? [])] };
  } finally { clearTimeout(timer); }
}
