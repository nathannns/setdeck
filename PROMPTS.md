# SetDeck: prompts for Claude Code

## How to use

1. Make a project folder, put `CLAUDE.md` in its root, and run `git init`.
2. Open a terminal in that folder and run `claude`.
3. Paste the prompts below one at a time, in order. Wait for each to finish, check it, and commit before the next.
4. Use plan mode (Shift+Tab until it shows plan mode) for prompts 0, 3 and 6. They are where the design is least certain.
5. Install AbletonOSC first (see prompt 0). Keep Live open with a test set for the prompts that need it.
6. When something fails on your real Live set, paste the error or what you saw back into Claude Code with the prompt "Debug with real Live" at the bottom.

Every prompt assumes Claude Code has read `CLAUDE.md`.

---

## Prompt 0: scaffold and probe Live

```
Read CLAUDE.md fully. Then:

1. Scaffold the npm workspace layout described in CLAUDE.md (server, web, shared, mock-live, live-extension, docs) with TypeScript, Vitest, ESLint and a root `npm run dev` that starts server and web together.
2. Fetch the AbletonOSC README and source from https://github.com/ideoforms/AbletonOSC and put the address list we need into server/src/osc-map.ts, noting any address you could not verify. Do not rely on memory for addresses.
3. Write a standalone probe script, `npm run probe`, that connects to AbletonOSC (send to 11000, listen on 11001) and checks, one by one: connection test, cue point list (names and times), jump to a cue, song position get/set, play/stop, loop get/set, tempo get/set, metronome get/set, track names, track mute/solo/volume, track rename, and whether output meter levels are available. Print a clear pass/fail table and write the result to docs/compat.md.
4. Write docs/setup.md for a Mac: how to install AbletonOSC into the User Library Remote Scripts folder, how to enable it in Live's Link/Tempo/MIDI preferences, and how to run the probe.

Do not build any UI yet. Show me the plan first (plan mode), then implement after I approve it.
```

**Check:** run `npm run probe` against Live 12 with a test set that has locators and a few tracks. Send me the table if anything fails.

---

## Prompt 1: mock Live and server core

```
Build /mock-live: a UDP OSC server on port 11000 (replies on 11001) that behaves like AbletonOSC for every address in osc-map.ts. It must hold a fake set: configurable tempo, time signature, 3 songs with locators (song start locators plus section locators like Intro, Verse 1, Chorus), 10 tracks with names/mute/solo/volume, and a transport with a real running clock that advances the song position in beats at the current tempo, loops when loop is on, and sends listener updates. Make the fake set configurable from a JSON file.

Then build the server core in /server:
- An OSC client wrapper with request/response matching, timeouts and automatic reconnect. Report connection state.
- A Live state store (transport, tempo, position, cue points, tracks) kept up to date from listeners, with light polling only where listeners are not available.
- A WebSocket API (message types defined in /shared with runtime validation) that sends full state on connect and incremental updates after, and accepts commands (play, stop, jump, set tempo).
- Persistence in ~/.setdeck/ as JSON with versioning and safe writes.

Add Vitest tests for the OSC wrapper and state store against the mock. Show that `npm run dev:mock` runs server plus mock and that a simple WebSocket client can control the mock transport.
```

**Check:** the tests pass, and the mock lets you develop without Live open.

---

## Prompt 2: locator setup, setlist and simple UI shell

```
Implement song detection and the simple mode UI.

Server:
- Derive songs and sections from the Live cue points using the user's saved choices. First run: no choices exist.
- Persist choices. Re-running setup updates songs without losing existing per-song data where the song still exists (match by name and position).

Web:
- First-run setup screen: list every locator with its position, the user taps which ones are songs, the rest become sections of the preceding song. Preview the resulting setlist before confirming.
- Main screen layout: setlist sidebar (collapsible into a drawer on phones), song header (name, key, BPM, progress, time remaining), big Play/Stop and Next/Previous, current and next song always visible, connection status badge, and a simple/advanced toggle (advanced can be empty for now).
- Reorder and hide songs in the app only (nothing is written to Live). Show total set duration.
- Dark theme, large touch targets, responsive from phone to tablet landscape. Use CSS variables for the palette so the style is easy to change.

Add component tests for the setup flow and a Playwright smoke test that runs against the mock. Take screenshots at tablet landscape and phone sizes and show them to me.
```

---

## Prompt 3: transport, queued jumps, end-of-song behavior

