const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const React = require("react");
const { create, act } = require("react-test-renderer");

// 実際の一覧画面・サークル行・展開詳細・商品行をReactで接続する。
// DB・外部処理・native部品は置き換えるため、実機の描画/スクロール検証ではない。
function textOf(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return node?.children ? textOf(node.children) : "";
}

async function runCircleReprocessLifecycleTests() {
  const appRoot = path.resolve(__dirname, "..");
  const originalLoad = Module._load;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const previousCache = new Map(Object.entries(require.cache));
  const hiddenCircleIds = new Set();
  const alerts = [];
  const unexpectedWrites = [];
  const circle = {
    id: 1, eventId: 21, name: "検証サークルA", penname: "検証作者",
    space: "A-01", hall: "東1", memo: "検証メモ", tags: '["検証タグ"]',
    genres: '["イラスト"]', description: "検証用", priorityColor: 5,
    purchaseStatus: 0, twitterUrl: null, websiteUrl: null, pixivUrl: null,
    circleCutFilename: null, pinX: null, pinY: null, mapNumber: null,
    hasCatalogPost: true, absenceStatus: 0, existingOnlyStatus: 0,
    catalogStatus: "done", renderRevision: 0,
  };
  const circles = [circle, { ...circle, id: 2, name: "検証サークルB", space: "A-02" }];
  const item = {
    id: 101, circleId: 1, name: "検証頒布物", price: 1200,
    purchaseStatus: 0, purchaseStatusSource: "manual", type: "本",
    description: "検証説明", sortOrder: 0,
  };
  const noWrite = (name) => async () => {
    unexpectedWrites.push(name);
    throw new Error(`表示確認で${name}を実行しないこと`);
  };
  const nativeModal = (props) => props.visible
    ? React.createElement("Modal", props, props.children)
    : null;
  const eventContext = {
    setCurrentEventId() {}, refreshStats() {}, stats: null, budget: null,
  };
  const priority = { value: 5, label: "通常", color: "#777777", bgColor: "#eeeeee" };
  const database = {
    getCircleListRows: async () => circles,
    getCircle: async (id) => circles.find((entry) => entry.id === id),
    getEventSummary: async () => ({ id: 21, name: "表示検証イベント", completed: false }),
    getItemsByCircle: async (id) => [{ ...item, id: 100 + id, circleId: id }],
    getItemImagesByCircle: async (id) => [{ id: 200 + id, circleId: id, filename: `file:///test-catalog-${id}.png` }],
    getBoughtItemNameKeysForCircle: async () => new Set(),
    normalizePurchaseLookupKey: (value) => value,
    getFavoriteCircles: async () => [], getEventMaps: async () => [],
    searchItemsByEvent: async () => [],
    deleteCircle: noWrite("サークル削除"), deleteItem: noWrite("商品削除"),
    updateCircle: noWrite("サークル更新"), updateItem: noWrite("商品更新"),
    updateCircleMemo: noWrite("メモ更新"),
    updateItemPurchaseStatus: noWrite("購入状態更新"),
  };
  const mocks = {
    "react-native": {
      View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView",
      TextInput: "TextInput", ActivityIndicator: "ActivityIndicator",
      RefreshControl: "RefreshControl", SafeAreaView: "SafeAreaView", StatusBar: "StatusBar",
      Modal: nativeModal,
      FlatList: (props) => React.createElement("FlatList", { ...props, ref: undefined },
        props.data.filter((entry) => !hiddenCircleIds.has(entry.id)).map((entry) =>
          React.createElement("Cell", { key: props.keyExtractor(entry) }, props.renderItem({ item: entry })))),
      StyleSheet: { create: (value) => value, absoluteFillObject: {}, hairlineWidth: 1 },
      LayoutAnimation: { configureNext() {}, Presets: { easeInEaseOut: {} } },
      Alert: { alert: (...args) => alerts.push(args) }, Linking: { openURL() {} },
      Platform: { OS: "android", select: (choices) => choices.android ?? choices.default },
      useWindowDimensions: () => ({ width: 412, height: 915, scale: 1, fontScale: 1 }),
    },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) },
    "expo-router": { useLocalSearchParams: () => ({ id: "21" }), useRouter: () => ({ back() {} }) },
    "@react-navigation/native": { useFocusEffect: (effect) => React.useEffect(effect, [effect]) },
    "expo-image": { Image: "Image" },
    "@expo/vector-icons/FontAwesome": "FontAwesome",
    "@/components/KeyboardLayout": {
      InputTextInput: "TextInput", InputModal: nativeModal, InputScrollView: "ScrollView",
      renderInputScrollView: (props) => React.createElement("ScrollView", props),
    },
    "@/components/CollapsibleHeader": "Filters",
    "@/components/BottomBar": "BottomBar",
    "@/components/MapView": "MapView",
    "@/components/ImageViewer": (props) => props.visible ? React.createElement("ImageViewer", props) : null,
    "@/lib/database": database,
    "@/lib/theme-context": { useTheme: () => ({ effectiveScheme: "dark" }) },
    "@/lib/event-context": { useEvent: () => eventContext },
    "@/lib/priority-color-context": { usePriorityColors: () => ({ options: [priority], getColor: () => priority }) },
    "@/lib/settings-store": { isGlobalSearchEnabled: async () => false },
    "@/lib/performance": {
      beginSqlMetricsScope: () => () => ({ count: 0, elapsedMs: 0, wallElapsedMs: 0 }),
      recordUiMetric() {}, recordUiMetricAfterPaint: () => () => {}, startUiMetric: () => 0,
    },
    "@/lib/crawl/post-reprocess": {
      extractTweetId: () => null, reprocessCircleFromPost: noWrite("外部再処理"),
    },
  };
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    if (request.startsWith("@/")) request = path.join(appRoot, request.slice(2));
    return originalLoad.call(this, request, parent, isMain);
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let tree;
  try {
    const Screen = require("../app/event/[id]").default;
    const Detail = require("../components/CircleExpandedDetail").default;
    const ItemRow = require("../components/ItemPurchaseRow").default;
    const step = async (action) => {
      await act(async () => { await action(); });
      await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
    };
    const press = (label, root = tree.root) => {
      const matches = root.findAllByType("Pressable").filter((node) => textOf(node).trim() === label);
      assert.equal(matches.length, 1, `${label}の操作が一意に存在すること`);
      return matches[0].props.onPress();
    };
    const row = (name = circle.name) => tree.root.findAllByType("Pressable")
      .find((node) => node.props.onLongPress && textOf(node).includes(name));
    const reprocessModals = () => tree.root.findAllByType("Modal")
      .filter((node) => textOf(node).includes("Xポストから再処理"));
    const assertClosed = (message) => assert.equal(reprocessModals().length, 0, message);
    const request = async (name = circle.name) => {
      await step(() => row(name).props.onLongPress());
      for (const label of ["編集", "Xポスト再取得", "削除"]) {
        assert.ok(tree.root.findAllByType("Pressable").some((node) => textOf(node).trim() === label), `${label}の長押し導線を残すこと`);
      }
      await step(() => press("Xポスト再取得"));
      assert.equal(reprocessModals().length, 1, "新しい長押し要求で再処理を表示すること");
    };
    await step(() => { tree = create(React.createElement(Screen)); });
    await step(() => row().props.onPress());
    assertClosed("通常タップで再処理モーダルを表示しないこと");
    const detail = tree.root.findByType(Detail);
    for (const label of ["検証頒布物", "1,200", "検証メモ", "検証タグ", "イラスト"]) {
      assert.ok(textOf(detail).includes(label), `${label}を展開欄に残すこと`);
    }
    assert.ok(detail.findAllByType("Pressable").some((node) => node.props.testID === "item-purchase-status-trigger" && node.props.accessibilityLabel.includes("未購入")), "購入状態ボタンを残すこと");
    assert.ok(detail.findAllByType("Image").some((node) => node.props.source.uri === "file:///test-catalog-1.png"), "お品書き画像を残すこと");
    for (const label of ["編集", "Xポスト再処理", "Xポスト再取得", "削除"]) {
      assert.ok(!detail.findAllByType("Pressable").some((node) => textOf(node).trim() === label), "サークル管理ボタンを常設しないこと");
    }

    // 実際の親画面の要求を使用し、キャンセル→unmount→通常再展開を検証する。
    await request();
    await step(() => press("キャンセル", reprocessModals()[0]));
    assertClosed("キャンセルで閉じること");
    await step(() => row().props.onPress());
    assert.equal(tree.root.findAllByType(Detail).length, 0, "折り畳みで詳細をunmountすること");
    await step(() => row().props.onPress());
    assertClosed("キャンセル後の折り畳み・通常再展開で古い再処理要求を再実行しないこと");

    // 同じコンポーネント上でも、取消/Android Back/外側タップの後に再要求できる。
    for (const close of ["cancel", "back", "overlay"]) {
      await request();
      const modal = reprocessModals()[0];
      const input = modal.findAllByType("TextInput").find((node) => node.props.keyboardType === "url");
      assert.equal(input.props.value, "", "再表示時は前のURLを残さないこと");
      await step(() => input.props.onChangeText("https://x.com/test/status/123"));
      await step(() => close === "cancel" ? press("キャンセル", modal)
        : close === "back" ? modal.props.onRequestClose()
          : modal.findAllByType("Pressable")[0].props.onPress());
      assertClosed(`${close}で閉じること`);
    }

    // FlatListによる再マウント相当。実スクロール/レイアウトの検証ではない。
    await step(() => { hiddenCircleIds.add(1); tree.update(React.createElement(Screen)); });
    assert.equal(tree.root.findAllByType(Detail).length, 0);
    await step(() => { hiddenCircleIds.clear(); tree.update(React.createElement(Screen)); });
    assert.equal(tree.root.findAllByType(Detail).length, 1);
    assertClosed("リスト再マウントで処理済みの要求を再実行しないこと");
    await step(() => row("検証サークルB").props.onPress());
    assertClosed("別サークルの通常展開で再処理を開かないこと");
    await step(() => row().props.onPress());
    assertClosed("元のサークルへ戻っても再処理を開かないこと");

    // サークル操作と商品個別操作を区別し、保存/削除は実行せず取消する。
    await step(() => row().props.onLongPress());
    await step(() => press("編集"));
    assert.ok(tree.root.findAllByType("Modal").some((node) => textOf(node).includes("サークル編集")));
    await step(() => press("キャンセル"));
    await step(() => row().props.onLongPress());
    await step(() => press("削除"));
    assert.equal(alerts.at(-1)[0], "サークル削除");
    assert.ok(alerts.at(-1)[2].some((button) => button.style === "cancel"));
    await step(() => tree.root.findByType(ItemRow).props.onEdit("price"));
    assert.ok(tree.root.findAllByType("TextInput").some((node) => node.props.value === "1200" && node.props.autoFocus));
    await step(() => press("キャンセル"));
    await step(() => tree.root.findByType(ItemRow).props.onDelete());
    assert.equal(alerts.at(-1)[0], "アイテム削除");
    assert.ok(alerts.at(-1)[2].some((button) => button.style === "cancel"));
    assert.deepEqual(unexpectedWrites, [], "表示・取消だけでDB書込/削除/外部再処理を行わないこと");
    console.log("再処理ライフサイクル: 実React親子接続、3種の取消、折り畳み/再マウント、長押し管理と商品編集の維持 PASS");
  } finally {
    if (tree) await act(async () => tree.unmount());
    Module._load = originalLoad;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    for (const filename of Object.keys(require.cache)) {
      if (filename.startsWith(appRoot + path.sep) && !previousCache.has(filename)) delete require.cache[filename];
    }
  }
}

module.exports = { runCircleReprocessLifecycleTests };
