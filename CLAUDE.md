# SetDeck: project guide for Claude Code

"SetDeck" is a working name and can be changed. This app is a setlist and playback controller for Ableton Live 12 (Arrangement view), in the spirit of AbleSet but simpler. It runs on the user's Mac, and the UI is opened in a browser on a tablet, phone or laptop over local Wi-Fi.

The user plays live keys through plugins hosted in Live while running backing-track playback from the same set. Hands are busy, so the UI must be big, calm, hard to misfire, and fast to read.

## Architecture

```
Ableton Live 12
   |  (AbletonOSC remote script + our small extension)
   |  OSC over UDP: Live listens on 11000, replies on 11001
Node server (TypeScript)  <--- MIDI input (hardware pads, foot switch) via CoreMIDI
   |  WebSocket (+ HTTP for static UI and file import)
Web UI (React + Vite + TypeScript), any device on the LAN
```

- Live stays the audio engine and plugin host. The app never hosts plugins or processes audio.
- The server is the single source of truth for app state. UIs are thin and reconnect cleanly.
- The server persists app data (song config, pads, MIDI bindings) as JSON under `~/.setdeck/`.

## Stack

- Node 20+, TypeScript everywhere, npm workspaces.
- Server: `ws` for WebSocket, a small HTTP server (Fastify or Express) for static files and uploads, `osc` or `node-osc` for OSC, `easymidi` or `jzz` for MIDI input.
- Web: React + Vite, plain CSS with CSS variables (no heavy UI kit), canvas for the timeline and waveform.
- Tests: Vitest. A mock Live (see below) makes the whole pipeline testable without Live.
- Extension: Python, installed beside AbletonOSC in Live's Remote Scripts folder.

## Repo layout

```
/server          Node server, OSC bridge, MIDI input, state, persistence
/web             Browser UI
/shared          Types and WebSocket message schemas shared by server and web
/mock-live       UDP OSC mock that behaves like AbletonOSC (cue points, transport clock, tracks)
/live-extension  Python additions for Arrangement clip pitch/warp (see Risks)
/docs            Setup guide, Live test checklist
```

## Feature list

### v1 simple mode (default)
- Setlist built from the locators in the Live set. A first-run setup screen lists all locators; the user marks which are songs, and the rest become sections of the preceding song. Choices are saved and can be redone.
- Reorder and hide songs in the app without changing the Live set. Show total set duration.
- Large Play/Stop, Next, Previous. Current song and next song always visible.
- Song header: name, key, BPM, progress and time remaining.
- Queued transitions by default (land on the next bar or at the end of the section). Immediate jump needs a deliberate action (long press or confirm).
- Structure timeline: bar ruler, section blocks from locators, moving playhead, cue markers.
- Cue pad grid below the strips: pads per song, each with label, color and a position. Default 8, any number allowed. Current section is lit.
- Per-song end behavior: stop, loop the song, loop the last section, or continue to the next song. Global default plus per-song override.
- Compact stem mute row.
- Connection status and a health check that explains what is wrong (script not enabled, wrong port, Live not running).

### v1 advanced mode (toggle)
- Per-song tempo: show original BPM, override by typing, nudging (1 and 0.1 BPM) or tap tempo, remembered per song, one-tap reset, visible "off original" indicator. Apply the song's tempo when the song starts or is jumped to (Live tempo automation can override outside changes).
- Per-song transpose in semitones, reset to original, with per-stem "follow transpose" (so drums and percussion can be excluded). Needs Arrangement clip access (see Risks).
- Warp awareness: flag unwarped stems, warn on large tempo changes.
- Vertical track strips (about 10 per song, any number): vertical fader, mute, solo, color bar, renamable name, level meter if available. Scroll sideways when they do not fit.
- Track rename that writes into Live (with confirm and one-step undo of the previous name). Display uses the Live name.
- Stem mute/solo state remembered per song.
- Section jump and section loop. Jump timing options: immediate, next beat, next bar, end of section.
- Click (metronome) on/off.
- Cue pad editing: right-click (long press on touch) the timeline to "Assign to pad", "New pad here", move or delete. "Learn" flow: choose Assign, then press a pad on screen or a hardware pad. Hold a pad while playing to capture the current position. Positions snap to bars or beats with a nudge. Positions are stored in beats (bars and beats are shown, with a time label as a convenience).
- MIDI learn input: hardware pads or a foot switch map to cue pads, next/previous, play/stop. Pads can map by position (pad 1 is the first section of the current song) or by name (pad 1 is always "Intro"). Notes, CC and program change are accepted.
- Optional waveform overlay from an imported stereo mixdown WAV (the user exports the song from Live and drops the file in). Display only.

