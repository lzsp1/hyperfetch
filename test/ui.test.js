'use strict';

/**
 * UI smoke test — launches HyperFetch against a local fixture server, drives
 * the renderer through the real download flow and captures screenshots into
 * ./screenshots.
 *
 *   npx electron test/ui.test.js
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, net } = require('electron');

const { Settings } = require('../src/main/settings');
const { DownloadManager } = require('../src/main/manager');
const { installQuitHandler } = require('../src/main/download');
const { resolveFinalUrlOnly, filenameFromUrl, formatBytes } = require('../src/main/util');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
const UA = path.join(ROOT, '.uitest');
fs.rmSync(UA, { recursive: true, force: true });
fs.rmSync(path.join(OUT, 'downloads'), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', UA);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* fixture server                                                      */
/* ------------------------------------------------------------------ */

const FIXTURE = crypto.randomBytes(24 * 1024 * 1024 + 777);
// Global throttle so a screenshot can catch real progress (bytes / second).
const FIXTURE_RATE = Number(process.env.HF_FIXTURE_RATE || 6 * 1024 * 1024);
let budget = FIXTURE_RATE;
let budgetAt = Date.now();
function take(n) {
  const now = Date.now();
  budget = Math.min(FIXTURE_RATE, budget + ((now - budgetAt) / 1000) * FIXTURE_RATE);
  budgetAt = now;
  budget -= n;
  return budget >= 0 ? 0 : (-budget / FIXTURE_RATE) * 1000;
}
const SHA = crypto.createHash('sha256').update(FIXTURE).digest('hex');

