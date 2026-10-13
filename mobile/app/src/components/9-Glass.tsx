import { BlurView } from 'expo-blur';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import { useTheme } from '../theme';

/** A frosted surface. On iOS it blurs what is behind it; where blur is not available the translucent fill still reads as a soft panel. DESIGN NOT YET SEEN ON A DEVICE. */
export function Glass({ children, style, radius = 22, intensity = 50 }: { children?: ReactNode; style?: StyleProp<ViewStyle>; radius?: number; intensity?: number }) {
  const t = useTheme();
  return (
    <View style={[{ borderRadius: radius, overflow: 'hidden', zIndex: 0, backgroundColor: t.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: t.glassLine }, style]}>
      <BlurView pointerEvents="none" intensity={intensity} tint={t.isDark ? 'systemThickMaterialDark' : 'systemThickMaterialLight'} style={[StyleSheet.absoluteFill, { zIndex: -1 }]} />
      {children}
    </View>
  );
}
