import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PairedDesktop } from '@orbit/core';
import { BackButton } from '../components/BackButton';
import { radius, space, useTheme } from '../theme';

export function ComputersScreen({ list, activeId, switchingId, onSwitch, onAdd, onForget, onBack }: {
  list: PairedDesktop[]; activeId?: string; switchingId?: string;
  onSwitch: (desktopServiceId: string) => void; onAdd: () => void; onForget: (desktopServiceId: string) => void; onBack: () => void }) {
  const t = useTheme();
  const [confirming, setConfirming] = useState<string>();
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function askForget(id: string): void {
    if (confirming === id) { clearTimeout(confirmTimer.current); setConfirming(undefined); onForget(id); return; }
    setConfirming(id);
    clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirming(undefined), 3000);
  }

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.root}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Computers</Text>
      <Text style={[styles.section, { color: t.sub }]}>PAIRED</Text>
      <View style={[styles.card, { backgroundColor: t.card }]}>
        {list.map((d, i) => {
          const active = d.desktopServiceId === activeId;
          const switching = d.desktopServiceId === switchingId;
          return (
            <View key={d.desktopServiceId} style={i > 0 ? [styles.split, { borderTopColor: t.fill }] : undefined}>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} disabled={active || switchingId !== undefined}
                onPress={() => { onSwitch(d.desktopServiceId); void Haptics.selectionAsync(); }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 48 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: t.text, fontSize: 17, opacity: active || switchingId === undefined ? 1 : 0.4 }}>{d.displayName}</Text>
                  {switching ? <Text style={{ color: t.sub, fontSize: 13 }}>Switching...</Text> : null}
                </View>
                {active ? <Text style={{ color: t.tint, fontSize: 19, fontWeight: '700' }}>✓</Text> : null}
                <Pressable accessibilityRole="button" hitSlop={8} onPress={() => askForget(d.desktopServiceId)}>
                  <Text style={{ color: confirming === d.desktopServiceId ? t.bad : t.sub, fontSize: 15 }}>
                    {confirming === d.desktopServiceId ? 'Tap again to forget' : 'Forget'}
                  </Text>
                </Pressable>
              </Pressable>
            </View>
          );
        })}
        {list.length === 0 ? <Text style={{ color: t.sub, fontSize: 15, lineHeight: 21 }}>No computers paired yet.</Text> : null}
      </View>
      <Pressable accessibilityRole="button" onPress={() => { onAdd(); void Haptics.selectionAsync(); }} style={[styles.card, styles.add, { backgroundColor: t.card }]}>
        <Text style={{ color: t.tint, fontSize: 17 }}>Add a computer</Text>
      </Pressable>
      <Text style={{ color: t.sub, fontSize: 13, lineHeight: 18 }}>Forgetting a computer removes its sign-in from this phone. Pair again from that computer's Orbit window to reconnect.</Text>
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  root: { flexGrow: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  section: { fontSize: 13, fontWeight: '500', marginTop: space.m },
  card: { padding: space.l, borderRadius: radius, gap: space.s },
  split: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.s },
  add: { alignItems: 'center', minHeight: 48, justifyContent: 'center' },
});