```
(Use plan mode.) Implement performance-safe navigation.

1. Queued jump scheduler in the server: jump targets can be a song, a section or a pad position, with quantize modes immediate, next beat, next bar, end of section. Use the transport position and tempo to act at the boundary. Test how Live's own jump timing behaves in the mock and add a note in docs/compat.md that real-Live accuracy must be measured (add a measurement tool: log requested boundary vs actual landing position).
2. Default is queued. Immediate jumps need a deliberate gesture in the UI (long press or confirm). Show queued state visibly (pending target, countdown in beats) and allow cancelling it.
3. Per-song end behavior: stop, loop song, loop last section, continue. Use Live's loop brace (set loop start and length) for the looping modes so the loop is sample-accurate, and a server-side watcher for stop. Global default and per-song override in settings.
4. Section navigation: tap a section block to queue a jump, loop a section on request.
5. Next/Previous song behavior respects the quantize setting.

Add tests for the scheduler (different tempos, time signatures, jumps requested just before and after a boundary) and for the end behaviors. Show me the plan first.
```

---

## Prompt 4: timeline and cue pads

```
Build the structure timeline and the cue pad system.

Timeline (canvas):
- Bar ruler, section blocks derived from locators (abbreviate or truncate narrow labels, with a tap/hover label), moving playhead, cue markers, zoom and horizontal scroll for long songs. If an imported waveform exists (a later prompt), render it behind the blocks; for now render the blocks only.
- Tap or click to move the queued target; right-click or long-press opens a context menu: Assign to pad, New pad here, Move marker, Delete marker. Markers are draggable, snapping to bar or beat, with a nudge control.

Cue pads:
- A pad grid below the track area. Default 8 pads per song, any number, wrapping or scrolling. Each pad: label, color, position (stored in beats), quantize mode, optional MIDI binding (used later).
- Auto-create pads from the song's sections the first time a song loads; user can edit, delete and add pads freely.
- "Assign to pad" learn flow: after choosing it from the timeline menu, the next pad pressed (on screen) receives the position. Also: hold a pad while the song plays to capture the current playhead position into that pad.
- The current section's pad is lit. Pads are large, color-coded and show label plus bar number (and an estimated time label).
- Pads persist per song.

Positions are beats internally; show bars, beats and an estimated time. Add tests for the beat/time conversions and a Playwright test of assign, capture and trigger against the mock.
```

---

## Prompt 5: per-song tempo

```
Implement tempo control for advanced mode.

- Each song shows its original BPM. The user can enter it once on the song setup screen (we cannot read tempo automation from Live), and the app remembers it.
- Controls: type a value, nudge +/-1 and +/-0.1, tap tempo, reset to original. The override is remembered per song.
- When a song starts or is jumped to, apply the stored tempo for that song. Make this reliable even if Live's own tempo automation would change the tempo afterward (detect and report a mismatch rather than silently fighting it; add a setting "app owns tempo" vs "Live owns tempo").
- Visible indicator when a song is off its original tempo. Warn on large changes (more than about 15 percent) because warped audio degrades.
- Cue pad positions and the timeline must stay correct when the tempo changes (they are stored in beats).

Add tests for tempo application order (jump then tempo), reset, and the display-time conversions. Add notes to docs/compat.md about how Live behaves with tempo automation once measured.
```

---

## Prompt 6: pitch and warp for Arrangement clips

```
(Use plan mode.) The user needs per-song transpose and warp awareness on Arrangement clips. AbletonOSC may not expose Arrangement clips.

1. Inspect the installed AbletonOSC source and confirm what clip properties are exposed and whether Arrangement clips are reachable. Document the finding in docs/compat.md.
2. If not reachable, design and write a small extension in /live-extension (Python) that follows AbletonOSC's handler pattern and exposes, over OSC: list Arrangement clips per track with start/end in beats, is_audio_clip, warping on/off, warp_mode, and pitch_coarse/pitch_fine get/set. Use Live's Python API (Track.arrangement_clips, Clip.pitch_coarse, pitch_fine, warping, warp_mode); verify names against the Live version in use and note anything uncertain. Provide installation steps that keep it a single folder to copy.
3. In the server: per-song transpose in semitones (reset to original), applied only to clips inside the song's beat range and only to stems with "follow transpose" enabled (drums and percussion off by default, configurable). Remember the setting per song.
4. Warp awareness: report unwarped audio clips per song, flag them in the UI, and warn when a tempo change would leave them out of sync.
5. Extend mock-live with fake Arrangement clips so this is testable.

Show me the plan first. Write the extension so it fails safely: if the API is unavailable, the app must continue to work and show "pitch control unavailable".
```

---

## Prompt 7: vertical stem strips, mute/solo, rename

