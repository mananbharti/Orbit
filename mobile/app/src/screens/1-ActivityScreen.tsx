import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AuditEntry } from '@orbit/core';
import type { AgentApi } from '@orbit/core';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

const label: Record<AuditEntry['kind'], string> = { submitted: 'You asked the agent to run a task', 'approval-requested': 'The agent asked for permission',
  approved: 'You approved', denied: 'You denied', 'approval-timeout': 'Permission request timed out and was denied',
  'cancelled-by-user': 'You cancelled a task', finished: 'Task ended', paused: 'You stopped the agent', resumed: 'You resumed the agent' };

export function ActivityScreen({ api, onBack }: { api: AgentApi; onBack: () => void }) {
  const t = useTheme();
  const [entries, setEntries] = useState<AuditEntry[]>();
  const [error, setError] = useState<string>();
  useEffect(() => { api.audit().then(setEntries, e => setError(friendlyError(e))); }, [api]);
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.root}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={14} onPress={onBack}><Text style={{ color: t.tint, fontSize: 17 }}>‹ Agent</Text></Pressable>
      <Text style={[styles.title, { color: t.text }]}>Activity</Text>
      <Text style={{ color: t.sub, fontSize: 15 }}>What this phone asked for and decided. Task text is never stored here.</Text>
      {error ? <Text style={{ color: t.bad }}>{error}</Text> : null}
      <View style={[styles.card, { backgroundColor: t.card }]}>
        {entries?.length === 0 ? <Text style={{ color: t.sub, fontSize: 16 }}>Nothing yet.</Text> : null}
        {entries?.map((e, i) => (
          <View key={`${e.at}-${i}`} style={styles.row}>
            <Text style={{ color: t.text, fontSize: 16 }}>{label[e.kind]}{e.kind === 'finished' && e.outcome ? `: ${e.outcome}` : ''}</Text>
            <Text style={{ color: t.sub, fontSize: 13 }}>{new Date(e.at).toLocaleString()}</Text>
          </View>))}
      </View>
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  root: { flexGrow: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  card: { padding: space.l, borderRadius: radius, gap: space.m },
  row: { gap: 2 },
});
