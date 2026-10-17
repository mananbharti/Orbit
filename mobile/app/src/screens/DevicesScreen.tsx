import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import type { DeviceInfo, DevicesApi, Scope } from '@orbit/core';
import { friendlyError } from '../orbit';
import { BackButton } from '../components/BackButton';
import { radius, space, useTheme } from '../theme';

const SCOPE_LABELS: { scope: Scope; label: string; hint: string }[] = [
  { scope: 'agent', label: 'Assistant', hint: 'Ask the computer to do things' },
  { scope: 'clipboard', label: 'Clipboard', hint: 'Share copied text and images' },
  { scope: 'files', label: 'Files', hint: 'Send files to the computer' },
  { scope: 'launcher', label: 'Apps', hint: 'See and open apps' },
  { scope: 'input', label: 'Keyboard & Mouse', hint: 'Control the pointer and keys' },
  { scope: 'dictation', label: 'Dictation', hint: 'Speak to type on the computer' },
  { scope: 'memory', label: 'Memory', hint: 'Read what the computer remembers' },
];

const shortId = (id: string): string => id.slice(0, 8);

export function DevicesScreen({ api, onBack, initialSelected }: { api: DevicesApi; onBack: () => void; initialSelected?: string }) {
  const t = useTheme();
  const [devices, setDevices] = useState<DeviceInfo[] | undefined>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | undefined>(initialSelected);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.refresh().then(setDevices).catch((e: unknown) => { setError(friendlyError(e)); setDevices([]); }); }, [api]);
  const current = devices?.find(d => d.deviceId === api.currentId());
  const others = devices?.filter(d => d.deviceId !== api.currentId()) ?? [];
  const editing = others.find(d => d.deviceId === selected);

  async function setScopes(deviceId: string, scopes: readonly Scope[] | 'all'): Promise<void> {
    if (saving) return;
    const before = devices;
    setSaving(true); setError('');
    setDevices(prev => prev?.map(d => d.deviceId === deviceId ? { ...d, scopes: scopes === 'all' ? 'all' : [...scopes] } : d));
    try { setDevices(await api.setScopes(deviceId, scopes)); }
    catch (e) { setDevices(before); setError(friendlyError(e)); }
    finally { setSaving(false); void Haptics.selectionAsync(); }
  }

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.root}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Devices</Text>
      {error ? <Text style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
      {devices === undefined ? <ActivityIndicator style={{ marginTop: space.l }} /> : (
        <>
          {current ? (
            <>
              <Text style={[styles.section, { color: t.sub }]}>THIS PHONE</Text>
              <View style={[styles.card, { backgroundColor: t.card }]}>
                <Text style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>This iPhone</Text>
                <Text style={{ color: t.sub, fontSize: 13, lineHeight: 18 }}>{current.scopes === 'all' ? 'Full access' : `Limited to ${current.scopes.length} ${current.scopes.length === 1 ? 'permission' : 'permissions'}`}</Text>
                {current.scopes !== 'all' ? <Text style={{ color: t.sub, fontSize: 13, lineHeight: 18 }}>{current.scopes.map(s => SCOPE_LABELS.find(l => l.scope === s)?.label ?? s).join(', ')}</Text> : null}
              </View>
            </>
          ) : null}
          <Text style={[styles.section, { color: t.sub }]}>OTHER DEVICES</Text>
          {others.length === 0 ? (
            <View style={[styles.card, { backgroundColor: t.card }]}>
              <Text style={{ color: t.sub, fontSize: 15, lineHeight: 21 }}>No other devices are paired with this computer. Pair one from the computer's Orbit window.</Text>
            </View>
          ) : others.map(d => (
            <Pressable key={d.deviceId} accessibilityRole="button" onPress={() => { setSelected(selected === d.deviceId ? undefined : d.deviceId); void Haptics.selectionAsync(); }}
              style={[styles.card, { backgroundColor: t.card }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>Device {shortId(d.deviceId)}</Text>
                  <Text style={{ color: t.sub, fontSize: 13 }}>{d.scopes === 'all' ? 'Full access' : `Limited to ${d.scopes.length} ${d.scopes.length === 1 ? 'permission' : 'permissions'}`}</Text>
                </View>
                <Text style={{ color: t.sub, fontSize: 22 }}>{selected === d.deviceId ? '‹' : '›'}</Text>
              </View>
            </Pressable>
          ))}
          {editing ? (
            <>
              <Text style={[styles.section, { color: t.sub }]}>DEVICE {shortId(editing.deviceId).toUpperCase()} CAN ACCESS</Text>
              <View style={[styles.card, { backgroundColor: t.card }]}>
                <View style={styles.row}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: t.text, fontSize: 17 }}>Full access</Text>
                    <Text style={{ color: t.sub, fontSize: 13, lineHeight: 18 }}>Everything this phone can do.</Text>
                  </View>
                  <Switch value={editing.scopes === 'all'} disabled={saving}
                    onValueChange={on => { void setScopes(editing.deviceId, on ? 'all' : SCOPE_LABELS.map(l => l.scope)); }} trackColor={{ true: t.good }} />
                </View>
                {editing.scopes !== 'all' ? SCOPE_LABELS.map(({ scope, label, hint }) => (
                  <View key={scope} style={[styles.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.fill }]}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ color: t.text, fontSize: 17 }}>{label}</Text>
                      <Text style={{ color: t.sub, fontSize: 13, lineHeight: 18 }}>{hint}</Text>
                    </View>
                    <Switch value={(editing.scopes as Scope[]).includes(scope)} disabled={saving}
                      onValueChange={on => {
                        const current_ = editing.scopes as Scope[];
                        const next = on ? [...current_, scope] : current_.filter(s => s !== scope);
                        if (next.length === 0) return; // a device with no permissions should be forgotten instead
                        void setScopes(editing.deviceId, next);
                      }} trackColor={{ true: t.good }} />
                  </View>
                )) : null}
              </View>
              <Text style={{ color: t.sub, fontSize: 13, lineHeight: 18 }}>Changes apply immediately and survive restarts on the computer.</Text>
            </>
          ) : null}
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
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m, paddingVertical: 6 },
});
