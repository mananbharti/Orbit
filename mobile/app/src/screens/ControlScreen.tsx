import { BackButton } from '../components/BackButton';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AudioSession, DisplayMode, DisplayTheme, MediaAction, NlControlApi, NlOutcome, PowerAction, SystemApi } from '@orbit/core';
import { Icon, type IconName } from '../components/Icon';
import { CommandError } from '@orbit/core';
import { friendlyError } from '../orbit';
import { radius, space, useTheme } from '../theme';

const POWER: { action: PowerAction; label: string; icon: IconName; danger?: boolean; confirm?: string }[] = [
  { action: 'lock', label: 'Lock', icon: 'lock' },
  { action: 'sleep', label: 'Sleep', icon: 'moon', confirm: 'Put your computer to sleep?' },
  { action: 'restart', label: 'Restart', icon: 'refresh', danger: true, confirm: 'Restart your computer? Unsaved work will be lost.' },
  { action: 'shutdown', label: 'Shut down', icon: 'power', danger: true, confirm: 'Shut down your computer? Unsaved work will be lost.' },
];

const MEDIA: { action: MediaAction; label: string; icon: IconName }[] = [
  { action: 'previous', label: 'Previous track', icon: 'previous' },
  { action: 'playpause', label: 'Play or pause', icon: 'play' },
  { action: 'next', label: 'Next track', icon: 'next' },
];

