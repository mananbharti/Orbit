# Local voice dictation (P4)

Goal: Wispr-Flow-style dictation that is offline, free and private. Hold a key (desktop) or tap the mic (phone), speak, and the text lands at the cursor or in the task box.

## What exists now
- `desktop/src/dictation/vad.ts` - trims leading/trailing silence, ignores clicks and coughs.
- `desktop/src/dictation/cleanup.ts` - removes unambiguous fillers (um, uh...), personal dictionary (whole words, longest first, literal replacement), spacing and capitals, Hindi danda.
- `desktop/src/dictation/pipeline.ts` - clip -> VAD -> local `Transcriber` -> cleanup. Audio lives only in memory and is wiped on every path (success, no speech, error, cancel). Errors surface as safe codes only.
- All covered by tests with synthetic audio (`desktop/test/dictation.test.ts`).

## Engine provisioning (built Oct 24)
- `desktop/src/dictation/provision.ts` - first run downloads one pinned whisper.cpp build (`b5454`, ggml-org release) and one pinned model (ggml-tiny, ~75 MB) into the private data directory, verifies both against recorded sha256 hashes before anything runs, extracts with the system `tar` (bsdtar on Windows 10+), and only then registers `dictation.*`. Both entrypoints (CLI and the Electron tray app) wire this; before this change the tray app never constructed an engine at all.
- Platforms: Windows x64 and Linux x64 auto-provision. macOS and other targets report unavailable and point at the manual env override below; nothing is downloaded there.
- `ORBIT_WHISPER_BIN` + `ORBIT_WHISPER_MODEL` always win and skip every download. Provisioning contacts github.com and huggingface.co exactly once per computer; whisper.cpp and the Whisper models are MIT licensed.
- Verified end to end (2026-10-24, Linux sandbox): real downloads passed hash verification, the extracted prebuilt `whisper-cli` transcribed real 16 kHz speech (the standard jfk.wav sample) through `WhisperCpp` and through the full `dictate` pipeline with the correct transcript. Hinglish accuracy still needs real recorded clips; no accuracy claim is made.

## Not built yet
1. Hinglish accuracy: a first bounded measurement landed 2026-10-24 (scripts/eval-dictation-hindi.mjs). Corpus: 10 clips from the Google FLEURS hi_in test split (CC-BY-4.0, read Hindi sentences, NOT conversational Hinglish and NOT code-mixed). On this sample with whisper.cpp b5454: tiny and base transcribe Hindi into romanized (Latin-script) output - unusable for Hindi text; small produces Devanagari at ~53% average WER with 0/10 exact matches, and 1 clip gated as no-speech. English by contrast is exact on the pinned JFK clip with all three models. Consequences: Hindi/Hinglish dictation is NOT good enough to claim yet even at small; real conversational Hinglish clips are still unmeasured; accuracy numbers above describe this 10-clip read-Hindi sample only and say nothing about other speech.
3. ~~Hold-to-talk hotkey and text insertion at the cursor on the desktop, mic indicator,~~ and the phone mic button (phone records, streams 16 kHz PCM to the paired desktop over the existing pinned channel, desktop transcribes, text returns). The desktop hotkey shipped 2026-10-24 as a toggle (press to start, press again to stop), not hold-to-talk.
4. Optional local LLM polish (off by default).

## Privacy rules (enforced in code where possible)
- Audio never leaves the paired devices; no cloud engine is a valid `Transcriber`.
- Nothing is stored after transcription; buffers are zeroed.
- A mic indicator is always shown while recording.

## Prior art
OpenWhispr and VoiceFlow are MIT: ideas and architecture only, attribution if any code is ever reused. Nothing has been copied.

## Running it
Desktop (Windows x64 / Linux x64): nothing to set up. On first start the app downloads the pinned engine + model into the private data directory (one time, ~85 MB) and dictation switches on when verification passes; if the download or hash check fails, dictation stays off and the failure is logged (metadata only). To use your own engine or a bigger model, set `ORBIT_WHISPER_BIN` and `ORBIT_WHISPER_MODEL` before start - the override skips all downloads. macOS: install whisper.cpp yourself (e.g. `brew install whisper-cpp`) and set the same two variables.
Android phones record compressed m4a, so the computer also needs ffmpeg: set `ORBIT_FFMPEG` to its path (or have ffmpeg on PATH when using the tray app). iPhones record WAV and do not need it. The compressed clip is decoded from a private temp file - MP4 cannot be demuxed from a pipe - and the file is overwritten and deleted right after each decode.
Audio is only held in memory and zeroed after each clip. The phone shows a Recording indicator while the mic on.
The phone mic button lives on the Tasks screen (tap to record, tap to stop; dictated text lands in the task box); it shows the computer's engine-setup state with explicit Retry/Cancel and never fires a download by itself. Both phone audio formats are verified end to end in-sandbox with the real engine; on-device capture remains real-device pending. A model picker shipped 2026-10-24: Settings offers tiny (75 MB, default), base (142 MB) and small (466 MB), all pinned and sha256-verified from the official whisper.cpp bucket; the picker shows a conservative hardware suggestion (by cores and memory) but the user chooses. Switching to a model that is not downloaded yet runs the same visible, cancellable provisioning path; switching to a downloaded one swaps the engine in place. Env overrides still win.

The desktop dictation hotkey shipped 2026-10-24: a user-chosen global shortcut (default Control+Shift+D, off by default) toggles one recording, and the local engine transcribes it. The transcript is never typed automatically - it lands in Orbit with Copy and Dismiss, plus, when the platform can verify window identity (Windows via GetForegroundWindow handle + process, X11 via xdotool id + pid), a "Type into <window>" button. That button is the only path that types: it brings the captured window to the front, re-verifies the same window id + process actually holds focus, and only then sends text. If activation or verification fails, nothing is typed and the text stays put. Typing re-checks focus between 240-character chunks and stops at the first mismatch - this bounds how much could land elsewhere if focus flips mid-typing; it is mitigation on an already user-confirmed action, not a guarantee, because the OS delivers keystrokes to whatever is focused at that instant. Wayland and macOS have no reliable focus identity, so the Type button never appears there. A red recording banner and the tray tooltip show while capturing; disabling the shortcut or quitting cancels any recording immediately and releases the mic; every capture error path stops the mic tracks, and captured audio is zeroed after use. The renderer surfaces are pixel-verified under Xvfb (settings card, preview card with the Type button); the global keypress and real mic capture are real-device pending.
