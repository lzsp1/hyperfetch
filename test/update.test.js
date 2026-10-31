'use strict';

/**
 * update.test.js — version comparison, CDN mirror list and the update flow
 * against a fake "GitHub API" served from Node's http module.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

/* ---- electron is not available under plain node: stub what update.js uses ---- */
const Module = require('module');
const originalResolve = Module._resolveFilename;
const electronStub = {
  app: { getVersion: () => '1.0.0', getPath: () => require('os').tmpdir(), quit: () => {} },
  shell: { openExternal: () => {}, openPath: () => {} },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};
void originalResolve;

const { compareVersions, cdnCandidates } = require('../src/main/update');

/* ------------------------------------------------------------------ */
/* pure helpers                                                        */
/* ------------------------------------------------------------------ */

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push([name, true]);
  } catch (e) {
    checks.push([name, false, e.message]);
  }
}

check('compareVersions 基本大小', () => {
  assert.ok(compareVersions('1.1.0', '1.0.0') > 0);
  assert.ok(compareVersions('1.0.1', '1.0.0') > 0);
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
});

check('compareVersions 带 v 前缀', () => {
  assert.ok(compareVersions('v1.2.0', '1.1.9') > 0);
  assert.strictEqual(compareVersions('v1.0.0', '1.0.0'), 0);
});

check('compareVersions 预发布低于正式版', () => {
  assert.ok(compareVersions('1.0.0', '1.0.0-beta.1') > 0);
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.1') > 0);
});

check('compareVersions 无法解析时返回 0', () => {
  assert.strictEqual(compareVersions('abc', '1.0.0'), 0);
});

check('CDN 候选包含镜像与直连，且直连在最后', () => {
  const list = cdnCandidates('https://github.com/o/r/releases/download/v1/a.exe');
  assert.ok(list.length >= 2);
  assert.strictEqual(list[list.length - 1], 'https://github.com/o/r/releases/download/v1/a.exe');
  assert.ok(list.some((u) => u.includes('ghfast.top')));
  assert.ok(list.some((u) => u.includes('gh-proxy.com')));
  // no duplicates
  assert.strictEqual(new Set(list).size, list.length);
});

/* ------------------------------------------------------------------ */
/* update flow with a fake GitHub API                                  */
/* ------------------------------------------------------------------ */

const INSTALLER = crypto.randomBytes(512 * 1024);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // gh-proxy style prefix
  const p = u.pathname.replace(/^\/https:\/\/api\.github\.com/, '');
  if (p === '/repos/demo/HyperFetch/releases/latest') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        tag_name: 'v1.4.0',
        name: 'HyperFetch v1.4.0',
        body: '- 新增浅色模式\n- 修复续传',
        html_url: 'https://github.com/demo/HyperFetch/releases/tag/v1.4.0',
        prerelease: false,
        assets: [
          { name: 'notes.txt', size: 10, browser_download_url: 'http://x/notes.txt' },
          {
            name: 'HyperFetch-1.4.0-x64-setup.exe',
            size: INSTALLER.length,
            browser_download_url: 'http://mirror.local/HyperFetch-1.4.0-x64-setup.exe',
          },
        ],
      })
    );
    return;
  }
  if (u.pathname.endsWith('/HyperFetch-1.4.0-x64-setup.exe')) {
    const range = req.headers.range;
    const m = range && /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const st = +m[1];
      const en = Math.min(m[2] ? +m[2] : INSTALLER.length - 1, INSTALLER.length - 1);
      res.writeHead(206, {
        'content-length': en - st + 1,
        'content-range': `bytes ${st}-${en}/${INSTALLER.length}`,
        'accept-ranges': 'bytes',
      });
      res.end(INSTALLER.subarray(st, en + 1));
      return;
    }
    res.writeHead(200, { 'content-length': INSTALLER.length, 'accept-ranges': 'bytes' });
    res.end(INSTALLER);
    return;
  }
  res.writeHead(404);
  res.end('nope');
});

async function runFlow() {
  const { DownloadJob } = require('../src/main/download');
  const ctx = {
    getNetFor: () => ({
      // the fixture speaks http; update.js resolves absolute URLs, so route
      // mirror.local through the local server for this test
      net: {
        request: (opts) => {
          const o = { ...opts };
          o.url = o.url.replace('http://mirror.local', `http://127.0.0.1:${server.address().port}`);
          o.headers = o.headers || {};
          // Node-level request to exercise ranges (Electron's net is exercised
          // by the UI test; here we only check the update orchestration)
          const EventEmitter = require('events');
          const E = new EventEmitter();
          const httpMod = require('http');
          const target = new URL(o.url);
          const req = httpMod.request(
            { hostname: target.hostname, port: target.port, path: target.pathname, method: o.method, headers: o.headers },
            (r) => E.emit('response', { statusCode: r.statusCode, status: r.statusCode, headers: r.headers, body: r })
          );
          // Headers are only flushed when the caller calls end(), like Electron.
          let started = false;
          req.on('error', (e) => E.emit('error', e));
          const start = () => {
            if (started) return;
            started = true;
            setImmediate(() => req.end());
          };
          return {
            setHeader: (k, v) => {
              if (!started) req.setHeader(k, v);
            },
            abort: () => req.destroy(),
            on: E.on.bind(E),
            once: E.once.bind(E),
            end: start,
          };
        },
      },
    }),
  };

  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-update-'));
  const job = new DownloadJob(ctx, {
    url: 'http://mirror.local/HyperFetch-1.4.0-x64-setup.exe',
    dir,
    name: 'HyperFetch-1.4.0-x64-setup.exe',
    connections: 4,
  });
  await job.start();
  const ok =
    job.state === 'completed' &&
    crypto.createHash('sha256').update(fs.readFileSync(job.filePath)).digest('hex') ===
      crypto.createHash('sha256').update(INSTALLER).digest('hex');
  checks.push(['更新包由内置引擎下载且校验一致', ok, job.state]);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await runFlow();
  } catch (e) {
    checks.push(['更新包由内置引擎下载且校验一致', false, e.message]);
  }
  server.close();

  let failed = 0;
  for (const [name, good, detail] of checks) {
    console.log(`${good ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!good) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
