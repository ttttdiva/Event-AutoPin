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
  const originalLoad = Module._load;
  const componentPath = require.resolve("../components/CircleExpandedDetail");
  const previousModule = require.cache[componentPath];
  const jsx = (type, props) => ({ type, props });
  const item = { id: 11, circleId: 1, name: "頒布物テスト", price: 1000, purchaseStatus: 0 };
  const image = { id: 12, circleId: 1, filename: "file:///catalog.png" };
  const statusWrites = [];
  const alerts = [];
  const openedImages = [];
  let refreshes = 0;
  let reprocessCalls = 0;
  const colors = { tint: "#69b4e4", text: "#eeeeee", textSecondary: "#aaaaaa" };
  const mocks = {
    react: harness.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView",
      ActivityIndicator: "ActivityIndicator", StyleSheet: { create: (styles) => styles },
      Linking: { openURL() {} }, Alert: { alert: (...args) => alerts.push(args) },
    },
    "@/components/KeyboardLayout": { InputTextInput: "TextInput", InputModal: "InputModal", InputScrollView: "InputScrollView" },
    "expo-image": { Image: "Image" },
    "@expo/vector-icons/FontAwesome": "FontAwesome",
    "@/components/ImageViewer": "ImageViewer",
    "@/components/ItemPurchaseRow": "ItemPurchaseRow",
    "@/lib/theme-context": { useTheme: () => ({ effectiveScheme: "dark" }) },
    "@/constants/Colors": { getColors: () => colors },
    "@/lib/event-context": { useEvent: () => ({ refreshStats: () => { refreshes++; } }) },
    "@/lib/types": { ITEM_CATEGORIES: ["", "合同誌"] },
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
    let tree = render();
    await new Promise((resolve) => setImmediate(resolve));
    tree = render();
    const modalOf = (value) => find(value, (node) => node.type === "InputModal")[0];
    assert.equal(modalOf(tree).props.visible, false, "通常の展開では再処理モーダルを開かないこと");
    const inline = tree.props.children.filter((node) => node?.type !== "InputModal" && node?.type !== "ImageViewer");
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
    Module._load = originalLoad;
    delete require.cache[componentPath];
    if (previousModule) require.cache[componentPath] = previousModule;
  }
}

module.exports = { runCircleExpandedActionsTests };
