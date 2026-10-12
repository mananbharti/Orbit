# Local voice dictation (P4)

Goal: Wispr-Flow-style dictation that is offline, free and private. Hold a key (desktop) or tap the mic (phone), speak, and the text lands at the cursor or in the task box.

## What exists now
- `desktop/src/dictation/vad.ts` - trims leading/trailing silence, ignores clicks and coughs.
- `desktop/src/dictation/cleanup.ts` - removes unambiguous fillers (um, uh...), personal dictionary (whole words, longest first, literal replacement), spacing and capitals, Hindi danda.
- `desktop/src/dictation/pipeline.ts` - clip -> VAD -> local `Transcriber` -> cleanup. Audio lives only in memory and is wiped on every path (success, no speech, error, cancel). Errors surface as safe codes only.
- All covered by tests with synthetic audio (`desktop/test/dictation.test.ts`).

## Not built yet
1. A `Transcriber` backed by a real local model (whisper.cpp or faster-whisper) and a model picker (tiny/base/small by hardware). Needs model downloads and real audio, so it cannot be judged in CI.
2. Hinglish accuracy: must be measured on real recorded Hindi/Hinglish/English clips. No accuracy claim is made until then.
3. Hold-to-talk hotkey and text insertion at the cursor on the desktop, mic indicator, and the phone mic button (phone records, streams 16 kHz PCM to the paired desktop over the existing pinned channel, desktop transcribes, text returns).
4. Optional local LLM polish (off by default).

## Privacy rules (enforced in code where possible)
- Audio never leaves the paired devices; no cloud engine is a valid `Transcriber`.
- Nothing is stored after transcription; buffers are zeroed.
- A mic indicator is always shown while recording.

## Prior art
OpenWhispr and VoiceFlow are MIT: ideas and architecture only, attribution if any code is ever reused. Nothing has been copied.
