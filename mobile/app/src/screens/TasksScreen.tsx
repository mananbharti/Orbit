import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { MicButton } from '../components/MicButton';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AgentApi, DictationApi, TaskStore, TaskSummary } from '@orbit/core';
import { Glass } from '../components/Glass';
import { Icon, type IconName } from '../components/Icon';
import { PressableScale } from '../components/PressableScale';
import { StatusPill } from '../components/StatusPill';
import { friendlyError } from '../orbit';
import { canWake, wakeDesktop } from '../wol';
import { radius, space, useTheme } from '../theme';

const connectionText = { connected: '', connecting: 'Connecting to your computer…', reconnecting: 'Reconnecting…', searching: 'Looking for your computer on this network…', stopped: 'Not connected',
  'authentication-required': 'This computer no longer recognises this phone' } as const;

export function TasksScreen({ store, api, dictation, name, macAddresses, wakePreview, answerOnlyPreview, onOpen, onRepair, onActivity, onApps, onClipboard, onFiles, onRemote, onPresent, onMemory, onControl, onSettings, onComputers, onAutomations, onTerminal, onTabs }: { store: TaskStore; api: AgentApi; dictation: DictationApi; name: string; macAddresses?: string[]; onOpen: (task: TaskSummary) => void; onRepair: () => void; onActivity: () => void; onApps: () => void; onClipboard: () => void; onFiles: () => void; onRemote: () => void; onPresent: () => void; onMemory: () => void; onControl: () => void; onSettings: () => void; onComputers?: () => void; onAutomations?: () => void; onTerminal?: () => void; onTabs?: () => void; wakePreview?: boolean;
  /** Preview only: render the answer-only toggle already switched on. Real phones always start it off. */
  answerOnlyPreview?: boolean }) {
  const t = useTheme();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const offline = state.connection !== 'connected';
  const agentOff = !offline && state.agentAvailable === false;
  const [paused, setPaused] = useState(false);
  const [answerOnlyReady, setAnswerOnlyReady] = useState(false);
  const [answerOnly, setAnswerOnly] = useState(answerOnlyPreview === true);
  const [waking, setWaking] = useState<'no' | 'sending' | 'sent'>('no');
  const wake = async (): Promise<void> => {
    if (!macAddresses?.length || waking !== 'no') return;
    setWaking('sending');
    try { await wakeDesktop(macAddresses); setWaking('sent'); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }
    catch (e) { setWaking('no'); setError(friendlyError(e)); }
  };
  useEffect(() => { if (state.connection === 'connected') api.status().then(s => { setPaused(s.paused); setAnswerOnlyReady(s.answerOnly); }, () => {}); }, [api, state.connection]);
  const setSafeMode = async (pause: boolean): Promise<void> => {
    try { if (pause) await api.pause(); else await api.resume(); setPaused(pause); void store.refresh(); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); }
    catch (e) { setError(friendlyError(e)); }
  };
  const confirmPause = (): void => Alert.alert('Stop the agent?', 'Everything running stops now and no new tasks start until you resume.',
    [{ text: 'Keep running', style: 'cancel' }, { text: 'Stop agent', style: 'destructive', onPress: () => { void setSafeMode(true); } }]);

  const send = async (): Promise<void> => {
    if (!prompt.trim() || sending || offline) return;
    setSending(true); setError(undefined);
    try { await store.submit(prompt, { answerOnly }); setPrompt(''); setAnswerOnly(false); void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }
    catch (e) { setError(friendlyError(e)); }
    finally { setSending(false); }
  };

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: t.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={[styles.title, { color: t.text }]}>Agent</Text>
      <View style={styles.subRow}>
        {onComputers ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Switch computer" onPress={onComputers} style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
            <Text numberOfLines={1} style={[styles.sub, { color: t.sub, flexShrink: 1 }]}>{name}</Text>
            <Text style={{ color: t.sub, fontSize: 13 }}> ›</Text>
          </Pressable>
        ) : <Text numberOfLines={1} style={[styles.sub, { color: t.sub, flexShrink: 1 }]}>{name}</Text>}
        {!paused && !offline && !agentOff ? <Pressable accessibilityRole="button" hitSlop={10} onPress={confirmPause}><Text style={{ color: t.bad, fontSize: 15 }}>Stop agent</Text></Pressable> : null}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={{ gap: space.s, paddingRight: space.l }}>
        {([['Remote', 'remote', onRemote], ['Present', 'present', onPresent], ['Files', 'files', onFiles], ['Clipboard', 'clipboard', onClipboard], ['Memory', 'memory', onMemory], ['Apps', 'apps', onApps], ['Activity', 'activity', onActivity], ...(onAutomations ? [['Automations', 'automations', onAutomations] as [string, IconName, () => void]] : []),
          ...(onTerminal ? [['Terminal', 'terminal', onTerminal] as [string, IconName, () => void]] : []),
          ...(onTabs ? [['Tabs', 'tabs', onTabs] as [string, IconName, () => void]] : []), ['Settings', 'settings', onSettings]] as [string, IconName, () => void][]).map(([label, icon, press]) => (
          <PressableScale key={label} accessibilityRole="button" accessibilityLabel={label} onPress={press}>
            <Glass radius={18} style={styles.chip}>
              <Icon name={icon} size={16} color={t.tint} />
              <Text style={{ color: t.tint, fontSize: 15, fontWeight: '500' }}>{label}</Text>
            </Glass>
          </PressableScale>
        ))}
      </ScrollView>
      {connectionText[state.connection] ? (
        <Pressable disabled={state.connection !== 'authentication-required'} onPress={onRepair}
          style={[styles.banner, { backgroundColor: t.fill }]}>
          <Text style={{ color: t.text, fontSize: 15 }}>{connectionText[state.connection]}{state.connection === 'authentication-required' ? ' Tap to pair again.' : ''}</Text>
        </Pressable>
      ) : null}
      {offline && state.connection !== 'authentication-required' && (wakePreview || canWake(macAddresses)) ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Wake ${name}`} disabled={waking !== 'no'} onPress={() => { if (wakePreview) { setWaking('sent'); } else void wake(); }}
          style={[styles.banner, { backgroundColor: t.tint, opacity: waking === 'sending' ? 0.6 : 1 }]}>
          <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>{waking === 'sent' ? `Wake signal sent. ${name} takes a moment to come online.` : `Wake ${name}`}</Text>
        </Pressable>
      ) : null}
      {agentOff ? (
        <View style={[styles.banner, { backgroundColor: t.fill }]}>
          <Text style={{ color: t.text, fontSize: 15 }}>The agent is not set up on {name}. Open Orbit there, go to Settings, Agent tasks, and paste the Hermes key - it takes a minute and your tasks stay on this computer.</Text>
        </View>
      ) : null}
      {paused && !agentOff ? (
        <Pressable accessibilityRole="button" onPress={() => { void setSafeMode(false); }} style={[styles.banner, { backgroundColor: t.bad + '26' }]}>
          <Text style={{ color: t.bad, fontSize: 15, fontWeight: '600' }}>Agent stopped. Tap to resume.</Text>
        </Pressable>
      ) : null}
      {state.needsAttention.length ? (
        <Pressable onPress={() => onOpen(state.needsAttention[0]!)} style={[styles.attention, { backgroundColor: t.warn + '26' }]}>
          <Text style={{ color: t.warn, fontWeight: '700', fontSize: 16 }}>{state.needsAttention.length === 1 ? '1 task needs you' : `${state.needsAttention.length} tasks need you`}</Text>
        </Pressable>
      ) : null}
      <FlatList data={state.tasks} keyExtractor={x => x.taskId} contentContainerStyle={{ gap: space.m, paddingBottom: space.xl }}
        ListEmptyComponent={<Text style={[styles.empty, { color: t.sub }]}>{agentOff ? '' : 'Ask your agent to do something. You will see its progress here and can stop it any time.'}</Text>}
        renderItem={({ item }) => (
          <PressableScale accessibilityRole="button" onPress={() => onOpen(item)} style={[styles.card, { backgroundColor: t.card, shadowColor: t.shadow, shadowOpacity: t.isDark ? 0 : 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: t.isDark ? 0 : 1 }]}>
            <Text numberOfLines={2} style={[styles.headline, { color: t.text }]}>{item.headline || 'Task'}</Text>
            <StatusPill state={item.state} />
          </PressableScale>
        )} />
      {error ? <Text style={{ color: t.bad, marginBottom: space.s }}>{error}</Text> : null}
      {agentOff ? null : (
      <>
      {answerOnlyReady && !offline ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Answer only, no actions" onPress={() => setAnswerOnly(v => !v)}>
          <Glass radius={18} style={[styles.answerChip, { borderColor: answerOnly ? t.tint : 'transparent' }]}>
            <View style={[styles.answerDot, { borderColor: answerOnly ? t.tint : t.sub, backgroundColor: answerOnly ? t.tint : 'transparent' }]} />
            <Text style={{ color: answerOnly ? t.tint : t.sub, fontSize: 14, fontWeight: '600' }}>{answerOnly ? 'Answer only - a text reply from this computer, no actions' : 'Answer only'}</Text>
          </Glass>
        </Pressable>
      ) : null}
      <Glass radius={24} style={styles.composer}>
        <TextInput value={prompt} onChangeText={setPrompt} placeholder="What should I do?" placeholderTextColor={t.sub} multiline
          style={[styles.input, { color: t.text }]} maxLength={4000} accessibilityLabel="Describe a task" />
        <MicButton api={dictation} onText={text => setPrompt(p => (p ? `${p} ${text}` : text).slice(0, 4000))} onError={setError} />
        <Pressable accessibilityRole="button" accessibilityLabel="Send task" disabled={!prompt.trim() || sending || offline || paused} onPress={() => { void send(); }}
          style={[styles.send, { backgroundColor: !prompt.trim() || offline ? t.fill : t.tint }]}>
          <Icon name="send" size={20} color="#FFFFFF" />
        </Pressable>
      </Glass>
      </>
      )}
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space.l, paddingTop: 70, paddingBottom: space.l },
  answerChip: { minHeight: 44, paddingHorizontal: space.m, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: space.s, alignSelf: 'stretch', borderWidth: 1 },
  answerDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5 },
  title: { fontSize: 34, fontWeight: '700' }, sub: { fontSize: 15 },
  chips: { flexGrow: 0, flexShrink: 0, marginBottom: space.m },
  chip: { minHeight: 40, paddingHorizontal: space.l, flexDirection: 'row', alignItems: 'center', gap: 6 },
  subRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.m },
  banner: { padding: space.m, borderRadius: radius, marginBottom: space.m },
  attention: { padding: space.m, borderRadius: radius, marginBottom: space.m },
  card: { padding: space.l, borderRadius: radius, gap: space.s },
  headline: { fontSize: 17, fontWeight: '600' },
  empty: { fontSize: 17, lineHeight: 22, textAlign: 'center', marginTop: 60, paddingHorizontal: space.xl },
  composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 6, gap: 6 },
  input: { flex: 1, fontSize: 17, maxHeight: 120, paddingHorizontal: 12, paddingVertical: 8 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#fff', fontSize: 20, fontWeight: '700' },
});
