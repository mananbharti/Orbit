import { StyleSheet, Text, View } from 'react-native';
import type { TaskState } from '@orbit/core';
import { useTheme } from '../theme';

export const stateLabel: Record<TaskState, string> = { queued: 'Queued', running: 'Working', 'awaiting-approval': 'Needs you',
  paused: 'Paused', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled', unknown: 'Check on computer' };

export function StatusPill({ state }: { state: TaskState }) {
  const t = useTheme();
  const color = state === 'completed' ? t.good : state === 'awaiting-approval' || state === 'unknown' ? t.warn
    : state === 'failed' ? t.bad : state === 'running' ? t.tint : t.sub;
  return (
    <View style={[styles.pill, { backgroundColor: color + '26' }]} accessibilityLabel={`Status: ${stateLabel[state]}`}>
      <Text style={[styles.text, { color }]}>{stateLabel[state]}</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, alignSelf: 'flex-start' },
  text: { fontSize: 13, fontWeight: '600' },
});
