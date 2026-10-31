'use strict';

/**
 * HyperFetch — Electron main process.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, net, session, nativeTheme, Menu, Notification } = require('electron');

const { Settings } = require('./settings');
const { DownloadManager } = require('./manager');
const { installQuitHandler } = require('./download');
const { UpdateManager } = require('./update');
const { resolveFinalUrlOnly, filenameFromContentDisposition, filenameFromUrl, formatBytes } = require('./util');
const sound = require('./sound');
const i18nMain = require('./i18n-main');

const APP_NAME = 'HyperFetch';

app.setName(APP_NAME);
app.commandLine.appendSwitch('enable-features', 'FontationsFontBackend');
// Electron derives the userData folder from package.json "name"; use an
// explicit, stable directory instead ("~/.hyperfetch").
process.env.HF_USERDATA = path.join(os.homedir(), '.hyperfetch');
app.setPath('userData', process.env.HF_USERDATA);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let win = null;
let settings = null;
let manager = null;
let updater = null;
let configDir = '';
let activeSession = null;
let soundFiles = null;
let soundWin = null;
const soundCache = {};

const tasksPath = () => path.join(configDir, 'tasks.json');

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function getDownloadsDir() {
  try {
    return app.getPath('downloads');
  } catch {
    return path.join(os.homedir(), 'Downloads');
  }
}

/** Applies the proxy configuration to an Electron session. */
async function applyProxy(sess, { proxyMode, proxyUrl }) {
  try {
    if (proxyMode === 'direct') {
      await sess.setProxy({ mode: 'direct' });
    } else if (proxyMode === 'custom' && proxyUrl) {
      await sess.setProxy({ proxyRules: proxyUrl, proxyBypassRules: '<local>' });
    } else {
      await sess.setProxy({ mode: 'system' });
    }
    await sess.closeAllConnections();
  } catch (e) {
    console.warn('proxy setup failed', e);
  }
}

