import { formatItemPrice, getItemPurchaseMenuLayout, ITEM_PURCHASE_OPTIONS } from "./item-purchase-menu";
import { PURCHASE_STATUS, type Item } from "./types";
import { getColors } from "../constants/Colors";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Element {
  type: unknown;
  props: Record<string, any>;
}

function findElements(node: unknown, predicate: (node: Element) => boolean): Element[] {
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, predicate));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [
    ...(predicate(element) ? [element] : []),
    ...findElements(element.props.children, predicate),
  ];
}

function byId(node: unknown, id: string): Element {
  const matches = findElements(node, (element) => element.props.testID === id);
  assert(matches.length === 1, `${id}が1つだけ存在すること`);
  return matches[0];
}

function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as Element).props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

/** ネイティブ描画を代替せず、実コンポーネントの構造・イベント契約だけを独立して検証する。 */
function createHookHarness() {
  const hooks: any[] = [];
  let cursor = 0;
  let dirty = false;
  let effects: Array<() => void> = [];
  return {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = { value: initial };
        return [hooks[index].value, (next: any) => {
          const value = typeof next === "function" ? next(hooks[index].value) : next;
          if (!Object.is(value, hooks[index].value)) dirty = true;
          hooks[index].value = value;
        }];
      },
      useRef(initial: unknown) {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = { current: initial };
        return hooks[index];
      },
      useEffect(effect: () => (() => void) | void, deps: unknown[]) {
        const index = cursor++;
        const previous = hooks[index];
        if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
          effects.push(() => {
            previous?.cleanup?.();
            hooks[index] = { deps, cleanup: effect() };
          });
        }
      },
    },
    render(component: (props: any) => unknown, props: any): unknown {
      let node: unknown;
      let remaining = 10;
      do {
        assert(remaining-- > 0, "描画が無限ループしないこと");
        cursor = 0;
        dirty = false;
        effects = [];
        node = component(props);
        effects.forEach((effect) => effect());
      } while (dirty);
      return node;
    },
    unmount() {
      hooks.forEach((hook) => hook?.cleanup?.());
    },
  };
}

