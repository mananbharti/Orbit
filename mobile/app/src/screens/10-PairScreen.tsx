import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

export function PairScreen({ onScanned }: { onScanned: (text: string) => Promise<void> }) {
  const t = useTheme();
  const [permission, request] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const handled = useRef(false);

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
      {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: t.bad }]}>{error}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.xl, paddingTop: 80, gap: space.l },
  title: { fontSize: 34, fontWeight: '700' },
  body: { fontSize: 17, lineHeight: 22 },
  camera: { flex: 1, maxHeight: 420, borderRadius: radius + 6, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.l, padding: space.xl },
  button: { paddingHorizontal: 22, paddingVertical: 13, borderRadius: radius },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  error: { fontSize: 15 },
});
