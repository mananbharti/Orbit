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
1. A model picker (tiny/base/small by hardware). ggml-tiny is the provisioned default; bigger models work through the env override.
2. Hinglish accuracy: must be measured on real recorded Hindi/Hinglish/English clips. No accuracy claim is made until then.
3. Hold-to-talk hotkey and text insertion at the cursor on the desktop, mic indicator, and the phone mic button (phone records, streams 16 kHz PCM to the paired desktop over the existing pinned channel, desktop transcribes, text returns).
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
The phone mic button lives on the Tasks screen (tap to record, tap to stop; dictated text lands in the task box); it shows the computer's engine-setup state with explicit Retry/Cancel and never fires a download by itself. Both phone audio formats are verified end to end in-sandbox with the real engine; on-device capture remains real-device pending. The desktop hold-to-talk hotkey (user-chosen shortcut, off by default, cursor insertion with focus re-check) is still being built.
