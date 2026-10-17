import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BackButton } from '../components/BackButton';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

export function PairScreen({ onScanned, onBack }: { onScanned: (text: string) => Promise<void>; onBack?: () => void }) {
  const t = useTheme();
  const [permission, request] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const handled = useRef(false);
  const [pasted, setPasted] = useState('');

  const onCode = async (data: string): Promise<void> => {
    if (handled.current) return;
    handled.current = true;
    setBusy(true); setError(undefined);
    try { await onScanned(data); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }
    catch (e) {
      setError(friendlyError(e));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setTimeout(() => { handled.current = false; }, 1500);
    } finally { setBusy(false); }
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      {onBack ? <BackButton onPress={onBack} /> : null}
      <Text style={[styles.title, { color: t.text }]}>Connect your computer</Text>
      <Text style={[styles.body, { color: t.sub }]}>Open Orbit on your computer and show the pairing code. Both devices need to be on the same Wi-Fi.</Text>
      <View style={[styles.camera, { backgroundColor: t.card, borderColor: t.line }]}>
        {permission?.granted ? (
          <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={busy ? undefined : ({ data }) => { void onCode(data); }} />
        ) : (
          <View style={styles.center}>
            <Text style={[styles.body, { color: t.sub, textAlign: 'center' }]}>Orbit needs the camera only to read the pairing code.</Text>
            <Pressable accessibilityRole="button" onPress={() => { void request(); }} style={[styles.button, { backgroundColor: t.tint }]}>
              <Text style={styles.buttonText}>Allow camera</Text>
            </Pressable>
          </View>
        )}
        {busy && <View style={[styles.center, StyleSheet.absoluteFill, { backgroundColor: '#0008' }]}><ActivityIndicator color="#fff" /></View>}
      </View>
      <Text style={{ color: t.sub, fontSize: 13, fontWeight: '500' }}>NO CAMERA? PASTE THE CODE</Text>
      <View style={[styles.pasteRow, { backgroundColor: t.card }]}>
        <TextInput value={pasted} onChangeText={setPasted} placeholder="Paste the contents of pairing.json" placeholderTextColor={t.sub}
          autoCapitalize="none" autoCorrect={false} accessibilityLabel="Pairing code" style={[styles.pasteInput, { color: t.text }]} />
        <Pressable accessibilityRole="button" accessibilityLabel="Pair with pasted code" disabled={!pasted.trim() || busy} onPress={() => { handled.current = false; void onCode(pasted.trim()); }}
          style={[styles.pasteGo, { backgroundColor: pasted.trim() ? t.tint : t.fill }]}>
          <Text style={styles.buttonText}>Pair</Text>
        </Pressable>
      </View>
      {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: t.bad }]}>{error}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.xl, paddingTop: 80, gap: space.l },
  title: { fontSize: 34, fontWeight: '700' },
  body: { fontSize: 17, lineHeight: 22 },
  camera: { flex: 1, maxHeight: 360, borderRadius: radius + 6, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.l, padding: space.xl },
  button: { paddingHorizontal: 22, paddingVertical: 13, borderRadius: radius },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  error: { fontSize: 15 },
  pasteRow: { flexDirection: 'row', alignItems: 'center', borderRadius: radius, padding: 6, gap: 6 },
  pasteInput: { flex: 1, fontSize: 15, paddingHorizontal: 10, minHeight: 44 },
  pasteGo: { minHeight: 44, paddingHorizontal: 18, borderRadius: radius - 4, justifyContent: 'center' },
});
