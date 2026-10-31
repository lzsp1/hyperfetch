'use strict';

/**
 * sound.test.js — verifies the generated chimes and that a hidden Electron
 * window can actually play them through the Web Audio API.
 *
 *   electron test/sound.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const sound = require('../src/main/sound');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const dataLen = buf.readUInt32LE(40);
  const samples = (buf.length - 44) / 2;
  let peak = 0;
  for (let i = 0; i < samples; i += 1) peak = Math.max(peak, Math.abs(buf.readInt16LE(44 + i * 2)) / 32768);
  return { channels, rate, bits, dataLen, samples, duration: samples / rate, peak };
}

async function main() {
  await app.whenReady();

  const wavs = sound.renders();
  const done = parseWav(wavs.done);
  const fail = parseWav(wavs.fail);

  check('成功提示音是合法 WAV', !!done && done.channels === 1 && done.bits === 16 && done.rate === 44100);
  check('失败提示音是合法 WAV', !!fail && fail.channels === 1 && fail.bits === 16 && fail.rate === 44100);
  check('两个提示音不同', !wavs.done.equals(wavs.fail));
  check('成功提示音较长且上扬（0.8–1.5s）', done && done.duration > 0.8 && done.duration < 1.5, `${done.duration.toFixed(2)}s`);
  check('失败提示音较短（0.5–1.2s）', fail && fail.duration > 0.5 && fail.duration < 1.2, `${fail.duration.toFixed(2)}s`);
  check('音量已归一化', done && done.peak > 0.6 && done.peak <= 1 && fail.peak > 0.6 && fail.peak <= 1);

  // write to a temp folder exactly like the app does
  const dir = path.join(os.tmpdir(), `hf-sound-${Date.now()}`);
  const files = sound.ensureSoundFiles(dir);
  check('提示音写入磁盘', !!(files && fs.existsSync(files.done) && fs.existsSync(files.fail)));
  const again = sound.ensureSoundFiles(dir);
  check('重复调用不重复生成', fs.existsSync(again.done) && fs.statSync(again.done).size === fs.statSync(files.done).size);

  // the same mechanism the app uses: a hidden renderer + Web Audio
  const win = new BrowserWindow({
    show: false,
    width: 160,
    height: 100,
    skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'main', 'sound-player.html'));

  const asDataUrl = (file) => `data:audio/wav;base64,${fs.readFileSync(file).toString('base64')}`;

  const play = async (file) => {
    const dataUrl = asDataUrl(file);
    return win.webContents.executeJavaScript(
      `(async () => {
        if (typeof window.playChime !== 'function') {
          return { ok: false, error: 'sound-player.html did not expose playChime' };
        }
        // decode first so a failed playback is distinguishable from a bad file
        const ctx = new AudioContext();
        const bin = atob(${JSON.stringify(dataUrl.split(',')[1])});
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const decoded = await new Promise((resolve) => {
          ctx.decodeAudioData(bytes.buffer, (b) => resolve({ ok: true, seconds: b.duration, sampleRate: b.sampleRate }), (e) => resolve({ ok: false, error: String(e) }));
        });
        if (!decoded.ok) return decoded;
        const played = await window.playChime(${JSON.stringify(dataUrl)}, 0.8);
        return { ok: played.ok, decodedSeconds: decoded.seconds, sampleRate: decoded.sampleRate, played: played.ok, error: played.error };
      })()`,
      true
    );
  };

  const playedDone = await play(files.done);
  check('成功提示音可被解码并播放', playedDone.ok, playedDone.ok ? `${playedDone.decodedSeconds?.toFixed(2)}s @${playedDone.sampleRate}Hz` : playedDone.error);
  const playedFail = await play(files.fail);
  check('失败提示音可被解码并播放', playedFail.ok, playedFail.ok ? `${playedFail.decodedSeconds?.toFixed(2)}s @${playedFail.sampleRate}Hz` : playedFail.error);

  win.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'all' : ''} ${failed === 0 ? 'sound checks passed' : `${failed} failed`}`);
  app.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('SOUND TEST FAILED', e);
  app.exit(1);
});
