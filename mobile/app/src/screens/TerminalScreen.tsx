import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TerminalApi } from '@orbit/core';
import { friendlyError } from '../orbit';
import { BackButton } from '../components/BackButton';
import { Icon } from '../components/Icon';
import { radius, space, useTheme } from '../theme';

interface Line { id: number; stream: 'cmd' | 'stdout' | 'stderr' | 'note'; text: string }
const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });
const MAX_LINES = 500;

export function TerminalScreen({ api, onBack, initialState }: { api: TerminalApi; onBack: () => void; initialState?: { cwd: string; lines: Line[] } }) {
  const t = useTheme();
  const [cwd, setCwd] = useState<string | undefined>(initialState?.cwd);
  const [lines, setLines] = useState<Line[]>(initialState?.lines ?? []);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const nextId = useRef((initialState?.lines.length ?? 0) + 1);
  const scroll = useRef<ScrollView>(null);

  const append = (stream: Line['stream'], text: string): void => {
    const parts = text.replace(/\r/g, '').split('\n');
    setLines(prev => [...prev, ...parts.filter((p, i) => p !== '' || i < parts.length - 1).map(p => ({ id: nextId.current++, stream, text: p }))].slice(-MAX_LINES));
  };

  useEffect(() => api.onOutput((stream, data) => append(stream, data)), [api]);

  async function begin(): Promise<void> {
    setStarting(true); setError('');
    try {
      const { cwd: dir } = await api.begin();
      setCwd(dir);
      append('note', 'Session approved.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) { setError(friendlyError(e)); }
    finally { setStarting(false); }
  }

  async function exec(): Promise<void> {
    const command = input.trim();
    if (!command || running) return;
    setInput(''); setRunning(true); setError('');
    append('cmd', command);
    try {
      const result = await api.exec(command);
      if (result.cwd !== cwd) setCwd(result.cwd);
      if (result.truncated) append('note', '(output was too long - the command was stopped)');
      if (result.timedOut) append('note', '(timed out - the command was stopped)');
      if (result.exitCode !== 0 && result.exitCode !== null) append('note', `(exit code ${result.exitCode})`);
    } catch (e) {
      const message = friendlyError(e);
      if (/session/i.test(message)) { setCwd(undefined); append('note', 'The session ended.'); }
      else setError(message);
    } finally { setRunning(false); }
  }

  async function end(): Promise<void> {
    await api.end();
    setCwd(undefined); setLines([]); setError('');
    void Haptics.selectionAsync();
  }

  if (cwd === undefined) {
    return (
      <View style={[styles.root, { backgroundColor: t.bg }]}>
        <BackButton onPress={onBack} />
        <Text style={[styles.title, { color: t.text }]}>Terminal</Text>
        <View style={[styles.card, { backgroundColor: t.card }]}>
          <Text style={{ color: t.text, fontSize: 17, lineHeight: 24 }}>Run commands on your computer from here.</Text>
          <Text style={{ color: t.sub, fontSize: 13, lineHeight: 18 }}>Each session needs a Yes on the computer's screen, and only one runs at a time. Sessions close on their own after 5 idle minutes.</Text>
        </View>
        {error ? <Text style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
        <Pressable accessibilityRole="button" disabled={starting} onPress={() => { void begin(); }} style={[styles.primary, { backgroundColor: t.tint, opacity: starting ? 0.5 : 1 }]}>
          {starting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={{ color: '#FFFFFF', fontSize: 17, fontWeight: '600' }}>Start session</Text>}
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <BackButton onPress={() => { void api.end().finally(onBack); }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[styles.title, { color: t.text }]}>Terminal</Text>
        <Pressable accessibilityRole="button" onPress={() => { void end(); }} hitSlop={10}><Text style={{ color: t.bad, fontSize: 15 }}>End session</Text></Pressable>
      </View>
      <Text numberOfLines={1} style={{ color: t.sub, fontSize: 13, fontFamily: mono }}>{cwd}</Text>
      <ScrollView ref={scroll} style={[styles.output, { backgroundColor: '#0D0D0F' }]} contentContainerStyle={{ padding: space.m, gap: 1 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
        {lines.length === 0 ? <Text style={{ color: '#636366', fontFamily: mono, fontSize: 13 }}>Ready.</Text> : lines.map(line => (
          <Text key={line.id} selectable style={{ fontFamily: mono, fontSize: 13, lineHeight: 18,
            color: line.stream === 'cmd' ? '#0A84FF' : line.stream === 'stderr' ? '#FF453A' : line.stream === 'note' ? '#636366' : '#F2F2F7' }}>
            {line.stream === 'cmd' ? `$ ${line.text}` : line.text}
          </Text>
        ))}
      </ScrollView>
      {error ? <Text style={{ color: t.bad, fontSize: 15 }}>{error}</Text> : null}
      <View style={{ flexDirection: 'row', gap: space.s, alignItems: 'flex-end' }}>
        <TextInput value={input} onChangeText={setInput} placeholder="Type a command" placeholderTextColor={t.sub}
          autoCapitalize="none" autoCorrect={false} autoComplete="off" spellCheck={false} editable={!running}
          onSubmitEditing={() => { void exec(); }} returnKeyType="send" enablesReturnKeyAutomatically
          style={[styles.input, { backgroundColor: t.card, color: t.text, fontFamily: mono }]} />
        {running ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Stop the running command" onPress={() => { void api.interrupt(); }}
            style={[styles.send, { backgroundColor: t.bad }]}>
            <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '700' }}>■</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel="Run command" disabled={!input.trim()} onPress={() => { void exec(); }}
            style={[styles.send, { backgroundColor: t.tint, opacity: input.trim() ? 1 : 0.4 }]}>
            <Icon name="send" size={18} color="#FFFFFF" />
          </Pressable>
        )}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: space.l, paddingTop: 70, gap: space.m },
  title: { fontSize: 34, fontWeight: '700' },
  card: { padding: space.l, borderRadius: radius, gap: space.s },
  primary: { borderRadius: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  output: { flex: 1, borderRadius: radius },
  input: { flex: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, maxHeight: 100 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
