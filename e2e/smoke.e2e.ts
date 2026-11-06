import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'test-results/screens';

async function setup(page: Page, songs: string[], shot: string) {
  for (const name of songs) await page.getByRole('listitem').filter({ hasText: name }).click();
  await expect(page.getByText(`Preview: ${songs.length} songs`)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/${shot}` });
  await page.getByRole('button', { name: new RegExp(`Use this setlist \\(${songs.length} songs\\)`) }).click();
}

test('arrangement: setup from locators, play, queue next song, land on it', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto('/');
  // first run opens setup in Session view; switch view from the setup screen
  await page.getByRole('group', { name: 'Live view' }).getByRole('button', { name: 'ARRANGEMENT' }).click();

  await expect(page.getByText('Which locators start a song?')).toBeVisible();
  await setup(page, ['Glass Harbor', 'Slow Satellite', 'Paper Lanterns'], 'setup-tablet.png');

  const setlist = page.getByRole('complementary', { name: 'Setlist' });
  await expect(setlist.getByText('Glass Harbor')).toBeVisible();
  await expect(page.getByLabel('Total set duration')).toHaveText('4:04');

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

  await page.getByRole('navigation', { name: 'Transport' }).getByRole('button', { name: /Next song/ }).click();
  await expect(page.getByText('→ Slow Satellite')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/perform-queued-tablet.png` });
  await expect(page.locator('.preset-name')).toHaveText('Slow Satellite', { timeout: 5000 });

  // a pad jumps at once; NEXT still queues, and CANCEL clears it
  const pads = page.getByRole('region', { name: 'Drum pads' });
  await pads.getByRole('button', { name: /^Pad \d+: Chorus/ }).click();
  await expect(pads.getByRole('button', { name: /^Pad \d+: Chorus, playing/ })).toBeVisible({ timeout: 1000 });
  await expect(page.getByRole('button', { name: 'CANCEL' })).toBeHidden();
  await page.getByRole('navigation', { name: 'Transport' }).getByRole('button', { name: /Next song/ }).click();
  await expect(page.getByRole('button', { name: 'CANCEL' })).toBeVisible();
  await page.getByRole('button', { name: 'CANCEL' }).click();
  await expect(page.getByRole('button', { name: 'CANCEL' })).toBeHidden();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/perform-tablet.png` });

  // phone layout: setlist lives in a drawer
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/perform-phone.png` });
  await page.getByRole('button', { name: 'Open setlist' }).click();
  await expect(setlist.getByText('Paper Lanterns')).toBeInViewport();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/drawer-phone.png` });

  await page.locator('.scrim').click({ position: { x: 370, y: 400 } });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});

test('session: setup from scenes, play, queue next song, launch a section', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto('/');

  // runs after the arrangement test (scene tempos would change its timings); switch back from setup
  await page.getByRole('button', { name: /Set up setlist/ }).click();
  await page.getByRole('group', { name: 'Live view' }).getByRole('button', { name: 'SESSION' }).click();
  await expect(page.getByText('Which scenes start a song?')).toBeVisible();
  await setup(page, ['Glass Harbor', 'Slow Satellite', 'PAPER LANTERNS'], 'setup-session-tablet.png');

  const setlist = page.getByRole('complementary', { name: 'Setlist' });
  await expect(setlist.getByText('Glass Harbor')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('LIVE');

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('.preset-name')).toHaveText('Glass Harbor');
  await expect(page.getByText('Elapsed')).toBeVisible();
  await expect(page.getByText('Left', { exact: true })).toBeHidden();

  // waveform: built by itself from the song's clips in Live (nothing to import); mark a section while playing
  const timeline = page.getByRole('region', { name: 'Song timeline' });
  await expect(timeline.locator('.wave-empty')).toBeHidden({ timeout: 15000 });
  await timeline.getByRole('button', { name: 'EDIT', exact: true }).click();
  await expect(timeline.getByRole('button', { name: /IMPORT WAV|REPLACE WAV/ })).toHaveCount(0);
  await expect(timeline.getByText('MIX BPM')).toHaveCount(0);
  await timeline.getByRole('button', { name: 'Intro', exact: true }).click();
  await expect(timeline.getByRole('button', { name: /^Intro at bar \d+\.1/ })).toBeVisible();
  // zoom in to place markers precisely: the timeline stretches and scrolls
  await timeline.getByRole('button', { name: 'Zoom in' }).click();
  await timeline.getByRole('button', { name: 'Zoom in' }).click();
  await expect(timeline.getByRole('button', { name: 'Reset zoom' })).toHaveText('4×');
  expect(await timeline.locator('.wave').evaluate((w) => w.scrollWidth > w.clientWidth * 3)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/wave-zoom-tablet.png` });
  await timeline.getByRole('button', { name: 'Reset zoom' }).click();
  await expect(timeline.getByRole('button', { name: 'Reset zoom' })).toHaveText('1×');
  await page.screenshot({ path: `${SHOTS}/wave-edit-tablet.png` });
  // delete a marker, then undo brings it back
  await timeline.getByRole('button', { name: /^Intro at bar \d+\.1/ }).click();
  await timeline.getByRole('button', { name: 'DELETE', exact: true }).click();
  await expect(timeline.getByRole('button', { name: /^Intro at bar \d+\.1/ })).toBeHidden();
  await timeline.getByRole('button', { name: 'Undo last section change' }).click();
  await expect(timeline.getByRole('button', { name: /^Intro at bar \d+\.1/ })).toBeVisible();
  // tap a spot, then a name: the marker goes there, not at the playhead (no need to hit it in time)
  const inner = timeline.locator('.wave-inner');
  const w = (await inner.boundingBox())!;
  await inner.click({ position: { x: w.width * 0.5, y: w.height - 8 } });
  await timeline.getByRole('button', { name: 'Chorus', exact: true }).click();
  const chorus = timeline.getByRole('button', { name: /^Chorus at bar/ });
  const placed = await chorus.getAttribute('aria-label');
  // drag a marker to move it
  const c = (await chorus.boundingBox())!;
  await page.mouse.move(c.x + 10, c.y + 10);
  await page.mouse.down();
  await page.mouse.move(c.x + 10 + w.width * 0.2, c.y + 10, { steps: 6 });
  await page.mouse.up();
  await expect(chorus).not.toHaveAttribute('aria-label', placed!);
  // double-tap plays from there: the playhead lands on the spot
  await inner.dblclick({ position: { x: w.width * 0.25, y: w.height - 8 } });
  await expect.poll(async () => {
    const p = await timeline.locator('.wave-playhead').boundingBox();
    return p !== null && Math.abs(p.x - (w.x + w.width * 0.25)) < w.width * 0.04;
  }).toBe(true);
  await timeline.getByRole('button', { name: 'DONE' }).click();
  await expect(timeline.getByText(/to Chorus/)).toBeVisible(); // the countdown to the next section

  // the marked section is the song's pad; renaming the pad renames the section
  const pads = page.getByRole('region', { name: 'Drum pads' });
  await expect(pads.getByRole('button', { name: /^Pad 1: Intro, playing/ })).toBeVisible();
  await timeline.getByRole('button', { name: 'EDIT', exact: true }).click();
  await pads.getByRole('button', { name: /^Edit Pad 1: Intro/ }).click();
  await timeline.getByRole('button', { name: 'Verse', exact: true }).click();
  await expect(timeline.getByRole('button', { name: /^Verse at bar \d+\.1/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/pads-edit-tablet.png` });
  await timeline.getByRole('button', { name: 'DONE' }).click();
  await expect(pads.getByRole('button', { name: /^Pad 1: Verse/ })).toBeVisible();
  await pads.getByRole('button', { name: /^Pad 1: Verse/ }).click(); // jumps inside the playing clips
  await expect(pads.getByRole('button', { name: /^Pad 1: Verse, playing/ })).toBeVisible(); // no queue: it jumped

  // mixer: mute a track, Live (mock) echoes it back
  const mixer = page.getByRole('region', { name: 'Mixer' });
  // like Live: top-level tracks first (3 groups + FX + Click); opening a group shows its tracks
  await expect(mixer.getByRole('button', { name: /^Mute / })).toHaveCount(5);
  await mixer.getByRole('button', { name: /^Open group RHYTHM, 3 tracks/ }).click();
  const rhythm = mixer.getByRole('group', { name: 'Group RHYTHM' });
  await expect(rhythm.getByRole('button', { name: /^Mute / })).toHaveCount(4); // RHYTHM, Drums, Perc, Bass
  await page.screenshot({ path: `${SHOTS}/mixer-group-open-tablet.png` });
  await mixer.getByRole('button', { name: /^Close group RHYTHM/ }).click();
  await expect(mixer.getByRole('button', { name: /^Mute / })).toHaveCount(5);
  await expect(mixer.getByRole('slider')).toHaveCount(5); // a fader per strip
  const firstMute = mixer.getByRole('button', { name: 'Mute RHYTHM' });
  await firstMute.click();
  await expect(firstMute).toHaveAttribute('aria-pressed', 'true');
  await firstMute.click();
  await expect(firstMute).toHaveAttribute('aria-pressed', 'false');
  // tablet: song header, waveform, sections and mixer all fit without scrolling
  const fits = await page.locator('.main').evaluate((m) => m.scrollHeight <= m.clientHeight + 1);
  expect(fits).toBe(true);
  await page.screenshot({ path: `${SHOTS}/mixer-tablet.png` });

  // Next triggers the next song's first scene; Live's launch quantization lands it on the next bar
  await page.getByRole('navigation', { name: 'Transport' }).getByRole('button', { name: /Next song/ }).click();
  await expect(page.getByText('→ Slow Satellite')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/perform-session-queued-tablet.png` });
  await expect(page.locator('.preset-name')).toHaveText('Slow Satellite', { timeout: 5000 });

  // always 8 pads: this song's 5 scenes, then blank ones
  await expect(pads.getByRole('button', { name: /^Pad \d+:/ })).toHaveCount(8);
  await expect(pads.getByRole('button', { name: 'Pad 8: empty' })).toBeVisible();
  // no markers in this song: its pads are its scenes; a pad launches its scene
  await pads.getByRole('button', { name: /^Pad 3: Chorus/ }).click();
  await expect(pads.getByRole('button', { name: /^Pad 3: Chorus, playing/ })).toBeVisible({ timeout: 1000 }); // at once, not on the bar
  await page.screenshot({ path: `${SHOTS}/perform-session-tablet.png` });
  // Space plays and stops, even with a pad focused (it doesn't also press the pad)
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});
