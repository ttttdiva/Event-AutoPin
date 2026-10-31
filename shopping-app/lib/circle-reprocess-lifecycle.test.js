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
  const openedUrls = [];
  const unexpectedWrites = [];
  const circle = {
    id: 1, eventId: 21, name: "検証サークルA", penname: "検証作者",
    space: "A-01", hall: "東1", memo: "検証メモ", tags: '["検証タグ"]',
    genres: '["イラスト"]', description: "検証用", priorityColor: 5,
    purchaseStatus: 0, twitterUrl: null, websiteUrl: null, pixivUrl: null,
    circleCutFilename: null, pinX: null, pinY: null, mapNumber: null,
    hasCatalogPost: true, absenceStatus: 0, existingOnlyStatus: 0,
    catalogStatus: "confirmed", subEvent: "併催テスト", menuUrl: "https://example.com/menu", renderRevision: 0,
  };
  const circles = [circle, { ...circle, id: 2, name: "検証サークルB", space: "A-02" },
    { ...circle, id: 3, name: "Miotec", space: "C-23,C-24" },
    { ...circle, id: 4, name: "Miotec", space: "D-15,D-16" }];
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
  const imageReads = [];
  const imageFiles = new Map([[1, ["file:///test-catalog-1.png", "file:///test-catalog-1b.png"]],
    [2, ["file:///test-catalog-2.png"]], [3, []], [4, ["file:///test-catalog-4.png"]]]);
  let delayedImageRead = null;
  const database = {
    getCircleListRows: async () => circles,
    getCircle: async (id) => circles.find((entry) => entry.id === id),
    getEventSummary: async () => ({ id: 21, name: "表示検証イベント", completed: false }),
    getItemsByCircle: async (id) => [{ ...item, id: 100 + id, circleId: id }],
    getItemImagesByCircle: async (id) => {
      imageReads.push(id);
      const result = (imageFiles.get(id) ?? []).map((filename, index) => ({ id: 200 + id * 10 + index, circleId: id, filename }));
      if (delayedImageRead?.id === id) {
        const pending = delayedImageRead;
        delayedImageRead = null;
        await pending.promise;
      }
      return result;
    },
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
      Alert: { alert: (...args) => alerts.push(args) }, Linking: { openURL: (url) => openedUrls.push(url) },
      Platform: { OS: "android", select: (choices) => choices.android ?? choices.default },
      useWindowDimensions: () => ({ width: 412, height: 915, scale: 1, fontScale: 1 }),
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView", useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) },
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
  let probe;
  try {
    const Screen = require("../app/event/[id]").default;
    const Detail = require("../components/CircleExpandedDetail").default;
    const Row = require("../components/CircleRow").default;
    const ItemRow = require("../components/ItemPurchaseRow").default;
    const step = async (action) => {
      await act(async () => { await action(); });
      await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
    };
    const rowProps = { isExpanded: false, onToggleExpand() {}, onCyclePurchaseStatus() {} };
    const renderProbe = (value) => React.createElement("CatalogProbe", null,
      React.createElement("RowHost", null, React.createElement(Row, { ...rowProps, circle: value })),
      React.createElement("DetailHost", null, React.createElement(Detail, { circle: value, onCircleUpdated() {} })));
    for (const [status, label] of [["confirmed", "確定"], ["preview", "予告"], ["needs_recheck", "要確認"], [null, null], ["future", null]]) {
      const value = { ...circle, catalogStatus: status, subEvent: status === null ? null : "併催表示テスト", menuUrl: null };
      await step(() => {
        if (probe) probe.update(renderProbe(value));
        else probe = create(renderProbe(value));
      });
      for (const host of ["RowHost", "DetailHost"]) {
        const text = textOf(probe.root.findByType(host));
        assert.equal(text.includes("おしながき: "), label !== null, `${host}: ${status}のラベル有無`);
        if (label) assert.ok(text.includes(`おしながき: ${label}`), `${host}: ${status}の日本語ラベル`);
        assert.equal(text.includes("併催表示テスト"), value.subEvent !== null, `${host}: 値がある場合だけ併催名を表示`);
      }
    }
    for (const [field, value] of [["catalogStatus", "preview"], ["subEvent", "別の併催"], ["menuUrl", "https://example.com/new-menu"]]) {
      assert.equal(Row.compare({ ...rowProps, circle }, { ...rowProps, circle: { ...circle, [field]: value } }), false, `${field}だけの更新でも行を再描画`);
    }
    await step(() => probe.unmount());
    probe = null;
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
    const duplicateRows = tree.root.findAllByType("Cell").filter((node) => textOf(node).includes("Miotec"));
    assert.equal(duplicateRows.length, 2, "同名Miotecの別スペースがそれぞれ行に残ること");
    assert.ok(textOf(duplicateRows[0]).includes("C-23,C-24") && textOf(duplicateRows[1]).includes("D-15,D-16"));
    await step(() => row().props.onPress());
    assertClosed("通常タップで再処理モーダルを表示しないこと");
    let detail = tree.root.findByType(Detail);
    assert.ok(textOf(detail).includes("おしながき: 確定") && textOf(detail).includes("併催テスト"), "一覧projectionから詳細へ状態・併催名を渡すこと");
    await step(() => press("おしながき", detail));
    assert.deepEqual(openedUrls, [circle.menuUrl], "menu_urlを詳細のリンクから開くこと");
    for (const label of ["検証頒布物", "1,200", "検証メモ", "検証タグ", "イラスト"]) {
      assert.ok(textOf(detail).includes(label), `${label}を展開欄に残すこと`);
    }
    assert.ok(detail.findAllByType("Pressable").some((node) => node.props.testID === "item-purchase-status-trigger" && node.props.accessibilityLabel.includes("未購入")), "購入状態ボタンを残すこと");
    assert.ok(detail.findAllByType("Image").some((node) => node.props.source.uri === "file:///test-catalog-1.png"), "お品書き画像を残すこと");
    assert.ok(detail.findAllByType("Image").some(node => node.props.source.uri === "file:///test-catalog-1b.png"));
    const imagePress = detail.findAllByType("Pressable").find(node => node.findAllByType("Image").some(image => image.props.source.uri === "file:///test-catalog-1.png"));
    imageReads.length = 0;
    await step(() => imagePress.props.onPress());
    assert.ok(imageReads.every(id => id === 1), "ビューアを開く際は他サークルを先読みしない");
    const viewer = () => tree.root.findByType("ImageViewer");
    assert.equal(viewer().props.uri, "file:///test-catalog-1.png");
    await step(() => viewer().props.onNavigateNext());
    assert.equal(viewer().props.uri, "file:///test-catalog-1b.png");
    await step(() => viewer().props.onNavigateNext());
    assert.equal(viewer().props.uri, "file:///test-catalog-2.png");
    await step(() => viewer().props.onNavigatePrevious());
    assert.equal(viewer().props.uri, "file:///test-catalog-1b.png");
    await step(() => viewer().props.onNavigatePrevious());
    assert.equal(viewer().props.uri, "file:///test-catalog-1.png");
    // 表示開始時に一覧全体を先読みせず、境界に到達した時だけ次へ進む。
    assert.equal(viewer().props.canNavigatePrevious, false, "先頭画像では戻れない");
    imageReads.length = 0;
    await step(() => viewer().props.onNavigateNext());
    assert.ok(imageReads.every(id => id === 1), "同一サークル内の移動で他サークルを読まない");
    await step(() => viewer().props.onNavigateNext());
    assert.equal(viewer().props.uri, "file:///test-catalog-2.png");
    imageReads.length = 0;
    await step(() => viewer().props.onNavigateNext());
    assert.equal(viewer().props.uri, "file:///test-catalog-4.png", "画像なしサークルを飛ばす");
    assert.ok(imageReads.includes(3) && imageReads.includes(4), "隣から順に遅延取得する");
    assert.equal(viewer().props.canNavigateNext, false, "末尾画像では進めない");
    await step(() => viewer().props.onNavigatePrevious());
    assert.equal(viewer().props.uri, "file:///test-catalog-2.png");
    await step(() => viewer().props.onNavigatePrevious());
    assert.equal(viewer().props.uri, "file:///test-catalog-1b.png", "前サークルへ戻る時は末尾画像");

    // 遅い取得の完了後に閉じたビューアが再表示されない。
    let releaseRead;
    delayedImageRead = { id: 1, promise: new Promise(resolve => { releaseRead = resolve; }) };
    await step(() => { viewer().props.onNavigateNext(); });
    await step(() => viewer().props.onClose());
    await step(() => releaseRead());
    assert.equal(tree.root.findAllByType("ImageViewer").length, 0, "閉じた後の遅延応答を無視する");
    detail = tree.root.findByType(Detail);
    const reopen = detail.findAllByType("Pressable").find(node => node.findAllByType("Image").some(image => image.props.source.uri === "file:///test-catalog-1.png"));
    await step(() => reopen.props.onPress());
    assert.equal(viewer().props.uri, "file:///test-catalog-1.png", "再表示は選んだ画像から開始");
    let releaseOldRead;
    delayedImageRead = { id: 1, promise: new Promise(resolve => { releaseOldRead = resolve; }) };
    await step(() => { viewer().props.onNavigateNext(); });
    await step(() => viewer().props.onNavigateNext());
    assert.equal(viewer().props.uri, "file:///test-catalog-1b.png");
    await step(() => releaseOldRead());
    assert.equal(viewer().props.uri, "file:///test-catalog-1b.png", "古い要求より後の操作を優先する");
    let releaseFilteredRead;
    delayedImageRead = { id: 1, promise: new Promise(resolve => { releaseFilteredRead = resolve; }) };
    await step(() => { viewer().props.onNavigateNext(); });
    await step(() => tree.root.findByType("Filters").props.onSearchChange("検証サークルB"));
    assert.equal(tree.root.findAllByType("ImageViewer").length, 0, "対象がフィルターで消えたら閉じる");
    await step(() => releaseFilteredRead());
    assert.equal(tree.root.findAllByType("ImageViewer").length, 0, "フィルター変更前の応答で再表示しない");
    await step(() => tree.root.findByType("Filters").props.onSearchChange(""));
    detail = tree.root.findByType(Detail);
    const reopenAgain = detail.findAllByType("Pressable").find(node => node.findAllByType("Image").some(image => image.props.source.uri === "file:///test-catalog-1.png"));
    await step(() => reopenAgain.props.onPress());
    imageFiles.set(1, ["file:///test-catalog-1b.png"]);
    await step(() => viewer().props.onNavigateNext());
    assert.equal(tree.root.findAllByType("ImageViewer").length, 0, "選択画像が消えたら別サークルへ飛ばない");
    imageFiles.set(1, ["file:///test-catalog-1.png", "file:///test-catalog-1b.png"]);
    detail = tree.root.findByType(Detail);
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
    // 実ImageViewerをレンダリングし、gesture callbackとwebキーを実行する。
    // native gesture認識自体はスタブのため、実端末のタッチ精度は対象外。
    delete mocks["@/components/ImageViewer"];
    const gestures = {};
    const gesture = (name) => {
      const value = { minPointers() { return this; }, numberOfTaps() { return this; },
        onUpdate(callback) { this.update = callback; return this; },
        onEnd(callback) { this.end = callback; return this; } };
      gestures[name] = value;
      return value;
    };
    mocks["react-native-gesture-handler"] = {
      GestureDetector: "GestureDetector", GestureHandlerRootView: "GestureHandlerRootView",
      Gesture: { Pinch: () => gesture("pinch"), Pan: () => gesture("pan"),
        Tap: () => gesture("tap"), Simultaneous: (...values) => values },
    };
    mocks["react-native-reanimated"] = {
      __esModule: true, default: { createAnimatedComponent: (component) => component },
      useSharedValue: (value) => React.useRef({ value }).current,
      useAnimatedStyle: (callback) => callback(), withTiming: (value) => value,
      runOnJS: (callback) => callback,
    };
    const previousWindow = globalThis.window;
    const listeners = new Set();
    globalThis.window = { addEventListener: (name, callback) => { if (name === "keydown") listeners.add(callback); },
      removeEventListener: (name, callback) => { if (name === "keydown") listeners.delete(callback); } };
    mocks["react-native"].Platform.OS = "web";
    let imageViewer;
    try {
      const ImageViewer = require("../components/ImageViewer").default;
      const calls = [];
      const props = { visible: true, uri: "synthetic://a1", onClose: () => calls.push("close"),
        onNavigatePrevious: () => calls.push("previous"), onNavigateNext: () => calls.push("next"),
        canNavigatePrevious: false, canNavigateNext: true };
      const prevented = [];
      const key = (key) => { for (const callback of [...listeners]) callback({ key, preventDefault: () => prevented.push(key) }); };
      const swipe = (translationX, translationY = 0) => gestures.pan.end({ translationX, translationY });
      await step(() => { imageViewer = create(React.createElement(ImageViewer, props)); });
      assert.equal(imageViewer.root.findAllByProps({ accessibilityLabel: "前の画像" }).length, 0);
      await step(() => { key("ArrowLeft"); swipe(100); key("ArrowRight"); swipe(-100); });
      assert.deepEqual(calls, ["next", "next"], "先頭境界で戻らず、キーとスワイプで進む");
      assert.deepEqual(prevented, ["ArrowRight"], "操作したキーのみ標準動作を抑止する");
      prevented.length = 0;
      calls.length = 0;
      await step(() => imageViewer.update(React.createElement(ImageViewer, { ...props, canNavigatePrevious: true, canNavigateNext: false })));
      assert.equal(imageViewer.root.findAllByProps({ accessibilityLabel: "次の画像" }).length, 0);
      await step(() => { key("ArrowRight"); swipe(-100); key("ArrowLeft"); swipe(100); });
      assert.deepEqual(calls, ["previous", "previous"], "末尾境界で進まず、キーとスワイプで戻る");
      assert.deepEqual(prevented, ["ArrowLeft"]);
      prevented.length = 0;
      calls.length = 0;
      await step(() => imageViewer.update(React.createElement(ImageViewer, { ...props, canNavigatePrevious: true })));
      await step(() => {
        swipe(-60); swipe(-100, 90);
        imageViewer.root.findByProps({ accessibilityLabel: "次の画像" }).props.onPress();
        imageViewer.root.findByProps({ accessibilityLabel: "前の画像" }).props.onPress();
        key("Escape"); key("a");
      });
      assert.deepEqual(calls, ["next", "previous", "close"], "短い/縦方向の動きを無視し、ボタンとEscapeを処理");
      assert.deepEqual(prevented, ["Escape"], "Escape以外の無関係なキーは抑止しない");
      await step(() => imageViewer.update(React.createElement(ImageViewer, { ...props, visible: false })));
      assert.equal(listeners.size, 0, "非表示でキーリスナーを解除");
      console.log("画像ビューア: 実コンポーネントのswipe/key/ボタン、先頭末尾境界、非表示解除 PASS");
    } finally {
      if (imageViewer) await act(async () => imageViewer.unmount());
      globalThis.window = previousWindow;
      mocks["react-native"].Platform.OS = "android";
    }
    // 101件の合成一覧で、画面側の実フィルターからヘッダーへ渡る集計を確認。
    await step(() => tree.unmount());
    circles.splice(0, circles.length, ...Array.from({ length: 101 }, (_, i) => ({
      ...circle, id: 1000 + i, name: `合成${i}`, space: `A-${String(i).padStart(3, "0")}`,
      priorityColor: i < 18 ? 15 : 5, purchaseStatus: i === 1 || i === 20 ? 1 : 0,
    })));
    await step(() => { tree = create(React.createElement(Screen)); });
    await step(() => tree.root.findByType("BottomBar").props.onViewModeChange("split"));
    let filters = () => tree.root.findByType("Filters").props;
    await step(() => filters().onTogglePriorityFilter(15));
    assert.equal(filters().filteredCount, 18);
    assert.equal(filters().stats.totalCircles, 18);
    assert.equal(filters().stats.boughtCircles, 1);
    await step(() => filters().onClearPriorityFilter());
    await step(() => filters().onTogglePriorityFilter(5));
    assert.equal(filters().stats.totalCircles, 83);
    assert.equal(filters().stats.boughtCircles, 1);
    await step(() => filters().onSearchChange("存在しない合成"));
    assert.equal(filters().stats.totalCircles, 0);
    await step(() => filters().onSearchChange(""));
    await step(() => filters().onClearPriorityFilter());
    assert.equal(filters().stats.totalCircles, 101);
    await step(() => tree.root.findByType("BottomBar").props.onViewModeChange("list"));
    assert.equal(filters().compact, false, "一覧モードは通常ヘッダーを維持する");
    console.log("半画面: 実画面フィルター18件・別優先度・検索0件・解除と一覧モード PASS");
    console.log("再処理ライフサイクル: 実React親子接続、3種の取消、折り畳み/再マウント、長押し管理と商品編集の維持 PASS");
    console.log("おしながきUI: 5状態×行/詳細、併催名の有無、memo更新判定、同名Miotec別スペース、menu_urlリンク PASS");
  } finally {
    if (probe) await act(async () => probe.unmount());
    if (tree) await act(async () => tree.unmount());
    Module._load = originalLoad;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    for (const filename of Object.keys(require.cache)) {
      if (filename.startsWith(appRoot + path.sep) && !previousCache.has(filename)) delete require.cache[filename];
    }
  }
}

module.exports = { runCircleReprocessLifecycleTests };
