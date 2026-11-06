# live-extension

Python additions to AbletonOSC for Arrangement clip pitch and warp. Built in Prompt 6.

## Needed now: `move_playing_pos` in AbletonOSC

Pad jumps while a song plays use Live's `Clip.move_playing_pos(beats)`, which stock AbletonOSC doesn't expose.
In `Remote Scripts/AbletonOSC/abletonosc/clip.py`, add `"move_playing_pos"` to the `methods` list in `ClipHandler.init_api`
(it becomes `/live/clip/move_playing_pos track scene beats`). Then, in Live, set the AbletonOSC control surface to None and back.
Don't use `/live/api/reload`: on AbletonOSC 0ca6821 it clears every address, then fails on a stale volume listener and never adds them back.
Updating AbletonOSC removes the line again.
