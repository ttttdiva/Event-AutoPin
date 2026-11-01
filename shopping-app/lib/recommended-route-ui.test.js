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
  const gestures = {};
  const makeGesture = kind => { const callbacks = {}; const instance = new Proxy({}, { get: (_, name) => (...args) => { if (String(name).startsWith('on')) callbacks[name] = args[0]; return instance; } }); gestures[kind] = callbacks; return instance; };
  const gesture = new Proxy({}, { get: (_, kind) => () => makeGesture(kind) });
  const jsx = (type, props) => ({ type, props });
  const mocks = {
    react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { StyleSheet: { create: x => x, absoluteFillObject: {}, hairlineWidth: 1 }, View: 'View', Text: 'Text', Pressable: 'Pressable', Modal: 'Modal', ScrollView: 'ScrollView', Alert: { alert: (...args) => alerts.push(args) }, useWindowDimensions: () => ({ width: 400, height: 800 }) },
    'expo-image': { Image: 'Image' },
    'react-native-gesture-handler': { GestureDetector: 'GestureDetector', GestureHandlerRootView: 'GestureHandlerRootView', Gesture: gesture },
    'react-native-reanimated': { __esModule: true, default: { View: 'Animated.View' }, useSharedValue: initial => h.react.useRef({ value: initial }).current, useAnimatedStyle: fn => fn(), withTiming: x => x, runOnJS: fn => fn },
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
    const pinLayers = () => {
      const pins = find(tree, n => typeof n.type === 'function' && ['StaticPin', 'DraggablePin'].includes(n.type.name));
      return pins.map(pin => {
        const rendered = pin.type(pin.props);
        const target = rendered.type === 'GestureDetector' ? rendered.props.children : rendered;
        return target.props.style[1].zIndex;
      });
    };
    assert.equal(byId('route-overlay'), undefined);
    assert.deepEqual(pinLayers(), [1, 1]);
    props = { ...props, routeEnabled: true }; tree = h.render(Component, props);
    assert.equal(byId('route-overlay').props.pointerEvents, 'none');
    assert.ok(byId('route-overlay').props.style[1].zIndex > 100);
    assert.deepEqual(pinLayers(), [1, 1]);
    const openInfo = () => { h.ref.current.showRouteInfo(); tree = h.render(Component, props); };
    openInfo();
    assert.equal(find(tree, n => n.type === 'Modal')[0].props.visible, true);
    assert.match(text(tree), /表示中の候補 2件/);
    assert.deepEqual(find(tree, n => n.props.testID === 'route-list-row').map(text), ['#1　A1　circle1', '#2　A1　circle2']);
    assert.equal(find(tree, n => n.props.testID === 'route-dot').length, 2);
    assert.equal(find(tree, n => n.props.testID === 'route-segment').length, 2);
    assert.match(text(tree), /30日以内 0件・古い 0件・不明 2件/);
    const denseCircles = Array.from({ length: 69 }, (_, i) => ({ ...circle(i + 1, 1, 15), pinX: .2, pinY: .3 }));
    props = { ...props, circles: denseCircles, highlightCircleId: 69 }; tree = h.render(Component, props);
    assert.equal(find(tree, n => n.props.testID === 'route-list-row').length, 69);
    assert.equal(find(tree, n => n.props.testID === 'route-dot').length, 69);
    assert.deepEqual(find(tree, n => n.props.testID === 'route-badge').map(text), ['69']);
    const nearby = Array.from({ length: 69 }, (_, i) => ({ ...circle(i + 1, 1, 15), pinX: i === 0 ? 0 : i === 68 ? 1 : .08 + (i % 12) * .018, pinY: i === 0 ? 0 : i === 68 ? 1 : .1 + Math.floor(i / 12) * .025 }));
    props = { ...props, circles: nearby, highlightCircleId: null }; tree = h.render(Component, props);
    const snapshot = () => ({ badges: find(tree, n => n.props.testID === 'route-badge'), starts: find(tree, n => n.props.testID === 'route-start'), dots: find(tree, n => n.props.testID === 'route-dot'), segments: find(tree, n => n.props.testID === 'route-segment'), rows: find(tree, n => n.props.testID === 'route-list-row').map(text) });
    const verify = (snap, scale) => {
      assert.equal(snap.dots.length, 69); assert.equal(snap.segments.length, 69); assert.equal(snap.rows.length, 69);
      const boxes = [...snap.starts, ...snap.badges].map(n => n.props.style[1]);
      for (const box of boxes) assert.ok(box.left >= 0 && box.top >= 0 && box.left + box.width <= 400.00001 && box.top + box.height <= 200.00001);
      for (let i = 0; i < boxes.length; i++) for (let j = 0; j < i; j++) assert.ok(Math.abs(boxes[i].left - boxes[j].left) * scale >= 26 - 1e-6 || Math.abs(boxes[i].top - boxes[j].top) * scale >= 26 - 1e-6, '表示位置で衝突しない');
    };
    const geometry = snap => ({ dots: snap.dots.map(n => { const s = n.props.style; return [s.left + s.width / 2, s.top + s.height / 2]; }), segments: snap.segments.map(n => { const s = n.props.style; return [s.left + s.width / 2, s.top + s.height / 2, s.width, s.transform[0].rotate]; }) });
    const pinch = factor => { const g = gestures.Pinch; g.onStart({ focalX: 0, focalY: 0 }); g.onUpdate({ focalX: 0, focalY: 0, scale: factor }); g.onEnd(); tree = h.render(Component, props); };
    const initial = snapshot(); verify(initial, 1); assert.equal(initial.starts.length, 1); assert.match(text(tree), /不明 69件/);
    pinch(5); const zoomed = snapshot(); verify(zoomed, 5); assert.ok(zoomed.badges.length > initial.badges.length, '拡大で番号が復帰する'); assert.deepEqual(zoomed.rows, initial.rows); assert.deepEqual(geometry(zoomed), geometry(initial));
    pinch(.2); const reduced = snapshot(); verify(reduced, 1); assert.equal(reduced.badges.length, initial.badges.length); assert.deepEqual(reduced.rows, initial.rows); assert.deepEqual(geometry(reduced), geometry(initial));
    props = { ...props, highlightCircleId: 1 }; tree = h.render(Component, props);
    const selectedStart = snapshot(); verify(selectedStart, 1); assert.ok(selectedStart.badges.some(n => text(n) === '1')); assert.equal(selectedStart.starts.length, 0);
    props = { ...props, highlightCircleId: 69 }; tree = h.render(Component, props);
    assert.deepEqual([...new Set(pinLayers())].sort((a, b) => a - b), [1, 100]);
    assert.ok(byId('route-overlay').props.style[1].zIndex > 100);
    const selectedEnd = snapshot(); verify(selectedEnd, 1); assert.ok(selectedEnd.badges.some(n => text(n) === '69')); assert.equal(selectedEnd.starts.length, 1);
    find(tree, n => n.type === 'Pressable' && text(n) === '閉じる')[0].props.onPress(); tree = h.render(Component, props); assert.equal(find(tree, n => n.type === 'Modal')[0].props.visible, false);
    openInfo(); assert.equal(find(tree, n => n.type === 'Modal')[0].props.visible, true);
    find(tree, n => n.type === 'Modal')[0].props.onRequestClose(); tree = h.render(Component, props); assert.equal(find(tree, n => n.type === 'Modal')[0].props.visible, false);
    openInfo(); assert.deepEqual(snapshot().rows, initial.rows);
    props = { ...props, routeEnabled: false }; tree = h.render(Component, props); assert.equal(byId('route-overlay'), undefined); assert.deepEqual([...new Set(pinLayers())].sort((a, b) => a - b), [1, 100]); assert.equal(snapshot().badges.length, 0); assert.equal(snapshot().dots.length, 0); assert.equal(snapshot().segments.length, 0);
    props = { ...props, routeEnabled: true };
    props = { ...props, circles: [circle(1, 1, 15), circle(2, 1, 10), circle(3, 2, 15)], highlightCircleId: null }; tree = h.render(Component, props);
    props = { ...props, parentPriorityFilter: new Set([15]) }; tree = h.render(Component, props);
    assert.match(text(tree), /表示中の候補 1件/);
    props = { ...props, parentPriorityFilter: new Set(), parentStatusFilter: new Set([2]) }; tree = h.render(Component, props);
    assert.match(text(tree), /表示中の候補 0件/);
    props = { ...props, parentStatusFilter: new Set() }; tree = h.render(Component, props);
    find(tree, n => n.type === 'Pressable' && text(n) === 'マップ 2')[0].props.onPress(); tree = h.render(Component, props); loadImage();
    assert.match(text(tree), /表示中の候補 1件/);
    props = { ...props, maps: [...maps, { id: 4, eventId: 1, mapNumber: 2, filename: 'duplicate' }] }; tree = h.render(Component, props);
    assert.match(text(tree), /同じ地図番号の画像が複数/);
    assert.match(text(tree), /地図・座標不明 1件/);
    props = { ...props, maps, routeEnabled: false }; tree = h.render(Component, props);
    assert.match(text(tree), /読み込み/);

  } finally { h.unmount(); delete require.cache[componentPath]; Module._load = originalLoad; }
}
module.exports = { runRecommendedRouteUiTests };
