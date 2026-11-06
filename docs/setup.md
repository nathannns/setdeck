# Setup on a Mac

SetDeck talks to Ableton Live through **AbletonOSC**, a free remote script that lets other apps control Live over the network. You install it once.

## 1. Install AbletonOSC

1. Download the zip: https://github.com/ideoforms/AbletonOSC/archive/refs/heads/master.zip
2. Unzip it. You get a folder called `AbletonOSC-master`. Rename it to exactly **`AbletonOSC`**.
3. In Finder, press **Cmd+Shift+G** and go to `~/Music/Ableton/User Library/`.
4. If there is no `Remote Scripts` folder inside, create one, named exactly **`Remote Scripts`**.
5. Move the `AbletonOSC` folder into it. The result should be:
   `~/Music/Ableton/User Library/Remote Scripts/AbletonOSC/__init__.py`

## 2. Turn it on in Live

1. Quit and reopen Live.
2. Open **Live > Settings > Link, Tempo & MIDI**.
3. In an empty **Control Surface** slot, choose **AbletonOSC**. Leave Input and Output as None.
4. Live's status bar at the bottom should say **"AbletonOSC: Listening for OSC on port 11000"**.

Live remembers this, so you only do it once. If something goes wrong later, AbletonOSC writes a log to
`~/Music/Ableton/User Library/Remote Scripts/AbletonOSC/logs/abletonosc.log`.

## 3. Make a test set

Use a separate set, not a gig set: the probe changes things and puts them back, but Live's undo history still records them.

- In Arrangement view, add a locator at the start of each song (**Create > Add Locator**) and name it after the song.
- Add more locators inside each song for sections: Intro, Verse 1, Chorus…
- 3 songs with a few tracks each is enough. Ideally one song has a different tempo.
- Some audio near the second locator lets the meter check see a signal.

## 4. Run the probe

With Live open and the test set loaded, in Terminal in the project folder:

```
npm install      # first time only
npm run probe
```

It runs 15 checks, prints a table, and writes the results into `docs/compat.md`. Send the table back if anything says FAIL.

Options: `npm run probe -- --host 192.168.1.20` if Live runs on another computer, `--timeout 3000` on a slow machine.

## Things that trip people up

- **"Port 11001 is in use"**: only one program can receive AbletonOSC's replies at a time. Stop the SetDeck server (or any other OSC tool) before running the probe.
- **"No reply from AbletonOSC"**: Live isn't open, AbletonOSC isn't selected in Control Surface, or the folder isn't named exactly `AbletonOSC`.
- **macOS asks "allow incoming network connections" for node**: click Allow. Tablets and phones need it to reach SetDeck over Wi-Fi.
