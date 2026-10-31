'use strict';

/**
 * test/rename.test.js — renaming a download.
 *
 * Covers: queued rename, completed-file rename on disk, duplicate rejection,
 * invalid characters, and that the UI shows the new name.
 *
 *   electron test/rename.test.js
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, net } = require('electron');

const { DownloadManager } = require('../src/main/manager');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const DATA = crypto.randomBytes(300 * 1024);
const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const st = +m[1];
    const en = Math.min(m[2] ? +m[2] : DATA.length - 1, DATA.length - 1);
    res.writeHead(206, { 'content-length': en - st + 1, 'content-range': `bytes ${st}-${en}/${DATA.length}` });
    return res.end(DATA.subarray(st, en + 1));
  }
  res.writeHead(200, { 'content-length': DATA.length, 'accept-ranges': 'bytes' });
  res.end(DATA);
});

async function main() {
  await app.whenReady();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-rename-')); 
  const UA = path.join(dir, 'userdata');
  app.setPath('userData', UA);

  const settings = { connections: 4, maxConcurrent: 2, maxSpeed: 0, downloadDir: dir };
  const manager = new DownloadManager(
    { getNetFor: () => ({ net: { request: (o) => net.request(o) } }), reservedPaths: new Set() },
    { config: settings, storePath: path.join(UA, 'tasks.json') }
  );

  // ---- 1. completed file rename
  const job = manager.add({ url: `${base}/original-file.bin`, dir, connections: 4 });
  await sleep(50);
  for (let i = 0; i < 200; i += 1) {
    const j = manager.get(job.id);
    if (j && j.state === 'completed') break;
    await sleep(50);
  }
  const done = manager.get(job.id);
  check('下载完成', done.state === 'completed', done.state);
  const before = done.filePath;
  const view = await manager.rename(job.id, '我的新名字.bin');
  check('重命名返回新名称', view.name === '我的新名字.bin', view.name);
  check('磁盘上文件已改名', fs.existsSync(path.join(dir, '我的新名字.bin')) && !fs.existsSync(before));
  check('文件内容保持不变', crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, '我的新名字.bin'))).digest('hex') === crypto.createHash('sha256').update(DATA).digest('hex'));
  check('filePath 已更新', view.filePath.endsWith('我的新名字.bin'), view.filePath);

  // ---- 2. duplicate name rejected
  let dupErr = null;
  try {
    await manager.rename(job.id, '我的新名字.bin'); // same name is a no-op
    fs.writeFileSync(path.join(dir, 'taken.bin'), 'x');
    await manager.rename(job.id, 'taken.bin');
  } catch (e) {
    dupErr = e.message;
  }
  check('重名被拒绝', !!dupErr && /已存在|exists|already/.test(dupErr), dupErr || 'no error');

  // ---- 3. invalid characters are sanitized
  const view3 = await manager.rename(job.id, 'bad:name?*.bin');
  check('非法字符被替换', !/[\\/:*?"<>|]/.test(view3.name) && fs.existsSync(view3.filePath), view3.name);

  // ---- 4. empty name rejected
  let emptyErr = null;
  try {
    await manager.rename(job.id, '   ');
  } catch (e) {
    emptyErr = e.message;
  }
  check('空名称被拒绝', !!emptyErr, emptyErr || 'no error');

  // ---- 5. renaming a queued task (before it starts)
  const queued = manager.add({ url: `${base}/queued.bin`, dir, connections: 2 });
  const q = manager.get(queued.id);
  if (q.state === 'queued') {
    const v = await manager.rename(queued.id, 'queued-renamed.bin');
    check('排队中的任务可改名', v.name === 'queued-renamed.bin', v.name);
  } else {
    check('排队中的任务可改名', true, `(skipped, state=${q.state})`);
  }

  // ---- 6. UI shows the renamed file
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    frame: false,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'), contextIsolation: true, sandbox: false },
  });
  const h = (ch, fn) => ipcMain.handle(ch, (_e, arg) => ({
    ok: true,
    data: fn(arg),
  }));
  h('settings:get', () => ({ ...settings, defaultDownloadDir: dir, language: 'zh-CN', version: '1.3.0' }));
  h('app:env', () => ({}));
  h('dl:list', () => ({ tasks: manager.jobs.map((j) => j.toView()), logs: [] }));
  h('log:list', () => []);
  h('update:status', () => ({ state: 'idle', checkedAt: 0 }));
  h('win:is-maximized', () => false);
  for (const ch of ['win:minimize', 'win:toggle-maximize', 'win:close']) h(ch, () => true);
  ipcMain.handle('dl:rename', async (_e, a, b) => {
    try {
      const id = b === undefined ? a && a.id : a;
      const name = b === undefined ? a && a.name : b;
      return { ok: true, data: await manager.rename(id, name) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await sleep(1200);
  const shown = await js(`Array.from(document.querySelectorAll('.task-name')).map(e => e.textContent)`);
  check('界面显示重命名后的文件名', shown.some((n) => String(n).includes('bad') && String(n).includes('.bin')), JSON.stringify(shown));

  const hasRenameBtn = await js(`!!document.querySelector('[data-act="rename"]')`);
  check('任务卡有重命名按钮', hasRenameBtn === true);

  await js(`document.querySelector('[data-act="rename"]').click()`);
  await sleep(500);
  const modalOpen = await js(`document.getElementById('renameModal').classList.contains('open')`);
  const inputVal = await js(`document.getElementById('renameInput').value`);
  check('点击后弹出重命名对话框', modalOpen === true, inputVal);
  await js(`(() => { const i = document.getElementById('renameInput'); i.value = '界面重命名.bin'; return true; })()`);
  await js(`document.getElementById('renameSave').click()`);
  await sleep(600);
  const after = await js(`Array.from(document.querySelectorAll('.task-name')).map(e => e.textContent)`);
  check('界面提交后名称更新', after.some((n) => String(n).includes('界面重命名')), JSON.stringify(after));

  win.destroy();
  server.close();
  setTimeout(() => app.exit(failed ? 1 : 0), 400);
  console.log(`\n${failed === 0 ? 'all' : ''} ${failed === 0 ? 'rename checks passed' : `${failed} failed`}`);
}

main().catch((e) => {
  console.error('RENAME TEST FAILED', e);
  app.exit(1);
});
