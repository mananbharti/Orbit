import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { loadThemePref, saveThemePref } from './storage';

const light = { isDark: false, bg: '#F2F2F7', card: '#FFFFFF', text: '#000000', sub: '#6C6C70', line: '#E5E5EA', tint: '#007AFF',
  good: '#34C759', warn: '#FF9500', bad: '#FF3B30', fill: '#E9E9EB', glass: 'rgba(255,255,255,0.62)', glassLine: 'rgba(255,255,255,0.7)',
  shadow: '#000000' };
const dark: typeof light = { isDark: true, bg: '#000000', card: '#1C1C1E', text: '#FFFFFF', sub: '#8E8E93', line: '#38383A', tint: '#0A84FF',
  good: '#30D158', warn: '#FF9F0A', bad: '#FF453A', fill: '#2C2C2E', glass: 'rgba(40,40,44,0.58)', glassLine: 'rgba(255,255,255,0.14)',
  shadow: '#000000' };

export type Theme = typeof light;
export type ThemePref = 'auto' | 'light' | 'dark';
const PrefContext = createContext<{ pref: ThemePref; setPref: (p: ThemePref) => void }>({ pref: 'auto', setPref: () => {} });

/** Auto follows the phone's appearance. The choice is remembered on the phone. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>('auto');
  useEffect(() => { void loadThemePref().then(setPrefState); }, []);
  const value = useMemo(() => ({ pref, setPref: (p: ThemePref) => { setPrefState(p); void saveThemePref(p); } }), [pref]);
  return createElement(PrefContext.Provider, { value }, children);
}
export const useThemePref = () => useContext(PrefContext);
export const useTheme = (): Theme => {
  const scheme = useColorScheme();
  const { pref } = useContext(PrefContext);
  return (pref === 'auto' ? scheme === 'dark' : pref === 'dark') ? dark : light;
};
export const radius = 14;
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 };
