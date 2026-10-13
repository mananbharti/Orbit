import { useEffect, useRef, type ReactNode } from 'react';
import { AccessibilityInfo, Animated } from 'react-native';

/** Fades and lifts a screen in when it appears. Skipped when the phone's Reduce Motion setting is on. */
export function ScreenTransition({ children }: { children: ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(reduce => {
      if (!live) return;
      if (reduce) v.setValue(1); else Animated.timing(v, { toValue: 1, duration: 240, useNativeDriver: true }).start();
    }, () => v.setValue(1));
    return () => { live = false; };
  }, [v]);
  return <Animated.View style={{ flex: 1, opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>{children}</Animated.View>;
}
