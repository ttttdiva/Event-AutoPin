/** 再処理中は書き換え操作だけを止め、スクロール・展開・画像表示を維持する。 */
export function makeReprocessViewReadOnly(root: HTMLElement): () => void {
  const previous = new Map<HTMLElement, boolean>();
  const lockControls = () => {
    for (const el of previous.keys()) if (!root.contains(el)) previous.delete(el);
    for (const el of root.querySelectorAll<HTMLElement>(
      "#eventMemoInput, #circleEditor input, #circleEditor textarea, " +
      "#circleEditor select, #circleEditor button, " +
      "#circleEditor .img-clickable, #circleEditor .item-img-cell",
    )) {
      if (el.matches(".img-clickable, .item-img-cell") && el.querySelector("img")) continue;
      if (!previous.has(el)) previous.set(el, el.inert);
      el.inert = true;
    }
  };
  const blockWrite = (event: Event) => {
    const target = event.target as Element | null;
    if (!target?.closest("#circleEditor, #eventMemoInput")) return;
    if (event.type === "contextmenu" && !target.closest(".img-clickable, .item-img-cell")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const events = ["drop", "paste", "cut", "contextmenu"];
  events.forEach((name) => root.addEventListener(name, blockWrite, true));
  lockControls();
  const observer = new MutationObserver(lockControls);
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    events.forEach((name) => root.removeEventListener(name, blockWrite, true));
    previous.forEach((inert, el) => { el.inert = inert; });
  };
}
