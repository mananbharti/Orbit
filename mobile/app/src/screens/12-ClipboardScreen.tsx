import { BackButton } from '../components/BackButton';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ClipboardApi } from '@orbit/core';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

export function ClipboardScreen({ api, onBack }: { api: ClipboardApi; onBack: () => void }) {
  const t = useTheme();
  const state = useSyncExternalStore(api.subscribe, api.getState);
  const [text, setText] = useState('');
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => { api.start().catch(e => setError(friendlyError(e))); return () => { void api.stop(); }; }, [api]);

  const send = async (value: string): Promise<void> => {
    setError(undefined); setNote(undefined);
    try {
      const result = await api.send(value);
      setNote(result === 'conflict' ? 'The computer copied something at the same time. Nothing was overwritten.' : 'Sent to your computer');
      if (result !== 'conflict') { setText(''); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }
    } catch (e) { setError(friendlyError(e)); }
  };
  const pasteAndSend = async (): Promise<void> => {
    const value = await Clipboard.getStringAsync(); // read only because the user tapped this button
    if (!value) { setNote('Your phone clipboard has no text'); return; }
    await send(value);
  };
  const copyIncoming = async (): Promise<void> => {
    if (!state.incoming) return;
    await Clipboard.setStringAsync(state.incoming.text);
    api.dismissIncoming(); setNote('Copied to this phone'); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Clipboard</Text>
      <Text style={{ color: t.sub, fontSize: 15 }}>Share text with your computer while this screen is open. Orbit never reads your clipboard unless you tap a button.</Text>
      {state.incoming ? (
        <View style={[styles.card, { backgroundColor: t.card }]}>
          <Text style={[styles.label, { color: t.sub }]}>Copied on your computer</Text>
          <Text numberOfLines={6} style={{ color: t.text, fontSize: 16, lineHeight: 21 }}>{state.incoming.text}</Text>
          <Pressable accessibilityRole="button" onPress={() => { void copyIncoming(); }} style={[styles.button, { backgroundColor: t.tint }]}>
            <Text style={styles.buttonText}>Copy to this phone</Text></Pressable>
        </View>
      ) : null}
      {state.blocked ? <Text style={{ color: t.warn, fontSize: 15 }}>{state.blocked === 'oversized' ? 'The computer clipboard is too large to share.' : 'The computer clipboard is not text.'}</Text> : null}
      <View style={[styles.card, { backgroundColor: t.card }]}>
        <Text style={[styles.label, { color: t.sub }]}>Send to your computer</Text>
        <TextInput value={text} onChangeText={setText} multiline placeholder="Type or paste text" placeholderTextColor={t.sub}
          style={{ color: t.text, fontSize: 16, minHeight: 80 }} accessibilityLabel="Text to send" />
        <View style={styles.row}>
          <Pressable accessibilityRole="button" onPress={() => { void pasteAndSend(); }} style={[styles.button, { backgroundColor: t.fill, flex: 1 }]}>
            <Text style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>Paste and send</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={!text} onPress={() => { void send(text); }} style={[styles.button, { backgroundColor: text ? t.tint : t.fill, flex: 1 }]}>
            <Text style={styles.buttonText}>Send</Text></Pressable>
        </View>
      </View>
      {note ? <Text style={{ color: t.good, fontSize: 15 }}>{note}</Text> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  card: { padding: space.l, borderRadius: radius, gap: space.s },
  label: { fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', gap: space.m },
  button: { paddingVertical: 13, borderRadius: radius, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});
