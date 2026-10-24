import { BackButton } from '../components/BackButton';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NotSent, TERMINAL_TASK_STATES, type TaskStore } from '@orbit/core';
import { StatusPill } from '../components/StatusPill';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

export function TaskDetailScreen({ store, taskId, onBack }: { store: TaskStore; taskId: string; onBack: () => void }) {
  const t = useTheme();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const task = state.tasks.find(x => x.taskId === taskId);
  const events = state.events[taskId] ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { void store.loadEvents(taskId); }, [store, taskId]);

  if (!task) return <View style={[styles.root, { backgroundColor: t.bg }]}><Pressable onPress={onBack}><Text style={{ color: t.tint, fontSize: 17 }}>‹ Back</Text></Pressable></View>;
  const request = [...events].reverse().find(e => e.kind === 'approval-request');
  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(undefined);
    try { await fn(); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }
    catch (e) { setError(friendlyError(e)); }
    finally { setBusy(false); }
  };

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.root}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>{task.headline || 'Task'}</Text>
      <StatusPill state={task.state} />
      {task.state === 'awaiting-approval' && request ? (
        <View style={[styles.card, { backgroundColor: t.card }]}>
          <Text style={[styles.label, { color: t.sub }]}>The agent is asking permission to</Text>
          <Text style={[styles.ask, { color: t.text }]}>{request.text}</Text>
          <View style={styles.row}>
            <Pressable disabled={busy} accessibilityRole="button" onPress={() => { void act(() => request.controlId ? store.approve(taskId, false, request.controlId) : Promise.reject(new NotSent('Update Orbit on your computer to answer this safely.'))); }} style={[styles.btn, { backgroundColor: t.fill }]}>
              <Text style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>Deny</Text></Pressable>
            <Pressable disabled={busy} accessibilityRole="button" onPress={() => { void act(() => request.controlId ? store.approve(taskId, true, request.controlId) : Promise.reject(new NotSent('Update Orbit on your computer to answer this safely.'))); }} style={[styles.btn, { backgroundColor: t.tint }]}>
              <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>Approve</Text></Pressable>
          </View>
        </View>
      ) : null}
      {task.state === 'unknown' ? (
        <View style={[styles.card, { backgroundColor: t.card }]}>
          <Text style={{ color: t.text, fontSize: 16, lineHeight: 21 }}>The computer restarted while this ran, so Orbit cannot tell whether it finished. Check on your computer before running it again.</Text>
        </View>
      ) : null}
      {['failed', 'cancelled', 'unknown'].includes(task.state) ? (
        <Pressable disabled={busy} accessibilityRole="button" onPress={() => Alert.alert('Run this again as a new task?',
          task.state === 'unknown' ? 'It may already have done part of its work. Check your computer first.' : undefined,
          [{ text: 'Not now', style: 'cancel' }, { text: 'Run again', onPress: () => { void act(async () => { await store.retry(taskId); onBack(); }); } }])}
          style={[styles.btn, { backgroundColor: t.tint }]}>
          <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>Run again as a new task</Text>
        </Pressable>) : null}
      <View style={[styles.card, { backgroundColor: t.card }]}>
        {events.length === 0 ? <Text style={{ color: t.sub, fontSize: 16 }}>No updates yet.</Text> : events.map(e => (
          <View key={e.seq} style={styles.event}>
            <Text style={{ color: e.kind === 'output' ? t.text : t.sub, fontSize: 16, lineHeight: 21 }}>{e.text}</Text>
          </View>))}
      </View>
      {error ? <Text style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
      {!TERMINAL_TASK_STATES.has(task.state) ? (
        <Pressable disabled={busy} accessibilityRole="button" onPress={() => Alert.alert('Cancel this task?', undefined, [
          { text: 'Keep going', style: 'cancel' }, { text: 'Cancel task', style: 'destructive', onPress: () => { void act(() => store.cancel(taskId)); } }])}>
          <Text style={{ color: t.bad, fontSize: 17, textAlign: 'center', padding: space.m }}>Cancel task</Text>
        </Pressable>) : null}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  root: { flexGrow: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 28, fontWeight: '700' },
  card: { padding: space.l, borderRadius: radius, gap: space.s },
  label: { fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 }, ask: { fontSize: 20, fontWeight: '600', lineHeight: 26 },
  row: { flexDirection: 'row', gap: space.m, marginTop: space.s },
  btn: { flex: 1, paddingVertical: 14, borderRadius: radius, alignItems: 'center' },
  event: { paddingVertical: 4 },
});
