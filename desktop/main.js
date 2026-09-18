const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const net = require('net');

let win = null;
let server = null;

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
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
  });

  win.loadURL(`http://127.0.0.1:${port}`);
  win.webContents.on('did-finish-load', async () => {
    console.log('[main] did-finish-load OK', win.webContents.getURL());
    try {
      const info = await win.webContents.executeJavaScript(`
        JSON.stringify({ title: document.title, nodes: document.querySelectorAll('*').length, text: (document.body.innerText || '').slice(0, 200), htmlLen: document.documentElement.outerHTML.length })
      `);
      console.log('[main] DOM:', info);
    } catch (e) { console.log('[main] DOM err', String(e)); }
    setTimeout(async () => {
      try {
        const info = await win.webContents.executeJavaScript(`
          (function () {
            const visible = [...document.querySelectorAll('body *')].filter((el) => {
              const st = getComputedStyle(el); return st.display !== 'none' && st.visibility !== 'hidden' && el.offsetParent !== null;
            });
            return JSON.stringify({
              visibleCount: visible.length,
              visibleText: (document.body.innerText || '').slice(0, 120),
              onboarding: !!document.querySelector('#onboarding, .onboarding, #login-screen'),
              modal: !!document.querySelector('#modal-root > *, #modal, #modal-shell'),
              token: !!localStorage.getItem('durov_token'),
              hasCrypto: !!window.CryptoLib || !!(window.Crypto && Crypto),
              bodyBg: getComputedStyle(document.body).background,
            });
          })()
        `);
        console.log('[main] DOM2:', info);
      } catch (e) { console.log('[main] DOM2 err', String(e)); }
    }, 2500);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => console.log('[main] did-fail-load', code, desc, url));
  win.webContents.on('render-process-gone', (e, details) => console.log('[main] render-process-gone', JSON.stringify(details)));
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 1) console.log(`[renderer:${level}] ${sourceId}:${line} ${message}`);
  });
  win.webContents.on('unresponsive', () => console.log('[main] renderer UNRESPONSIVE'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const menu = Menu.buildFromTemplate([
    {
      label: 'DUROV MSG',
      submenu: [
        { label: 'Открыть в браузере', click: () => shell.openExternal(`http://127.0.0.1:${port}`) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'quit' },
      ],
    },
    { label: 'Вид', role: 'viewMenu' },
  ]);
  Menu.setApplicationMenu(menu);
}

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