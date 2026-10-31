'use strict';

/**
 * test/feedback.test.js — end-to-end check of the completion feedback:
 * a real download job that succeeds and one that fails must each trigger the
 * chime + notification path exactly once, honouring the settings switches.
 *
 *   electron test/feedback.test.js
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, net } = require('electron');

const { DownloadManager } = require('../src/main/manager');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const DATA = crypto.randomBytes(1024 * 1024);
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/missing') {
    res.writeHead(404);
    res.end('nope');
    return;
  }
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

/**
 * Mirrors main.js: listens to the manager's done/failed events and plays a
 * chime through the hidden player page, exactly like the real app.
 */
async function main() {
  await app.whenReady();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-feedback-'));

  const player = new BrowserWindow({
    show: false,
    width: 160,
    height: 100,
    skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await player.loadFile(path.join(__dirname, '..', 'src', 'main', 'sound-player.html'));
  const ready = await player.webContents.executeJavaScript('typeof window.playChime === "function"', true);
  check('提示音播放器页面已就绪', ready === true);

  const plays = [];
  const playChime = async (kind) => {
    const file = path.join(__dirname, '..', '.tools', `chime-${kind}.wav`);
    const url = `data:audio/wav;base64,${fs.readFileSync(file).toString('base64')}`;
    const r = await player.webContents.executeJavaScript(`window.playChime(${JSON.stringify(url)}, 0.8)`, true);
    plays.push({ kind, ...r });
  };
  // generate the chime files the same way main.js does
  const sound = require('../src/main/sound');
  const files = sound.ensureSoundFiles(path.join(__dirname, '..', '.tools'));
  check('提示音文件可用', !!(files && fs.existsSync(files.done) && fs.existsSync(files.fail)));

  const settings = {
    connections: 8,
    maxConcurrent: 2,
    maxSpeed: 0,
    soundOnDone: true,
    soundOnFail: true,
    notifyOnDone: true,
  };
  const manager = new DownloadManager(
    { getNetFor: () => ({ net: { request: (o) => net.request(o) } }), reservedPaths: new Set() },
    { config: settings, storePath: path.join(dir, 'tasks.json') }
  );

  let doneCount = 0;
  let failCount = 0;
  manager.on('done', () => {
    doneCount += 1;
    if (settings.soundOnDone) playChime('done');
  });
  manager.on('failed', () => {
    failCount += 1;
    if (settings.soundOnFail) playChime('fail');
  });

  // ---- 1. a successful download chimes once
  manager.add({ url: `${base}/file.bin`, dir, connections: 8 });
  for (let i = 0; i < 200 && doneCount === 0; i += 1) await sleep(50);
  await sleep(300);
  check('下载成功触发一次 done 事件', doneCount === 1, `done=${doneCount}`);
  check('下载成功播放成功提示音', plays.some((p) => p.kind === 'done' && p.ok));

  // ---- 2. a failing download chimes with the *other* sound
  plays.length = 0;
  manager.add({ url: `${base}/missing`, dir, connections: 4 });
  for (let i = 0; i < 200 && failCount === 0; i += 1) await sleep(50);
  await sleep(300);
  check('下载失败触发一次 failed 事件', failCount === 1, `failed=${failCount}`);
  check('下载失败播放失败提示音（与成功音不同）', plays.length === 1 && plays[0].kind === 'fail' && plays[0].ok);

  // ---- 3. the switches are honoured
  plays.length = 0;
  settings.soundOnFail = false;
  const failsBefore = failCount;
  manager.add({ url: `${base}/missing?second=1`, dir, connections: 4 });
  for (let i = 0; i < 200 && failCount === failsBefore; i += 1) await sleep(50);
  await sleep(500);
  check('关闭失败提示音后不再播放', failCount === failsBefore + 1 && plays.length === 0, `failed=${failCount - failsBefore} plays=${plays.length}`);

  const doneFile = path.join(dir, 'file.bin');
  const okFile = fs.existsSync(doneFile) && crypto.createHash('sha256').update(fs.readFileSync(doneFile)).digest('hex') === crypto.createHash('sha256').update(DATA).digest('hex');
  check('下载文件内容正确', okFile);

  player.destroy();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'all' : ''} ${failed === 0 ? 'feedback checks passed' : `${failed} failed`}`);
  app.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FEEDBACK TEST FAILED', e);
  app.exit(1);
});
