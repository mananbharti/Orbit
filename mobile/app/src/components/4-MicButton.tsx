import * as Haptics from 'expo-haptics';
import { AudioQuality, IOSOutputFormat, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, type RecordingOptions } from 'expo-audio';
import { File } from 'expo-file-system';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { WavError, wavToPcm16k, type DictationApi } from '@orbit/core';
import { friendlyError } from '../orbit';
import { useTheme } from '../theme';

// iOS records uncompressed 16 kHz mono PCM straight into a WAV file. Android has no such path in Expo yet, so the button is hidden there.
const OPTIONS: RecordingOptions = { extension: '.wav', sampleRate: 16_000, numberOfChannels: 1, bitRate: 256_000,
  android: { extension: '.m4a', outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { extension: '.wav', sampleRate: 16_000, outputFormat: IOSOutputFormat.LINEARPCM, audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
  web: {} };

function readAll(file: File): Uint8Array {
  const handle = file.open();
  try { handle.offset = 0; return handle.readBytes(file.size); } finally { handle.close(); }
}

/** Tap to start, tap to stop. The clip goes to your computer for transcription; the file is deleted right after. UNTESTED ON A REAL iPHONE. */
export function MicButton({ api, onText, onError }: { api: DictationApi; onText: (text: string) => void; onError: (message: string) => void }) {
  const t = useTheme();
  const recorder = useAudioRecorder(OPTIONS);
  const [state, setState] = useState<'idle' | 'recording' | 'working'>('idle');
  if (Platform.OS !== 'ios') return null;

  const start = async (): Promise<void> => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) { onError('Allow the microphone in Settings to dictate.'); return; }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record(); setState('recording'); void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (e) { setState('idle'); onError(friendlyError(e)); }
  };
  const stop = async (): Promise<void> => {
    setState('working');
    let file: File | undefined;
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      if (!recorder.uri) throw new WavError('EMPTY');
      file = new File(recorder.uri);
      const pcm = wavToPcm16k(readAll(file));
      const result = await api.transcribe(pcm);
      if (result.status === 'text') onText(result.text); else onError('I did not hear anything.');
    } catch (e) {
      onError(e instanceof WavError ? 'That recording could not be read.' : friendlyError(e));
    } finally { try { file?.delete(); } catch { /* already gone */ } setState('idle'); }
  };

  return (
    <View style={styles.wrap}>
      {state === 'recording' ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 13 }}>● Recording</Text> : null}
      {state === 'working' ? <Text style={{ color: t.sub, fontSize: 13 }}>Transcribing…</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={state === 'recording' ? 'Stop dictation' : 'Start dictation'} disabled={state === 'working'}
        onPress={() => { void (state === 'recording' ? stop() : start()); }} style={[styles.btn, { backgroundColor: state === 'recording' ? t.bad : t.fill }]}>
        <Text style={{ fontSize: 18 }}>{state === 'recording' ? '■' : '🎙'}</Text>
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create({ wrap: { alignItems: 'center', justifyContent: 'center', gap: 2 }, btn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' } });