function resolveNet(proxy) {
  const mode = proxy?.mode || settings.data.proxyMode;
  // The system/current proxy configuration lives on the app's default session.
  const sess = mode === 'system' || !activeSession ? net : activeSession;
  return { net: { request: (opts) => sess.request(opts) } };
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function isSafeExternal(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Keeps Electron's native widgets in sync with the requested theme. */
function applyNativeTheme(theme) {
  const value = theme === 'light' || theme === 'dark' ? theme : 'system';
  nativeTheme.themeSource = value;
  const light = value === 'light' || (value === 'system' && !nativeTheme.shouldUseDarkColors);
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(light ? '#eceef4' : '#06070b');
  }
}

/* ------------------------------------------------------------------ */
/* completion chime                                                    */
/* ------------------------------------------------------------------ */

/**
 * Plays one of the generated chimes.
 *
 * The sound is handed to a tiny hidden renderer as a base64 data URL and played
 * with the Web Audio API — no player plugin, no system sound dependency, and no
 * file:// access from an opaque page. Failures stay silent: a missing chime
 * must never interrupt a download.
 */
function playChime(kind) {
  const wanted = kind === 'fail' ? settings?.data.soundOnFail : settings?.data.soundOnDone;
  if (!wanted || !soundFiles) return;
  const file = kind === 'fail' ? soundFiles.fail : soundFiles.done;
  if (!file) return;
  const volume = Math.min(1, Math.max(0, Number(settings?.data.soundVolume ?? 0.8)));
  let dataUrl;
  try {
    if (!soundCache[file] || !fs.existsSync(file)) {
      soundCache[file] = `data:audio/wav;base64,${fs.readFileSync(file).toString('base64')}`;
    }
    dataUrl = soundCache[file];
  } catch {
    return;
  }

  const send = () =>
    soundWin.webContents
      .executeJavaScript(`window.playChime(${JSON.stringify(dataUrl)}, ${volume})`, true)
      .catch(() => {});

  try {
    if (!soundWin || soundWin.isDestroyed()) {
      soundWin = new BrowserWindow({
        show: false,
        width: 160,
        height: 100,
        skipTaskbar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      soundWin.webContents.on('did-finish-load', send);
      soundWin.loadFile(path.join(__dirname, 'sound-player.html'));
      return;
    }
    if (soundWin.webContents.isLoading()) return; // the load handler will play it
    send();
  } catch {
    /* silent: the chime is cosmetic */
  }
}

/** Shows a system notification (Windows toast) when a download finishes. */
function notifyDone(task, failed) {
  if (!Notification.isSupported()) return;
  if (!win || win.isDestroyed() || win.isFocused()) return; // already looking at it
  if (!settings.data.notifyOnDone) return;
  const name = task?.name || task?.url || '';
  const title = failed
    ? i18nMain.t('notify.failedTitle')
    : i18nMain.t('notify.doneTitle');
  const body = failed
    ? i18nMain.t('notify.failedBody', { name, error: task?.error || '' })
    : i18nMain.t('notify.doneBody', { name });
  try {
    const n = new Notification({ title, body, silent: true, icon: path.join(__dirname, '..', 'assets', 'icon.png') });
    n.on('click', () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
    n.show();
  } catch {
    /* notifications are best effort */
  }
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#06070b',
    transparent: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      zoomFactor: 1,
    },
  });

  win.setMenuBarVisibility(false);
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  applyNativeTheme(settings.data.theme);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  const emitState = () => {
    if (!win || win.isDestroyed()) return;
    broadcast('win:state', { maximized: win.isMaximized(), focused: win.isFocused() });
  };
  win.on('maximize', emitState);
  win.on('unmaximize', emitState);
  win.on('focus', emitState);
  win.on('blur', emitState);

  // Open target="_blank" / window.open links in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    // The renderer itself must never navigate away; external links open in the
    // user's browser instead.
    e.preventDefault();
    if (!url.startsWith('file:') && isSafeExternal(url)) shell.openExternal(url);
  });

  win.on('closed', () => {
    win = null;
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, data: await fn(event, ...args) };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    });
  };

  /* settings */
  handle('settings:get', () => ({
    ...settings.all,
    downloadDir: settings.data.downloadDir || getDownloadsDir(),
    defaultDownloadDir: getDownloadsDir(),
    platform: process.platform,
    version: app.getVersion(),
    appName: APP_NAME,
  }));

  handle('settings:set', async (_e, patch = {}) => {
    const before = { ...settings.data };
    settings.set(patch);
    if (
      before.proxyMode !== settings.data.proxyMode ||
      before.proxyUrl !== settings.data.proxyUrl
    ) {
      if (activeSession) {
        await applyProxy(activeSession, settings.data);
      }
    }
    if (
      before.maxSpeed !== settings.data.maxSpeed ||
      before.maxConcurrent !== settings.data.maxConcurrent ||
      before.connections !== settings.data.connections
    ) {
      manager.applySettings();
    }
    if (before.theme !== settings.data.theme) {
      applyNativeTheme(settings.data.theme);
    }
    broadcast('settings:changed', settings.all, { downloadDir: settings.data.downloadDir || getDownloadsDir() });
    return {
      ...settings.all,
      defaultDownloadDir: getDownloadsDir(),
    };
  });

  handle('settings:reset', () => {
    settings.reset();
    applyNativeTheme(settings.data.theme);
    broadcast('settings:changed', settings.all);
    return { ...settings.all, defaultDownloadDir: getDownloadsDir() };
  });

  /* updates (GitHub Releases via CDN mirrors) */
  handle('update:status', () => updater.status());
  handle('update:check', () => updater.check());
  handle('update:download', () => updater.startUpdate());
  handle('update:cancel', () => {
    updater.cancelUpdate();
    return updater.status();
  });
  handle('update:install', () => updater.installAndQuit());
  handle('update:open-releases', () => updater.openReleasePage());
  handle('update:open-installer-folder', () => {
    const inst = updater.installer;
    if (inst?.path) shell.showItemInFolder(inst.path);
    return true;
  });

  /* dialogs & shell */
  handle('dialog:folder', async () => {
    if (!win || win.isDestroyed()) return null;
    // A folder dialog must be tied to the window that asked for it, and the
    // window must be interactive — a hidden/disabled window makes the dialog
    // disappear instantly, which looked like "nothing happened".
    if (win.isMinimized()) win.restore();
    try {
      win.focus();
    } catch {
      /* ignore */
    }
    const res = await dialog.showOpenDialog(win, {
      title: '选择下载保存位置',
      defaultPath: settings.data.downloadDir || getDownloadsDir(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择此文件夹',
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  handle('shell:open-path', async (_e, p) => {
    if (!p) return false;
    try {
      await fs.promises.access(p);
    } catch {
      throw new Error(i18nMain.t('toast.fileMissing'));
    }
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return true;
  });

  handle('shell:show-item', async (_e, p) => {
    if (!p) return false;
    try {
      await fs.promises.access(p);
      shell.showItemInFolder(p);
      return true;
    } catch {
      // fall back to the containing folder
      const dir = path.dirname(p);
      await shell.openPath(dir);
      return true;
    }
  });

  handle('shell:open-external', async (_e, u) => {
    if (!isSafeExternal(u)) throw new Error(i18nMain.t('toast.unsupportedLink'));
    await shell.openExternal(u);
    return true;
  });

  handle('clipboard:read', () => clipboard.readText());

  /** Renames an existing downloaded file (keeps the same folder). */
  handle('dl:rename', async (_e, id, newName) => {
    const job = manager.get(id);
    if (!job) throw new Error(i18nMain.t('rename.failed', { error: 'job not found' }));
    return manager.rename(id, newName);
  });

  handle('app:env', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    configDir,
    tasksFile: tasksPath(),
    configFile: path.join(configDir, 'settings.json'),
    downloadsDir: getDownloadsDir(),
    home: os.homedir(),
    repo: settings.data.updateRepo || '',
    installed: app.isPackaged,
  }));

  /* window controls */
  handle('win:minimize', () => win && win.minimize());
  handle('win:toggle-maximize', () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  handle('win:close', () => win && win.close());
  handle('win:is-maximized', () => !!(win && win.isMaximized()));

  /* downloads */
  handle('dl:list', () => ({
    tasks: manager.jobs.map((j) => j.toView()),
    settings: { ...settings.all, defaultDownloadDir: getDownloadsDir() },
    logs: manager.logs,
  }));

  handle('dl:add', (_e, input) => manager.add(input || {}));
  handle('dl:pause', (_e, id) => manager.pause(id));
  handle('dl:resume', (_e, id) => manager.resume(id));
  handle('dl:remove', (_e, id) => manager.remove(id));
  handle('dl:pause-all', () => manager.pauseAll());
  handle('dl:resume-all', () => manager.resumeAll());
  handle('dl:clear-completed', () => manager.clearCompleted());
  handle('dl:set-connections', (_e, id, n) => manager.setConnections(id, n));
  handle('dl:set-max-speed', (_e, id, n) => manager.setMaxSpeed(id, n));

  /** Resolves a URL's metadata (name, size, range support) for the preview card. */
  handle('dl:probe', async (_e, url) => {
    let target = String(url || '').trim();
    if (!target) throw new Error('请输入下载地址');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) target = `https://${target}`;
    if (!/^https?:\/\//i.test(target)) throw new Error('仅支持 HTTP / HTTPS 地址');
    const ctx = resolveNet();
    const head = await resolveFinalUrlOnly(ctx, target, { timeout: 9000 });
    const finalUrl = head.finalUrl || target;
    const headers = head.headers || {};
    const name =
      filenameFromContentDisposition(headers['content-disposition']) ||
      filenameFromUrl(finalUrl) ||
      'download';
    const size = headers['content-length'] ? Number(headers['content-length']) : 0;
    const type = headers['content-type'] || '';
    return {
      url: target,
      finalUrl,
      name,
      size,
      sizeText: size ? formatBytes(size) : '未知大小',
      type,
      acceptsRanges: headers['accept-ranges'] === 'bytes',
      status: head.status || 0,
    };
  });

  handle('log:list', () => manager.logs);
  handle('i18n:locale', () => i18nMain.getLocale());

  /* completion feedback */
  handle('sound:preview', (_e, kind) => {
    playChime(kind === 'fail' ? 'fail' : 'done');
    return true;
  });
  handle('notify:preview', () => {
    if (!Notification.isSupported()) throw new Error(i18nMain.t('notify.unsupported'));
    new Notification({
      title: i18nMain.t('notify.doneTitle'),
      body: i18nMain.t('notify.doneBody', { name: 'HyperFetch-setup.exe' }),
      silent: true,
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    }).show();
    return true;
  });

  handle('dl:save-file-to', async (_e, sourcePath, suggestedName) => {
    if (!sourcePath) throw new Error(i18nMain.t('toast.fileMissing'));
    const res = await dialog.showSaveDialog(win, {
      title: '另存为',
      defaultPath: path.join(settings.data.downloadDir || getDownloadsDir(), suggestedName || path.basename(sourcePath)),
    });
    if (res.canceled || !res.filePath) return null;
    await fs.promises.copyFile(sourcePath, res.filePath);
    return res.filePath;
  });
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

if (gotLock) {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    configDir = path.join(app.getPath('userData'));
    try {
      fs.mkdirSync(configDir, { recursive: true });
    } catch {
      /* ignore */
    }

    settings = new Settings(path.join(configDir, 'settings.json'));
    i18nMain.bindSettings(settings);
    // chimes are generated once into the app's data folder
    soundFiles = sound.ensureSoundFiles(path.join(configDir, 'sounds'));
    if (!settings.data.downloadDir) settings.data.downloadDir = getDownloadsDir();

    activeSession = session.defaultSession;
    await applyProxy(activeSession, settings.data);

    // Follow the Windows theme by default; "system" is resolved in the renderer.
    nativeTheme.themeSource = settings.data.theme === 'light' || settings.data.theme === 'dark' ? settings.data.theme : 'system';

    manager = new DownloadManager(
      { getNetFor: resolveNet, reservedPaths: new Set() },
      { config: settings.data, storePath: tasksPath() }
    );
    manager.load();

    updater = new UpdateManager({
      config: settings.data,
      getNetFor: resolveNet,
      getSettings: () => settings.data,
    });
    updater.on('update', (s) => {
      broadcast('update:state', s);
      if (win && !win.isDestroyed()) {
        if (s.state === 'downloading' && s.progress?.total) {
          win.setProgressBar(Math.min(1, (s.progress.received || 0) / s.progress.total));
        } else if (s.state === 'ready' || s.state === 'error') {
          win.setProgressBar(-1);
        }
      }
    });
    updater.on('progress', (p) => broadcast('update:progress', p));
    updater.on('log', (line) => broadcast('log:line', { t: Date.now(), time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), m: line }));
    updater.on('ready', (inst) => broadcast('update:ready', inst));

    manager.on('update', (d) => broadcast('dl:update', d));
    manager.on('done', (d) => {
      broadcast('dl:done', d);
      playChime('done');
      notifyDone(d, false);
      if (!win || win.isDestroyed()) return;
      if (!win.isFocused() && settings.data.taskbarProgress !== false) {
        win.setProgressBar(1);
        setTimeout(() => win.setProgressBar(-1), 2600);
      }
      if (settings.data.openFolderWhenDone && d.filePath) {
        shell.showItemInFolder(d.filePath);
      }
    });
    manager.on('failed', (d) => {
      broadcast('dl:failed', d);
      playChime('fail');
      notifyDone(d, true);
      if (!win || win.isDestroyed()) return;
      win.setProgressBar(-1);
    });
    manager.on('removed', (id) => broadcast('dl:removed', id));
    manager.on('log', (line) => broadcast('log:line', line));
    manager.on('list-changed', () => broadcast('dl:list-changed', true));

    registerIpc();
    installQuitHandler(app, () => manager.jobs);
    createWindow();

    // kick the queue once the UI is up
    setTimeout(() => {
      manager.applySettings();
    }, 800);

    // silently look for a newer release a few seconds after launch
    setTimeout(() => {
      if (settings.data.autoCheckUpdate !== false && settings.data.updateRepo) {
        updater.check({ silent: true }).catch(() => {});
      }
    }, 3500);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    try {
      manager?.persistAllSync();
    } catch {
      /* ignore */
    }
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
  });
}

// Guard against unhandled rejections taking the app down.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
