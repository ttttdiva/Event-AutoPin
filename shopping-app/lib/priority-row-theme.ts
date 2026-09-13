/** サークル行専用の配色。desktop-app/src/styles.css の行トークンと揃える。 */
export type RowScheme = 'light' | 'dark';

export const PRIORITY_ROW_THEME = {
  light: {
    base: '#ffffff', start: 0.34, end: 0.18,
    hoverStart: 0.38, hoverEnd: 0.22,
    text: '#172033', secondary: '#273449', inkBase: '#000000',
  },
  dark: {
    base: '#111827', start: 0.36, end: 0.22,
    hoverStart: 0.38, hoverEnd: 0.24,
    text: '#f8fafc', secondary: '#f1f5f9', inkBase: '#ffffff',
  },
} as const;

export const ROW_STATUS_COLORS = {
  light: [
    { background: '#f1f5f9', foreground: '#334155' },
    { background: '#dcfce7', foreground: '#166534' },
    { background: '#fee2e2', foreground: '#991b1b' },
    { background: '#f3e8ff', foreground: '#6b21a8' },
  ],
  dark: [
    { background: '#334155', foreground: '#e2e8f0' },
    { background: '#14532d', foreground: '#dcfce7' },
    { background: '#7f1d1d', foreground: '#fee2e2' },
    { background: '#581c87', foreground: '#f3e8ff' },
  ],
} as const;

function normalizedColor(color: string): string {
  const value = color.trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '#0277bd';
}

/** 不透明なsRGB色同士を混ぜる。背景との二重の透明度合成を避ける。 */
export function mixRowColor(color: string, weight: number, base: string): string {
  const w = Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0;
  const from = normalizedColor(color);
  const to = normalizedColor(base);
  return '#' + [1, 3, 5].map((offset) => {
    const channel = Math.round(
      parseInt(from.slice(offset, offset + 2), 16) * w +
      parseInt(to.slice(offset, offset + 2), 16) * (1 - w),
    );
    return channel.toString(16).padStart(2, '0');
  }).join('');
}

// SVGは固定のASCII要素と検証済みの色だけで構成する。
// Androidのdata URIデコーダ用にbase64化し、Bufferやbtoaの有無に依存しない。
function asciiBase64(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < value.length; i += 3) {
    const a = value.charCodeAt(i);
    const b = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
    const c = i + 2 < value.length ? value.charCodeAt(i + 2) : 0;
    result += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)];
    result += i + 1 < value.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
    result += i + 2 < value.length ? alphabet[c & 63] : '=';
  }
  return result;
}

export function getPriorityRowTheme(color: string, scheme: RowScheme) {
  const theme = PRIORITY_ROW_THEME[scheme];
  const priority = normalizedColor(color);
  const start = mixRowColor(priority, theme.start, theme.base);
  const end = mixRowColor(priority, theme.end, theme.base);
  const ink = mixRowColor(priority, 0.35, theme.inkBase);
  // 既存expo-imageのSVG対応を利用。細長い単色Viewを並べず、全幅を補間する。
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="8" viewBox="0 0 1024 8" preserveAspectRatio="none">' +
    '<defs><linearGradient id="row" x1="0%" y1="0%" x2="100%" y2="0%" color-interpolation="sRGB">' +
    `<stop offset="0%" stop-color="${start}"/><stop offset="100%" stop-color="${end}"/>` +
    '</linearGradient></defs><rect width="1024" height="8" fill="url(#row)"/></svg>';
  return {
    start, end, ink, text: theme.text, secondary: theme.secondary,
    gradientUri: 'data:image/svg+xml;base64,' + asciiBase64(svg),
  };
}

export function getRowStatusColors(status: number, scheme: RowScheme) {
  const options = ROW_STATUS_COLORS[scheme];
  return options[status as 0 | 1 | 2 | 3] ?? options[0];
}
