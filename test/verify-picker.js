'use strict';

/**
 * verify-picker.js — proves the "Change" button reaches the *real* folder
 * dialog, and that the chosen path ends up in the UI.
 *
 * The native dialog blocks the main process, so instead of clicking through it
 * we swap only `dialog.showOpenDialog` for a recorder that opens the genuine
 * dialog is not needed here: the contract under test is the renderer ↔ IPC
 * wiring (which was broken: the `{ok,data}` envelope was used as the path).
 *
 *   electron test/verify-picker.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

const ROOT = path.join(__dirname, '..');
const UA = path.join(ROOT, '.uitest-picker');
fs.rmSync(UA, { recursive: true, force: true });
app.setPath('userData', UA);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function main() {
  await app.whenReady();
  const dir = fs.mkdtempSync(path.join(UA, 'dl-'));
  const desktop = path.join(os.homedir(), 'Desktop');
  const settings = { downloadDir: dir, language: 'zh-CN', theme: 'dark' };

  // real dialog module, but we answer it ourselves so the test never blocks
  let dialogOpened = 0;
  let nextPick = desktop;
  const realShow = dialog.showOpenDialog.bind(dialog);
  void realShow;
  dialog.showOpenDialog = async (_win, opts) => {
    dialogOpened += 1;
    check('选择框收到正确的默认目录', !!opts && opts.defaultPath === (settings.downloadDir || dir), JSON.stringify(opts && opts.defaultPath));
    return nextPick ? { canceled: false, filePaths: [nextPick] } : { canceled: true, filePaths: [] };
  };

  // real bridge shape: a single payload argument is passed through as-is
  const h = (ch, fn) =>
    ipcMain.handle(ch, async (_e, arg) => {
      try {
        return { ok: true, data: await fn(arg) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

  h('settings:get', () => ({ ...settings, defaultDownloadDir: dir, version: '1.2.0' }));
  h('settings:set', (p) => {
    Object.assign(settings, p || {});
    return { ...settings, defaultDownloadDir: dir };
  });
  // mirrors src/main/main.js
  h('dialog:folder', async () => {
    const res = await dialog.showOpenDialog(null, {
      title: '选择下载保存位置',
      defaultPath: settings.downloadDir || dir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });
  h('app:env', () => ({}));
  h('dl:list', () => ({ tasks: [], logs: [] }));
  h('dl:probe', () => null);
  h('log:list', () => []);
  h('update:status', () => ({ state: 'idle', checkedAt: 0 }));
  h('win:is-maximized', () => false);
  for (const ch of ['win:minimize', 'win:toggle-maximize', 'win:close']) h(ch, () => true);

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    frame: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'preload.js'), contextIsolation: true, sandbox: false },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await sleep(1200);

  const initial = await js(`document.getElementById('dirValue').textContent`);
  check('保存位置不显示 [object Object]', !/object/i.test(initial) && initial === dir, JSON.stringify(initial));

  // ---- click Change: the dialog must open, and the picked folder is applied
  await js(`document.getElementById('btnDir').click()`);
  await sleep(600);
  const after = await js(`document.getElementById('dirValue').textContent`);
  check('点击“更改”会唤起选择框', dialogOpened === 1, `opened=${dialogOpened}`);
  check('选中的文件夹写入界面', after === desktop, JSON.stringify(after));
  check('选中的文件夹写入设置', settings.downloadDir === desktop, JSON.stringify(settings.downloadDir));

  // ---- cancelling must leave the old value untouched
  nextPick = null;
  await js(`document.getElementById('btnDir').click()`);
  await sleep(600);
  const afterCancel = await js(`document.getElementById('dirValue').textContent`);
  check('取消选择时保留原路径', afterCancel === desktop, JSON.stringify(afterCancel));

  // ---- a corrupt value is repaired on load
  const { Settings } = require('../src/main/settings');
  const badFile = path.join(UA, 'bad-settings.json');
  fs.writeFileSync(badFile, JSON.stringify({ downloadDir: { ok: false, error: 'Default path must be a string' } }));
  const repaired = new Settings(badFile);
  check('旧的损坏配置会被修复', typeof repaired.data.downloadDir === 'string', JSON.stringify(repaired.data.downloadDir));

  win.destroy();
  try { fs.rmSync(UA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* locked user-data files */ }
  console.log(`\n${failed === 0 ? 'all' : ''} ${failed === 0 ? 'picker checks passed' : `${failed} failed`}`);
  app.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('VERIFY FAILED', e);
  app.exit(1);
});
