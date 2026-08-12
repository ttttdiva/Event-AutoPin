const tintColorLight = '#2196f3';
const tintColorDark = '#64b5f6';

const Colors = {
  light: {
    text: '#333',
    textSecondary: '#888',
    background: '#fff',
    backgroundSecondary: '#f5f5f5',
    tint: tintColorLight,
    tabIconDefault: '#ccc',
    tabIconSelected: tintColorLight,
    card: '#fff',
    border: '#e0e0e0',
    inputBackground: '#fafafa',
    checked: '#4caf50',
    danger: '#e53935',
  },
  dark: {
    text: '#f0f0f0',
    textSecondary: '#aaa',
    background: '#1a1a2e',
    backgroundSecondary: '#222240',
    tint: tintColorDark,
    tabIconDefault: '#666',
    tabIconSelected: tintColorDark,
    card: '#252540',
    border: '#3a3a5c',
    inputBackground: '#2d2d4a',
    checked: '#66bb6a',
    danger: '#ef5350',
  },
};

export type ThemeColors = typeof Colors.light;

export function getColors(scheme: 'light' | 'dark' | null | undefined): ThemeColors {
  return Colors[scheme ?? 'light'];
}

export default Colors;
