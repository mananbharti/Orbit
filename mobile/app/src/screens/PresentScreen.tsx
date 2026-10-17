/** Presentation remote: slide keys, black/white screen, and a laser pad (Ctrl+drag) inside an approved control session. */
import { BackButton } from '../components/BackButton';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import type { InputApi, InputKey } from '@orbit/core';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

export function PresentScreen({ api, onBack }: { api: InputApi; onBack: () => void }) {
  const t = useTheme();
  const state = useSyncExternalStore(api.subscribe, api.getState);
  const [error, setError] = useState<string>();
  const active = state.status === 'active';
  const laserHeld = useRef(false);
  const laserLast = useRef({ x: 0, y: 0 });

  useEffect(() => () => { void api.end(); }, [api]);

  const start = async (): Promise<void> => {
    setError(undefined);
    try { await api.begin(); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }
    catch (e) { setError(e instanceof Error && e.message === 'BIOMETRIC_REQUIRED' ? 'Your computer did not approve control. Confirm on the computer and try again.' : friendlyError(e)); }
  };
  const key = (k: InputKey) => () => {
    try { api.push({ t: 'key', key: k }); void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }
    catch (e) { setError(friendlyError(e)); }
  };

  // PowerPoint (and most decks) read Ctrl + left-drag as the laser pointer during a slideshow.
  const laser = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      try {
        api.push({ t: 'key', key: 'v', modifiers: ['ctrl'], action: 'down' }); // any letter with ctrl held keeps the modifier down; v is unused by decks
        api.push({ t: 'button', button: 'left', action: 'down' });
        laserHeld.current = true;
        laserLast.current = { x: 0, y: 0 };
      } catch (e) { setError(friendlyError(e)); }
    },
    onPanResponderMove: (_, gesture) => {
      if (!laserHeld.current) return;
      const dx = gesture.dx - laserLast.current.x, dy = gesture.dy - laserLast.current.y;
      laserLast.current = { x: gesture.dx, y: gesture.dy };
      try { api.push({ t: 'move', dx, dy }); } catch { /* session ended mid-drag */ }
    },
    onPanResponderRelease: () => {
      if (!laserHeld.current) return;
      laserHeld.current = false;
      try { api.push({ t: 'button', button: 'left', action: 'up' }); api.push({ t: 'key', key: 'v', modifiers: ['ctrl'], action: 'up' }); } catch { /* released on end */ }
    },
  }), [api]);

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Present</Text>
      {!active ? (
        <>
          <Text style={{ color: t.sub, fontSize: 15 }}>Drive your slides from the stage: next and previous slide, start and end the deck, black out the screen, and a laser pointer. Your computer asks its owner to approve first.</Text>
          <Pressable accessibilityRole="button" disabled={state.status === 'waiting'} onPress={() => { void start(); }} style={[styles.button, { backgroundColor: t.tint }]}>
            <Text style={styles.buttonText}>{state.status === 'waiting' ? 'Waiting for approval on your computer…' : 'Start presenting'}</Text>
          </Pressable>
          {state.status === 'ended' && state.error ? <Text style={{ color: t.warn, fontSize: 15 }}>Control ended: {state.error}</Text> : null}
        </>
      ) : (
        <>
          <View {...laser.panHandlers} accessibilityLabel="Laser pointer pad" style={[styles.laser, { backgroundColor: t.card }]}>
            <Text style={{ color: t.sub }}>Touch and drag for the laser pointer</Text>
          </View>
          <View style={styles.navRow}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous slide" onPress={key('left')} style={[styles.nav, { backgroundColor: t.fill }]}>
              <Text style={[styles.navGlyph, { color: t.text }]}>‹</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Next slide" onPress={key('right')} style={[styles.nav, { backgroundColor: t.tint }]}>
              <Text style={[styles.navGlyph, { color: '#FFFFFF' }]}>›</Text>
            </Pressable>
          </View>
          <View style={styles.row}>
            <Pressable accessibilityRole="button" onPress={key('f5')} style={[styles.action, { backgroundColor: t.fill }]}><Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>Start deck</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={key('b')} style={[styles.action, { backgroundColor: t.fill }]}><Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>Black screen</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={key('w')} style={[styles.action, { backgroundColor: t.fill }]}><Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>White screen</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={key('escape')} style={[styles.action, { backgroundColor: t.fill }]}><Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>End deck</Text></Pressable>
          </View>
          <Pressable accessibilityRole="button" onPress={() => { void api.end(); }}><Text style={{ color: t.bad, fontSize: 17, textAlign: 'center' }}>Stop presenting</Text></Pressable>
        </>
      )}
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  button: { paddingVertical: 14, borderRadius: radius, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  laser: { flex: 1, borderRadius: radius, alignItems: 'center', justifyContent: 'center' },
  navRow: { flexDirection: 'row', gap: space.m },
  nav: { flex: 1, height: 120, borderRadius: radius, alignItems: 'center', justifyContent: 'center' },
  navGlyph: { fontSize: 64, fontWeight: '300', marginTop: -6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  action: { paddingHorizontal: space.l, paddingVertical: 12, borderRadius: radius },
});