export function ControlScreen({ api, nl, onBack, onPanic }: { api: SystemApi; nl: NlControlApi; onBack: () => void; onPanic?: () => void }) {
  const t = useTheme();
  const [volume, setVolume] = useState<number>();
  const [muted, setMuted] = useState(false);
  const [brightness, setBrightness] = useState<number | null>();
  const [mode, setMode] = useState<DisplayMode | null>();
  const [sessions, setSessions] = useState<AudioSession[]>([]);
  const [volumeSupported, setVolumeSupported] = useState(true);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getVolume().then(v => { setVolume(v.level); setMuted(v.muted); }).catch(e => {
      // A desktop without sound control (e.g. macOS has no adapter) must not leave a dead card on screen - hide it like the theme and brightness cards.
      if (e instanceof CommandError && e.code === 'SYSTEM_UNAVAILABLE') setVolumeSupported(false);
    });
    api.getBrightness().then(setBrightness).catch(() => setBrightness(null));
    api.getMode().then(setMode).catch(() => setMode(null));
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

  const say = (): void => {
    const text = phrase.trim();
    if (!text || busy) return;
    setBusy(true); setError(undefined); setNote(undefined);
    const describe = (out: NlOutcome): string =>
      out.status === 'executed' ? 'Done on your computer'
      : out.status === 'rejected' ? `Not allowed (${out.error})`
      : out.status === 'unclear' ? out.hint
      : "Didn't understand - try 'volume 50' or 'agla gana'";
    void nl.say(text).then(out => {
      // Only 'executed' is success: rejected/unclear/unknown all mean nothing happened - show them as errors, not green notes.
      if (out.status === 'executed') { setNote(describe(out)); setPhrase(''); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }
      else setError(describe(out));
    }, e => setError(friendlyError(e))).finally(() => setBusy(false));
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

  const pickTheme = (theme: DisplayTheme): void => {
    if (!mode || mode.theme === theme) return;
    setMode({ ...mode, theme });
    run(() => api.setMode({ theme }), theme === 'dark' ? 'Dark theme on your computer' : 'Light theme on your computer');
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={styles.root}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Control</Text>
      <Text style={{ color: t.sub, fontSize: 15 }}>Power, sound and display on your computer.</Text>
      {note ? <Text style={{ color: t.good, fontSize: 15 }}>{note}</Text> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
      <Text style={[styles.section, { color: t.sub }]}>SAY IT</Text>
      <View style={[styles.card, styles.sayRow, { backgroundColor: t.card }]}>
        <TextInput
          style={[styles.sayInput, { color: t.text, borderColor: t.fill }]}
          placeholder="volume 50, agla gana, open chrome..."
          placeholderTextColor={t.sub}
          value={phrase}
          onChangeText={setPhrase}
          onSubmitEditing={say}
          maxLength={200}
          returnKeyType="send"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Tell your computer what to do"
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Send to your computer" onPress={say}
          style={({ pressed }) => [styles.step, { backgroundColor: t.tint, opacity: pressed || busy ? 0.6 : 1 }]}>
          <Icon name="next" size={18} color="#fff" />
        </Pressable>
      </View>
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
      <Text style={[styles.section, { color: t.sub }]}>MEDIA</Text>
      <View style={[styles.card, styles.mediaRow, { backgroundColor: t.card }]}>
        {MEDIA.map(m => (
          <Pressable key={m.action} accessibilityRole="button" accessibilityLabel={`${m.label} on your computer`}
            onPress={() => run(() => api.mediaTransport(m.action), m.action === 'playpause' ? 'Play/pause sent to your computer' : `${m.label} on your computer`)}
            style={[styles.step, { backgroundColor: t.fill }]}>
            <Icon name={m.icon} size={20} color={t.text} />
          </Pressable>
        ))}
      </View>
      {volumeSupported ? (
      <>
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
      </>
      ) : null}
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
      {mode && mode.theme !== null ? (
        <>
          <Text style={[styles.section, { color: t.sub }]}>THEME</Text>
          <View style={[styles.card, { backgroundColor: t.card }]}>
            {(['dark', 'light'] as const).map(themeOption => {
              const active = mode.theme === themeOption;
              return (
                <Pressable key={themeOption} accessibilityRole="button" accessibilityLabel={`${themeOption === 'dark' ? 'Dark' : 'Light'} theme on your computer`}
                  accessibilityState={{ selected: active }} onPress={() => pickTheme(themeOption)}
                  style={({ pressed }) => [styles.themeChoice, { backgroundColor: active ? t.tint : t.fill, opacity: pressed ? 0.6 : 1 }]}>
                  <Icon name={themeOption === 'dark' ? 'moon' : 'sun'} size={18} color={active ? '#fff' : t.text} />
                  <Text style={{ color: active ? '#fff' : t.text, fontSize: 15, fontWeight: '600' }}>{themeOption === 'dark' ? 'Dark' : 'Light'}</Text>
                </Pressable>
              );
            })}
          </View>
          {mode.nightLight !== null ? (
            <View style={[styles.card, { backgroundColor: t.card }]}>
              <View style={styles.meterWrap}>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>Night light</Text>
                <Text style={{ color: t.sub, fontSize: 13 }}>Warmer colors in the evening.</Text>
              </View>
              <Pressable accessibilityRole="switch" accessibilityLabel="Night light" accessibilityState={{ checked: mode.nightLight }}
                onPress={() => { const next = !mode.nightLight; setMode({ ...mode, nightLight: next }); run(() => api.setMode({ nightLight: next }), next ? 'Night light on' : 'Night light off'); }}
                style={[styles.nightToggle, { backgroundColor: mode.nightLight ? t.tint : t.fill, justifyContent: mode.nightLight ? 'flex-end' : 'flex-start' }]}>
                <View style={styles.nightKnob} />
              </Pressable>
            </View>
          ) : null}
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
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  sayRow: { flexDirection: 'row', alignItems: 'center', gap: space.s, padding: space.s },
  sayInput: { flex: 1, borderWidth: 1, borderRadius: radius, paddingHorizontal: space.m, paddingVertical: 10, fontSize: 15 },
  root: { padding: space.l, paddingTop: 70, paddingBottom: 40, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  section: { fontSize: 13, fontWeight: '500', marginTop: space.s },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.m },
  tile: { flexBasis: '46%', flexGrow: 1, borderRadius: radius, padding: space.l, alignItems: 'center', gap: space.s },
  card: { borderRadius: radius, padding: space.m, flexDirection: 'row', alignItems: 'center', gap: space.m },
  step: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  mediaRow: { justifyContent: 'space-evenly' },
  stepSmall: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 22, fontWeight: '700' },
  meterWrap: { flex: 1, gap: 4 },
  meter: { height: 6, borderRadius: 3, overflow: 'hidden' },
  themeChoice: { flex: 1, borderRadius: radius - 4, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.s },
  nightToggle: { width: 46, height: 28, borderRadius: 14, padding: 2, flexDirection: 'row', alignItems: 'center' },
  nightKnob: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' },
  panic: { borderRadius: radius, padding: space.m, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.s },
});
