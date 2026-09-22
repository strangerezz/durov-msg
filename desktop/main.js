const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const net = require('net');

let win = null;
let server = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

function findFreePort(base) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(base, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', () => resolve(base));
  });
}

async function startServer() {
  const base = process.env.DUROV_PORT ? parseInt(process.env.DUROV_PORT, 10) : 9173;
  const port = await findFreePort(base);
  const { startServer: boot } = require(path.join(__dirname, '..', 'server', 'index.js'));
  server = await boot(port);
  return port;
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    title: 'DUROV MSG',
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
    icon: path.join(__dirname, 'icon.png'),
  });

  win.loadURL(`http://127.0.0.1:${port}`);
  win.webContents.on('did-fail-load', (e, code, desc, url) => console.log('[main] did-fail-load', code, desc, url));
  win.webContents.on('render-process-gone', (e, details) => console.log('[main] render-process-gone', JSON.stringify(details)));
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 1) console.log(`[renderer:${level}] ${sourceId}:${line} ${message}`);
  });
  win.webContents.on('unresponsive', () => console.log('[main] renderer UNRESPONSIVE'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const menu = Menu.buildFromTemplate([
    {
      label: 'DUROV MSG',
      submenu: [
        { role: 'togglefullscreen' },
        { role: 'quit' },
      ],
    },
    { label: 'Вид', role: 'viewMenu' },
    { label: 'Правка', role: 'editMenu' },
  ]);
  Menu.setApplicationMenu(menu);
}

if (gotLock) {
  app.whenReady().then(async () => {
    const port = await startServer();
    createWindow(port);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    if (server && server.server) { try { server.server.close(); } catch {} }
  });
}