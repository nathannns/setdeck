// Every AbletonOSC address SetDeck uses. Nothing else in the codebase writes an address string.
//
// Verified against the AbletonOSC source (abletonosc/{song,track,handler,osc_server,constants}.py
// and README.md) at commit 0ca6821 on master, 2025-11-19. Runtime behaviour on Live 12 is
// confirmed by `npm run probe`, results in docs/compat.md.
//
// Protocol facts that shape the client (from osc_server.py / handler.py):
// - AbletonOSC listens on UDP 11000 and replies to the sender's IP on port 11001, whatever port
//   the request came from. Only one process on the Mac can bind 11001.
// - A reply uses the same address as the request. Track replies start with the track index.
// - Unknown addresses and handler exceptions send NO reply (they are only logged in
//   AbletonOSC/logs), so every request needs a timeout.
// - `start_listen/<prop>` sends the current value at once, then every change, to `get/<prop>`.
// - `/live/song/get/cue_points` has NO listener: poll it.
// - Session view: Live has no 'playing scene'. It is derived from each track's playing_slot_index.
// - Arrangement clips expose only name, length and start_time. No pitch or warp (Prompt 6 adds them).
// - Cue jump by index needs an OSC int ('i'); node-osc encodes JS integers as 'i'.

export const ABLETONOSC_VERIFIED_SHA = '0ca6821';
export const LIVE_PORT = 11000;
export const REPLY_PORT = 11001;

export const OSC = {
  app: {
    test: '/live/test', // -> 'ok'
    version: '/live/application/get/version', // -> major, minor
    startup: '/live/startup', // pushed when the script (re)starts
    error: '/live/error', // pushed: error_msg
  },
  song: {
    startPlaying: '/live/song/start_playing',
    stopPlaying: '/live/song/stop_playing',
    continuePlaying: '/live/song/continue_playing',
    jumpBy: '/live/song/jump_by', // beats
    // properties: get/<p> -> value; set/<p> value; start_listen/<p> -> pushes get/<p>
    get: (p: SongProp) => `/live/song/get/${p}`,
    set: (p: SongRwProp) => `/live/song/set/${p}`,
    listen: (p: SongProp) => `/live/song/start_listen/${p}`,
    unlisten: (p: SongProp) => `/live/song/stop_listen/${p}`,
    listenBeat: '/live/song/start_listen/beat', // pushes /live/song/get/beat <int beat>
    unlistenBeat: '/live/song/stop_listen/beat',
    beat: '/live/song/get/beat',
    numTracks: '/live/song/get/num_tracks', // -> n
    trackNames: '/live/song/get/track_names', // [min, max] -> name, name, ...
    // [min, max, 'track.<prop>', ...] -> the props of each track in turn, flat (song.py). A Track value
    // (group_track) comes back as its index, None as nil. One request instead of one per track.
    trackData: '/live/song/get/track_data',
    numScenes: '/live/song/get/num_scenes', // -> n
    sceneNames: '/live/song/get/scenes/name', // [min, max] -> name, name, ...
  },
  scene: {
    // all take scene_index first and reply scene_index, value (scene.py)
    fire: '/live/scene/fire', // scene_index; follows Live's global launch quantization
    get: (p: SceneProp) => `/live/scene/get/${p}`,
    listen: (p: SceneListenProp) => `/live/scene/start_listen/${p}`,
  },
  cue: {
    list: '/live/song/get/cue_points', // -> name, time, name, time, ... (no listener)
    jump: '/live/song/cue_point/jump', // index (int) or name (string)
    next: '/live/song/jump_to_next_cue',
    prev: '/live/song/jump_to_prev_cue',
  },
  // Session clips. Replies start with track_index, clip_index (= scene index) (clip.py, clip_slot.py).
  clipSlot: {
    hasClip: '/live/clip_slot/get/has_clip', // track, scene -> track, scene, bool
  },
  clip: {
    get: (p: ClipProp) => `/live/clip/get/${p}`, // track, scene -> track, scene, value
    // Moving the start is how a jump inside a playing song works: AbletonOSC has no way to move a playing
    // clip's position (clip methods are fire/stop/duplicate_loop/remove_notes_by_id). On an unlooped clip
    // loop_start IS its start (it moves start_marker too); setting start_marker there is ignored (Live 12).
    setStart: '/live/clip/set/loop_start', // track, scene, value
    // Live's own jump inside a playing clip: relative, in beats; nothing if the clip isn't playing.
    // Not in stock AbletonOSC: SetDeck adds "move_playing_pos" to clip.py's method list (see live-extension).
    move: '/live/clip/move_playing_pos', // track, scene, beats
    // playing_position: beats into the clip (absolute clip time; seconds if unwarped audio), pushed as it plays
    listen: (p: 'playing_position') => `/live/clip/start_listen/${p}`,
    unlisten: (p: 'playing_position') => `/live/clip/stop_listen/${p}`,
  },
  track: {
    // all take track_index first and reply track_index, value
    get: (p: TrackProp) => `/live/track/get/${p}`,
    set: (p: TrackRwProp) => `/live/track/set/${p}`,
    listen: (p: TrackProp) => `/live/track/start_listen/${p}`,
    unlisten: (p: TrackProp) => `/live/track/stop_listen/${p}`,
    arrangementClipStarts: '/live/track/get/arrangement_clips/start_time', // -> track, start, ...
    arrangementClipLengths: '/live/track/get/arrangement_clips/length',
    arrangementClipNames: '/live/track/get/arrangement_clips/name',
  },
} as const;

export type SongRwProp =
  | 'current_song_time' | 'loop' | 'loop_start' | 'loop_length' | 'tempo' | 'metronome'
  | 'signature_numerator' | 'signature_denominator'
  | 'clip_trigger_quantization'; // global launch quantization: 0 None, 1 8 Bars, 2 4 Bars, 3 2 Bars, 4 1 Bar, 5 1/2, 6 1/2T, 7 1/4, ...
export type SongProp = SongRwProp | 'is_playing' | 'song_length';
// tempo/time_signature are the scene's own values, applied on launch only when *_enabled is true.
// is_empty has no listener in Live: poll it. is_triggered is observable.
export type SceneProp = 'name' | 'color' | 'tempo' | 'tempo_enabled' | 'is_empty' | 'is_triggered';
export type SceneListenProp = 'name' | 'is_triggered';

// Markers are in beats, except unwarped audio clips: seconds. warping is None (nil) on MIDI clips.
// Unlooped clips: loop_start/loop_end are the clip's start and end.
export type ClipProp = 'loop_start' | 'loop_end' | 'looping' | 'warping' | 'is_midi_clip' | 'file_path' | 'playing_position'; // file_path: audio clips only
export type TrackRwProp = 'name' | 'mute' | 'solo' | 'volume' | 'color';
// output_meter_* are read-only but listenable (track.py properties_r)
export type TrackProp = TrackRwProp | 'output_meter_level' | 'output_meter_left' | 'output_meter_right'
  | 'playing_slot_index' | 'fired_slot_index'; // Session: scene index playing / launched (-1 none, -2 stop button)
