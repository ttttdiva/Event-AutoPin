import {
  getPriorityRowTheme, getRowStatusColors, mixRowColor,
  PRIORITY_ROW_THEME, ROW_STATUS_COLORS, type RowScheme,
} from './priority-row-theme';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function runPriorityRowThemeTests() {
  const req = eval('require') as (id: string) => any;
  const fs = req('node:fs');
  const path = req('node:path');
  const Buffer = req('node:buffer').Buffer;
  const appRoot = path.resolve(path.dirname(eval('__filename')), '..');
  const desktopCss = fs.readFileSync(path.join(appRoot, '../desktop-app/src/styles.css'), 'utf8');
  const source = fs.readFileSync(path.join(appRoot, 'components/CircleRow.tsx'), 'utf8');
  const manifest = fs.readFileSync(path.join(appRoot, '../scripts/public-sync-manifest.txt'), 'utf8');
  const priorities = ['#0277bd', '#2e7d32', '#f57f17', '#c62828', '#ffffff', '#000000', '#123456', '#ff00ff'];
  // カスタム配色の極端な明度・色相でも文字が読めることを確認する。
  for (const r of [0, 64, 128, 192, 255]) {
    for (const g of [0, 64, 128, 192, 255]) {
      for (const b of [0, 64, 128, 192, 255]) {
        priorities.push('#' + [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join(''));
      }
    }
  }
  let checks = 0;
  for (const scheme of ['light', 'dark'] as RowScheme[]) {
    const theme = PRIORITY_ROW_THEME[scheme];
    const block = desktopCss.slice(desktopCss.indexOf(scheme === 'light' ? ':root {' : 'html.dark {')).split('}')[0];
    for (const [token, expected] of Object.entries({
      base: theme.base, 'start-rest': `${theme.start * 100}%`, 'end-rest': `${theme.end * 100}%`,
      'start-hover': `${theme.hoverStart * 100}%`, 'end-hover': `${theme.hoverEnd * 100}%`,
      text: theme.text, secondary: theme.secondary, 'ink-base': theme.inkBase,
    })) {
      assert(block.includes(`--priority-row-${token}: ${expected};`), `${scheme}: PC/モバイルの${token}が一致すること`);
    }
    for (const priority of priorities) {
      const row = getPriorityRowTheme(priority, scheme);
      const svg = Buffer.from(row.gradientUri.split(',')[1], 'base64').toString('utf8');
      assert(svg.startsWith('<svg ') && svg.endsWith('</svg>'), 'SVGが完全なbase64 data URIであること');
      assert((svg.match(/<stop /g) ?? []).length === 2, '単色の短冊ではなく連続補間の両端だけを定義すること');
      assert(svg.includes(`offset="0%" stop-color="${row.start}"`) && svg.includes(`offset="100%" stop-color="${row.end}"`), '背景が右端まで連続すること');
      assert(!svg.includes('stop-opacity') && !svg.includes('transparent'), '背景の薄めすぎにつながる二重透過がないこと');
      assert(row.start === mixRowColor(priority, theme.start, theme.base) && row.end === mixRowColor(priority, theme.end, theme.base), '設定した優先度色を背景へ反映すること');
      for (const active of [false, true]) {
        const start = mixRowColor(priority, active ? theme.hoverStart : theme.start, theme.base);
        const end = mixRowColor(priority, active ? theme.hoverEnd : theme.end, theme.base);
        for (const position of [0, 0.24, 0.44, 0.52, 0.56, 0.75, 1]) {
          const background = mixRowColor(end, position, start);
          for (const foreground of [row.text, row.secondary, row.ink]) {
            const ratio = contrast(foreground, background);
            assert(ratio >= 4.5, `${scheme} ${priority} ${position}: 文字のコントラスト ${ratio.toFixed(3)} >= 4.5`);
            checks++;
          }
        }
      }
    }
    for (let status = 0; status < 4; status++) {
      const colors = getRowStatusColors(status, scheme);
      assert(contrast(colors.foreground, colors.background) >= 4.5, '全購入状態のボタン文字が読めること');
      assert(block.includes(`--circle-status-${status}-bg: ${colors.background};`) && block.includes(`--circle-status-${status}-ink: ${colors.foreground};`), 'PC/モバイルの状態色が一致すること');
      assert(colors === ROW_STATUS_COLORS[scheme][status], '状態番号の意味を維持すること');
    }
    assert(getRowStatusColors(-1, scheme) === ROW_STATUS_COLORS[scheme][0], '不明な状態は未購入の表示へ戻すこと');
    assert(getPriorityRowTheme('invalid', scheme).gradientUri === getPriorityRowTheme('#0277bd', scheme).gradientUri, '無効な色は既定色へ戻すこと');
    assert(getPriorityRowTheme(' #ABCDEF ', scheme).gradientUri === getPriorityRowTheme('#abcdef', scheme).gradientUri, '大文字と空白を正規化すること');
  }
  assert(mixRowColor('#ffffff', 2, '#000000') === '#ffffff', '重みの上限を守ること');
  assert(mixRowColor('#ffffff', -1, '#000000') === '#000000', '重みの下限を守ること');
  assert(mixRowColor('#ffffff', NaN, '#000000') === '#000000', '非有限の重みを安全に処理すること');
  assert(!/priorityTint(?:Strong|Mid|Soft)|priorityMeter|rowOpacity|opacity:/.test(source), '短冊・段付きメーター・行全体の透過が戻らないこと');
  assert(source.includes('getPriorityRowTheme(priority.color, effectiveScheme)') && source.includes('[priority.color, effectiveScheme]'), 'テーマ変更とカスタム色変更で再計算すること');
  assert(source.includes('source={{ uri: surface.gradientUri }}') && source.includes('contentFit="fill"') && source.includes('decodeFormat="argb"'), '実コンポーネントが全幅・32bitの連続グラデーションを使うこと');
  assert(source.includes('pointerEvents="none"') && source.includes('accessible={false}') && source.includes('recyclingKey={surface.gradientUri}'), '背景が操作や読み上げを遮らず、再利用時に旧色を残さないこと');
  assert(source.includes('textDecorationLine: \'line-through\'') && source.includes('onCyclePurchaseStatus(circle.id)') && source.includes('onPurchaseStatusMenu?.(circle)'), '購入済み表現と既存タップ・長押し操作を維持すること');
  const rowCss = desktopCss.slice(desktopCss.indexOf('  /* サークル行:'), desktopCss.indexOf('  /* 画像セル */'));
  assert(!rowCss.includes('transparent 52%') && rowCss.includes(' 100%'), 'PCでも途中でグラデーションを打ち切らないこと');
  assert(rowCss.includes('.circle-row:focus-within') && rowCss.includes('.circle-row.expanded'), 'フォーカス・展開時も優先度の配色を維持すること');
  assert(rowCss.includes('background: transparent !important;'), '購入操作のセル背景でグラデーションを分断しないこと');
  for (const file of ['shopping-app/lib/priority-row-theme.ts', 'shopping-app/lib/priority-row-theme.test.ts', 'docs/circle-row-appearance.md']) {
    assert(manifest.split('\n').includes(file), `${file}が公開用同期から欠落しないこと`);
  }
  console.log(`サークル行: ${checks}件の文字コントラスト、8状態配色、SVGとPC/モバイルの接続を検証しました`);
}