```
Build the track strips area, placed between the timeline and the cue pads.

- One vertical strip per Live track in the set (about 10, any number): vertical fader, mute, solo, color bar, name, and a level meter if the probe showed output meters are available (otherwise skip meters without errors). Scroll sideways when they do not fit.
- Simple mode shows only a compact row of mute buttons; advanced mode shows the full strips.
- Mute/solo state is remembered per song and restored when the song starts or is jumped to (make this a setting).
- Rename: advanced mode only. Editing a name writes it to Live (track name) after a confirm; keep a one-step undo that restores the previous name. Reflect renames made inside Live too.
- Fader changes are rate-limited and sent to Live; show Live's value if it changes elsewhere.

Add tests against the mock for mute/solo memory per song, rename with undo, and fader sync. Show screenshots at tablet landscape size with 10 strips and with 16 strips.
```

---

## Prompt 8: MIDI learn input

```
Add MIDI input to the server for hardware pads and a foot switch.

- List MIDI input ports in settings and let the user choose one. macOS CoreMIDI allows Live to read the same port at the same time.
- Accept note on, CC and program change, with channel.
- MIDI learn: in advanced mode, a Learn button on any cue pad, Next/Previous, Play/Stop, or a section pad. Press it, then press the hardware control, and the binding is stored. Show the binding on the control and allow clearing it.
- Two mapping modes for cue pads, selectable in settings: by position (pad 1 triggers the first section of the current song, and so on), and by name (pad 1 is always "Intro", and does nothing if the current song has no matching section).
- Triggers use the pad's quantize mode and the same guard rules as the UI.
- Document in docs/setup.md how to stop pad notes from reaching the keys plugins in Live (different MIDI channel for the pads, or restrict the keys track's input channel).
- Add a MIDI test harness that injects fake MIDI messages so tests run without hardware.
```

---

## Prompt 9: waveform import

```
Add an optional waveform overlay for the timeline.

- The user exports a stereo mixdown WAV from Live for a song (or for the whole set) and drops it into the app, or points the app at a folder it watches.
- The server computes a peak overview (decode, downsample to peaks, cache per file) without blocking the event loop. Use a worker thread. Support 16, 24 and 32-bit float WAV at common sample rates.
- Map the waveform to the song's beat range using the song's original tempo, so it stays aligned when the tempo changes.
- Render it behind the section blocks on the timeline canvas, with zoom matching the timeline.
- If no waveform is imported, the timeline still works without it.
- Clearly mark in the UI that the waveform is a picture of the original mix and does not reflect muted stems or tempo/pitch changes.

Add tests for the peak computation and the beat mapping.
```

---

## Prompt 10: polish, packaging and the live test checklist

```
Finish v1.

1. Health check screen: shows OSC connection, AbletonOSC detected, extension detected, MIDI input status, and exact fix instructions for each failure.
2. A launcher: `npm run start` builds the web UI and serves it from the server, prints the LAN URL and a QR code in the terminal, and optionally opens the browser on the Mac.
3. Keyboard shortcuts on laptop (space for play/stop, arrows for next/previous, number keys for pads).
4. A wake lock on tablet while the performance screen is open, and a "stage lock" toggle that disables editing and advanced controls so nothing changes by accident.
5. Review accessibility basics (contrast, focus order, labels) and fix problems.
6. Write docs/live-test-checklist.md: step by step manual checks for a real Live 12 set (locator detection, jumping accuracy at several quantize settings, end behaviors, tempo override with and without automation, transpose on Arrangement clips, track rename and undo, MIDI learn, and keys-plugin isolation), with a place to record results.
7. Write a README with install steps for AbletonOSC, the extension, and the app, aimed at a non-developer musician.

Then run the full test suite and the Playwright smoke tests and report what passes, what is untested because it needs real Live, and a list of the five risks you consider most likely to bite on stage.
```

---

## Utility prompts

### Debug with real Live
```
Here is what I did and what happened on my real Live 12 set: <describe it, paste the console output or probe table>. Reproduce it in the mock if possible, find the root cause, fix it, add a regression test, and update docs/compat.md. Do not change unrelated behavior.
```

### Review before I trust it on stage
```
Act as a skeptical reviewer for a live-performance tool. Read the code for misfire risks: anything that can stop playback, jump unexpectedly, change tempo or pitch silently, rename a track unintentionally, lose state when Wi-Fi drops or the server restarts, or lock up the UI. List concrete scenarios, rank them by severity, and fix the top ones with tests.
```

### Change the look
```
Restyle the UI. Keep the layout and behavior. Here is the direction: <colors, mood, fonts, or reference>. Put all colors, spacing and type sizes in CSS variables, and show before and after screenshots at tablet landscape and phone sizes.
```

---

## Tips

- Commit after each prompt. If a phase goes wrong, roll back and re-run it with more detail.
- Keep a real Live test set with 3 songs, about 10 stems each, named locators and one song with a different tempo. It makes every real-Live check faster.
- After prompt 0 and again after prompt 6, send the compat results back to me and I'll adjust the later prompts if Live or AbletonOSC behaves differently than expected.
