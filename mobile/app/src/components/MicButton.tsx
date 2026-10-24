import * as Haptics from 'expo-haptics';
import { AudioQuality, IOSOutputFormat, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, type RecordingOptions } from 'expo-audio';
import { File } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { WavError, wavToPcm16k, type DictationApi, type DictationInsertOutcome, type DictationSetupState } from '@orbit/core';
import { friendlyError } from '../orbit';
import { useTheme } from '../theme';

// iOS records uncompressed 16 kHz mono PCM into a WAV file. Expo cannot do that on Android, so Android records m4a and the computer decodes it.
const OPTIONS: RecordingOptions = { extension: '.wav', sampleRate: 16_000, numberOfChannels: 1, bitRate: 256_000,
  android: { extension: '.m4a', outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { extension: '.wav', sampleRate: 16_000, outputFormat: IOSOutputFormat.LINEARPCM, audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
  web: {} };

function readAll(file: File): Uint8Array {
  const handle = file.open();
  try { handle.offset = 0; return handle.readBytes(file.size); } finally { handle.close(); }
}

/** Tap to start, tap to stop. The clip goes to your computer for transcription; the file is deleted right after. UNTESTED ON A REAL PHONE (iPhone or Android). */
export function MicButton({ api, onText, onError }: { api: DictationApi; onText: (text: string) => void; onError: (message: string) => void }) {
  const t = useTheme();
  const recorder = useAudioRecorder(OPTIONS);
  const [state, setState] = useState<'idle' | 'recording' | 'working'>('idle');
  const [setup, setSetup] = useState<DictationSetupState | undefined>(undefined);
  const [offer, setOffer] = useState<{ dictationId: string; target?: string } | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  // Older desktops without dictation.status throw; treat them as ready (they only ever ran an env-configured engine).
  useEffect(() => { let live = true; api.setupState().then(s => { if (live) setSetup(s); }).catch(() => undefined); return () => { live = false; }; }, [api]);
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;

  const retry = async (): Promise<void> => {
    try { setSetup(await api.retrySetup()); } catch (e) { onError(friendlyError(e)); }
  };
  const cancelSetup = async (): Promise<void> => {
    try { setSetup(await api.cancelSetup()); } catch (e) { onError(friendlyError(e)); }
  };

  const start = async (): Promise<void> => {
    try {
      // Check the computer's dictation engine before recording so a one-time download or failed setup surfaces honestly instead of a dead transcription. Retry and cancel are explicit user actions below, never side effects of tapping the mic.
      try {
        const now = await api.setupState(); setSetup(now);
        if (now.state === 'downloading') return;
        if (now.state === 'failed') return;
        if (now.state === 'off') { onError('Dictation is not available on this computer.'); return; }
      } catch { /* older desktop: proceed */ }
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) { onError('Allow the microphone in Settings to dictate.'); return; }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record(); setOffer(undefined); setNotice(undefined); setState('recording'); void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
      const bytes = readAll(file);
      // iOS wrote uncompressed WAV. Android wrote m4a; the computer decodes it and needs ffmpeg (ORBIT_FFMPEG).
      const { result, dictationId } = Platform.OS === 'ios' ? await api.transcribeForInsert(wavToPcm16k(bytes)) : await api.transcribeCompressedForInsert(bytes);
      if (result.status === 'text') {
        onText(result.text);
        // The computer may offer to paste this into the window that was focused when recording began; the user decides per use.
        if (dictationId) setOffer({ dictationId, ...(result.insertTarget ? { target: result.insertTarget } : {}) });
      } else onError('I did not hear anything.');
    } catch (e) {
      onError(e instanceof WavError ? 'That recording could not be read.' : friendlyError(e));
    } finally { try { file?.delete(); } catch { /* already gone */ } setState('idle'); }
  };

  const insertOutcomeText: Record<DictationInsertOutcome, string> = {
    'paste-sent': 'Sent to your computer - check that it landed in the right window.',
    unavailable: 'Insertion is not available for that window.',
    'unsupported-target': 'That app cannot receive pasted text.',
    'activation-failed': 'The window you dictated from is no longer available; nothing was sent.',
    'focus-mismatch': 'The window you dictated from is no longer focused; nothing was sent.',
    'focus-lost': 'Focus changed during insertion - the text may have landed in the wrong window. Check your computer.',
    'paste-failed': 'The paste failed on the computer; nothing was sent.',
    'clipboard-unavailable': "The computer's clipboard is not usable right now; nothing was sent.",
  };
  const insert = async (): Promise<void> => {
    if (!offer) return;
    setState('working');
    try {
      const outcome = await api.confirmInsert(offer.dictationId);
      setNotice(insertOutcomeText[outcome]);
    } catch { setNotice('The insert offer expired; dictate again.'); }
    finally { setOffer(undefined); setState('idle'); }
  };
  const dismissOffer = (): void => {
    if (offer) void api.discard(offer.dictationId);
    setOffer(undefined);
  };

  const settingUp = setup?.state === 'downloading';
  return (
    <View style={styles.wrap}>
      {state === 'recording' ? <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 13 }}>● Recording</Text> : null}
      {state === 'working' ? <Text style={{ color: t.sub, fontSize: 13 }}>Transcribing…</Text> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={{ color: t.sub, fontSize: 13 }}>{notice}</Text> : null}
      {offer ? (
        <View style={styles.row}>
          <Text accessibilityLiveRegion="polite" style={{ color: t.text, fontSize: 13 }}>Also insert into {offer.target ?? 'the window you dictated from'}?</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Insert dictated text into the computer window" onPress={() => { void insert(); }} style={[styles.small, { borderColor: t.line }]}>
            <Text style={{ color: t.text, fontSize: 12 }}>Insert</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss insert offer" onPress={dismissOffer} style={[styles.small, { borderColor: t.line }]}>
            <Text style={{ color: t.sub, fontSize: 12 }}>Not now</Text>
          </Pressable>
        </View>
      ) : null}
      <SetupNotice setup={setup} onRetry={() => { void retry(); }} onCancel={() => { void cancelSetup(); }} />
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={state === 'recording' ? 'Stop dictation' : 'Start dictation'} disabled={state === 'working' || settingUp}
          onPress={() => { void (state === 'recording' ? stop() : start()); }} style={[styles.btn, { backgroundColor: state === 'recording' ? t.bad : t.fill, opacity: state === 'working' || settingUp ? 0.5 : 1 }]}>
          <Text style={{ fontSize: 18 }}>{state === 'recording' ? '■' : '🎙'}</Text>
        </Pressable>
      </View>
    </View>
  );
}
/** Visible, explicit dictation-setup surface: one-time download state with a real Cancel, failure with a real Retry. Nothing here fires a download on its own. Exported so the exact states can be render-verified off-device. */
export function SetupNotice({ setup, onRetry, onCancel }: { setup?: DictationSetupState; onRetry: () => void; onCancel: () => void }) {
  const t = useTheme();
  if (!setup || setup.state === 'ready') return null;
  if (setup.state === 'off') return <Text accessibilityLiveRegion="polite" style={{ color: t.sub, fontSize: 13 }}>Dictation is not available on this computer.</Text>;
  if (setup.state === 'downloading') {
    return (
      <View style={styles.row}>
        <Text accessibilityLiveRegion="polite" style={{ color: t.sub, fontSize: 13 }}>Setting up dictation on your computer (one-time download)…</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel dictation setup" onPress={onCancel} style={[styles.small, { borderColor: t.line }]}>
          <Text style={{ color: t.sub, fontSize: 12 }}>Cancel</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <Text accessibilityLiveRegion="polite" style={{ color: t.bad, fontSize: 13 }}>Dictation setup {setup.reason === 'cancelled' ? 'was cancelled' : 'failed'} on your computer.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Retry dictation setup" onPress={onRetry} style={[styles.small, { borderColor: t.line }]}>
        <Text style={{ color: t.text, fontSize: 12 }}>Retry</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { alignItems: 'center', justifyContent: 'center', gap: 2 }, row: { flexDirection: 'row', alignItems: 'center', gap: 8 }, btn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }, small: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 } });
