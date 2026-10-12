import * as Haptics from 'expo-haptics';
import { useState, useSyncExternalStore } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TaskStore, TaskSummary } from '@orbit/core';
import { StatusPill } from '../components/StatusPill';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

const connectionText = { connected: '', connecting: 'Connecting to your computer…', reconnecting: 'Reconnecting…', stopped: 'Not connected',
  'authentication-required': 'This computer no longer recognises this phone' } as const;

export function TasksScreen({ store, name, onOpen, onRepair, onActivity }: { store: TaskStore; name: string; onOpen: (task: TaskSummary) => void; onRepair: () => void; onActivity: () => void }) {
  const t = useTheme();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const offline = state.connection !== 'connected';

  const send = async (): Promise<void> => {
    if (!prompt.trim() || sending || offline) return;
    setSending(true); setError(undefined);
    try { await store.submit(prompt); setPrompt(''); void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }
    catch (e) { setError(friendlyError(e)); }
    finally { setSending(false); }
  };

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: t.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={[styles.title, { color: t.text }]}>Agent</Text>
      <View style={styles.subRow}>
        <Text style={[styles.sub, { color: t.sub }]}>{name}</Text>
        <Pressable accessibilityRole="button" onPress={onActivity}><Text style={{ color: t.tint, fontSize: 15 }}>Activity</Text></Pressable>
      </View>
      {connectionText[state.connection] ? (
        <Pressable disabled={state.connection !== 'authentication-required'} onPress={onRepair}
          style={[styles.banner, { backgroundColor: t.fill }]}>
          <Text style={{ color: t.text, fontSize: 15 }}>{connectionText[state.connection]}{state.connection === 'authentication-required' ? ' Tap to pair again.' : ''}</Text>
        </Pressable>
      ) : null}
      {state.needsAttention.length ? (
        <Pressable onPress={() => onOpen(state.needsAttention[0]!)} style={[styles.attention, { backgroundColor: t.warn + '26' }]}>
          <Text style={{ color: t.warn, fontWeight: '700', fontSize: 16 }}>{state.needsAttention.length === 1 ? '1 task needs you' : `${state.needsAttention.length} tasks need you`}</Text>
        </Pressable>
      ) : null}
      <FlatList data={state.tasks} keyExtractor={x => x.taskId} contentContainerStyle={{ gap: space.m, paddingBottom: space.xl }}
        ListEmptyComponent={<Text style={[styles.empty, { color: t.sub }]}>Ask your agent to do something. You will see its progress here and approve anything sensitive.</Text>}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" onPress={() => onOpen(item)} style={({ pressed }) => [styles.card, { backgroundColor: t.card, opacity: pressed ? 0.7 : 1 }]}>
            <Text numberOfLines={2} style={[styles.headline, { color: t.text }]}>{item.headline || 'Task'}</Text>
            <StatusPill state={item.state} />
          </Pressable>
        )} />
      {error ? <Text style={{ color: t.bad, marginBottom: space.s }}>{error}</Text> : null}
      <View style={[styles.composer, { backgroundColor: t.card, borderColor: t.line }]}>
        <TextInput value={prompt} onChangeText={setPrompt} placeholder="What should I do?" placeholderTextColor={t.sub} multiline
          style={[styles.input, { color: t.text }]} maxLength={4000} accessibilityLabel="Describe a task" />
        <Pressable accessibilityRole="button" accessibilityLabel="Send task" disabled={!prompt.trim() || sending || offline} onPress={() => { void send(); }}
          style={[styles.send, { backgroundColor: !prompt.trim() || offline ? t.fill : t.tint }]}>
          <Text style={styles.sendText}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space.l, paddingTop: 70, paddingBottom: space.l },
  title: { fontSize: 34, fontWeight: '700' }, sub: { fontSize: 15 },
  subRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.m },
  banner: { padding: space.m, borderRadius: radius, marginBottom: space.m },
  attention: { padding: space.m, borderRadius: radius, marginBottom: space.m },
  card: { padding: space.l, borderRadius: radius, gap: space.s },
  headline: { fontSize: 17, fontWeight: '600' },
  empty: { fontSize: 17, lineHeight: 22, textAlign: 'center', marginTop: 60, paddingHorizontal: space.xl },
  composer: { flexDirection: 'row', alignItems: 'flex-end', borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, padding: 6, gap: 6 },
  input: { flex: 1, fontSize: 17, maxHeight: 120, paddingHorizontal: 12, paddingVertical: 8 },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#fff', fontSize: 20, fontWeight: '700' },
});
