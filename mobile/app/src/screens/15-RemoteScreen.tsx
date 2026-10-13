import { BackButton } from '../components/BackButton';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { InputApi, InputKey } from '@orbit/core';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

const SPEED = 1.6;
const KEYS: { key: InputKey; label: string }[] = [{ key: 'escape', label: 'Esc' }, { key: 'tab', label: 'Tab' }, { key: 'backspace', label: '⌫' },
  { key: 'enter', label: 'Return' }, { key: 'left', label: '←' }, { key: 'up', label: '↑' }, { key: 'down', label: '↓' }, { key: 'right', label: '→' }];

export function RemoteScreen({ api, onBack }: { api: InputApi; onBack: () => void }) {
  const t = useTheme();
  const state = useSyncExternalStore(api.subscribe, api.getState);
  const [error, setError] = useState<string>();
  const [typed, setTyped] = useState('');
  const last = useRef({ x: 0, y: 0, moved: false });
  const scrollLast = useRef(0);
  const active = state.status === 'active';

  useEffect(() => () => { void api.end(); }, [api]);

  const start = async (): Promise<void> => {
    setError(undefined);
    try { await api.begin(); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }
    catch (e) { setError(e instanceof Error && e.message === 'BIOMETRIC_REQUIRED' ? 'Your computer did not approve control. Confirm on the computer and try again.' : friendlyError(e)); }
  };
  const pad = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: e => { last.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, moved: false }; },
    onPanResponderMove: e => {
      const { pageX, pageY } = e.nativeEvent;
      const dx = (pageX - last.current.x) * SPEED, dy = (pageY - last.current.y) * SPEED;
      last.current = { x: pageX, y: pageY, moved: last.current.moved || Math.abs(dx) + Math.abs(dy) > 3 };
      if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) api.push({ t: 'move', dx, dy });
    },
    onPanResponderRelease: () => { if (!last.current.moved) { api.push({ t: 'button', button: 'left', action: 'click' }); void Haptics.selectionAsync(); } },
  }), [api]);
  const scroll = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: e => { scrollLast.current = e.nativeEvent.pageY; },
    onPanResponderMove: e => { const dy = e.nativeEvent.pageY - scrollLast.current; scrollLast.current = e.nativeEvent.pageY; if (Math.abs(dy) >= 1) api.push({ t: 'scroll', dx: 0, dy: -dy }); },
  }), [api]);
  const guard = (fn: () => void) => () => { try { fn(); } catch (e) { setError(friendlyError(e)); } };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Remote control</Text>
      {!active ? (
        <>
          <Text style={{ color: t.sub, fontSize: 15 }}>Use this phone as a trackpad and keyboard. Your computer asks its owner to approve every session, and control stops if the connection drops.</Text>
          <Pressable accessibilityRole="button" disabled={state.status === 'waiting'} onPress={() => { void start(); }} style={[styles.button, { backgroundColor: t.tint }]}>
            <Text style={styles.buttonText}>{state.status === 'waiting' ? 'Waiting for approval on your computer…' : 'Start controlling'}</Text></Pressable>
          {state.status === 'ended' && state.error ? <Text style={{ color: t.warn, fontSize: 15 }}>Control ended: {state.error}</Text> : null}
        </>
      ) : (
        <>
          <View {...pad.panHandlers} accessibilityLabel="Trackpad" style={[styles.pad, { backgroundColor: t.card }]}><Text style={{ color: t.sub }}>Drag to move · tap to click</Text></View>
          <View style={styles.row}>
            <View {...scroll.panHandlers} accessibilityLabel="Scroll" style={[styles.scroll, { backgroundColor: t.card }]}><Text style={{ color: t.sub }}>Scroll</Text></View>
            <Pressable accessibilityRole="button" onPress={guard(() => api.push({ t: 'button', button: 'left', action: 'click' }))} style={[styles.key, { backgroundColor: t.fill }]}><Text style={{ color: t.text }}>Left click</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={guard(() => api.push({ t: 'button', button: 'right', action: 'click' }))} style={[styles.key, { backgroundColor: t.fill }]}><Text style={{ color: t.text }}>Right click</Text></Pressable>
          </View>
          <View style={styles.row}>
            {KEYS.map(k => <Pressable key={k.key} accessibilityRole="button" onPress={guard(() => api.push({ t: 'key', key: k.key }))} style={[styles.key, { backgroundColor: t.fill }]}><Text style={{ color: t.text }}>{k.label}</Text></Pressable>)}
          </View>
          <TextInput value={typed} onChangeText={v => { if (v.length > typed.length) guard(() => api.push({ t: 'text', text: v.slice(typed.length) }))(); setTyped(v.length > 40 ? '' : v); }}
            placeholder="Type to send keystrokes" placeholderTextColor={t.sub} autoCorrect={false} autoCapitalize="none"
            style={{ color: t.text, fontSize: 17, padding: space.m, backgroundColor: t.card, borderRadius: radius }} accessibilityLabel="Keyboard" />
          <Pressable accessibilityRole="button" onPress={() => { void api.end(); }}><Text style={{ color: t.bad, fontSize: 17, textAlign: 'center' }}>Stop controlling</Text></Pressable>
        </>
      )}
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  pad: { flex: 1, borderRadius: radius, alignItems: 'center', justifyContent: 'center' },
  scroll: { width: 70, height: 56, borderRadius: radius, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  key: { paddingHorizontal: space.l, paddingVertical: 14, borderRadius: radius },
  button: { paddingVertical: 14, borderRadius: radius, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});
