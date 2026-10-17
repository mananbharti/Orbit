import { BackButton } from '../components/BackButton';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { InputApi, InputKey, KeyboardMacro, MacroStep } from '@orbit/core';
import { friendlyError } from '../orbit';
import { gyroAvailable, startGyroMouse } from '../gyro';
import { radius, space, useTheme } from '../theme';

const SPEED = 1.6;
const KEYS: { key: InputKey; label: string }[] = [{ key: 'escape', label: 'Esc' }, { key: 'tab', label: 'Tab' }, { key: 'backspace', label: '⌫' },
  { key: 'enter', label: 'Return' }, { key: 'left', label: '←' }, { key: 'up', label: '↑' }, { key: 'down', label: '↓' }, { key: 'right', label: '→' }];
const MODS: { key: NonNullable<MacroStep['modifiers']>[number]; label: string }[] = [{ key: 'ctrl', label: 'Ctrl' }, { key: 'shift', label: 'Shift' }, { key: 'alt', label: 'Alt' }, { key: 'meta', label: 'Win' }];
const MACRO_KEYS: InputKey[] = [...'abcdefghijklmnopqrstuvwxyz'.split(''), ...'0123456789'.split(''),
  'enter', 'tab', 'escape', 'space', 'backspace', 'delete', 'up', 'down', 'left', 'right',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'] as InputKey[];
function chordLabel(step: MacroStep): string { return [...(step.modifiers ?? []).map(m => MODS.find(x => x.key === m)!.label), step.key.toUpperCase()].join('+'); }

export function RemoteScreen({ api, onBack }: { api: InputApi; onBack: () => void }) {
  const t = useTheme();
  const state = useSyncExternalStore(api.subscribe, api.getState);
  const [error, setError] = useState<string>();
  const [typed, setTyped] = useState('');
  const [macros, setMacros] = useState<KeyboardMacro[]>([]);
  const [running, setRunning] = useState<string>();
  const [gyro, setGyro] = useState(false);
  const [gyroSupported, setGyroSupported] = useState(false);
  const [composing, setComposing] = useState<{ name: string; steps: MacroStep[]; mods: Set<MacroStep['modifiers'] extends (infer M)[] | undefined ? M : never>; key: InputKey } | null>(null);

  const runMacro = async (macro: KeyboardMacro): Promise<void> => {
    setRunning(macro.id); setError(undefined);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try { await api.runMacro(macro); } catch (e) { setError(friendlyError(e)); }
    finally { setRunning(undefined); }
  };
  const manageMacro = (macro: KeyboardMacro): void => {
    Alert.alert(macro.name, macro.steps.map(chordLabel).join('  then  '), [
      { text: 'Delete macro', style: 'destructive', onPress: () => { void api.deleteMacro(macro.id).then(setMacros).catch(e => setError(friendlyError(e))); } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };
  const saveMacro = async (): Promise<void> => {
    if (!composing || !composing.name.trim() || !composing.steps.length) return;
    setError(undefined);
    try {
      setMacros(await api.saveMacro(composing.name.trim(), composing.steps));
      setComposing(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) { setError(friendlyError(e)); }
  };
  const last = useRef({ x: 0, y: 0, moved: false });
  const scrollLast = useRef(0);
  const active = state.status === 'active';
  useEffect(() => { if (active) void api.macros().then(setMacros).catch(() => {}); }, [api, active]);
  useEffect(() => { void gyroAvailable().then(setGyroSupported); }, []);
  useEffect(() => {
    if (!gyro || !active) return;
    const stop = startGyroMouse((dx, dy) => { try { api.push({ t: 'move', dx, dy }); } catch { /* session ended */ } });
    return stop;
  }, [gyro, active, api]);
  useEffect(() => { if (!active) setGyro(false); }, [active]);

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
          <View {...(gyro ? {} : pad.panHandlers)} accessibilityLabel="Trackpad" style={[styles.pad, { backgroundColor: t.card }]}>
            <Text style={{ color: t.sub }}>{gyro ? 'Tilt the phone to move the pointer' : 'Drag to move · tap to click'}</Text>
            {gyro ? <Text style={{ color: t.tint, fontSize: 13, marginTop: 4 }}>Gyro on</Text> : null}
          </View>
          <View style={styles.row}>
            <View {...scroll.panHandlers} accessibilityLabel="Scroll" style={[styles.scroll, { backgroundColor: t.card }]}><Text style={{ color: t.sub }}>Scroll</Text></View>
            <Pressable accessibilityRole="button" onPress={guard(() => api.push({ t: 'button', button: 'left', action: 'click' }))} style={[styles.key, { backgroundColor: t.fill }]}><Text style={{ color: t.text }}>Left click</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={guard(() => api.push({ t: 'button', button: 'right', action: 'click' }))} style={[styles.key, { backgroundColor: t.fill }]}><Text style={{ color: t.text }}>Right click</Text></Pressable>
            {gyroSupported ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Toggle gyro mouse" onPress={() => { setGyro(on => !on); void Haptics.selectionAsync(); }}
                style={[styles.key, { backgroundColor: gyro ? t.tint : t.fill }]}>
                <Text style={{ color: gyro ? '#fff' : t.text }}>Gyro</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.row}>
            {KEYS.map(k => <Pressable key={k.key} accessibilityRole="button" onPress={guard(() => api.push({ t: 'key', key: k.key }))} style={[styles.key, { backgroundColor: t.fill }]}><Text style={{ color: t.text }}>{k.label}</Text></Pressable>)}
          </View>
          <Text style={{ color: t.sub, fontSize: 13, fontWeight: '600' }}>MACROS</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s }}>
            {macros.map(macro => (
              <Pressable key={macro.id} accessibilityRole="button" accessibilityLabel={`Run macro ${macro.name}`} disabled={!!running}
                onPress={() => { void runMacro(macro); }} onLongPress={() => manageMacro(macro)}
                style={[styles.macroChip, { backgroundColor: t.tint + '1f', opacity: running && running !== macro.id ? 0.5 : 1 }]}>
                <Text style={{ color: t.tint, fontSize: 15, fontWeight: '600' }}>{running === macro.id ? 'Running…' : macro.name}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" accessibilityLabel="New macro" onPress={() => setComposing({ name: '', steps: [], mods: new Set(), key: 'v' })}
              style={[styles.macroChip, { backgroundColor: t.fill }]}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>+ Macro</Text>
            </Pressable>
          </ScrollView>
          {composing ? (
            <View style={[styles.composer, { backgroundColor: t.card }]}>
              <TextInput value={composing.name} onChangeText={name => setComposing({ ...composing, name })} placeholder="Macro name (e.g. Paste plain)" placeholderTextColor={t.sub}
                maxLength={40} style={{ color: t.text, fontSize: 16, padding: space.s, backgroundColor: t.fill, borderRadius: 10 }} accessibilityLabel="Macro name" />
              <View style={styles.row}>
                {MODS.map(m => {
                  const on = composing.mods.has(m.key);
                  return <Pressable key={m.key} accessibilityRole="button" onPress={() => { const mods = new Set(composing.mods); if (on) mods.delete(m.key); else mods.add(m.key); setComposing({ ...composing, mods }); }}
                    style={[styles.key, { backgroundColor: on ? t.tint : t.fill }]}><Text style={{ color: on ? '#fff' : t.text }}>{m.label}</Text></Pressable>;
                })}
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {MACRO_KEYS.map(k => (
                  <Pressable key={k} accessibilityRole="button" onPress={() => setComposing({ ...composing, key: k })}
                    style={[styles.macroKey, { backgroundColor: composing.key === k ? t.tint : t.fill }]}>
                    <Text style={{ color: composing.key === k ? '#fff' : t.text, fontSize: 14, fontWeight: '600' }}>{k.toUpperCase()}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Pressable accessibilityRole="button" onPress={() => setComposing({ ...composing, steps: [...composing.steps, { key: composing.key, ...(composing.mods.size ? { modifiers: [...composing.mods] } : {}) }].slice(0, 8) })}
                style={[styles.macroChip, { backgroundColor: t.fill, alignSelf: 'flex-start' }]}>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>+ Add step: {chordLabel({ key: composing.key, modifiers: [...composing.mods] })}</Text>
              </Pressable>
              {composing.steps.length ? (
                <View style={styles.row}>
                  {composing.steps.map((step, i) => (
                    <Pressable key={i} accessibilityRole="button" accessibilityLabel={`Remove step ${chordLabel(step)}`} onPress={() => setComposing({ ...composing, steps: composing.steps.filter((_, j) => j !== i) })}
                      style={[styles.macroChip, { backgroundColor: t.fill }]}>
                      <Text style={{ color: t.text, fontSize: 14 }}>{chordLabel(step)}  ×</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <View style={styles.row}>
                <Pressable accessibilityRole="button" disabled={!composing.name.trim() || !composing.steps.length} onPress={() => { void saveMacro(); }}
                  style={[styles.macroChip, { backgroundColor: composing.name.trim() && composing.steps.length ? t.tint : t.fill }]}>
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Save macro</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => setComposing(null)} style={[styles.macroChip, { backgroundColor: t.fill }]}>
                  <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
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
  macroChip: { borderRadius: 18, paddingVertical: 9, paddingHorizontal: 14 },
  macroKey: { borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  composer: { borderRadius: radius, padding: space.m, gap: space.s },
});
