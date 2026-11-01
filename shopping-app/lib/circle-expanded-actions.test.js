const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");

// 実コンポーネントの構造・イベント契約を検証する。ネイティブ描画検証ではない。
function createHookHarness() {
  const hooks = [];
  let cursor = 0;
  let dirty = false;
  let effects = [];
  const changed = (previous, deps) => !previous || deps.some((value, i) => !Object.is(value, previous.deps[i]));
  return {
    react: {
      memo: (component) => component,
      useState(initial) {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
        return [hooks[index].value, (next) => {
          const value = typeof next === "function" ? next(hooks[index].value) : next;
          if (!Object.is(value, hooks[index].value)) dirty = true;
          hooks[index].value = value;
        }];
      },
      useRef(initial) {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = { current: initial };
        return hooks[index];
      },
      useMemo(factory, deps) {
        const index = cursor++;
        if (changed(hooks[index], deps)) hooks[index] = { deps, value: factory() };
        return hooks[index].value;
      },
      useEffect(effect, deps) {
        const index = cursor++;
        const previous = hooks[index];
        if (changed(previous, deps)) effects.push(() => {
          previous?.cleanup?.();
          hooks[index] = { deps, cleanup: effect() };
        });
      },
    },
    render(component, props) {
      let tree;
      let remaining = 10;
      do {
        assert.ok(remaining-- > 0, "描画が無限ループしないこと");
        cursor = 0;
        dirty = false;
        effects = [];
        tree = component(props);
        effects.forEach((effect) => effect());
      } while (dirty);
      return tree;
    },
    unmount() { hooks.forEach((hook) => hook?.cleanup?.()); },
  };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((child) => find(child, predicate));
  if (!node || typeof node !== "object" || !node.props) return [];
  return [...(predicate(node) ? [node] : []), ...find(node.props.children, predicate)];
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && node.props) return textOf(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

async function runCircleExpandedActionsTests() {
  const harness = createHookHarness();
  const rowHarness = createHookHarness();
  const originalLoad = Module._load;
  const componentPath = require.resolve("../components/CircleExpandedDetail");
  const rowPath = require.resolve("../components/CircleRow");
  const previousModule = require.cache[componentPath];
  const previousRowModule = require.cache[rowPath];
  const jsx = (type, props) => ({ type, props });
  const item = { id: 11, circleId: 1, name: "頒布物テスト", price: 1000, purchaseStatus: 0 };
  const image = { id: 12, circleId: 1, filename: "file:///catalog.png" };
  const statusWrites = [];
  const alerts = [];
  const openedImages = [];
  const openedUrls = [];
  let refreshes = 0;
  let reprocessCalls = 0;
  const colors = { tint: "#69b4e4", text: "#eeeeee", textSecondary: "#aaaaaa" };
  const mocks = {
    react: harness.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      Platform: { OS: "android" },
      View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView",
      ActivityIndicator: "ActivityIndicator", StyleSheet: { create: (styles) => styles, absoluteFillObject: {}, hairlineWidth: 1 },
      Linking: { openURL: (url) => openedUrls.push(url) }, Alert: { alert: (...args) => alerts.push(args) },
    },
    "@/components/KeyboardLayout": { InputTextInput: "TextInput", InputModal: "InputModal", InputScrollView: "InputScrollView" },
    "expo-image": { Image: "Image" },
    "@expo/vector-icons/FontAwesome": "FontAwesome",
    "@/components/ImageViewer": "ImageViewer",
    "@/components/ItemPurchaseRow": "ItemPurchaseRow",
    "@/lib/theme-context": { useTheme: () => ({ effectiveScheme: "dark" }) },
    "@/lib/priority-color-context": { usePriorityColors: () => ({ getColor: () => ({ color: "#000" }) }) },
    "@/lib/priority-row-theme": { getPriorityRowTheme: () => ({ end: "#000", ink: "#fff", text: "#fff", secondary: "#aaa", gradientUri: "gradient" }), getRowStatusColors: () => ({ foreground: "#fff", background: "#000" }) },
    "@/constants/Colors": { getColors: () => colors },
    "@/lib/event-context": { useEvent: () => ({ refreshStats: () => { refreshes++; } }) },
    "@/lib/types": { ...require("./types"), ITEM_CATEGORIES: ["", "合同誌"] },
    "@/lib/database": {
      getItemsByCircle: async () => [item], getItemImagesByCircle: async () => [image],
      getBoughtItemNameKeysForCircle: async () => new Set(), normalizePurchaseLookupKey: (value) => value,
      updateItemPurchaseStatus: async (...args) => { statusWrites.push(args); },
    },
    "@/lib/performance": {
      beginSqlMetricsScope: () => () => ({ count: 0, elapsedMs: 0 }), recordUiMetric() {},
    },
    "@/lib/event-load-epoch": {
      createLoadEpochGuard() {
        let epoch = 0;
        return { next: () => ++epoch, isCurrent: (value) => value === epoch };
      },
    },
    "@/lib/crawl/post-reprocess": {
      extractTweetId: () => null,
      reprocessCircleFromPost: async () => { reprocessCalls++; throw new Error("意図しない外部処理"); },
    },
  };
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[componentPath];
    delete require.cache[rowPath];
    mocks.react = rowHarness.react;
    const Row = require("../components/CircleRow").default;
    mocks.react = harness.react;
    const Detail = require("../components/CircleExpandedDetail").default;
    const props = {
      circle: { id: 1, eventId: 2, name: "サークルテスト", penname: null, memo: "メモテスト", tags: '["合同誌"]', genres: '["イラスト"]' },
      onCircleUpdated() {},
      // 呼び出し元が旧propsを渡しても、重複ボタンを復活させない。
      onEditCircle() { throw new Error("一覧からサークル編集を呼ばないこと"); },
      onDeleteCircle() { throw new Error("一覧からサークル削除を呼ばないこと"); },
      onOpenCatalogImage: (...args) => openedImages.push(args),
      reprocessRequestToken: null,
    };
    const render = () => harness.render(Detail, props);
    const url = "https://example.com/catalog";
    const rowCircle = { ...props.circle, memo: `通常メモ ${url}`, purchaseStatus: 0, priorityColor: 0, hall: "東", space: "A01", catalogStatus: "", subEvent: "" };
    let expanded = false;
    const rowProps = { circle: rowCircle, isExpanded: false, onToggleExpand: () => { expanded = true; }, onCyclePurchaseStatus() {} };
    let row = rowHarness.render(Row, rowProps);
    assert.ok(textOf(row).includes("サークルテスト") && textOf(row).includes("通常メモ") && textOf(row).includes("東 A01"));
    assert.equal(find(row, (node) => node.type === "Pressable" && node.props.accessibilityRole === "button").length, 1, "購入状態を残すこと");
    assert.ok(!textOf(row).includes(url), "一覧にURLを表示しないこと");
    find(row, (node) => node.type === "Pressable" && !node.props.accessibilityRole)[0].props.onPress();
    assert.equal(expanded, true, "行タップで展開すること");
    rowCircle.memo = url;
    row = rowHarness.render(Row, rowProps);
    assert.equal(find(row, (node) => node.type === "Text" && node.props.style?.some?.((style) => style?.fontStyle === "italic")).length, 0, "URLだけならメモ行自体を置かないこと");
    const memoLines = (tree) => find(tree, (node) => node.type === "Text" && node.props.style?.some?.((style) => style?.fontStyle === "italic"));
    for (const memo of [`（${url}）`, `"HTTPS://example.com/catalog"`, null]) {
      rowCircle.memo = memo;
      row = rowHarness.render(Row, rowProps);
      assert.equal(memoLines(row).length, 0, "囲まれたURLだけ、またはnullならメモ行を置かないこと");
      assert.equal(rowCircle.memo, memo, "元のメモを変更しないこと");
    }
    const mixedMemo = `通常メモ（HTTPS://example.com/catalog）後で買う`;
    rowCircle.memo = mixedMemo;
    row = rowHarness.render(Row, rowProps);
    assert.equal(textOf(memoLines(row)), "通常メモ（）後で買う", "URLの後の句読点と文章を残すこと");
    assert.equal(rowCircle.memo, mixedMemo, "一覧表示で元のメモを変更しないこと");
    props.circle.memo = `メモテスト ${url}`;
    let tree = render();
    await new Promise((resolve) => setImmediate(resolve));
    tree = render();
    const modalOf = (value) => find(value, (node) => node.type === "InputModal")[0];
    const reprocessNotice = textOf(modalOf(tree));
    for (const rule of [
      "取得できた頒布物・お品書き画像だけを更新します",
      "同名・同種別の頒布物の購入状態と説明は引き継ぎます",
      "取得結果にない頒布物は更新後の一覧から除かれます",
      "失敗時や何も取得できなかった場合は既存データを保持します",
    ]) assert.ok(reprocessNotice.includes(rule), `再処理の説明に「${rule}」を含めること`);
    assert.doesNotMatch(reprocessNotice, /既存の頒布物・画像は削除されます/, "無条件に削除されると案内しないこと");
    assert.equal(modalOf(tree).props.visible, false, "通常の展開では再処理モーダルを開かないこと");
    const inline = tree.props.children.filter((node) => node?.type !== "InputModal" && node?.type !== "ImageViewer");
    assert.ok(textOf(inline).includes(props.circle.memo), "詳細には元のメモ全体を残すこと");
    const memoLink = find(inline, (node) => node.type === "Text" && node.props.onPress && textOf(node) === url)[0];
    assert.ok(memoLink, "展開後もメモのURLを表示すること");
    memoLink.props.onPress();
    assert.deepEqual(openedUrls, [url], "展開後のURLを開けること");
    const labels = find(inline, (node) => node.type === "Pressable").map((node) => textOf(node).trim());
    for (const label of ["編集", "Xポスト再処理", "削除"]) assert.ok(!labels.includes(label), `${label}の常設ボタンを表示しないこと`);
    const source = fs.readFileSync(componentPath, "utf8");
    assert.doesNotMatch(source, /circleActionRow|editCircleBtn|deleteCircleBtn/, "削除したボタン列の余白・スタイルを残さないこと");
    assert.ok(textOf(inline).includes("頒布物") && textOf(inline).includes("1,000"), "頒布物と合計金額を残すこと");
    for (const label of ["メモテスト", "合同誌", "イラスト"]) assert.ok(textOf(inline).includes(label), `${label}を残すこと`);
    const catalog = find(inline, (node) => node.type === "Pressable" && find(node, (child) => child.type === "Image").length > 0)[0];
    catalog.props.onPress();
    assert.deepEqual(openedImages, [[props.circle, image.filename]], "お品書き画像の拡大操作を残すこと");
    const purchaseRow = find(inline, (node) => node.type === "ItemPurchaseRow")[0];
    assert.equal(purchaseRow.props.item.name, item.name, "商品情報を残すこと");
    await purchaseRow.props.onStatusChange(1);
    assert.deepEqual(statusWrites, [[11, 1]], "購入状態の更新を残すこと");
    assert.equal(refreshes, 1, "購入状態の統計を更新すること");

    // 長押しメニューからの要求を受け、閉じた後も新しい要求で再表示できる。
    for (const token of [1, 2]) {
      props.reprocessRequestToken = token;
      tree = render();
      const modal = modalOf(tree);
      assert.equal(modal.props.visible, true, "長押しメニューから再処理モーダルを開けること");
      assert.equal(find(modal, (node) => node.type === "TextInput" && node.props.keyboardType === "url").length, 1, "URL入力を残すこと");
      find(modal, (node) => node.type === "Pressable" && textOf(node).trim() === "キャンセル")[0].props.onPress();
      assert.equal(modalOf(render()).props.visible, false, "再処理をキャンセルできること");
    }
    assert.equal(reprocessCalls, 0, "メニュー表示だけで外部処理を実行しないこと");
    assert.deepEqual(alerts, [], "通常表示・キャンセルでエラーを出さないこと");
    console.log("サークル展開UI: 常設操作・余白の削除、表示内容・購入状態・再処理導線の維持 PASS");
  } finally {
    harness.unmount();
    rowHarness.unmount();
    Module._load = originalLoad;
    delete require.cache[componentPath];
    delete require.cache[rowPath];
    if (previousModule) require.cache[componentPath] = previousModule;
    if (previousRowModule) require.cache[rowPath] = previousRowModule;
  }
}

module.exports = { runCircleExpandedActionsTests };
