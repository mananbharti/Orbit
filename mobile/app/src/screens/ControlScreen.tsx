import { BackButton } from '../components/BackButton';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AudioSession, PowerAction, SystemApi } from '@orbit/core';
import { Icon, type IconName } from '../components/Icon';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

const POWER: { action: PowerAction; label: string; icon: IconName; danger?: boolean; confirm?: string }[] = [
  { action: 'lock', label: 'Lock', icon: 'lock' },
  { action: 'sleep', label: 'Sleep', icon: 'moon', confirm: 'Put your computer to sleep?' },
  { action: 'restart', label: 'Restart', icon: 'refresh', danger: true, confirm: 'Restart your computer? Unsaved work will be lost.' },
  { action: 'shutdown', label: 'Shut down', icon: 'power', danger: true, confirm: 'Shut down your computer? Unsaved work will be lost.' },
];

export function ControlScreen({ api, onBack, onPanic }: { api: SystemApi; onBack: () => void; onPanic?: () => void }) {
  const t = useTheme();
  const [volume, setVolume] = useState<number>();
  const [muted, setMuted] = useState(false);
  const [brightness, setBrightness] = useState<number | null>();
  const [sessions, setSessions] = useState<AudioSession[]>([]);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();

  useEffect(() => {
    api.getVolume().then(v => { setVolume(v.level); setMuted(v.muted); }).catch(() => {});
    api.getBrightness().then(setBrightness).catch(() => setBrightness(null));
    api.audioSessions().then(setSessions).catch(() => {});
  }, [api]);

  const nudgeSession = async (session: AudioSession, delta: number): Promise<void> => {
    const level = Math.max(0, Math.min(100, session.volume + delta));
    try {
      await api.setAudioSession(session.id, level);
      setSessions(prev => prev.map(x => (x.id === session.id ? { ...x, volume: level } : x)));
    } catch (e) { setError(friendlyError(e)); }
  };
  const toggleSessionMute = async (session: AudioSession): Promise<void> => {
    try {
      await api.setAudioSession(session.id, undefined, !session.muted);
      setSessions(prev => prev.map(x => (x.id === session.id ? { ...x, muted: !x.muted } : x)));
      void Haptics.selectionAsync();
    } catch (e) { setError(friendlyError(e)); }
  };

  const run = (job: () => Promise<void>, done: string): void => {
    setError(undefined); setNote(undefined);
    void job().then(() => { setNote(done); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); },
      e => setError(friendlyError(e)));
  };
  const power = (action: PowerAction, label: string, confirm?: string): void => {
    const go = () => run(() => api.power(action), `${label} requested on your computer`);
    if (confirm) Alert.alert(label + ' computer?', confirm, [{ text: 'Cancel', style: 'cancel' }, { text: label, style: action === 'lock' ? 'default' : 'destructive', onPress: go }]);
    else go();
  };
  const nudgeVolume = (delta: number): void => {
    const next = Math.max(0, Math.min(100, (volume ?? 50) + delta));
    setVolume(next);
    run(() => api.setVolume(next, muted), `Volume ${next}%`);
  };
  const toggleMute = (): void => {
    const next = !muted; setMuted(next);
    run(() => api.setVolume(volume ?? 50, next), next ? 'Muted' : 'Unmuted');
  };
  const nudgeBrightness = (delta: number): void => {
    if (brightness == null) return;
    const next = Math.max(0, Math.min(100, brightness + delta));
    setBrightness(next);
    run(() => api.setBrightness(next), `Brightness ${next}%`);
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Control</Text>
      <Text style={{ color: t.sub, fontSize: 15 }}>Power, sound and display on your computer.</Text>
      <Text style={[styles.section, { color: t.sub }]}>POWER</Text>
      <View style={styles.grid}>
        {POWER.map(p => (
          <Pressable key={p.action} accessibilityRole="button" accessibilityLabel={`${p.label} your computer`} onPress={() => power(p.action, p.label, p.confirm)}
            style={({ pressed }) => [styles.tile, { backgroundColor: t.card, opacity: pressed ? 0.6 : 1 }]}>
            <Icon name={p.icon} size={26} color={p.danger ? t.bad : t.tint} />
            <Text style={{ color: p.danger ? t.bad : t.text, fontSize: 15, fontWeight: '600' }}>{p.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={[styles.section, { color: t.sub }]}>VOLUME</Text>
      <View style={[styles.card, { backgroundColor: t.card }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Volume down" onPress={() => nudgeVolume(-10)} style={[styles.step, { backgroundColor: t.fill }]}><Text style={[styles.stepText, { color: t.text }]}>−</Text></Pressable>
        <View style={styles.meterWrap}>
          <View style={[styles.meter, { backgroundColor: t.fill }]}>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: muted ? t.sub : t.tint, width: `${muted ? 0 : volume ?? 0}%` }} />
          </View>
          <Text style={{ color: t.sub, fontSize: 13, textAlign: 'center' }}>{muted ? 'Muted' : `${volume ?? '—'}%`}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Volume up" onPress={() => nudgeVolume(10)} style={[styles.step, { backgroundColor: t.fill }]}><Text style={[styles.stepText, { color: t.text }]}>+</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={muted ? 'Unmute' : 'Mute'} onPress={toggleMute} style={[styles.step, { backgroundColor: muted ? t.bad : t.fill }]}>
          <Icon name={muted ? 'mute' : 'speaker'} size={20} color={muted ? '#fff' : t.text} />
        </Pressable>
      </View>
      {sessions.length ? (
        <>
          <Text style={[styles.section, { color: t.sub }]}>APP VOLUME</Text>
          {sessions.map(session => (
            <View key={session.id} style={[styles.card, { backgroundColor: t.card }]}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Mute ${session.name}`} onPress={() => { void toggleSessionMute(session); }}
                style={[styles.step, { backgroundColor: session.muted ? t.bad : t.fill }]}>
                <Icon name={session.muted ? 'mute' : 'speaker'} size={18} color={session.muted ? '#fff' : t.text} />
              </Pressable>
              <View style={styles.meterWrap}>
                <Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{session.name}</Text>
                <View style={[styles.meter, { backgroundColor: t.fill }]}>
                  <View style={{ height: 6, borderRadius: 3, backgroundColor: session.muted ? t.sub : t.tint, width: `${session.volume}%` }} />
                </View>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`${session.name} volume down`} onPress={() => { void nudgeSession(session, -10); }} style={[styles.stepSmall, { backgroundColor: t.fill }]}><Text style={[styles.stepText, { color: t.text }]}>−</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`${session.name} volume up`} onPress={() => { void nudgeSession(session, 10); }} style={[styles.stepSmall, { backgroundColor: t.fill }]}><Text style={[styles.stepText, { color: t.text }]}>+</Text></Pressable>
            </View>
          ))}
        </>
      ) : null}
      {brightness !== null && brightness !== undefined ? (
        <>
          <Text style={[styles.section, { color: t.sub }]}>BRIGHTNESS</Text>
          <View style={[styles.card, { backgroundColor: t.card }]}>
            <Pressable accessibilityRole="button" accessibilityLabel="Brightness down" onPress={() => nudgeBrightness(-10)} style={[styles.step, { backgroundColor: t.fill }]}><Text style={[styles.stepText, { color: t.text }]}>−</Text></Pressable>
            <View style={styles.meterWrap}>
              <View style={[styles.meter, { backgroundColor: t.fill }]}>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: t.tint, width: `${brightness}%` }} />
              </View>
              <Text style={{ color: t.sub, fontSize: 13, textAlign: 'center' }}>{brightness}%</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Brightness up" onPress={() => nudgeBrightness(10)} style={[styles.step, { backgroundColor: t.fill }]}><Text style={[styles.stepText, { color: t.text }]}>+</Text></Pressable>
          </View>
        </>
      ) : null}
      {onPanic ? (
        <>
          <Text style={[styles.section, { color: t.sub }]}>EMERGENCY</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Panic lock"
            onPress={() => Alert.alert('Panic Lock', 'Lock the computer and unpair this phone immediately? You will need to pair again to reconnect.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Panic Lock', style: 'destructive', onPress: () => {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                void api.panic().then(status => {
                  Alert.alert(status === 'locked' ? 'Computer locked' : 'Phone unpaired', 'This phone has been unpaired. Pair again to reconnect.');
                  onPanic();
                }).catch(e => setError(friendlyError(e)));
              } },
            ])}
            style={[styles.panic, { backgroundColor: t.bad }]}>
            <Icon name="lock" size={20} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>Panic Lock</Text>
          </Pressable>
        </>
      ) : null}
      {note ? <Text style={{ color: t.good, fontSize: 15 }}>{note}</Text> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  section: { fontSize: 13, fontWeight: '500', marginTop: space.s },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.m },
  tile: { flexBasis: '46%', flexGrow: 1, borderRadius: radius, padding: space.l, alignItems: 'center', gap: space.s },
  card: { borderRadius: radius, padding: space.m, flexDirection: 'row', alignItems: 'center', gap: space.m },
  step: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  stepSmall: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 22, fontWeight: '700' },
  meterWrap: { flex: 1, gap: 4 },
  meter: { height: 6, borderRadius: 3, overflow: 'hidden' },
  panic: { borderRadius: radius, padding: space.m, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.s },
});
