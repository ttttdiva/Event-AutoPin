import { inputScrollDelta } from './input-scroll-layout';

export function runKeyboardViewportTests() {
  const req = eval('require') as (id: string) => any;
  const React = req('react');
  const { create, act } = req('react-test-renderer');
  const Module = req('node:module'), original = Module._load;
  const listeners = new Map<string, Set<(event: any) => void>>();
  let visible = false;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Module._load = function(request: string, parent: unknown, isMain: boolean) {
    if (request === '@/lib/input-scroll-layout') return { inputScrollDelta };
    if (request === 'react-native') return {
      View: 'View', TextInput: 'TextInput', ScrollView: 'ScrollView', Modal: 'Modal',
      Dimensions: { get: () => ({ height: 800 }), addEventListener: () => ({ remove() {} }) },
      Keyboard: {
        isVisible: () => visible, metrics: () => visible ? { screenY: 500 } : undefined,
        addListener: (name: string, callback: (event: any) => void) => {
          const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set);
          return { remove: () => set.delete(callback) };
        },
      },
    };
    return original.call(this, request, parent, isMain);
  };
  let tree: any;
  try {
    const { KeyboardViewport } = req('../components/KeyboardLayout');
    const mount = () => {
      act(() => { tree = create(React.createElement(KeyboardViewport, {}, React.createElement('Content')), {
        createNodeMock: () => ({ measureInWindow: (callback: Function) => callback(0, 0, 400, 800) }),
      }); });
      act(() => tree.root.findAllByType('View')[0].props.onLayout());
    };
    const padding = () => tree.root.findAllByType('View')[1].props.style.paddingBottom;
    const equal = (actual: number, expected: number) => { if (actual !== expected) throw new Error(`IME復元: ${actual} != ${expected}`); };
    mount(); equal(padding(), 0);
    for (let i = 0; i < 5; i++) {
      visible = true;
      act(() => listeners.get('keyboardDidShow')?.forEach((callback) => callback({ endCoordinates: { screenY: 500, height: 300 } })));
      equal(padding(), 300);
      visible = false;
      // Android 17の終了時にシステムバー相当の座標が残っていても0へ戻す。
      act(() => listeners.get('keyboardDidHide')?.forEach((callback) => callback({ endCoordinates: { screenY: 723, height: 77 } })));
      equal(padding(), 0);
    }
    act(() => tree.unmount()); tree = null;
    visible = true; mount(); equal(padding(), 300);
    console.log('IME終了時の余白復元・5回の再表示・表示中のモーダル追加を検証しました');
  } finally {
    if (tree) act(() => tree.unmount());
    Module._load = original;
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
}
