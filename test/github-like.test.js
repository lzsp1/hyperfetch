'use strict';

/**
 * test/github-like.test.js — mimics what a blocked/slow GitHub direct
 * connection looks like: high speed, then throughput collapses to a trickle,
 * all sockets stall (no data, no close), and a fraction of new requests fail.
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { DownloadJob } = require('../src/main/download');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const DATA = crypto.randomBytes(60 * 1024 * 1024);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');

const state = {
  phase: 'fast', // fast | trickle | stall
  startedAt: Date.now(),
  requests: 0,
};

const server = http.createServer((req, res) => {
  state.requests += 1;
  // The global phase flips between fast / trickle / stall; `startedAt` is reset
  // when the connection recovers so new requests are served normally again.
  const phase = state.phase;

  if (phase === 'stall') {
    // Accept the request but never send a byte and never close it — exactly how
    // a blocked tunnel behaves. The engine must time it out and retry rather
    // than wait forever.
    return; // socket stays open
  }

  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(200, { 'content-length': DATA.length, 'accept-ranges': 'bytes' });
    return res.end(DATA);
  }
  const st = +m[1];
  const en = Math.min(m[2] ? +m[2] : DATA.length - 1, DATA.length - 1);
  res.writeHead(206, { 'content-length': en - st + 1, 'content-range': `bytes ${st}-${en}/${DATA.length}` });

  const chunk = phase === 'trickle' ? 1024 : 32 * 1024;
  const delay = phase === 'trickle' ? 900 : 12;
  let pos = st;
  const pump = () => {
    if (pos > en) return res.end();
    const next = Math.min(en + 1, pos + chunk);
    res.write(DATA.subarray(pos, next));
    pos = next;
    setTimeout(pump, delay);
  };
  pump();
});

function fakeNet() {
  return {
    request: (opts) => {
      const E = new (require('events'))();
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

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-gh-'));
  const job = new DownloadJob(
    { getNetFor: () => ({ net: fakeNet() }), reservedPaths: new Set() },
    { url: `http://127.0.0.1:${server.address().port}/gh.zip`, dir, connections: 8 }
  );
  const logs = [];
  job.on('log', (m) => logs.push(m));
  const etas = [];
  const speeds = [];
  const iv = setInterval(() => {
    if (job.active) {
      etas.push(job.eta || 0);
      speeds.push(job.currentSpeed || 0);
    }
  }, 250);

  const p = job.start();
  // after ~4s the connection becomes a blackhole (like a blocked tunnel)
  // a hard stall in the middle, then the tunnel recovers
  setTimeout(() => { state.phase = 'stall'; }, 3000);
  setTimeout(() => { state.phase = 'fast'; state.startedAt = Date.now(); }, 25000);
  const guard = setTimeout(() => job.pause(), 180000);
  await p;
  clearTimeout(guard);
  clearInterval(iv);

  const maxEta = Math.max(0, ...etas);
  const doneFile = fs.existsSync(`${dir}/gh.zip`);
  const hashOk = doneFile && crypto.createHash('sha256').update(fs.readFileSync(`${dir}/gh.zip`)).digest('hex') === SHA;

  console.log('  state:', job.state, '| error:', job.error || '-');
  console.log('  max ETA:', (maxEta / 3600).toFixed(2), 'hours | min speed:', Math.min(...speeds).toFixed(0), 'B/s');
  console.log('  logs:', logs.slice(-6).map((l) => '    ' + l).join('\n'));

  check('卡住 8 秒后恢复并完成', job.state === 'completed' && hashOk, job.state);
  check('剩余时间不会显示成数小时以上', maxEta < 6 * 3600, `${(maxEta / 60).toFixed(0)} 分钟`);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  server.close();
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
