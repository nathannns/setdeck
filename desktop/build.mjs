// Builds SetDeck.app: bundles the Electron main process (with the server inside) and packages it.
/* global URL, process, console */
// Run `npm run app` from the repo root (it builds the web UI first).
import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const electronVersion = JSON.parse(readFileSync(new URL('../node_modules/electron/package.json', import.meta.url))).version;

mkdirSync('app', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'app/main.mjs',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  // ws uses require(); give the ESM bundle one.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
writeFileSync('app/package.json', JSON.stringify({ name: 'setdeck', productName: 'SetDeck', version: '0.1.0', main: 'main.mjs', type: 'module' }, null, 2));

const [out] = await packager({
  dir: 'app',
  out: 'out',
  overwrite: true,
  platform: 'darwin',
  arch: process.arch,
  name: 'SetDeck',
  appBundleId: 'local.setdeck.app',
  appCategoryType: 'public.app-category.music',
  icon: 'icon.icns',
  electronVersion,
  extraResource: ['../web/dist'],
  asar: true,
});
console.log(`Built ${out}/SetDeck.app`);
