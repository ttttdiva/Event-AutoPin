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
  const pathMod = req('node:path');
  let scheme: 'light' | 'dark' = 'light';
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'react-native') return {
      View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', ScrollView: 'ScrollView',
      StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
      LayoutAnimation: { configureNext() {}, Presets: { easeInEaseOut: {} } },
    };
    if (request === '@/components/KeyboardLayout') return { InputTextInput: 'TextInput' };
    if (request === '@expo/vector-icons/FontAwesome') return 'Icon';
    if (request === '@/constants/Colors') return { getColors };
    if (request === '@/lib/types') return types;
    if (request === '@/lib/priority-colors') return priorityColors;
    if (request === '@/lib/high-priority-progress') {
      return originalLoad.call(
        this,
        pathMod.resolve(pathMod.dirname(eval('__filename')), 'high-priority-progress.ts'),
        parent,
        isMain,
      );
    }
    if (request === '@/lib/theme-context') return { useTheme: () => ({ effectiveScheme: scheme }) };
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
      onSortChange(value: string) { props.sortBy = value; render(); },
      onTogglePriorityFilter(value: number) {
        const next = new Set(props.priorityFilter);
        if (next.has(value)) next.delete(value); else next.add(value);
        props.priorityFilter = next; render();
      },
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
    const chipScroll = tree.root.findByType('ScrollView');
    const style = Object.assign({}, ...[chipScroll.props.style].flat(Infinity));
    assert(style.flexShrink === 0 && style.flexGrow === 0 && style.height == null && style.maxHeight == null,
      '横スクロール行は内容の高さを保ち、小画面・文字拡大でも親の縦スクロール内で潰れないこと');
    assert(chipScroll.props.keyboardShouldPersistTaps === 'handled', 'IME表示中も最初のタップでフィルターを操作できること');
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
    click('お気に入り順'); click('通常'); click('おしながき'); click('漫画'); click('西');
    assert(props.sortBy === 'favorite' && props.priorityFilter.has(5) && props.catalogPostOnly
      && props.genreFilter === '漫画' && props.hallFilter === '西', '横スクロール後方の条件も操作できること');
    click('フィルター解除');
    assert(props.sortBy === 'favorite' && props.priorityFilter.size === 0 && !props.catalogPostOnly
      && props.genreFilter === null && props.hallFilter === null, '解除で全条件を消し、並べ替えを維持すること');

    const flatten = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
    const progressText = () => tree.root.findAllByType('Text').find((node: any) =>
      typeof node.props.accessibilityLabel === 'string'
      && node.props.accessibilityLabel.startsWith('高・最優先'),
    );
    const progressBar = () => tree.root.findAll((node: any) => node.props?.accessibilityRole === 'progressbar')[0];
    const progressFill = () => {
      const bar = progressBar();
      return bar.findAllByType('View').find((node: any) => node !== bar);
    };
    const assertTheme = (current: 'light' | 'dark') => {
      const colors = getColors(current);
      assert(flatten(progressText().props.style).color === colors.textSecondary, `${current}: 進捗テキスト色`);
      assert(flatten(progressBar().props.style).backgroundColor === colors.border, `${current}: バートラック色`);
      assert(flatten(progressFill().props.style).backgroundColor === colors.tint, `${current}: バー塗り色`);
    };
    for (const current of ['light', 'dark'] as const) {
      scheme = current;
      act(() => { render(); });
      assertTheme(current);
    }
    scheme = 'light';
    act(() => { render(); });

    props.stats = { totalCircles: 36, boughtCircles: 1 };
    props.isShoppingMode = true;
    act(() => { render(); });
    assert(text(tree.root).includes('1/36'), '買えた/全件のミニ件数が残ること');
    assert(text(tree.root).includes('買い物中'), '買い物中バッジが残ること');
    const badge = tree.root.findAllByType('View').find((node: any) => flatten(node.props.style).backgroundColor === '#e65100');
    assert(badge, '買い物badge背景は #e65100 のまま');
    const expandBtn = tree.root.findAllByType('Pressable').find((node: any) =>
      node.findAllByType('Icon').some((icon: any) => icon.props.name === 'filter' || icon.props.name === 'chevron-up'),
    );
    const expandStyle = flatten(expandBtn.props.style);
    assert(expandStyle.width === 32 && expandStyle.height === 32, 'expandBtn は 32×32');
    const topRow = tree.root.findAllByType('View').find((node: any) => {
      const s = flatten(node.props.style);
      return s.flexDirection === 'row' && s.flexWrap === 'wrap' && s.alignItems === 'center' && s.paddingHorizontal === 12;
    });
    assert(topRow, 'topRow があること');
    assert(flatten(topRow.props.style).paddingVertical === 8, 'topRow の paddingVertical は 8');

    const slot = tree.root.findAllByType('View').find((node: any) => {
      const s = flatten(node.props.style);
      return s.flex === 1 && s.minWidth === 0 && s.flexShrink === 1;
    });
    assert(slot, '進捗スロットがあること');
    assert(flatten(slot.props.style).overflow === 'hidden', '進捗スロットは overflow hidden');
    assert(progressText().props.numberOfLines === 1, '進捗ラベルは numberOfLines 1');
    assert(flatten(progressText().props.style).flexShrink === 1, '進捗ラベルは flexShrink 1');
    assert(flatten(progressFill().props.style).width === '0%', '未指定/total 0 の塗り幅は 0%');
    assert(flatten(progressFill().props.style).width !== '100%', 'total 0 の塗り幅は 100% ではない');

    props.highPriorityProgress = { done: 3, total: 5, remaining: 2 };
    act(() => { render(); });
    assert(text(tree.root).includes('高・最優先 対応済み 3/5・残り 2'), 'full句が見えること');
    assert(text(tree.root).includes('1/36'), '進捗句とミニ件数は別であること');
    assert(flatten(progressFill().props.style).width === '60%', 'done 3 total 5 の塗り幅は 60%');
    assert(progressText().props.accessibilityLabel === '高・最優先 対応済み 3/5・残り 2', 'a11y は常に full句');
    assert(
      progressBar().props.accessibilityValue.min === 0
      && progressBar().props.accessibilityValue.max === 5
      && progressBar().props.accessibilityValue.now === 3,
      'progressbar の accessibilityValue',
    );
    act(() => { slot.props.onLayout({ nativeEvent: { layout: { width: 220, height: 12 } } }); });
    assert(text(progressText()) === '高・最優先 対応済み 3/5・残り 2', '幅220は full');
    assert(text(progressText()).includes('残り'), '幅220は「残り」が見えること');
    act(() => { slot.props.onLayout({ nativeEvent: { layout: { width: 150, height: 12 } } }); });
    assert(text(progressText()) === '高・最優先 3/5 残2', '幅150は short');
    act(() => { slot.props.onLayout({ nativeEvent: { layout: { width: 60, height: 12 } } }); });
    assert(text(progressText()) === '3/5', '幅60は tiny');
    assert(progressText().props.accessibilityLabel === '高・最優先 対応済み 3/5・残り 2', 'tinyでも a11y は full句');

    props.highPriorityProgress = { done: 0, total: 0, remaining: 0 };
    act(() => { render(); });
    assert(flatten(progressFill().props.style).width === '0%', 'total 0 の塗り幅は 0%');
    assert(flatten(progressFill().props.style).width !== '100%', 'total 0 を 100% にしない');

    props.highPriorityProgress = { done: 4, total: 5, remaining: 1 };
    act(() => { render(); });
    assert(text(progressText()) === '4/5', 'prop更新で文言が変わること');

    const inPressable = tree.root.findAllByType('Pressable').some((node: any) => {
      const label = text(node);
      return label.includes('高・最優先') || label === '4/5' || label === '対象なし' || label === '0/0';
    });
    assert(!inPressable, '進捗テキストは Pressable の中に入れない');

    console.log('フィルター行の高さ・IME中タップ・全条件の選択と解除を検証しました');
  } finally {
    if (tree) act(() => tree.unmount());
    Module._load = originalLoad;
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
}
