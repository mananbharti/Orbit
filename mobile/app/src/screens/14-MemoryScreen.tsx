import { BackButton } from '../components/BackButton';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { MemoryApi, MemoryHit } from '@orbit/core';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

export function MemoryScreen({ api, onBack }: { api: MemoryApi; onBack: () => void }) {
  const t = useTheme();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryHit[]>();
  const [name, setName] = useState('');
  const [fact, setFact] = useState('');
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();

  const search = async (): Promise<void> => {
    setError(undefined); setNote(undefined);
    if (!query.trim()) { setHits(undefined); return; }
    try { setHits(await api.recall(query.trim())); } catch (e) { setError(friendlyError(e)); }
  };
  const save = async (): Promise<void> => {
    setError(undefined); setNote(undefined);
    if (!name.trim()) return;
    try {
      await api.remember({ name: name.trim(), ...(fact.trim() ? { fact: fact.trim() } : {}) });
      setName(''); setFact(''); setNote('Saved on your computer'); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) { setError(friendlyError(e)); }
  };
  const forget = async (h: MemoryHit): Promise<void> => {
    try { await api.forget(h.id); setHits(list => list?.filter(x => x.id !== h.id)); void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); }
    catch (e) { setError(friendlyError(e)); }
  };
  const input = [styles.input, { backgroundColor: t.card, color: t.text }];

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Memory</Text>
      <Text style={{ color: t.sub, fontSize: 15 }}>Kept on your computer only.</Text>
      <TextInput accessibilityLabel="Search memory" placeholder="Search" placeholderTextColor={t.sub} value={query} onChangeText={setQuery}
        onSubmitEditing={() => { void search(); }} returnKeyType="search" style={input} maxLength={200} />
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
      {note ? <Text style={{ color: t.good, fontSize: 15 }}>{note}</Text> : null}
      <FlatList data={hits ?? []} keyExtractor={h => h.id} contentContainerStyle={{ gap: space.s }}
        ListEmptyComponent={hits ? <Text style={{ color: t.sub, fontSize: 17, textAlign: 'center', marginTop: 20 }}>Nothing found.</Text> : null}
        renderItem={({ item }) => (
          <View style={[styles.row, { backgroundColor: t.card }]}>
            <Text style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>{item.name}</Text>
            {item.via ? <Text style={{ color: t.sub, fontSize: 13 }}>{item.via}</Text> : null}
            {item.facts.map(f => <Text key={f} style={{ color: t.text, fontSize: 15 }}>{f}</Text>)}
            <Pressable accessibilityRole="button" accessibilityLabel={`Forget ${item.name}`} onPress={() => { void forget(item); }}><Text style={{ color: t.bad, fontSize: 15 }}>Forget</Text></Pressable>
          </View>
        )} />
      <View style={{ gap: space.s }}>
        <TextInput accessibilityLabel="Name" placeholder="Remember: name" placeholderTextColor={t.sub} value={name} onChangeText={setName} style={input} maxLength={80} />
        <TextInput accessibilityLabel="Fact" placeholder="Fact (optional)" placeholderTextColor={t.sub} value={fact} onChangeText={setFact} style={input} maxLength={280} />
        <Pressable accessibilityRole="button" onPress={() => { void save(); }} style={[styles.row, { backgroundColor: t.tint }]}><Text style={{ color: '#fff', fontSize: 17, textAlign: 'center' }}>Save</Text></Pressable>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  input: { padding: space.m, borderRadius: radius, fontSize: 17 },
  row: { padding: space.l, borderRadius: radius, gap: 4 },
});