export async function runItemPurchaseUiTests(): Promise<void> {
  assert(ITEM_PURCHASE_OPTIONS.map((option) => option.value).join(",") === "1,2,3", "保存値1/2/3を維持すること");
  assert(ITEM_PURCHASE_OPTIONS.map((option) => option.label).join(",") === "購入済み,買えなかった,見送り", "状態を日本語で明示すること");
  assert(formatItemPrice(0) === "0円", "無料の0円を価格不明と混同しないこと");
  assert(formatItemPrice(null) === "価格不明", "不明価格を0円扱いしないこと");
  assert(formatItemPrice(1500) === "1,500円", "金額を桁区切りで表示すること");
  assert(formatItemPrice(12345678) === "12,345,678円", "高額でも値を省略しないこと");

  let geometryChecks = 0;
  for (const width of [240, 320, 360, 393, 430, 768]) {
    for (const height of [240, 640, 852]) {
      for (const top of [0, 28, 59]) {
        for (const bottom of [0, 24, 34]) {
          const insets = { top, bottom, left: 4, right: 4 };
          for (const x of [-20, width / 2, width - 44]) {
            for (const y of [-20, height / 2, height - bottom - 44]) {
              for (const requestedHeight of [180, 320, 640, 1400]) {
                const layout = getItemPurchaseMenuLayout({ x, y, width: 44, height: 44 }, { width, height }, insets, requestedHeight);
                const visibleHeight = Math.min(layout.maxHeight, requestedHeight);
                assert(layout.left >= insets.left + 8, "左の安全領域に収まること");
                assert(layout.left + layout.width <= width - insets.right - 8, "右の安全領域に収まること");
                assert(layout.top >= top + 8, "上の安全領域に収まること");
                assert(layout.top + visibleHeight <= height - bottom - 8, "下の安全領域に収まること");
                geometryChecks++;
              }
            }
          }
        }
      }
    }
  }
  const below = getItemPurchaseMenuLayout({ x: 300, y: 100, width: 44, height: 44 }, { width: 393, height: 852 }, { top: 28, bottom: 34, left: 0, right: 0 }, 280);
  assert(below.top === 150, "十分な空間があればボタンの下に開くこと");
  const above = getItemPurchaseMenuLayout({ x: 300, y: 720, width: 44, height: 44 }, { width: 393, height: 852 }, { top: 28, bottom: 34, left: 0, right: 0 }, 280);
  assert(above.top === 434, "下に入らない場合はボタンの上に開くこと");

  const runtimeRequire = eval("require") as (id: string) => any;
  const Module = runtimeRequire("node:module");
  const originalLoad = Module._load;
  let harness = createHookHarness();
  let viewport = { width: 393, height: 852, fontScale: 1 };
  const alerts: unknown[][] = [];
  const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props });
  const native = {
    View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", Modal: "Modal",
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
    useWindowDimensions: () => viewport,
    Alert: { alert: (...args: unknown[]) => alerts.push(args) },
  };
  Module._load = function mockLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === "react") return harness.react;
    if (request === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (request === "react-native") return native;
    if (request === "react-native-safe-area-context") return { useSafeAreaInsets: () => ({ top: 28, bottom: 34, left: 0, right: 0 }) };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const Row = runtimeRequire("../components/ItemPurchaseRow").default;
    const Menu = runtimeRequire("../components/ItemPurchaseStatusMenu").default;
    const colors = getColors("dark");
    const item: Item = {
      id: 1, circleId: 2, name: "圧倒的ゆかりちゃん不足です！".repeat(10), price: 1000,
      type: "新刊(イラスト)".repeat(20), description: null,
      purchaseStatus: PURCHASE_STATUS.NOT_YET, purchaseStatusSource: null, rawJson: null,
    };
    let edits = 0;
    const row = Row({ item, colors, isDark: true, isBoughtSomewhere: true, showReorder: true,
      canMoveUp: false, canMoveDown: true, onEdit: () => edits++, onDelete() {},
      onMoveUp() {}, onMoveDown() {}, onStatusChange: async () => {},
    });
    assert(row.type === "View" && !row.props.onPress, "行全体に編集タップを持たせないこと");
    const nameScroll = byId(row, "item-name-scroll");
    assert(nameScroll.props.horizontal && nameScroll.props.nestedScrollEnabled, "名前を横スワイプできること");
    assert(nameScroll.props.style.flex === 1 && nameScroll.props.style.minWidth === 0 && nameScroll.props.style.overflow === "hidden", "名前の幅を確実に制限すること");
    assert(textOf(nameScroll) === item.name, "長い商品名を切り捨てず保持すること");
    assert(!findElements(nameScroll, (element) => element.props.testID === "item-price").length, "金額をスクロール領域の外に置くこと");
    const price = byId(row, "item-price");
    assert(textOf(price) === "1,000円" && price.props.style.flexShrink === 0, "固定領域に金額全体を表示すること");
    assert(findElements(row, (element) => element.type === Menu).length === 1, "状態トリガーを1個に集約すること");
    findElements(nameScroll, (element) => element.type === "Pressable")[0].props.onPress();
    assert(edits === 1, "商品名の通常タップによる編集を維持すること");

    let writes: number[] = [];
    let props = { itemName: item.name, colors, status: 0, onChange: async (value: number) => { writes.push(value); } };
    function render() { return harness.render(Menu, props); }
    function open() {
      let tree = render();
      const trigger = byId(tree, "item-purchase-status-trigger");
      trigger.props.ref.current = { measureInWindow: (callback: Function) => callback(330, 720, 44, 44) };
      trigger.props.onPress();
      return render();
    }
    let tree = open();
    let trigger = byId(tree, "item-purchase-status-trigger");
    assert(trigger.props.style.width === 44 && trigger.props.style.height === 44, "トリガーのタップ領域は44dpを確保すること");
    const circle = findElements(trigger, (element) => element.type === "View")[0];
    assert(circle.props.style[0].width === 28 && circle.props.style[0].height === 28, "丸ボタンの見た目は既存の28dpを維持すること");
    assert(trigger.props.accessibilityState.expanded, "開閉状態を読み上げに提供すること");
    let choices = findElements(tree, (element) => element.props.accessibilityRole === "radio");
    assert(choices.length === 3, "未購入のときは3つの選択肢を表示すること");
    for (const choice of choices) {
      assert(choice.props.style({ pressed: false })[0].minHeight >= 56, "選択肢の高さを56dp以上にすること");
    }
    byId(tree, "item-purchase-status-backdrop").props.onPress();
    assert(!findElements(render(), (element) => element.type === "Modal").length && writes.length === 0, "外側タップは更新せず閉じること");
    tree = open();
    findElements(tree, (element) => element.type === "Modal")[0].props.onRequestClose();
    assert(!findElements(render(), (element) => element.type === "Modal").length && writes.length === 0, "Androidの戻る操作は更新せず閉じること");

    for (const status of [1, 2, 3]) {
      props = { ...props, status: 0 };
      tree = open();
      byId(tree, `item-purchase-status-option-${status}`).props.onPress();
      await Promise.resolve();
      assert(writes[writes.length - 1] === status, "選択した既存の状態値を保存すること");
      props = { ...props, status };
      tree = open();
      const chosen = byId(tree, `item-purchase-status-option-${status}`);
      assert(chosen.props.accessibilityState.checked, "現在の状態を選択済みとして表示すること");
      const previousWrites: number = writes.length;
      chosen.props.onPress();
      await Promise.resolve();
      assert(writes.length === previousWrites, "同じ状態の選択で意図せず未購入に戻さないこと");
      tree = open();
      byId(tree, "item-purchase-status-option-0").props.onPress();
      await Promise.resolve();
      assert(writes[writes.length - 1] === 0, "未購入に戻す操作で0を保存すること");
    }

    let finish: (() => void) | undefined;
    writes = [];
    props = { ...props, status: 0, onChange: async (value) => {
      writes.push(value);
      await new Promise<void>((resolve) => { finish = resolve; });
    } };
    tree = open();
    const select = byId(tree, "item-purchase-status-option-1").props.onPress;
    select(); select();
    assert(writes.length === 1, "連打による二重保存を防ぐこと");
    assert(byId(render(), "item-purchase-status-trigger").props.disabled, "保存中は再選択を無効化すること");
    finish?.();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert(!byId(render(), "item-purchase-status-trigger").props.disabled, "保存完了後は再選択できること");

    props = { ...props, onChange: async () => { throw new Error("保存失敗"); } };
    tree = open();
    byId(tree, "item-purchase-status-option-2").props.onPress();
    await Promise.resolve();
    assert(alerts.length === 1 && !byId(render(), "item-purchase-status-trigger").props.disabled, "保存失敗を通知して再操作を許可すること");

    tree = open();
    viewport = { ...viewport, width: 852, height: 393 };
    assert(!findElements(render(), (element) => element.type === "Modal").length, "回転後に古い位置のメニューを残さないこと");
    tree = render();
    let lateMeasure: Function | undefined;
    trigger = byId(tree, "item-purchase-status-trigger");
    trigger.props.ref.current = { measureInWindow: (callback: Function) => { lateMeasure = callback; } };
    trigger.props.onPress();
    harness.unmount();
    lateMeasure?.(330, 720, 44, 44);
    assert(!findElements(render(), (element) => element.type === "Modal").length, "アンマウント後の遅い測定結果でメニューを開かないこと");
    console.log(`購入UI: ${geometryChecks}件の配置検査、長い名前・価格固定・3状態・取消・連打・失敗・回転の契約検証に成功`);
  } finally {
    Module._load = originalLoad;
    harness.unmount();
  }
}
