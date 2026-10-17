import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import type { Automation, AutomationAction, AutomationApi } from '@orbit/core';
import { friendlyError } from '../orbit';
import { BackButton } from '../components/BackButton';
import { radius, space, useTheme } from '../theme';

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export interface SceneOption { id: string; name: string }

function describeDays(days: number[]): string {
  if (days.length === 0 || days.length === 7) return 'Every day';
  if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return 'Weekdays';
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends';
  return [...days].sort((a, b) => a - b).map(d => DAY_NAMES[d]).join(' ');
}
function describeAction(action: AutomationAction, scenes: SceneOption[]): string {
  if (action.type === 'power') return action.action === 'sleep' ? 'Sleep' : 'Lock';
  if (action.type === 'scene') return `Open ${scenes.find(s => s.id === action.sceneId)?.name ?? 'a scene'}`;
  return 'Open an app';
}

interface Draft { id?: string; time: string; days: number[]; action: AutomationAction }

export function AutomationsScreen({ api, scenes, onBack, initialDraft }: { api: AutomationApi; scenes: SceneOption[]; onBack: () => void; initialDraft?: { id?: string; time: string; days: number[]; action: AutomationAction } }) {
  const t = useTheme();
  const [list, setList] = useState<Automation[] | undefined>();
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | undefined>(initialDraft);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.refresh().then(setList).catch((e: unknown) => { setError(friendlyError(e)); setList([]); }); }, [api]);

  async function run(work: () => Promise<Automation[]>): Promise<void> {
    if (saving) return;
    setSaving(true); setError('');
    try { setList(await work()); setDraft(undefined); }
    catch (e) { setError(friendlyError(e)); }
    finally { setSaving(false); void Haptics.selectionAsync(); }
  }
  const [hour, minute] = (draft?.time ?? '09:00').split(':').map(Number) as [number, number];
  const setTime = (h: number, m: number): void => setDraft(d => d && { ...d, time: `${String((h + 24) % 24).padStart(2, '0')}:${String((m + 60) % 60).padStart(2, '0')}` });
  const toggleDay = (day: number): void => setDraft(d => d && { ...d, days: d.days.includes(day) ? d.days.filter(x => x !== day) : [...d.days, day] });

  if (draft) {
    const actionChoices: { label: string; action: AutomationAction }[] = [
      { label: 'Sleep', action: { type: 'power', action: 'sleep' } },
      { label: 'Lock', action: { type: 'power', action: 'lock' } },
      ...scenes.map(s => ({ label: `Open ${s.name}`, action: { type: 'scene', sceneId: s.id } as AutomationAction })),
    ];
    const currentAction = describeAction(draft.action, scenes);
    return (
      <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.root}>
        <BackButton onPress={() => setDraft(undefined)} />
        <Text style={[styles.title, { color: t.text }]}>{draft.id ? 'Edit automation' : 'New automation'}</Text>
        {error ? <Text style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
        <Text style={[styles.section, { color: t.sub }]}>ACTION</Text>
        <View style={[styles.card, { backgroundColor: t.card }]}>
          {actionChoices.map((c, i) => (
            <Pressable key={c.label} accessibilityRole="radio" accessibilityState={{ selected: describeAction(c.action, scenes) === currentAction }}
              onPress={() => { setDraft({ ...draft, action: c.action }); void Haptics.selectionAsync(); }}
              style={[styles.choice, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.fill }]}>
              <Text style={{ color: t.text, fontSize: 17, flex: 1 }}>{c.label}</Text>
              {describeAction(c.action, scenes) === currentAction ? <Text style={{ color: t.tint, fontSize: 17, fontWeight: '700' }}>✓</Text> : null}
            </Pressable>
          ))}
        </View>
        <Text style={[styles.section, { color: t.sub }]}>TIME</Text>
        <View style={[styles.card, styles.timeRow, { backgroundColor: t.card }]}>
          {[{ value: hour, step: (d: number) => setTime(hour + d, minute) }, { value: minute, step: (d: number) => setTime(hour, minute + d * 5) }].map((col, i) => (
            <View key={i} style={{ alignItems: 'center', gap: 4 }}>
              <Pressable accessibilityRole="button" accessibilityLabel={i === 0 ? 'Later hour' : 'Later'} onPress={() => col.step(1)} style={styles.stepper}><Text style={{ color: t.tint, fontSize: 24 }}>▲</Text></Pressable>
              <Text style={{ color: t.text, fontSize: 40, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{String(col.value).padStart(2, '0')}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={i === 0 ? 'Earlier hour' : 'Earlier'} onPress={() => col.step(-1)} style={styles.stepper}><Text style={{ color: t.tint, fontSize: 24 }}>▼</Text></Pressable>
            </View>
          ))}
        </View>
        <Text style={[styles.section, { color: t.sub }]}>REPEAT</Text>
        <View style={{ flexDirection: 'row', gap: space.s, justifyContent: 'space-between' }}>
          {DAY_LABELS.map((label, day) => {
            const on = draft.days.includes(day);
            return (
              <Pressable key={day} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={DAY_NAMES[day]}
                onPress={() => { toggleDay(day); void Haptics.selectionAsync(); }}
                style={[styles.day, { backgroundColor: on ? t.tint : t.card }]}>
                <Text style={{ color: on ? '#FFFFFF' : t.text, fontSize: 15, fontWeight: '600' }}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={{ color: t.sub, fontSize: 13 }}>{describeDays(draft.days)}. The computer runs this even if the phone is away.</Text>
        <Pressable accessibilityRole="button" disabled={saving} onPress={() => { void run(() => api.save({ ...(draft.id ? { id: draft.id } : {}), time: draft.time, days: draft.days, action: draft.action })); }}
          style={[styles.primary, { backgroundColor: t.tint, opacity: saving ? 0.5 : 1 }]}>
          <Text style={{ color: '#FFFFFF', fontSize: 17, fontWeight: '600' }}>Save</Text>
        </Pressable>
        {draft.id ? (
          <Pressable accessibilityRole="button" disabled={saving} onPress={() => { void run(() => api.remove(draft.id!)); }} style={{ alignItems: 'center', minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: t.bad, fontSize: 17 }}>Delete automation</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.root}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Automations</Text>
      {error ? <Text style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
      {list === undefined ? <ActivityIndicator style={{ marginTop: space.l }} /> : (
        <>
          {list.length === 0 ? (
            <View style={[styles.card, { backgroundColor: t.card }]}>
              <Text style={{ color: t.sub, fontSize: 15, lineHeight: 21 }}>No automations yet. Make the computer open your work apps at 9, or put itself to sleep at night - even when your phone is away.</Text>
            </View>
          ) : (
            <View style={[styles.card, { backgroundColor: t.card }]}>
              {list.map((a, i) => (
                <View key={a.id} style={[styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.fill }]}>
                  <Pressable accessibilityRole="button" onPress={() => { setDraft({ id: a.id, time: a.time, days: [...a.days], action: a.action }); void Haptics.selectionAsync(); }} style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: t.text, fontSize: 28, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{a.time}</Text>
                    <Text style={{ color: t.sub, fontSize: 13 }}>{describeAction(a.action, scenes)} · {describeDays(a.days)}</Text>
                  </Pressable>
                  <Switch value={a.enabled} disabled={saving} onValueChange={on => { void run(() => api.setEnabled(a.id, on)); }} trackColor={{ true: t.good }} />
                </View>
              ))}
            </View>
          )}
          <Pressable accessibilityRole="button" onPress={() => { setDraft({ time: '09:00', days: [1, 2, 3, 4, 5], action: { type: 'power', action: 'sleep' } }); void Haptics.selectionAsync(); }}
            style={[styles.card, styles.add, { backgroundColor: t.card }]}>
            <Text style={{ color: t.tint, fontSize: 17 }}>New automation</Text>
          </Pressable>
          <Text style={{ color: t.sub, fontSize: 13, lineHeight: 18 }}>Automations run on the computer's clock, phone or no phone.</Text>
        </>
      )}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  root: { flexGrow: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  section: { fontSize: 13, fontWeight: '500', marginTop: space.m },
  card: { padding: space.l, borderRadius: radius, gap: space.s },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: 8 },
  add: { alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  choice: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: space.m },
  timeRow: { flexDirection: 'row', justifyContent: 'space-evenly' },
  stepper: { minWidth: 44, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  day: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  primary: { borderRadius: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: space.s },
});
