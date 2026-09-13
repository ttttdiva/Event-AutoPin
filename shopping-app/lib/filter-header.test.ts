import { getColors } from '../constants/Colors';
import * as types from './types';
import * as priorityColors from './priority-colors';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** 実ヘッダーのタップ→state更新→再描画を検証。nativeのIME・描画確認とは区別する。 */
export function runFilterHeaderTests() {
  const req = eval('require') as (id: string) => any;
  const React = req('react');
  const { create, act } = req('react-test-renderer');
  const Module = req('node:module');
  const originalLoad = Module._load;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'react-native') return {
      View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', ScrollView: 'ScrollView',
      StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
      LayoutAnimation: { configureNext() {}, Presets: { easeInEaseOut: {} } },
    };
    if (request === '@expo/vector-icons/FontAwesome') return 'Icon';
    if (request === '@/constants/Colors') return { getColors };
    if (request === '@/lib/types') return types;
    if (request === '@/lib/priority-colors') return priorityColors;
    if (request === '@/lib/theme-context') return { useTheme: () => ({ effectiveScheme: 'light' }) };
    if (request === '@/lib/priority-color-context') return { usePriorityColors: () => ({
      options: [{ value: 5, label: '通常', color: '#123456', bgColor: '#eeeeee' }],
      getColor: () => ({ label: '通常', color: '#123456' }),
    }) };
    return originalLoad.call(this, request, parent, isMain);
  };
  let tree: any;
  try {
    const Header = req('../components/CollapsibleHeader').default;
    const props: any = {
      globalSearchEnabled: false, searchQuery: '新刊', statusFilter: new Set([1, 2]),
      priorityFilter: new Set([5]), hallFilter: '東', halls: ['東', '西'], genreFilter: '漫画',
      catalogPostOnly: true, hideSkipped: false, sortBy: 'space', filteredCount: 2, totalCount: 10,
      stats: { totalCircles: 0 }, budget: { totalListPrice: 0 }, isShoppingMode: false,
      onSortChange() {}, onTogglePriorityFilter() {},
    };
    const render = () => tree.update(React.createElement(Header, props));
    for (const [callback, key] of [['onSearchChange', 'searchQuery'], ['onStatusFilterChange', 'statusFilter'],
      ['onHallFilterChange', 'hallFilter'], ['onGenreFilterChange', 'genreFilter'],
      ['onCatalogPostOnlyChange', 'catalogPostOnly'], ['onHideSkippedChange', 'hideSkipped']]) {
      props[callback] = (value: unknown) => { props[key] = value; render(); };
    }
    props.onClearPriorityFilter = () => { props.priorityFilter = new Set(); render(); };
    act(() => { tree = create(React.createElement(Header, props)); });
    const text = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(text).join('');
    const click = (label: string) => {
      const buttons = tree.root.findAllByType('Pressable').filter((node: any) => text(node) === label);
      assert(buttons.length > 0, `${label}ボタンがあること`);
      act(() => buttons[0].props.onPress());
    };
    for (const condition of ['検索: 新刊', '場所: 東', '購入状態: 買えた', '購入状態: 買えなかった', '優先度: 通常', 'ジャンル: 漫画', 'おしながきあり']) {
      assert(text(tree.root).includes(condition), `折りたたみ時にも${condition}が見えること`);
    }
    assert(tree.root.findAllByType('TextInput').length === 0, 'フィルターが初期状態で閉じていること');
    click('フィルター解除');
    assert(!text(tree.root).includes('検索:') && props.statusFilter.size === 0 && props.hallFilter === null && props.priorityFilter.size === 0, '解除で全条件と表示を消すこと');
    const expand = tree.root.findAllByType('Pressable').find((node: any) => node.findAllByType('Icon').some((icon: any) => icon.props.name === 'filter'));
    act(() => expand.props.onPress());
    for (const combo of [['買えた', '買えなかった'], ['未購入', '見送り'], ['買えた', '買えなかった', '見送り']]) {
      click('全て');
      combo.forEach(click);
      assert(props.statusFilter.size === combo.length, '複数状態を保持すること');
      const selected = tree.root.findAllByType('Pressable').filter((node: any) => node.props.accessibilityState?.checked);
      assert(selected.length === combo.length, '各選択ボタンを選択済み表示にすること');
      combo.forEach(click);
      assert(props.statusFilter.size === 0, '最後の選択解除で全状態に戻ること');
    }
    click('見送り非表示'); click('見送り');
    assert(!props.hideSkipped && props.statusFilter.has(3), '見送りの明示選択で非表示を解除すること');
    click('全て');
    assert(!props.hideSkipped && props.statusFilter.size === 0, '全ては見送り非表示も解除すること');
    console.log('フィルターの折りたたみ表示・解除・複数選択・全ての操作を検証しました');
  } finally {
    if (tree) act(() => tree.unmount());
    Module._load = originalLoad;
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
}