function sendRange(req, res, data, opts = {}) {
  const range = req.headers.range;
  const m = range && /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) return false;
  const start = Number(m[1]);
  const end = Math.min(m[2] ? Number(m[2]) : data.length - 1, data.length - 1);
  res.writeHead(206, {
    'content-type': opts.type || 'application/octet-stream',
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${data.length}`,
    'accept-ranges': 'bytes',
  });
  let pos = start;
  const pump = () => {
    if (pos > end) return res.end();
    const next = Math.min(end + 1, pos + 64 * 1024);
    res.write(data.subarray(pos, next));
    const wait = take(next - pos) + (opts.delay || 0);
    pos = next;
    setTimeout(pump, wait);
  };
  pump();
  return true;
}

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/downloads/Eclipse-Setup-3.2.1.exe') {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': FIXTURE.length, 'accept-ranges': 'bytes' });
      return res.end();
    }
    if (sendRange(req, res, FIXTURE, { delay: 4 })) return;
    res.writeHead(200, { 'content-length': FIXTURE.length, 'accept-ranges': 'bytes' });
    return res.end(FIXTURE);
  }
  if (p === '/downloads/Blender-4.2.1-windows-x64.msi') {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': FIXTURE.length, 'accept-ranges': 'bytes' });
      return res.end();
    }
    if (sendRange(req, res, FIXTURE, { delay: 10 })) return;
    res.writeHead(200, { 'content-length': FIXTURE.length });
    return res.end(FIXTURE);
  }
  res.writeHead(404);
  res.end('not found');
});

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const settings = new Settings(path.join(UA, 'settings.json'));
  const dlDir = path.join(OUT, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  Object.assign(settings.data, { downloadDir: dlDir, connections: 16, maxConcurrent: 3 });

  const dlNet = { request: (o) => net.request(o) };
  const manager = new DownloadManager(
    { getNetFor: () => ({ net: dlNet }), reservedPaths: new Set() },
    { config: settings.data, storePath: path.join(UA, 'tasks.json') }
  );
  manager.load();

  /**
   * Mirrors the real IPC bridge: every handler answers { ok, data } and always
   * settles, so renderer promises never hang.
   */
  const wrap = (fn) => async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  };
  const h = (ch, fn) => ipcMain.handle(ch, wrap(fn));

  let win = null;
  const broadcast = (ch, p) => win && !win.isDestroyed() && win.webContents.send(ch, p);

  h('settings:get', () => ({ ...settings.all, defaultDownloadDir: dlDir, version: '1.0.0' }));
  h('settings:set', (patch) => {
    settings.set(patch);
    manager.applySettings();
    broadcast('settings:changed', settings.all);
    return { ...settings.all, defaultDownloadDir: dlDir };
  });
  h('settings:reset', () => settings.reset());
  h('dialog:folder', () => dlDir);
  h('shell:open-path', () => true);
  h('shell:show-item', () => true);
  h('shell:open-external', () => true);
  h('clipboard:read', () => `${base}/downloads/Blender-4.2.1-windows-x64.msi`);
  h('app:env', () => ({
    version: '1.0.0',
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    configFile: path.join(UA, 'settings.json'),
    tasksFile: path.join(UA, 'tasks.json'),
    configDir: UA,
  }));
  h('win:minimize', () => true);
  h('win:toggle-maximize', () => false);
  h('win:close', () => true);
  h('win:is-maximized', () => false);
  h('dl:list', () => ({ tasks: manager.jobs.map((j) => j.toView()), logs: manager.logs }));
  h('dl:add', (input) => manager.add(input));
  h('dl:pause', (id) => manager.pause(id));
  h('dl:resume', (id) => manager.resume(id));
  h('dl:remove', (id) => manager.remove(id));
  h('dl:pause-all', () => manager.pauseAll());
  h('dl:resume-all', () => manager.resumeAll());
  h('dl:clear-completed', () => manager.clearCompleted());
  h('dl:set-connections', (id, n) => manager.setConnections(id, n));
  h('dl:set-max-speed', (id, n) => manager.setMaxSpeed(id, n));
  h('log:list', () => manager.logs);

  /* completion feedback: record which chime was requested */
  const soundCalls = [];
  h('sound:preview', (kind) => {
    soundCalls.push(kind);
    return true;
  });
  h('notify:preview', () => {
    soundCalls.push('notify');
    return true;
  });

  /* updates: a canned "new version available" so the dialog can be captured */
  const fakeUpdate = {
    state: 'available',
    current: '1.0.0',
    repo: 'demo/HyperFetch',
    checkedAt: Date.now(),
    info: {
      version: '1.4.0',
      tag: 'v1.4.0',
      htmlUrl: 'https://github.com/demo/HyperFetch/releases/tag/v1.4.0',
      body: '- 新增浅色 / 深色主题切换\n- 应用内更新支持国内 CDN 加速\n- 单线程回退更稳定',
      asset: { name: 'HyperFetch-1.4.0-x64-setup.exe', size: 82 * 1024 * 1024 },
    },
    installer: null,
    error: null,
    progress: null,
  };
  h('update:status', () => fakeUpdate);
  h('update:check', () => fakeUpdate);
  h('update:download', () => fakeUpdate);
  h('update:cancel', () => fakeUpdate);
  h('update:install', () => true);
  h('update:open-releases', () => true);
  h('update:open-installer-folder', () => true);
  globalThis.__fakeUpdate = fakeUpdate;
  // The renderer keeps its own state; push the same object through the bridge.
  const pushFakeUpdate = () => broadcast('update:state', fakeUpdate);
  void pushFakeUpdate;
  h('dl:probe', async (url) => {
    const r = await resolveFinalUrlOnly({ net: dlNet }, url, { timeout: 8000 });
    const size = r.headers['content-length'] ? Number(r.headers['content-length']) : 0;
    return {
      url,
      finalUrl: r.finalUrl,
      name: filenameFromUrl(r.finalUrl) || 'download',
      size,
      sizeText: size ? formatBytes(size) : '未知大小',
      type: r.headers['content-type'] || '',
      acceptsRanges: r.headers['accept-ranges'] === 'bytes',
    };
  });
  let peakSpeed = 0;
  manager.on('update', (d) => {
    if (d.speed) peakSpeed = Math.max(peakSpeed, d.speed);
    broadcast('dl:update', d);
  });
  manager.on('done', (d) => broadcast('dl:done', d));
  manager.on('removed', (id) => broadcast('dl:removed', id));
  manager.on('log', (l) => broadcast('log:line', l));
  manager.on('list-changed', () => broadcast('dl:list-changed', true));
  installQuitHandler(app, () => manager.jobs);

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: true,
    frame: false,
    backgroundColor: '#06070b',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    await sleep(450);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('screenshot:', name);
  };
  const typeUrl = (url) =>
    js(`(() => {
      const i = document.getElementById('urlInput');
      i.value = ${JSON.stringify(url)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return i.value;
    })()`);
  const submit = () => js(`document.getElementById('addForm').requestSubmit()`);

  await sleep(1200);
  await shot('01-empty.png');

  await typeUrl(`${base}/downloads/Eclipse-Setup-3.2.1.exe`);
  await sleep(1400);
  await shot('02-probe.png');

  await submit();
  await sleep(300);
  await typeUrl(`${base}/downloads/Blender-4.2.1-windows-x64.msi`);
  await sleep(1300);
  await submit();
  await sleep(3500);
  await shot('03-downloading.png');

  await js(`document.querySelector('.task').click()`);
  await sleep(900);
  await shot('04-drawer.png');
  await js(`document.getElementById('drawerClose').click()`);
  await sleep(500);

  await js(`document.querySelector('.tab[data-page="settings"]').click()`);
  await sleep(900);
  await shot('05-settings.png');

  // completion-feedback card: previews must reach the main process
  await js(`document.getElementById('setSoundDone').scrollIntoView({ block: 'center' })`);
  await sleep(400);
  await js(`document.querySelector('[data-preview="done"]').click()`);
  await sleep(500);
  await js(`document.querySelector('[data-preview="fail"]').click()`);
  await sleep(500);
  await js(`document.querySelector('[data-preview="notify"]').click()`);
  await sleep(500);
  const feedback = await js(`(() => ({
    done: document.getElementById('setSoundDone').checked,
    fail: document.getElementById('setSoundFail').checked,
    notify: document.getElementById('setNotifyDone').checked,
    vol: document.getElementById('setSoundVolume').value,
  }))()`);
  await shot('05c-settings-feedback.png');
  // turning the failure chime off must persist to settings
  await js(`(() => { const el = document.getElementById('setSoundFail'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(500);
  const persisted = settings.data.soundOnFail;
  console.log('RESULT feedback:', JSON.stringify({ ...feedback, soundCalls: soundCalls.slice(), persistedSoundOnFail: persisted }));
  // restore for the rest of the run
  await js(`(() => { const el = document.getElementById('setSoundFail'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(300);

  // light theme
  await js(`(() => { const b = document.querySelector('.theme-toggle button[data-theme="light"]'); b && b.click(); return document.documentElement.dataset.theme; })()`);
  await sleep(900);
  await shot('05b-settings-light.png');
  await js(`document.querySelector('.tab[data-page="downloads"]').click()`);
  await sleep(700);
  await shot('03b-downloads-light.png');

  // update dialog in light theme (fake status so the layout is captured)
  await js(`window.__showFakeUpdate && window.__showFakeUpdate('available', ${JSON.stringify(globalThis.__fakeUpdate)})`);
  await sleep(900);
  await shot('08-update-light.png');
  await js(`document.getElementById('updateClose').click()`);
  await sleep(400);

  // back to dark theme
  await js(`document.querySelector('.tab[data-page="settings"]').click()`);
  await sleep(400);
  await js(`(() => { const b = document.querySelector('.theme-toggle button[data-theme="dark"]'); b && b.click(); return document.documentElement.dataset.theme; })()`);
  await sleep(700);
  await js(`document.querySelector('.tab[data-page="downloads"]').click()`);
  await sleep(500);

  const t0 = Date.now();
  while (manager.jobs.some((j) => j.active) && Date.now() - t0 < 120000) await sleep(300);
  await sleep(1600);
  await shot('06-completed.png');

  const done = manager.jobs.filter((j) => j.state === 'completed');
  const ok = done.every(
    (j) => fs.existsSync(j.filePath) && crypto.createHash('sha256').update(fs.readFileSync(j.filePath)).digest('hex') === SHA
  );
  console.log(
    `RESULT completed: ${done.length}/${manager.jobs.length}, checksum ok: ${ok}, peak speed: ${(peakSpeed / 1e6).toFixed(1)} MB/s`
  );
  console.log('RESULT states:', manager.jobs.map((j) => `${j.name}=${j.state}`).join(', '));

  await js(`document.getElementById('consoleToggle').click()`);
  await sleep(800);
  await shot('07-logs.png');

  // dark update dialog
  await js(`window.__showFakeUpdate && window.__showFakeUpdate('available', ${JSON.stringify(globalThis.__fakeUpdate)})`);
  await sleep(900);
  await shot('08b-update-dark.png');
  await js(`document.getElementById('updateClose').click()`);
  await sleep(300);

  // ---- language switching: every supported language must render its own text
  const langReports = [];
  for (const code of ['en', 'fr', 'es', 'ru', 'ar']) {
    await js(`document.querySelector('.tab[data-page="settings"]').click()`);
    await sleep(350);
    await js(`document.querySelector('[data-lang="${code}"]').click()`);
    await sleep(700);
    const info = await js(`(() => ({
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      tab: document.querySelector('.tab[data-page="downloads"] span').textContent,
      head: document.querySelector('.page-heading h2').textContent,
      body: document.getElementById('langGrid').children.length,
    }))()`);
    langReports.push(info);
    await shot(`09-lang-${code}.png`);
    await js(`document.querySelector('.tab[data-page="downloads"]').click()`);
    await sleep(250);
  }
  // back to Chinese for the rest of the session
  await js(`document.querySelector('.tab[data-page="settings"]').click()`);
  await sleep(300);
  await js(`document.querySelector('[data-lang="zh-CN"]').click()`);
  await sleep(600);
  await js(`document.querySelector('.tab[data-page="downloads"]').click()`);
  await sleep(400);
  console.log('RESULT languages:', JSON.stringify(langReports));

  manager.persistAllSync();
  server.close();
  setTimeout(() => app.quit(), 400);
}

main().catch((e) => {
  console.error('UI TEST FAILED', e);
  app.exit(1);
});
