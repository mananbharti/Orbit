import { BackButton } from '../components/BackButton';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { OutcomeUnknown, type AppEntry, type LauncherApi } from '@orbit/core';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

// Stable, recognizable tile color per app name - the same app always gets the same gradient.
const PALETTES: [string, string][] = [
  ['#0a84ff', '#409cff'], ['#bf5af2', '#da8fff'], ['#ff375f', '#ff6482'], ['#ff9f0a', '#ffb340'],
  ['#30d158', '#63e68a'], ['#64d2ff', '#8fe0ff'], ['#ff453a', '#ff6961'], ['#ffd60a', '#ffe14d'],
  ['#5e5ce6', '#7d7aff'], ['#ac8e68', '#c7ab87'], ['#66d4cf', '#8fe3df'], ['#ff6482', '#ff8fab']];
function palette(name: string): [string, string] {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTES[h % PALETTES.length]!;
}
function initials(name: string): string {
  const words = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  const pick = words.length > 1 ? words[0]![0]! + words[1]![0]! : name.trim().slice(0, 2);
  return pick.toUpperCase();
}

export function AppsScreen({ api, onBack }: { api: LauncherApi; onBack: () => void }) {
  const t = useTheme();
  const [apps, setApps] = useState<AppEntry[]>();
  const [error, setError] = useState<string>();
  const [launching, setLaunching] = useState<string>();
  const [launched, setLaunched] = useState<string>();
  const [query, setQuery] = useState('');
  const [icons, setIcons] = useState<Record<string, string | null>>({});

  const load = useCallback(async () => {
    setError(undefined);
    try { setApps(await api.list()); } catch (e) { setError(friendlyError(e)); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  // Real icons stream in after the grid is up: first screenful first, one request at a time.
  useEffect(() => {
    if (!apps) return;
    let cancelled = false;
    void (async () => {
      for (const app of apps.slice(0, 96)) {
        if (cancelled) return;
        try {
          const icon = await api.icon(app.appId);
          if (cancelled || !icon) continue;
          setIcons(prev => (prev[app.appId] ? prev : { ...prev, [app.appId]: icon }));
        } catch { /* no icon: the letter tile stays */ }
      }
    })();
    return () => { cancelled = true; };
  }, [apps, api]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (apps ?? []).filter(a => !q || a.name.toLowerCase().includes(q));
  }, [apps, query]);

  const launch = async (app: AppEntry): Promise<void> => {
    setLaunching(app.appId); setError(undefined); setLaunched(undefined);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await api.launch(app.appId);
      setLaunched(app.appId); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => setLaunched(cur => (cur === app.appId ? undefined : cur)), 2500);
    } catch (e) {
      setError(friendlyError(e));
      if (!(e instanceof OutcomeUnknown)) void load();
    } finally { setLaunching(undefined); }
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Apps</Text>
      <Text style={{ color: t.sub, fontSize: 15 }}>Open any app on your computer, from here.</Text>
      <View style={[styles.search, { backgroundColor: t.fill }]}>
        <TextInput value={query} onChangeText={setQuery} placeholder="Search apps" placeholderTextColor={t.sub} autoCorrect={false} autoCapitalize="none"
          style={{ flex: 1, color: t.text, fontSize: 16 }} accessibilityLabel="Search apps" />
      </View>
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
      {!apps && !error ? <ActivityIndicator style={{ marginTop: 40 }} /> : null}
      <FlatList data={filtered} keyExtractor={a => a.appId} numColumns={4} columnWrapperStyle={{ gap: space.s }}
        contentContainerStyle={{ gap: space.m, paddingBottom: space.xl, paddingTop: space.s }}
        ListEmptyComponent={apps ? <Text style={{ color: t.sub, fontSize: 16, textAlign: 'center', marginTop: 40 }}>{query ? 'No apps match.' : 'No apps found on your computer.'}</Text> : null}
        renderItem={({ item }) => {
          const [c1] = palette(item.name);
          const busy = launching === item.appId;
          const done = launched === item.appId;
          return (
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.name} on your computer`} disabled={!!launching}
              onPress={() => { void launch(item); }}
              style={({ pressed }) => [styles.tile, { opacity: pressed || busy ? 0.6 : 1 }]}>
              <View style={[styles.icon, icons[item.appId] ? styles.iconImage : { backgroundColor: c1 }]}>
                {busy ? <ActivityIndicator color="#fff" size="small" /> :
                  done ? <Text style={styles.check}>✓</Text> :
                    icons[item.appId] ? <Image source={{ uri: 'data:image/png;base64,' + icons[item.appId] }} style={styles.image} /> :
                    <Text style={styles.initials}>{initials(item.name)}</Text>}
              </View>
              <Text numberOfLines={2} style={[styles.name, { color: t.text }]}>{item.name}</Text>
            </Pressable>
          );
        }} />
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  search: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  tile: { flex: 1 / 4, alignItems: 'center', gap: 6 },
  icon: { width: 60, height: 60, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 4 },
  iconImage: { backgroundColor: 'transparent' },
  image: { width: 60, height: 60 },
  initials: { color: '#fff', fontSize: 22, fontWeight: '800', letterSpacing: 0.5 },
  check: { color: '#fff', fontSize: 26, fontWeight: '800' },
  name: { fontSize: 11.5, fontWeight: '500', textAlign: 'center', lineHeight: 14 },
});
