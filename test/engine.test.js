'use strict';

/**
 * Engine test harness.
 *
 * Builds a fake Electron `net` object backed by Node's http client, starts a
 * local streaming HTTP server, and exercises DownloadJob: multi-segment
 * download, pause/resume, redirects, HEAD-less servers, stream fallback and
 * 404 handling.
 *
 *   node test/engine.test.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { Readable } = require('stream');

const { DownloadJob } = require('../src/main/download');

const ROOT = path.join(os.tmpdir(), `hf-engine-test-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });

const SIZE = 12 * 1024 * 1024 + 12345; // ~12 MB, not a round number
const DATA = crypto.randomBytes(SIZE);
const DATA_SHA = crypto.createHash('sha256').update(DATA).digest('hex');

/* ------------------------------------------------------------------ */
/* fake Electron net                                                   */
/* ------------------------------------------------------------------ */

/**
 * Faithful stand-in for Electron's ClientRequest: the request is only actually
 * sent inside end() (after the caller had the chance to set headers) and the
 * response is delivered asynchronously, exactly like the real thing.
 */
class FakeRequest extends require('events').EventEmitter {
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.options = options;
    this.headers = {};
    this.aborted = false;
    this.ended = false;
    this.req = null;
    this.started = false;
  }

  setHeader(k, v) {
    if (this.started) throw new Error('Cannot set headers after the request was started');
    // Electron's header names are case-insensitive
    this.headers[String(k).toLowerCase()] = v;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const u = new URL(this.url);
    const method = this.options.method || 'GET';
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { 'user-agent': 'HyperFetch-Test', ...this.headers },
      },
      (res) => {
        if (this.aborted) {
          res.destroy();
          return;
        }
        const location = res.headers.location;
        if (location && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          setImmediate(() => this.emit('redirect', res.statusCode, method, new URL(location, u).toString(), res.headers));
          return;
        }
        const fakeRes = {
          statusCode: res.statusCode,
          status: res.statusCode,
          headers: res.headers,
          // Electron exposes the body as a Node Readable
          body: method === 'HEAD' ? null : res,
        };
        if (method === 'HEAD') res.resume();
        setImmediate(() => this.emit('response', fakeRes));
      }
    );
    this.req = req;
    req.on('error', (e) => {
      if (!this.aborted) this.emit('error', e);
    });
    req.end();
  }

  abort() {
    this.aborted = true;
    this.start();
    try {
      this.req?.destroy();
    } catch {
      /* ignore */
    }
  }

  end() {
    this.ended = true;
    setImmediate(() => this.start());
  }
}

const fakeNet = {
  request: (opts) =>
    new FakeRequest(typeof opts === 'string' ? opts : opts.url, typeof opts === 'object' ? opts : {}),
};

const ctx = { getNetFor: () => ({ net: fakeNet }), reservedPaths: new Set() };

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */

let rangeCounter = 0;

