import { BackButton } from '../components/BackButton';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { OutcomeUnknown, type AppEntry, type LauncherApi } from '@orbit/core';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

export function AppsScreen({ api, onBack }: { api: LauncherApi; onBack: () => void }) {
  const t = useTheme();
  const [apps, setApps] = useState<AppEntry[]>();
  const [error, setError] = useState<string>();
  const [launching, setLaunching] = useState<string>();
  const [note, setNote] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try { setApps(await api.list()); } catch (e) { setError(friendlyError(e)); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const launch = async (app: AppEntry): Promise<void> => {
    setLaunching(app.appId); setNote(undefined); setError(undefined);
    try { await api.launch(app.appId); setNote(`Opening ${app.name} on your computer`); void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); }
    catch (e) {
      setError(friendlyError(e));
      if (!(e instanceof OutcomeUnknown)) void load(); // stale catalog or similar: get a fresh list
    } finally { setLaunching(undefined); }
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Apps</Text>
      {note ? <Text style={{ color: t.good, fontSize: 15 }}>{note}</Text> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
      {!apps && !error ? <ActivityIndicator style={{ marginTop: 40 }} /> : null}
      <FlatList data={apps ?? []} keyExtractor={a => a.appId} contentContainerStyle={{ gap: space.s, paddingBottom: space.xl }}
        refreshing={false} onRefresh={() => { void load(); }}
        ListEmptyComponent={apps ? <Text style={{ color: t.sub, fontSize: 17, textAlign: 'center', marginTop: 40 }}>No apps found on your computer.</Text> : null}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.name}`} disabled={!!launching} onPress={() => { void launch(item); }}
            style={({ pressed }) => [styles.row, { backgroundColor: t.card, opacity: pressed || launching === item.appId ? 0.6 : 1 }]}>
            <Text numberOfLines={1} style={{ color: t.text, fontSize: 17 }}>{item.name}</Text>
          </Pressable>
        )} />
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  row: { padding: space.l, borderRadius: radius },
});
