'use strict';

/**
 * test/network-recovery.test.js — the downloader must survive an unreliable
 * connection: resets, stalls, zero-speed windows, and a temporary total outage.
 *
 *   electron test/network-recovery.test.js
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { DownloadJob } = require('../src/main/download');
const { net } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const DATA = crypto.randomBytes(3 * 1024 * 1024);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');

/** Knobs the tests flip between requests. */
let flaky = { resetEvery: 2, stallMs: 0, outageUntil: 0, counter: 0 };

const server = http.createServer((req, res) => {
  // a temporary total outage: sockets are destroyed immediately
  if (Date.now() < flaky.outageUntil) {
    req.socket.destroy();
    return;
  }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(200, { 'content-length': DATA.length, 'accept-ranges': 'bytes' });
    return res.end(DATA);
  }
  const st = +m[1];
  const en = Math.min(m[2] ? +m[2] : DATA.length - 1, DATA.length - 1);
  flaky.counter += 1;
  const n = flaky.counter;

  res.writeHead(206, { 'content-length': en - st + 1, 'content-range': `bytes ${st}-${en}/${DATA.length}` });

  // every Nth request: start, send a little, then kill the socket
  if (flaky.resetEvery && n % flaky.resetEvery === 0) {
    res.write(DATA.subarray(st, Math.min(en + 1, st + 4096)));
    setTimeout(() => req.socket.destroy(), 30);
    return;
  }
  let pos = st;
  const pump = () => {
    if (pos > en) return res.end();
    const next = Math.min(en + 1, pos + 64 * 1024);
    res.write(DATA.subarray(pos, next));
    pos = next;
    setTimeout(pump, flaky.stallMs);
  };
  pump();
});

function fakeNet() {
  return {
    request: (opts) => {
      const EventEmitter = require('events');
      const E = new EventEmitter();
      const u = new URL(opts.url);
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method, headers: opts.headers || {} },
        (r) => E.emit('response', { statusCode: r.statusCode, headers: r.headers, body: r })
      );
      req.on('error', (e) => E.emit('error', e));
      let started = false;
      return {
        setHeader: (k, v) => { if (!started) req.setHeader(k, v); },
        abort: () => req.destroy(),
        on: E.on.bind(E),
        once: E.once.bind(E),
        end: () => { if (started) return; started = true; setImmediate(() => req.end()); },
      };
    },
  };
}

async function withJob(opts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-net-'));
  const job = new DownloadJob({ getNetFor: () => ({ net: fakeNet() }), reservedPaths: new Set() }, {
    url: `http://127.0.0.1:${server.address().port}/file.bin`,
    dir,
    connections: 8,
    ...opts,
  });
  job.log = [];
  job.on('log', (m) => job.log.push(m));
  try {
    await fn(job, dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // ---- 1. frequent connection resets must still complete
  flaky = { resetEvery: 2, stallMs: 0, outageUntil: 0, counter: 0 };
  await withJob({}, async (job, dir) => {
    const t0 = Date.now();
    const timer = setTimeout(() => job.pause(), 120000);
    await job.start();
    clearTimeout(timer);
    const ok = job.state === 'completed' && crypto.createHash('sha256').update(fs.readFileSync(job.filePath)).digest('hex') === SHA;
    check('频繁断连（每 2 个请求重置一次）仍能完成', ok, `${job.state}, ${((Date.now() - t0) / 1000).toFixed(1)}s, 重试日志 ${job.log.filter((l) => /重试|retry/i.test(l)).length} 条`);
  });

  // ---- 2. a total outage in the middle must be waited out, not failed
  flaky = { resetEvery: 0, stallMs: 0, outageUntil: 0, counter: 0 };
  await withJob({}, async (job, dir) => {
    const p = job.start();
    setTimeout(() => {
      flaky.outageUntil = Date.now() + 12000; // 12 s of blackhole
    }, 400);
    const guard = setTimeout(() => job.pause(), 180000);
    await p;
    clearTimeout(guard);
    const ok = job.state === 'completed' && crypto.createHash('sha256').update(fs.readFileSync(job.filePath)).digest('hex') === SHA;
    check('中途断网 12 秒后自动恢复并完成', ok, job.state);
  });

  // ---- 3. slow (stalled) server: ETA must stay sane, not days
  flaky = { resetEvery: 0, stallMs: 35, outageUntil: 0, counter: 0 };
  await withJob({}, async (job) => {
    let maxEta = 0;
    let minSpeed = Infinity;
    const iv = setInterval(() => {
      if (job.active) {
        maxEta = Math.max(maxEta, job.eta || 0);
        minSpeed = Math.min(minSpeed, job.currentSpeed || 0);
      }
    }, 200);
    const guard = setTimeout(() => job.pause(), 180000);
    await job.start();
    clearInterval(iv);
    clearTimeout(guard);
    check('低速网络下剩余时间不会跳到数小时', maxEta < 3600, `最大 ETA ${(maxEta / 60).toFixed(1)} 分钟, 最小速度 ${(minSpeed / 1024).toFixed(0)} KB/s`);
  });

  server.close();
  console.log(`\n${failed === 0 ? 'all' : ''} ${failed === 0 ? 'network recovery checks passed' : `${failed} failed`}`);
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
}

main().catch((e) => {
  console.error('TEST FAILED', e);
  process.exit(1);
});
