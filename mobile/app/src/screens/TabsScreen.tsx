import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { BrowserTab, TabsApi } from '@orbit/core';
import { BackButton } from '../components/BackButton';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

const hostOf = (url: string): string => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };

export function TabsScreen({ api, onBack }: { api: TabsApi; onBack: () => void }) {
  const t = useTheme();
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [offline, setOffline] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api.list();
      setTabs(result.tabs);
      setOffline(false);
      setError(undefined);
    } catch (e) {
      const message = friendlyError(e);
      if (/extension/i.test(message)) { setOffline(true); setTabs([]); } else setError(message);
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (job: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(undefined);
    try { await job(); void Haptics.selectionAsync(); await refresh(); }
    catch (e) { setError(friendlyError(e)); }
    finally { setBusy(false); }
  };

  const open = (): Promise<void> => run(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    await api.open(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    setUrl('');
  });

  if (offline) {
    return (
      <View style={[styles.root, { backgroundColor: t.bg }]}>
        <BackButton onPress={onBack} />
        <Text style={[styles.title, { color: t.text }]}>Browser tabs</Text>
        <View style={[styles.card, { backgroundColor: t.card }]}>
          <Text style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>One-time setup on your computer</Text>
          <Text style={{ color: t.sub, fontSize: 15, lineHeight: 21 }}>1. In Chrome or Edge, open chrome://extensions and turn on Developer mode.{'\n'}2. Choose "Load unpacked" and pick the extension folder from Orbit.{'\n'}3. Copy the port and token from Orbit's Settings on the computer into the extension's setup page.</Text>
          <Pressable accessibilityRole="button" onPress={() => { void refresh(); }} style={[styles.button, { backgroundColor: t.tint }]}>
            <Text style={styles.buttonText}>I've connected it - check again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Browser tabs</Text>
      <Text style={{ color: t.sub, fontSize: 15 }}>Every tab on your computer. Tap one to bring it up, or send a link to open.</Text>
      <View style={{ flexDirection: 'row', gap: space.s }}>
        <TextInput value={url} onChangeText={setUrl} placeholder="Open a link on your computer" placeholderTextColor={t.sub}
          autoCapitalize="none" autoCorrect={false} keyboardType="url" onSubmitEditing={() => { void open(); }}
          style={[styles.input, { backgroundColor: t.card, color: t.text }]} />
        <Pressable accessibilityRole="button" disabled={busy || !url.trim()} onPress={() => { void open(); }}
          style={[styles.button, { backgroundColor: url.trim() ? t.tint : t.fill }]}>
          <Text style={styles.buttonText}>Open</Text>
        </Pressable>
      </View>
      {error ? <Text style={{ color: t.bad, fontSize: 14 }}>{error}</Text> : null}
      <FlatList data={tabs} keyExtractor={tab => String(tab.id)} contentContainerStyle={{ gap: space.s, paddingBottom: 40 }}
        refreshing={busy} onRefresh={() => { void refresh(); }}
        ListEmptyComponent={<Text style={{ color: t.sub, fontSize: 15, marginTop: space.l }}>No tabs right now.</Text>}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void run(() => api.activate(item.id)); }}
            style={[styles.row, { backgroundColor: t.card, borderColor: item.active ? t.tint : 'transparent' }]}>
            <View style={{ flex: 1, gap: 1 }}>
              <Text numberOfLines={1} style={{ color: t.text, fontSize: 16 }}>{item.title || hostOf(item.url)}</Text>
              <Text numberOfLines={1} style={{ color: t.sub, fontSize: 13 }}>{hostOf(item.url)}{item.active ? ' · in front' : ''}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close tab" disabled={busy} hitSlop={12}
              onPress={() => { void run(() => api.close(item.id)); }}>
              <Text style={{ color: t.sub, fontSize: 18, paddingHorizontal: space.s }}>x</Text>
            </Pressable>
          </Pressable>
        )} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: space.l, gap: space.m },
  title: { fontSize: 28, fontWeight: '700' },
  card: { borderRadius: radius, padding: space.l, gap: space.m },
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: radius, padding: space.m, borderWidth: 1.5 },
  input: { flex: 1, borderRadius: radius, paddingHorizontal: space.m, paddingVertical: 10, fontSize: 15 },
  button: { borderRadius: radius, paddingHorizontal: space.l, justifyContent: 'center' },
  buttonText: { color: 'white', fontSize: 15, fontWeight: '600', textAlign: 'center', paddingVertical: 10 },
});