### Later (not in v1)
- Build waveform from stem clip files on disk.
- On-screen MIDI-sending drum pads, MIDI out on section change (program change, notes to external gear).
- Parameter macros that control plugin parameters in Live.
- Multi-computer redundancy, mixer, OSC output tracks, lyrics. Explicitly out of scope.

## Data model (sketch)

```ts
Song { id, name, startBeat, endBeat, bpm, timeSig, key?, color?, hidden, order,
       endBehavior, tempoOverride?, transposeSemitones, stemFollowTranspose: Record<trackId, boolean>,
       stemState: Record<trackId, {mute, solo}>, sections: Section[], pads: Pad[] }
Section { id, name, startBeat }          // derived from locators
Pad { id, label, color, positionBeats, quantize: 'immediate'|'beat'|'bar'|'section', midi?: MidiBinding }
MidiBinding { kind: 'note'|'cc'|'pc', channel, number }
Settings { globalEndBehavior, defaultQuantize, midiInputPort, ... }
```

All positions are stored internally in beats. Convert to time only for display, using the tempo and time signature.

## Rules and conventions

1. Put every OSC address in one file (`server/src/osc-map.ts`). Verify each address against the AbletonOSC source and README in the installed version. Do not trust remembered addresses.
2. Never assume an OSC feature works on Live 12; the probe script in prompt 0 confirms it. Record results in `/docs/compat.md`.
3. Destructive or surprising actions need a guard: rename writes to Live (confirm plus undo), immediate jumps (deliberate gesture), tempo and transpose changes (visible indicator).
4. The server must survive Live quitting or the script being disabled. Reconnect automatically and show status.
5. Prefer OSC listeners over polling. Where polling is unavoidable, keep it light (target 20 to 50 ms for playhead) and never block the event loop.
6. The mock Live must support everything the app uses, so tests and demos run without Live.
7. UI: dark theme, big touch targets (minimum 48 px, pads much larger), no tiny text on the performance screen, usable on a tablet in landscape first, with a phone layout that degrades sensibly. Do not copy any other product's branding, assets or exact styling.
8. Accessibility basics: keyboard operable, sufficient contrast, no information conveyed by color alone.
9. Keep dependencies modest. Explain any new dependency in the commit message.
10. Commit after each completed prompt phase with a clear message.

## Risks to verify early

- AbletonOSC is community-maintained and marked beta. Confirm it loads on Live 12 and that cue points (names, times), jump, song position, play/stop, loop, tempo, metronome, track name and mute/solo/volume all work.
- AbletonOSC clip controls are built around Session clip slots. Arrangement clips (pitch, warp on/off, warp mode) may not be exposed. Plan: extend the remote script using Live's Python API (`Track.arrangement_clips` and `Clip.pitch_coarse`, `pitch_fine`, `warping`, `warp_mode`), and confirm the exact API in the Live version in use.
- Live does not expose the master tempo automation lane, so per-song BPM is entered or learned and stored by the app.
- Whether a cue jump respects Live's global quantization is unknown. The app needs its own queued-jump scheduler (act on beat or bar boundaries using the playhead and tempo) with a measured accuracy.
- Track output meters may be available as listenable properties; confirm before building meters.
- Live does not give the master output audio to external tools, so waveforms come from an imported mixdown.
- Two apps can read the same MIDI input on macOS, but pad notes can also reach the user's keys plugins in Live. Document the fix (different MIDI channel for pads, or restrict the keys track input channel).

## Testing

- Unit tests for beat/time conversion, section derivation, quantized-jump scheduling, end-behavior logic, persistence and message schemas.
- Integration tests with the mock Live over real UDP.
- `/docs/live-test-checklist.md` lists manual checks the user runs with real Live 12 on their Mac, and results are fed back into `/docs/compat.md`.

## Out of scope

Hosting plugins or audio, mixing or routing, building sets from stems (TracksBuilder's job), lyrics editing, redundancy across computers, OSC output tracks.
