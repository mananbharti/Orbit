import * as Haptics from 'expo-haptics';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { BackButton } from '../components/BackButton';
import { radius, space, useTheme, useThemePref, type ThemePref } from '../theme';

const options: { value: ThemePref; label: string }[] = [{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];

export function SettingsScreen({ name, onBack, onRepair, autoSync, onAutoSync, appLock, onAppLock, biometrics }: { name: string; onBack: () => void; onRepair: () => void; autoSync: boolean; onAutoSync: (on: boolean) => void; appLock: boolean; onAppLock: (on: boolean) => void; biometrics: boolean }) {
  const t = useTheme();
  const { pref, setPref } = useThemePref();
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.root}>
      <BackButton onPress={onBack} />
      <Text style={[styles.title, { color: t.text }]}>Settings</Text>
      <Text style={[styles.section, { color: t.sub }]}>APPEARANCE</Text>
      <View style={[styles.segment, { backgroundColor: t.fill }]} accessibilityRole="radiogroup">
        {options.map(o => {
          const on = pref === o.value;
          return (
            <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => { setPref(o.value); void Haptics.selectionAsync(); }}
              style={[styles.seg, on && { backgroundColor: t.isDark ? '#636366' : t.card }]}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: on ? '600' : '400' }}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={{ color: t.sub, fontSize: 13 }}>Auto follows your phone's light or dark setting.</Text>
      <Text style={[styles.section, { color: t.sub }]}>CLIPBOARD</Text>
      <View style={[styles.card, { backgroundColor: t.card }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: t.text, fontSize: 17 }}>Auto-sync clipboard</Text>
            <Text style={{ color: t.sub, fontSize: 13, lineHeight: 18 }}>Copy on one device, paste on the other, while Orbit is open.</Text>
          </View>
          <Switch value={autoSync} onValueChange={v => { onAutoSync(v); void Haptics.selectionAsync(); }} trackColor={{ true: t.good }} />
        </View>
      </View>
      <Text style={[styles.section, { color: t.sub }]}>SECURITY</Text>
      <View style={[styles.card, { backgroundColor: t.card }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: t.text, fontSize: 17 }}>Require Face ID</Text>
            <Text style={{ color: t.sub, fontSize: 13, lineHeight: 18 }}>{biometrics ? 'Ask for Face ID before Orbit connects to your computer.' : 'This phone has no face or fingerprint enrolled, so Orbit cannot gate the connection.'}</Text>
          </View>
          <Switch value={appLock && biometrics} disabled={!biometrics} onValueChange={v => { onAppLock(v); void Haptics.selectionAsync(); }} trackColor={{ true: t.good }} />
        </View>
      </View>
      <Text style={[styles.section, { color: t.sub }]}>COMPUTER</Text>
      <View style={[styles.card, { backgroundColor: t.card }]}>
        <Text style={{ color: t.text, fontSize: 17 }}>{name}</Text>
        <Pressable accessibilityRole="button" onPress={onRepair} style={{ minHeight: 44, justifyContent: 'center' }}>
          <Text style={{ color: t.bad, fontSize: 17 }}>Forget this computer</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  root: { flexGrow: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  section: { fontSize: 13, fontWeight: '500', marginTop: space.m },
  segment: { flexDirection: 'row', borderRadius: 10, padding: 2 },
  seg: { flex: 1, minHeight: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  card: { padding: space.l, borderRadius: radius, gap: space.s },
});
