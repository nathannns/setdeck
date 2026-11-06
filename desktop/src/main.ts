// SetDeck.app: runs the SetDeck server inside the app and shows the UI in a native window.
// Tablets can still connect over Wi-Fi to the same server.

import { app, BrowserWindow, Menu, dialog, nativeTheme, screen, shell, clipboard } from 'electron';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@setdeck/server';

const PORT = 7300;
let win: BrowserWindow | null = null;
let server: Awaited<ReturnType<typeof startServer>> | null = null;

if (!app.requestSingleInstanceLock()) app.quit();
nativeTheme.themeSource = 'dark';

const lanUrls = () =>
  Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i!.address}:${PORT}`);

function showTabletInfo() {
  const urls = lanUrls();
  const response = dialog.showMessageBoxSync({
    type: 'info',
    message: 'Use SetDeck on an iPad or phone',
    detail: urls.length
      ? `On a device on the same Wi-Fi, open:\n\n${urls.join('\n')}\n\nIn Safari: Share › Add to Home Screen for a full-screen app.`
      : 'This Mac is not on a network. Connect to Wi-Fi first.',
    buttons: urls.length ? ['OK', 'Copy address'] : ['OK'],
  });
  if (response === 1 && urls[0]) clipboard.writeText(urls[0]);
}

function createWindow() {
  // Opens filling the second screen (the main one is for watching), or the main one if there is only one.
  const main = screen.getPrimaryDisplay();
  const { x, y, width, height } = (screen.getAllDisplays().find((d) => d.id !== main.id) ?? main).workArea;
  win = new BrowserWindow({
    x, y, width, height, minWidth: 900, minHeight: 640,
    backgroundColor: '#09090b', title: 'SetDeck', show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win?.show());
  void win.loadURL(`http://localhost:${PORT}`);
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

void app.whenReady().then(async () => {
  try {
    // Packaged: the built UI sits in Contents/Resources/dist.
    server = await startServer({ httpPort: PORT, webDir: app.isPackaged ? join(process.resourcesPath, 'dist') : undefined });
  } catch (e) {
    const busy = (e as NodeJS.ErrnoException).code === 'EADDRINUSE';
    dialog.showErrorBox('SetDeck could not start', busy
      ? `Port ${PORT} is already in use. Is SetDeck (or its development server) already running?`
      : String(e));
    app.quit();
    return;
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Use on iPad or Phone…', click: showTabletInfo },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { role: 'windowMenu' },
  ]));
  createWindow();
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('activate', () => { if (!win && server) createWindow(); });
// ponytail: closing the window quits (the server dies with it), so nothing keeps running unseen.
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => server?.close());
