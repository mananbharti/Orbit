import { useColorScheme } from 'react-native';

const light = { bg: '#F2F2F7', card: '#FFFFFF', text: '#000000', sub: '#6C6C70', line: '#E5E5EA', tint: '#007AFF',
  good: '#34C759', warn: '#FF9500', bad: '#FF3B30', fill: '#E9E9EB' };
const dark: typeof light = { bg: '#000000', card: '#1C1C1E', text: '#FFFFFF', sub: '#8E8E93', line: '#38383A', tint: '#0A84FF',
  good: '#30D158', warn: '#FF9F0A', bad: '#FF453A', fill: '#2C2C2E' };

export type Theme = typeof light;
export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);
export const radius = 14;
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 };
