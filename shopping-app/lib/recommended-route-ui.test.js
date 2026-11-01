const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// MapView の実際の JSX とイベントを評価する。ネイティブ描画の代替ではない。
function harness() {
  const hooks = []; let cursor = 0, dirty = false, effects = []; const ref = { current: null };
  const changed = (prev, deps) => !prev || !deps || deps.some((x, i) => !Object.is(x, prev.deps[i]));
  const react = {
    forwardRef: f => props => f(props, ref),
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[i].value, next => { const value = typeof next === 'function' ? next(hooks[i].value) : next; if (!Object.is(value, hooks[i].value)) dirty = true; hooks[i].value = value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; },
    useMemo(fn, deps) { const i = cursor++; if (changed(hooks[i], deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
    useEffect(fn, deps) { const i = cursor++; const prev = hooks[i]; if (changed(prev, deps)) effects.push(() => { prev?.cleanup?.(); hooks[i] = { deps, cleanup: fn() }; }); },
    useImperativeHandle(ref, create) { ref.current = create(); },
  };
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps);
  react.useLayoutEffect = react.useEffect;
  return { react, ref, render(Component, props) { let tree, attempts = 20; do { assert.ok(attempts--, '再描画が収束する'); cursor = 0; dirty = false; effects = []; tree = Component(props); effects.forEach(f => f()); } while (dirty); return tree; }, unmount() { hooks.forEach(h => h?.cleanup?.()); } };
}
function find(node, predicate) { if (Array.isArray(node)) return node.flatMap(n => find(n, predicate)); if (!node || typeof node !== 'object' || !node.props) return []; return [...(predicate(node) ? [node] : []), ...find(node.props.children, predicate)]; }
function text(node) { if (Array.isArray(node)) return node.map(text).join(''); if (node && typeof node === 'object' && node.props) return text(node.props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }

async function runRecommendedRouteUiTests() {
  const h = harness(), originalLoad = Module._load, alerts = [];
  const gesture = new Proxy({}, { get: () => (...args) => gesture });
  const jsx = (type, props) => ({ type, props });
  const mocks = {
    react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { StyleSheet: { create: x => x, absoluteFillObject: {}, hairlineWidth: 1 }, View: 'View', Text: 'Text', Pressable: 'Pressable', Alert: { alert: (...args) => alerts.push(args) }, useWindowDimensions: () => ({ width: 400, height: 800 }) },
    'expo-image': { Image: 'Image' },
    'react-native-gesture-handler': { GestureDetector: 'GestureDetector', GestureHandlerRootView: 'GestureHandlerRootView', Gesture: gesture },
    'react-native-reanimated': { __esModule: true, default: { View: 'Animated.View' }, useSharedValue: initial => h.react.useRef(initial).currentValue || { value: initial }, useAnimatedStyle: fn => fn(), withTiming: x => x, runOnJS: fn => fn },
    '@/constants/Colors': { getColors: () => ({ background: '#000', text: '#fff', textSecondary: '#aaa', border: '#555', tint: '#00f' }) },
    '@/lib/theme-context': { useTheme: () => ({ effectiveScheme: 'dark' }) },
    '@/lib/priority-color-context': { usePriorityColors: () => ({ options: [], getColor: () => ({ color: '#ffffff', bgColor: '#ffffff' }) }) },
    '@/lib/performance': { recordUiMetric() {}, recordUiMetricAfterPaint: () => () => {}, startUiMetric: () => 0 },
    './MapCirclePopup': { __esModule: true, default: 'MapCirclePopup' },
  };
  Module._load = function(request, parent, isMain) { if (request in mocks) return mocks[request]; if (request.startsWith('@/')) return originalLoad.call(this, path.join(__dirname, '..', request.slice(2)), parent, isMain); return originalLoad.call(this, request, parent, isMain); };
  const componentPath = require.resolve('../components/MapView');
  delete require.cache[componentPath];
  try {
    const Component = require('../components/MapView').default;
    const circle = (id, mapNumber, priorityColor) => ({ id, name: `circle${id}`, penname: null, memo: '', description: null, hall: 'A', space: 'A1', hasCatalogPost: false, mapNumber, priorityColor, purchaseStatus: 0, absenceStatus: null, pinX: .2 * id, pinY: .3 });
    const maps = [{ id: 1, eventId: 1, mapNumber: 1, filename: 'one' }, { id: 2, eventId: 1, mapNumber: 2, filename: 'two' }];
    let props = { eventId: 1, maps, circles: [circle(1, 1, 15), circle(2, 1, 10), circle(3, 2, 15)], showFilters: false };
    let tree = h.render(Component, props);
    const byId = id => find(tree, n => n.props.testID === id)[0];
    const loadImage = () => { find(tree, n => n.type === 'Image')[0].props.onLoad({ source: { width: 1000, height: 500 } }); tree = h.render(Component, props); };
    assert.equal(byId('route-toggle'), undefined);
    assert.equal(byId('route-info'), undefined);
    const offTree = JSON.stringify(tree);
    assert.ok(!offTree.includes('routeControls'), 'OFF時に操作行を追加しない');
    loadImage();
    props = { ...props, routeEnabled: true }; tree = h.render(Component, props);
    h.ref.current.showRouteInfo(); assert.match(alerts.at(-1)[1], /2件/);
    assert.match(alerts.at(-1)[1], /直線距離の目安/);
    props = { ...props, parentPriorityFilter: new Set([15]) }; tree = h.render(Component, props);
    h.ref.current.showRouteInfo(); assert.match(alerts.at(-1)[1], /1件/);
    props = { ...props, parentPriorityFilter: new Set(), parentStatusFilter: new Set([2]) }; tree = h.render(Component, props);
    h.ref.current.showRouteInfo(); assert.match(alerts.at(-1)[1], /0件/);
    props = { ...props, parentStatusFilter: new Set() }; tree = h.render(Component, props);
    h.ref.current.showRouteInfo(); assert.match(alerts.at(-1)[1], /2件/);
    find(tree, n => n.type === 'Pressable' && text(n) === 'マップ 2')[0].props.onPress(); tree = h.render(Component, props); loadImage();
    h.ref.current.showRouteInfo(); assert.match(alerts.at(-1)[1], /1件/);
    // 同番号の画像が追加されても既存ピンは残し、巡回だけを停止する。
    props = { ...props, maps: [...maps, { id: 4, eventId: 1, mapNumber: 2, filename: 'duplicate' }] }; tree = h.render(Component, props);
    h.ref.current.showRouteInfo(); assert.match(alerts.at(-1)[1], /同じ地図番号の画像が複数/);
    assert.match(alerts.at(-1)[1], /地図・座標不明 1件/);
    assert.ok(!alerts.at(-1)[1].includes('仮の開始点'));
    props = { ...props, maps }; tree = h.render(Component, props);
    h.ref.current.showRouteInfo(); assert.match(alerts.at(-1)[1], /表示中の候補 1件/);
    props = { ...props, routeEnabled: false }; tree = h.render(Component, props);
    h.ref.current.showRouteInfo(); assert.match(alerts.at(-1)[1], /読み込み/);
  } finally { h.unmount(); delete require.cache[componentPath]; Module._load = originalLoad; }
}
module.exports = { runRecommendedRouteUiTests };
