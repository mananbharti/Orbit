import { BackButton } from '../components/BackButton';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { OutcomeUnknown, type AppEntry, type LauncherApi, type LauncherScene } from '@orbit/core';
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
  const [pinned, setPinned] = useState<string[]>([]);
  const [scenes, setScenes] = useState<LauncherScene[]>([]);
  const [launchingScene, setLaunchingScene] = useState<string>();
  const [selecting, setSelecting] = useState<{ id?: string; name: string; selected: Set<string> } | null>(null);

  const load = useCallback(async () => {
    setError(undefined);
    try { setApps(await api.list()); setPinned(api.getPinned()); setScenes(await api.scenes()); } catch (e) { setError(friendlyError(e)); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  // Real icons stream in after the grid is up: first screenful first, in batches of 8 per round trip.
  useEffect(() => {
    if (!apps) return;
    let cancelled = false;
    void (async () => {
      const ids = apps.slice(0, 96).map(a => a.appId);
      for (let i = 0; i < ids.length; i += 8) {
        if (cancelled) return;
        try {
          const batch = await api.icons(ids.slice(i, i + 8));
          if (cancelled) continue;
          const filled: Record<string, string> = {};
          batch.forEach((icon: string | null, appId: string) => { if (icon) filled[appId] = icon; });
          if (Object.keys(filled).length) setIcons(prev => ({ ...filled, ...prev }));
        } catch { /* no icons: the letter tiles stay */ }
      }
    })();
    return () => { cancelled = true; };
  }, [apps, api]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (apps ?? []).filter(a => !q || a.name.toLowerCase().includes(q));
  }, [apps, query]);

  // Pinned favourites, in the owner's order, resolved against the live catalog; a missing app simply skips a beat.
  const pinnedApps = useMemo(() => {
    if (!apps) return [];
    const byId = new Map(apps.map(a => [a.appId, a]));
    return pinned.map(id => byId.get(id)).filter((a): a is AppEntry => !!a);
  }, [apps, pinned]);

  const mutatePins = async (op: () => Promise<string[]>): Promise<void> => {
    setError(undefined);
    try { setPinned(await op()); void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }
    catch (e) { setError(friendlyError(e)); }
  };

  /** Long-press menu: the iOS-flavoured way to pin, unpin and reorder without a separate edit mode. */
  const manage = (app: AppEntry): void => {
    const index = pinned.indexOf(app.appId);
    const pinnedApp = index !== -1;
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [
      { text: 'Open', onPress: () => { void launch(app); } },
    ];
    if (!pinnedApp) buttons.push({ text: 'Pin to top', onPress: () => { void mutatePins(() => api.pin(app.appId)); } });
    else {
      buttons.push({ text: 'Unpin', style: 'destructive', onPress: () => { void mutatePins(() => api.unpin(app.appId)); } });
      if (index > 0) buttons.push({ text: 'Move earlier', onPress: () => {
        const next = [...pinned]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
        void mutatePins(() => api.reorder(next));
      } });
      if (index < pinned.length - 1) buttons.push({ text: 'Move later', onPress: () => {
        const next = [...pinned]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
        void mutatePins(() => api.reorder(next));
      } });
    }
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(app.name, pinnedApp ? 'Pinned at the top of this screen.' : undefined, buttons);
  };

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

  const runScene = async (scene: LauncherScene): Promise<void> => {
    setLaunchingScene(scene.id); setError(undefined);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const outcome = await api.launchScene(scene.id);
      if (outcome.failed.length) setError(`Could not open: ${outcome.failed.join(', ')}`);
      else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) { setError(friendlyError(e)); }
    finally { setLaunchingScene(undefined); }
  };

  const manageScene = (scene: LauncherScene): void => {
    Alert.alert(scene.name, `${scene.appIds.length} apps`, [
      { text: 'Edit', onPress: () => setSelecting({ id: scene.id, name: scene.name, selected: new Set(scene.appIds) }) },
      { text: 'Delete scene', style: 'destructive', onPress: () => { void api.deleteScene(scene.id).then(setScenes).catch(e => setError(friendlyError(e))); } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const saveScene = async (): Promise<void> => {
    if (!selecting || !selecting.name.trim() || !selecting.selected.size) return;
    setError(undefined);
    try {
      setScenes(await api.saveScene(selecting.name.trim(), [...selecting.selected], selecting.id));
      setSelecting(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) { setError(friendlyError(e)); }
  };

  const tile = (item: AppEntry) => {
    const [c1] = palette(item.name);
    const busy = launching === item.appId;
    const done = launched === item.appId;
    const selected = selecting?.selected.has(item.appId) ?? false;
    return (
      <Pressable key={item.appId} accessibilityRole="button" accessibilityLabel={`Open ${item.name} on your computer`} disabled={!!launching}
        onPress={() => {
          if (selecting) {
            const next = new Set(selecting.selected);
            if (next.has(item.appId)) next.delete(item.appId); else next.add(item.appId);
            setSelecting({ ...selecting, selected: next });
          } else void launch(item);
        }} onLongPress={() => manage(item)}
        style={({ pressed }) => [styles.tile, { opacity: pressed || busy ? 0.6 : 1 }]}>
        <View style={[styles.icon, icons[item.appId] ? styles.iconImage : { backgroundColor: c1 }]}>
          {busy ? <ActivityIndicator color="#fff" size="small" /> :
            done ? <Text style={styles.check}>✓</Text> :
              icons[item.appId] ? <Image source={{ uri: 'data:image/png;base64,' + icons[item.appId] }} style={styles.image} /> :
              <Text style={styles.initials}>{initials(item.name)}</Text>}
        </View>
        {selecting && selected ? (
          <View style={[styles.selectedBadge, { backgroundColor: t.tint, borderColor: t.bg }]}><Text style={styles.selectedCheck}>✓</Text></View>
        ) : null}
        <Text numberOfLines={2} style={[styles.name, { color: t.text }]}>{item.name}</Text>
      </Pressable>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Apps</Text>
      <Text style={{ color: t.sub, fontSize: 15 }}>Open any app on your computer, from here. Long-press to pin favourites to the top.</Text>
      {selecting ? (
        <View style={{ gap: space.s }}>
          <TextInput value={selecting.name} onChangeText={name => setSelecting({ ...selecting, name })} placeholder="Scene name (e.g. Work)" placeholderTextColor={t.sub}
            maxLength={40} style={[styles.search, { backgroundColor: t.fill, color: t.text, fontSize: 16 }]} accessibilityLabel="Scene name" />
          <View style={{ flexDirection: 'row', gap: space.s }}>
            <Pressable accessibilityRole="button" disabled={!selecting.name.trim() || !selecting.selected.size} onPress={() => { void saveScene(); }}
              style={[styles.sceneAction, { backgroundColor: selecting.name.trim() && selecting.selected.size ? t.tint : t.fill }]}>
              <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>Save scene ({selecting.selected.size})</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setSelecting(null)} style={[styles.sceneAction, { backgroundColor: t.fill }]}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>Cancel</Text>
            </Pressable>
          </View>
          <Text style={{ color: t.sub, fontSize: 13 }}>Tap apps below to include them in this scene.</Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s }}>
          {scenes.map(scene => (
            <Pressable key={scene.id} accessibilityRole="button" accessibilityLabel={`Launch scene ${scene.name}`} disabled={!!launchingScene}
              onPress={() => { void runScene(scene); }} onLongPress={() => manageScene(scene)}
              style={[styles.sceneChip, { backgroundColor: t.tint + '1f', opacity: launchingScene && launchingScene !== scene.id ? 0.5 : 1 }]}>
              {launchingScene === scene.id ? <ActivityIndicator size="small" color={t.tint} /> : null}
              <Text style={{ color: t.tint, fontSize: 15, fontWeight: '600' }}>{scene.name}</Text>
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" accessibilityLabel="New scene" onPress={() => setSelecting({ name: '', selected: new Set() })}
            style={[styles.sceneChip, { backgroundColor: t.fill }]}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>+ New scene</Text>
          </Pressable>
        </ScrollView>
      )}
      <View style={[styles.search, { backgroundColor: t.fill }]}>
        <TextInput value={query} onChangeText={setQuery} placeholder="Search apps" placeholderTextColor={t.sub} autoCorrect={false} autoCapitalize="none"
          style={{ flex: 1, color: t.text, fontSize: 16 }} accessibilityLabel="Search apps" />
      </View>
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
      {!apps && !error ? <ActivityIndicator style={{ marginTop: 40 }} /> : null}
      <FlatList data={filtered} keyExtractor={a => a.appId} numColumns={4} columnWrapperStyle={{ gap: space.s }}
        contentContainerStyle={{ gap: space.m, paddingBottom: space.xl, paddingTop: space.s }}
        ListHeaderComponent={!query.trim() && pinnedApps.length ? (
          <View style={{ marginBottom: space.m }}>
            <Text style={{ color: t.sub, fontSize: 13, fontWeight: '600', marginBottom: space.s }}>PINNED</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s }}>{pinnedApps.map(tile)}</View>
            <View style={{ height: 1, backgroundColor: t.line, marginTop: space.m }} />
          </View>
        ) : null}
        ListEmptyComponent={apps ? <Text style={{ color: t.sub, fontSize: 16, textAlign: 'center', marginTop: 40 }}>{query ? 'No apps match.' : 'No apps found on your computer.'}</Text> : null}
        renderItem={({ item }) => tile(item)} />
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  search: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  tile: { flex: 1 / 4, alignItems: 'center', gap: 6, position: 'relative' },
  icon: { width: 60, height: 60, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 4 },
  iconImage: { backgroundColor: 'transparent' },
  image: { width: 60, height: 60 },
  initials: { color: '#fff', fontSize: 22, fontWeight: '800', letterSpacing: 0.5 },
  check: { color: '#fff', fontSize: 26, fontWeight: '800' },
  name: { fontSize: 11.5, fontWeight: '500', textAlign: 'center', lineHeight: 14 },
  sceneChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 18, paddingVertical: 9, paddingHorizontal: 14 },
  sceneAction: { flex: 1, borderRadius: 12, paddingVertical: 10, alignItems: 'center' },
  selectedBadge: { position: 'absolute', top: -4, right: 2, width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  selectedCheck: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
});
