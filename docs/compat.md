# Compatibility: AbletonOSC on Live 12

What works and what doesn't on the user's real setup. The block at the bottom is rewritten by `npm run probe`. Everything above it is kept.

## From the AbletonOSC source (commit 0ca6821, 2025-11-19)

- No reply is sent for unknown addresses or handler errors; the client relies on timeouts.
- Cue points have no listener, so the server polls `/live/song/get/cue_points`.
- Arrangement clips expose only name, length and start time. No pitch or warp, so Prompt 6 needs the extension.
- Group structure comes from `/live/song/get/track_data` with `track.is_foldable` and `track.group_track` (the parent group's index, nil at the top level). Live has no listener for grouping, so the server re-reads it every 10 s in one bulk request per 40 tracks. Confirmed on Live 12 with a 183-track set (2026-11-05): nested groups come back correctly.
- A burst of about 1,100 `start_listen` messages (6 per track on that set) kept AbletonOSC busy for over 5 s. The server now sends in chunks of 40 and waits for Live to finish each one, and listens to only 4 properties per track.

## Manual notes

(Add observations from real Live here.)

- 2026-11-06, Session clips (warped, unlooped stems): `/live/clip/set/start_marker` is ignored on an unlooped clip (it reads back unchanged), and a launch still starts at 0. `/live/clip/set/loop_start` works: it moves start_marker too, and the next launch starts there. Setting loop_start back while the clip plays pulls the playback back to the new start, so a clip-jump start can only go back once the clip has stopped.
- 2026-11-06, launching right after moving a clip's start: Live applies the new start 290-360 ms later, so a launch in between plays the old start first, then jumps (heard as "Intro, then Verse"). Unchanged starts launch at once.
- 2026-11-06, scene fire vs clip slot fires: firing 10 clip slots one by one lands the stems 20-23 ms apart (sounds doubled); one `/live/scene/fire` starts them in the same buffer (0 ms).
- 2026-11-06, `/live/clip/start_listen/playing_position` pushes the clip's position (absolute clip beats) as it plays; used for elapsed time.
- 2026-11-06, `/live/api/reload` breaks AbletonOSC: it clears all handlers, then raises KeyError on a stale volume listener, so no address answers until the control surface is reselected in Live.
- 2026-11-06, play/stop: Live sends `is_playing` once per change, with no position updates after a stop, so the server must never throttle away a play/stop change.

<!-- probe:start -->
Not run yet. Run `npm run probe` with Live open.
<!-- probe:end -->