function serveRange(req, res, data, { noHead = false, delay = 0 } = {}) {
  const range = req.headers.range;
  if (range && !noHead) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      rangeCounter += 1;
      const start = Number(m[1]);
      let end = m[2] ? Number(m[2]) : data.length - 1;
      if (start >= data.length) {
        res.writeHead(416);
        res.end();
        return;
      }
      end = Math.min(end, data.length - 1);
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${data.length}`,
      });
      // stream slowly in chunks so the writer coalescing is exercised
      let pos = start;
      const CHUNK = 64 * 1024;
      const pump = () => {
        if (pos > end) return res.end();
        const next = Math.min(end + 1, pos + CHUNK);
        res.write(data.subarray(pos, next));
        pos = next;
        if (delay) setTimeout(pump, delay);
        else setImmediate(pump);
      };
      pump();
      return true;
    }
  }
  return false;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (p === '/files/big.bin') {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        'content-length': DATA.length,
      });
      res.end();
      return;
    }
    if (serveRange(req, res, DATA)) return;
    res.writeHead(200, { 'content-length': DATA.length, 'accept-ranges': 'bytes' });
    res.end(DATA);
    return;
  }

  if (p === '/nohdr/unknown.bin') {
    // No HEAD support, no content-length on GET, but ranges on ranged GETs.
    if (req.method === 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (serveRange(req, res, DATA, { noHead: true })) return;
    res.writeHead(200);
    res.end(DATA);
    return;
  }

  if (p === '/norange/stream.bin') {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': DATA.length, 'accept-ranges': 'none' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': DATA.length });
    let pos = 0;
    const pump = () => {
      if (pos >= DATA.length) return res.end();
      const next = Math.min(DATA.length, pos + 256 * 1024);
      res.write(DATA.subarray(pos, next));
      pos = next;
      setImmediate(pump);
    };
    pump();
    return;
  }

  if (p === '/redirect/big.bin') {
    res.writeHead(302, { location: '/files/big.bin' });
    res.end();
    return;
  }

  if (p === '/headers/fancy.bin') {
    const disposition = "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E4%BB%B6.zip";
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-disposition': disposition,
        'content-length': DATA.length,
        'accept-ranges': 'bytes',
      });
      res.end();
      return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const st = Number(m[1]);
      const en = Math.min(m[2] ? Number(m[2]) : DATA.length - 1, DATA.length - 1);
      res.writeHead(206, {
        'content-disposition': disposition,
        'content-length': en - st + 1,
        'content-range': `bytes ${st}-${en}/${DATA.length}`,
      });
      return res.end(DATA.subarray(st, en + 1));
    }
    res.writeHead(200, { 'content-disposition': disposition, 'content-length': DATA.length });
    res.end(DATA);
    return;
  }

  if (p === '/missing') {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<h1>not found</h1>');
    return;
  }

  res.writeHead(500);
  res.end();
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function waitFor(predicate, timeout = 20000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (predicate()) return;
    await sleep(40);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

async function testSegmented(base) {
  const job = new DownloadJob(ctx, {
    url: `${base}/files/big.bin`,
    dir: path.join(ROOT, 'segmented'),
    connections: 8,
  });
  let maxSpeed = 0;
  job.on('log', (m) => process.env.VERBOSE && console.log('     ·', m));
  job.on('update', (d) => {
    maxSpeed = Math.max(maxSpeed, d.speed || 0, job.speed || 0);
  });
  const p = job.start();
  await waitFor(() => job.state === 'completed' || job.state === 'error', 40000, 'segmented completion');
  await p;
  const file = job.filePath;
  const ok =
    job.state === 'completed' &&
    fs.existsSync(file) &&
    sha(file) === DATA_SHA &&
    !fs.existsSync(`${file}.part`) &&
    !fs.existsSync(`${file}.hfd`);
  report('多线程分段下载（8 连接）内容校验', ok, `${job.state}, ${job.segments.length} 分片, 峰值 ${(maxSpeed / 1e6).toFixed(1)} MB/s`);}

async function testResume(base) {
  const dir = path.join(ROOT, 'resume');
  const job = new DownloadJob(ctx, { url: `${base}/files/big.bin`, dir, connections: 6 });
  job.on('log', (m) => process.env.VERBOSE && console.log('     ·', m));
  const p = job.start();
  await waitFor(() => job.received > DATA.length * 0.2 || job.state === 'error', 30000, 'progress');
  job.pause();
  await p;
  const received1 = job.received;
  const pausedOk = job.state === 'paused' && received1 > 0 && received1 < DATA.length;
  await sleep(200);
  // At this point the partial file should still be on disk
  const partOk = fs.existsSync(job.partPath);
  const metaOk = fs.existsSync(job.metaPath);

  job.resume();
  await waitFor(() => job.state === 'completed' || job.state === 'error', 40000, 'resume completion');
  await sleep(200);
  const ok = pausedOk && partOk && metaOk && job.state === 'completed' && sha(job.filePath) === DATA_SHA;
  report('暂停 / 续传（元数据 + 分段偏移恢复）', ok, `暂停于 ${(received1 / 1e6).toFixed(1)} MB, 最终 ${(fs.statSync(job.filePath).size / 1e6).toFixed(1)} MB`);
}

async function testRestoreFromMeta(base) {
  const dir = path.join(ROOT, 'restore');
  const a = new DownloadJob(ctx, { url: `${base}/files/big.bin`, dir, connections: 4 });
  const p = a.start();
  await waitFor(() => a.received > DATA.length * 0.15, 30000, 'progress(restore)');
  a.pause();
  await p;
  await sleep(300);
  const metaRaw = JSON.parse(fs.readFileSync(a.metaPath, 'utf8'));

  // Simulate an app restart: build a brand new job from the persisted metadata
  const b = new DownloadJob(ctx, { restore: metaRaw });
  b.on('log', (m) => process.env.VERBOSE && console.log('     ·', m));
  b.resume();
  await waitFor(() => b.state === 'completed' || b.state === 'error', 40000, 'restored completion');
  await sleep(200);
  const ok = b.state === 'completed' && sha(b.filePath) === DATA_SHA;
  report('重启后从 .hfd 元数据恢复任务', ok, `${b.state}`);
}

async function testRedirectAndDisposition(base) {
  const job = new DownloadJob(ctx, {
    url: `${base}/redirect/big.bin`,
    dir: path.join(ROOT, 'disposition'),
    connections: 4,
  });
  await job.start();
  const ok = job.state === 'completed' && job.name === 'big.bin' && sha(job.filePath) === DATA_SHA;
  report('302 重定向 + 解析最终文件名', ok, job.name);

  const job2 = new DownloadJob(ctx, {
    url: `${base}/headers/fancy.bin`,
    dir: path.join(ROOT, 'disposition'),
    connections: 4,
  });
  await job2.start();
  const ok2 = job2.state === 'completed' && job2.name === '测试文件.zip' && sha(job2.filePath) === DATA_SHA;
  report('RFC 5987 Content-Disposition 中文文件名', ok2, job2.name);
}

async function testNoHead(base) {
  const job = new DownloadJob(ctx, { url: `${base}/nohdr/unknown.bin`, dir: path.join(ROOT, 'nohead'), connections: 5 });
  await job.start();
  const ok = job.state === 'completed' && job.total === DATA.length && sha(job.filePath) === DATA_SHA;
  report('无 HEAD / 无 Content-Length 服务器（探测 Content-Range）', ok, `${job.state}, size=${job.total}`);
}

async function testStreamFallback(base) {
  const job = new DownloadJob(ctx, { url: `${base}/norange/stream.bin`, dir: path.join(ROOT, 'stream'), connections: 8 });
  await job.start();
  const ok = job.state === 'completed' && job.mode === 'stream' && sha(job.filePath) === DATA_SHA;
  report('不支持 Range 时回退单连接模式', ok, `${job.mode}`);
}

async function test404(base) {
  const job = new DownloadJob(ctx, { url: `${base}/missing`, dir: path.join(ROOT, 'missing'), connections: 4 });
  await job.start();
  const ok = job.state === 'error' && /404|不存在/.test(job.error || '') && !job.filePath;
  report('404 给出友好错误且不产生残留文件', ok, job.error);
}

async function testDuplicateName(base) {
  const dir = path.join(ROOT, 'dup');
  const a = new DownloadJob(ctx, { url: `${base}/files/big.bin`, dir, connections: 2 });
  await a.start();
  const first = a.filePath;
  const b = new DownloadJob(ctx, { url: `${base}/files/big.bin`, dir, connections: 2 });
  await b.start();
  const ok = first !== b.filePath && b.filePath.endsWith('big (2).bin') && b.state === 'completed';
  report('同名文件自动重命名（big (2).bin）', ok, path.basename(b.filePath));
}

/**
 * The segment planner must cover every byte exactly once and never create tiny
 * slivers, or a resumed download would leave holes.
 */
async function checkHintSegments(base) {
  const job = new DownloadJob(ctx, {
    url: `${base}/files/big.bin`,
    dir: path.join(ROOT, 'segments'),
    connections: 16,
  });
  const p = job.start();
  await waitFor(() => job.segments.length > 0, 20000, 'segments planned');
  job.pause();
  await p.catch(() => {});
  const segs = job.segments;
  let expect = 0;
  let contiguous = true;
  let smallest = Infinity;
  for (const s of segs) {
    if (s.start !== expect) contiguous = false;
    expect = s.end;
    smallest = Math.min(smallest, s.end - s.start);
  }
  const ok =
    contiguous &&
    expect === job.total &&
    smallest >= 65536 &&
    segs.length <= job.connections * 8 &&
    job.pieces > 0;
  report('分片切分完整性（连续、无缝隙、无过碎）', ok, `${segs.length} 片 / ${job.pieces} 块 / 最小 ${(smallest / 1024).toFixed(0)} KB`);
}

async function testManyConnections(base) {  rangeCounter = 0;
  const job = new DownloadJob(ctx, { url: `${base}/files/big.bin`, dir: path.join(ROOT, 'many'), connections: 32 });
  await job.start();
  const ok = job.state === 'completed' && sha(job.filePath) === DATA_SHA && rangeCounter >= 20;
  report('32 连接高并发写入正确性', ok, `${rangeCounter} 个 Range 请求, ${job.segments.length} 分片`);
}

/* ------------------------------------------------------------------ */

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`HyperFetch engine tests · server ${base} · ${(SIZE / 1048576).toFixed(1)} MB fixture\n`);

  const tests = [
    testSegmented,
    testResume,
    testRestoreFromMeta,
    testRedirectAndDisposition,
    testNoHead,
    testStreamFallback,
    test404,
    testDuplicateName,
    testManyConnections,
  ];
  for (const t of tests) {
    try {
      await t(base);
    } catch (e) {
      report(t.name, false, e.message);
    }
  }
  try {
    await checkHintSegments(base);
  } catch (e) {
    report('分片切分完整性', false, e.message);
  }

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('Failed:', failed.map((f) => f.name).join(', '));
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(process.exitCode || 0), 200);
})();
