/** Automatic two-way clipboard sync while the app is open: computer -> phone is applied the moment it arrives,
 *  phone -> computer is sent when the phone clipboard changes. Never runs when the user turned it off. */
import * as Clipboard from 'expo-clipboard';
import type { ClipboardApi } from '@orbit/core';

export interface AutoSync {
  setEnabled(on: boolean): void;
  stop(): void;
}

export function startClipboardAutoSync(api: ClipboardApi, onApplied: (text: string) => void): AutoSync {
  let enabled = true;
  let appliedRevision = -1;
  let lastWritten = ''; // text we put on the phone clipboard ourselves: never send it back
  let sending = false;

  const unsub = api.subscribe(() => {
    const { incoming } = api.getState();
    if (!enabled || !incoming || incoming.revision === appliedRevision) return;
    appliedRevision = incoming.revision;
    lastWritten = incoming.text;
    void Clipboard.setStringAsync(incoming.text).then(() => onApplied(incoming.text), () => {});
  });

  const listener = Clipboard.addClipboardListener(() => {
    if (!enabled || sending) return;
    void (async () => {
      const text = await Clipboard.getStringAsync();
      if (!text || text === lastWritten || sending) return;
      sending = true;
      try { await api.send(text); } catch { /* offline or conflict: the next change retries */ }
      finally { sending = false; }
    })();
  });

  return {
    setEnabled(on) { enabled = on; },
    stop() { unsub(); listener.remove(); },
  };
}
