import { BackButton } from '../components/BackButton';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { FileApi, TransferManifest } from '@orbit/core';
import { sinkForDownload, sourceFromUri } from '../files';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const label = { preparing: 'Preparing', offered: 'Waiting for your computer', transferring: 'Transferring', paused: 'Paused', verifying: 'Verifying',
  completed: 'Done', cancelled: 'Cancelled', failed: 'Failed', expired: 'Expired' } as const;

export function FilesScreen({ api, onBack }: { api: FileApi; onBack: () => void }) {
  const t = useTheme();
  const state = useSyncExternalStore(api.subscribe, api.getState);
  const [error, setError] = useState<string>();
  const transfer = state.transfer;
  const running = !!transfer && ['preparing', 'offered', 'transferring', 'verifying'].includes(transfer.state);

  useEffect(() => { api.watch().catch(e => setError(friendlyError(e))); }, [api]);

  const run = async (job: () => Promise<void>): Promise<void> => {
    setError(undefined);
    try { await job(); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch (e) { setError(friendlyError(e)); }
  };
  const pick = (): Promise<void> => run(async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    await api.upload(sourceFromUri(asset.uri, asset.name));
  });
  const receive = (offer: TransferManifest): Promise<void> => run(async () => {
    await api.download(offer, sinkForDownload(offer.transferId, offer.name));
    await api.refreshOffers();
  });

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Files</Text>
      <Text style={{ color: t.sub, fontSize: 15 }}>Send a file you choose to your computer, or receive one it offers. Every file is checked end to end before it is kept.</Text>
      <Pressable accessibilityRole="button" disabled={running} onPress={() => { void pick(); }}
        style={[styles.button, { backgroundColor: running ? t.fill : t.tint }]}>
        <Text style={styles.buttonText}>Choose a file to send</Text></Pressable>
      {transfer ? (
        <View style={[styles.card, { backgroundColor: t.card }]}>
          <Text numberOfLines={1} style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>{transfer.name}</Text>
          <Text style={{ color: t.sub, fontSize: 15 }}>{transfer.direction === 'to-desktop' ? 'To your computer' : 'To this phone'} · {label[transfer.state]}</Text>
          <View style={[styles.track, { backgroundColor: t.fill }]}>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: transfer.state === 'failed' ? t.bad : t.tint,
              width: `${transfer.sizeBytes ? Math.min(100, (transfer.doneBytes / transfer.sizeBytes) * 100) : transfer.state === 'completed' ? 100 : 0}%` }} />
          </View>
          <Text style={{ color: t.sub, fontSize: 13 }}>{size(transfer.doneBytes)} of {size(transfer.sizeBytes)}</Text>
          {transfer.state === 'completed' && transfer.direction === 'to-client' ? <Text style={{ color: t.good, fontSize: 15 }}>Saved in this app's Orbit folder</Text> : null}
          {transfer.state === 'paused' ? <Pressable accessibilityRole="button" onPress={() => { void run(() => api.retry()); }}><Text style={{ color: t.tint, fontSize: 17 }}>Resume</Text></Pressable> : null}
          {running ? <Pressable accessibilityRole="button" onPress={() => { void api.cancel(); }}><Text style={{ color: t.bad, fontSize: 17 }}>Cancel</Text></Pressable> : null}
        </View>
      ) : null}
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
      <Text style={[styles.label, { color: t.sub }]}>Offered by your computer</Text>
      <FlatList data={state.offers} keyExtractor={o => o.transferId} contentContainerStyle={{ gap: space.s }}
        ListEmptyComponent={<Text style={{ color: t.sub, fontSize: 15 }}>Nothing waiting.</Text>}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={`Receive ${item.name}`} disabled={running} onPress={() => { void receive(item); }}
            style={[styles.card, { backgroundColor: t.card, opacity: running ? 0.5 : 1 }]}>
            <Text numberOfLines={1} style={{ color: t.text, fontSize: 17 }}>{item.name}</Text>
            <Text style={{ color: t.sub, fontSize: 13 }}>{size(item.sizeBytes)} · tap to receive</Text>
          </Pressable>
        )} />
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  card: { padding: space.l, borderRadius: radius, gap: space.xs },
  label: { fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  button: { paddingVertical: 13, borderRadius: radius, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});
