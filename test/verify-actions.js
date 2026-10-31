'use strict';
/**
 * verify-actions.js — checks the task card + drawer interactions after the fix:
 *   no duplicated buttons, icons actually render, pause/details work,
 *   removal really removes.
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, net } = require('electron');
const { DownloadManager } = require('../src/main/manager');

const ROOT = path.join(__dirname, '..');
const UA = path.join(ROOT, '.uitest-verify-actions');
try { fs.rmSync(UA, { recursive: true, force: true }); } catch {}
app.setPath('userData', UA);
const OUT = path.join(ROOT, 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const DATA = crypto.randomBytes(30 * 1024 * 1024);
const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const st = +m[1];
    const en = Math.min(m[2] ? +m[2] : DATA.length - 1, DATA.length - 1);
    res.writeHead(206, { 'content-length': en - st + 1, 'content-range': `bytes ${st}-${en}/${DATA.length}` });
    let pos = st;
    const pump = () => {
      if (pos > en) return res.end();
      const next = Math.min(en + 1, pos + 64 * 1024);
      res.write(DATA.subarray(pos, next));
      pos = next;
      setTimeout(pump, 50);
    };
    return pump();
  }
  res.writeHead(200, { 'content-length': DATA.length, 'accept-ranges': 'bytes' });
  res.end(DATA);
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(UA, 'dl-'));
  const settings = { connections: 8, maxConcurrent: 2, downloadDir: dir, language: 'zh-CN', theme: 'dark' };
  const manager = new DownloadManager(
    { getNetFor: () => ({ net: { request: (o) => net.request(o) } }), reservedPaths: new Set() },
    { config: settings, storePath: path.join(UA, 'tasks.json') }
  );
  let win = null;
  const bc = (ch, p) => win && !win.isDestroyed() && win.webContents.send(ch, p);
  manager.on('update', (d) => bc('dl:update', d));
  manager.on('done', (d) => bc('dl:done', d));
  manager.on('removed', (id) => bc('dl:removed', id));
  manager.on('log', (l) => bc('log:line', l));

  const w = (fn) => async (_e, arg) => { try { return { ok: true, data: await fn(arg) }; } catch (e) { return { ok: false, error: e.message }; } };
  const h = (ch, fn) => ipcMain.handle(ch, w(fn));
  h('settings:get', () => ({ ...settings, defaultDownloadDir: dir }));
  h('settings:set', (p) => ({ ...settings, ...(p || {}) }));
  h('app:env', () => ({}));
  h('dl:list', () => ({ tasks: manager.jobs.map((j) => j.toView()), logs: [] }));
  h('dl:add', (i) => manager.add(i));
  h('dl:remove', (id) => manager.remove(id));
  h('dl:pause', (id) => manager.pause(id));
  h('dl:resume', (id) => manager.resume(id));
  h('dl:rename', (a, b) => manager.rename(a, b));
  h('dl:probe', () => null);
  h('log:list', () => []);
  h('update:status', () => ({ state: 'idle', checkedAt: 0 }));
  h('win:is-maximized', () => false);
  for (const ch of ['win:minimize', 'win:toggle-maximize', 'win:close', 'dl:pause-all', 'dl:resume-all', 'dl:clear-completed', 'dl:set-connections', 'dl:set-max-speed', 'sound:preview', 'notify:preview']) h(ch, () => true);

  win = new BrowserWindow({ width: 1200, height: 800, show: true, frame: false, webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'preload.js'), contextIsolation: true, sandbox: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) errs.push(msg); });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await sleep(1000);

  manager.add({ url: `${base}/running.bin`, dir, connections: 8 });
  await sleep(2000);

  const card = await js(`(() => {
    const c = document.querySelector('.task');
    const btns = Array.from(c.querySelectorAll('.task-actions [data-act]'));
    return {
      actions: btns.map(b => b.dataset.act),
      icons: c.querySelectorAll('.task-actions svg').length,
      buttons: btns.length,
    };
  })()`);
  check('任务卡没有重复的重命名按钮', card.actions.filter((a) => a === 'rename').length === 0, JSON.stringify(card.actions));
  check('每个操作按钮都有图标', card.icons === card.buttons, `${card.icons}/${card.buttons}`);

  // pause works
  await js(`document.querySelector('.task [data-act="pause"]').click(); true`);
  await sleep(1000);
  const paused = await js(`document.querySelector('.task .task-state').textContent`);
  check('暂停按钮生效', paused === '已暂停', paused);

  // details opens the drawer with working buttons
  await js(`document.querySelector('.task [data-act="details"]').click(); true`);
  await sleep(800);
  const drawer = await js(`(() => {
    const b = document.getElementById('drawerBody');
    const btns = Array.from(b.querySelectorAll('.drawer-actions .ghost-btn'));
    const icons = btns.map(x => x.querySelector('svg') ? x.querySelector('svg').innerHTML.length : 0);
    return { open: document.getElementById('drawer').classList.contains('open'), count: btns.length, texts: btns.map(x => x.textContent.trim()), icons };
  })()`);
  check('详情按钮打开抽屉', drawer.open === true);
  check('抽屉内无重复重命名', drawer.texts.filter((x) => x === '重命名').length === 1, JSON.stringify(drawer.texts));
  check('抽屉内每个按钮都有图标', drawer.icons.every((n) => n > 0), JSON.stringify(drawer.icons));
  await sleep(400);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'fix-drawer-icons.png'), img.toPNG());

  // resume via drawer
  const resumeBtn = drawer.texts.indexOf('继续');
  if (resumeBtn >= 0) {
    await js(`document.querySelectorAll('#drawerBody .drawer-actions .ghost-btn')[${resumeBtn}].click(); true`);
    await sleep(800);
  }
  await js(`document.getElementById('drawerClose').click(); true`);
  await sleep(300);

  // remove really removes
  const beforeCards = await js(`document.querySelectorAll('.task').length`);
  await js(`document.querySelector('.task [data-act="remove"]').click(); true`);
  await sleep(1200);
  const afterCards = await js(`({ cards: document.querySelectorAll('.task').length, listChildren: document.getElementById('taskList').children.length, emptyShown: !document.getElementById('listEmpty').classList.contains('hidden') })`);
  check('移除后卡片从列表消失', beforeCards === 1 && afterCards.cards === 0, JSON.stringify(afterCards));
  check('移除后显示空状态', afterCards.emptyShown === true);

  check('无渲染错误', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  win.destroy();
  server.close();
  console.log(`\n${failed === 0 ? 'all' : ''} ${failed === 0 ? 'action checks passed' : `${failed} failed`}`);
  setTimeout(() => app.exit(failed ? 1 : 0), 300);
});
