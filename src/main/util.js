'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

class AbortedError extends Error {
  constructor(message = '已取消') {
    super(message);
    this.name = 'AbortedError';
    this.code = 'ABORTED';
  }
}

function isAbort(err) {
  return (
    err &&
    (err.code === 'ABORTED' ||
      err.name === 'AbortError' ||
      err.code === 'ABORT_ERR' ||
      err.code === 'ERR_CANCELED')
  );
}

class TimeoutError extends Error {
  constructor(message = '请求超时') {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

/* Map low-level errors to friendly Chinese messages ------------------ */

const ERROR_MAP = {
  ENOSPC: '磁盘空间不足，请更换保存位置',
  EACCES: '没有写入权限，请更换保存位置',
  EPERM: '文件被占用或没有权限（可能文件已在其他程序中打开）',
  EBUSY: '目标文件正被其他程序占用',
  ENOENT: '路径不存在',
  ENOTFOUND: '域名解析失败，请检查网络或地址拼写',
  EAI_AGAIN: '域名解析暂时失败',
  ECONNREFUSED: '连接被服务器拒绝',
  ECONNRESET: '连接被服务器重置',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  CERT_HAS_EXPIRED: '服务器证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '服务器证书无效（自签名）',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证服务器证书',
};

/** Base classes of network errors: these are worth retrying. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET',
  'ETIMEOUT_HEADERS',
  // a connection that went silent without closing: retry, keeping the data
  // already written to disk
  'ESTALL',
]);

function isRetryable(err) {
  if (!err) return false;
  if (isAbort(err)) return false;
  if (err.code === 'ETIMEDOUT') return true;
  if (RETRYABLE_CODES.has(err.code)) return true;
  if (typeof err.message === 'string') {
    return /ECONNRESET|socket hang up|premature close|other side closed|aborted|ETIMEDOUT/i.test(
      err.message
    );
  }
  return false;
}

function friendlyError(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  if (isAbort(err)) return '已取消';
  const mapped = ERROR_MAP[err.code];
  const msg = err.message || err.code || String(err);
  if (mapped) return `${mapped}（${err.code}）`;
  const code = err.code && !String(msg).includes(err.code) ? `（${err.code}）` : '';
  return `${msg}${code}`;
}

/* ------------------------------------------------------------------ */
/* byte formatting                                                     */
/* ------------------------------------------------------------------ */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/* ------------------------------------------------------------------ */
/* file / path helpers                                                 */
/* ------------------------------------------------------------------ */

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

function sanitizeFilename(name) {
  let n = String(name || '');
  try {
    n = n.normalize('NFC');
  } catch {
    /* ignore */
  }
  n = n.split(/[\\/]+/).pop();
  n = n.replace(INVALID_CHARS, '_').replace(/\s+$/g, '').replace(/^\.+/, '');
  if (!n) n = 'download';
  if (RESERVED_NAMES.test(n)) n = `_${n}`;
  // keep plenty of room for " (12).part" suffixes and the .part extension
  const ext = path.extname(n);
  const base = path.basename(n, ext);
  if (n.length > 180) {
    n = base.slice(0, 175) + ext.slice(0, 20);
  }
  return n;
}

/**
 * Decodes an RFC 5987 extended value (`UTF-8''%E4%B8%AD…`).
 */
function decodeExtended(value) {
  let charset = 'utf-8';
  let s = String(value);
  const m = /^([A-Za-z0-9!#$&+\-.^_`|~]+)'[^']*'(.*)$/s.exec(s);
  if (m) {
    charset = m[1].toLowerCase();
    s = m[2];
  }
  try {
    s = decodeURIComponent(s);
  } catch {
    /* leave as-is */
  }
  if (charset !== 'utf-8' && charset !== 'utf8') {
    try {
      s = Buffer.from(s, 'latin1').toString('utf8');
    } catch {
      /* ignore */
    }
  }
  return s;
}

/**
 * Parses Content-Disposition taking RFC 5987 (`filename*=UTF-8''…`) and
 * RFC 2231 continuations (`filename*0*=…`) into account.
 * Returns { filename, filenameStar }.
 */
function parseContentDisposition(header) {
  const out = { filename: null, filenameStar: null };
  if (!header) return out;
  const val = String(header);

  // RFC 2231 continuations: filename*0*=UTF-8''…; filename*1*=…
  const cont = new Map();
  const reCont = /filename\*(\d+)(\*)?\s*=\s*(?:"([^"]*)"|([^;]*))/gi;
  let m;
  while ((m = reCont.exec(val))) {
    cont.set(Number(m[1]), { v: (m[3] ?? m[4] ?? '').trim(), enc: !!m[2] });
  }
  if (cont.size) {
    const keys = [...cont.keys()].sort((a, b) => a - b);
    let joined = keys.map((k) => cont.get(k).v).join('');
    if ([...cont.values()].some((c) => c.enc)) joined = decodeExtended(joined);
    if (joined) out.filenameStar = joined;
  }

  if (!out.filenameStar) {
    const single = /filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(val);
    if (single) {
      const v = (single[1] ?? single[2] ?? '').trim();
      if (v) out.filenameStar = decodeExtended(v);
    }
  }

  if (!out.filenameStar) {
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(val);
    if (plain) {
      let s = (plain[1] ?? plain[2] ?? '').trim();
      if (/^[A-Za-z0-9!#$&+\-.^_`|~]+'[^']*'/i.test(s)) s = decodeExtended(s);
      if (s) out.filename = s;
    }
  }
  return out;
}

function filenameFromContentDisposition(header) {
  const { filenameStar, filename } = parseContentDisposition(header);
  return filenameStar || filename || null;
}

/**
 * Picks a nice filename from a redirect chain / path. Returns null when it
 * looks meaningless (e.g. "download" without extension).
 */
function filenameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const segs = u.pathname.split('/').filter(Boolean);
    let last = segs.length ? segs[segs.length - 1] : '';
    try {
      last = decodeURIComponent(last);
    } catch {
      /* ignore */
    }
    if (!last) return null;
    const ext = path.extname(last);
    if (!ext && last.length < 3) return null;
    return last;
  } catch {
    return null;
  }
}

async function ensureUniquePath(dir, filename, extraReserved = new Set()) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let i = 1;
  for (;;) {
    const full = path.join(dir, candidate);
    let exists = extraReserved.has(full.toLowerCase());
    if (!exists) {
      try {
        await fs.promises.access(full);
        exists = true;
      } catch {
        exists = false;
      }
    }
    if (!exists) return full;
    i += 1;
    candidate = `${base} (${i})${ext}`;
  }
}

/**
 * Opens (creating if needed) an existing file, ensuring it has at least
 * `size` bytes. Returns the handle.
 */
async function openOrCreateSized(filePath, size) {
  let st = null;
  try {
    st = await fs.promises.stat(filePath);
  } catch {
    st = null;
  }
  if (st && st.isDirectory()) {
    throw Object.assign(new Error(`目标路径是文件夹：${filePath}`), { code: 'EISDIR' });
  }
  const handle = await fs.promises.open(filePath, st ? 'r+' : 'w+');
  if (st && st.size > size) {
    await handle.truncate(size);
  } else if (!st || st.size < size) {
    await handle.truncate(size);
  }
  return handle;
}

/* ------------------------------------------------------------------ */
/* Single HTTP request (redirects / gzip handled by Electron net)      */
/* ------------------------------------------------------------------ */

/**
 * Performs one request without following redirects.
 * Defaults to GET, because that is what probing a download actually needs:
 * some servers reject HEAD, and a body-less GET is cheap enough.
 * The body is never read unless the caller iterates it.
 */
function requestOnce(netArg, url, { headers = {}, timeout = 15000, signal, method = 'GET', body = null } = {}) {
  const net = netArg && netArg.net ? netArg.net : netArg;
  return new Promise((resolve, reject) => {
    // Resolved once, in one place; `nested` guards against a synchronous
    // `response` event firing while we are still setting headers.
    let nested = false;
    let settled = false;
    let timer = null;
    let req = null;
    let onAbort = null;

    const settle = (kind, payload) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Drop the abort listener: a job with hundreds of requests would
      // otherwise trip the AbortSignal max-listener warning.
      if (onAbort && signal) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          /* ignore */
        }
        onAbort = null;
      }
      // Responses must stay open for the caller to read the body; anything else
      // can abandon the request right away.
      if (kind === 'reject' || !(payload && payload.body)) {
        try {
          req?.abort?.();
        } catch {
          /* ignore */
        }
      }
      const call = () => (kind === 'resolve' ? resolve(payload) : reject(payload));
      if (nested) setTimeout(call, 0);
      else call();
    };

    if (signal && signal.aborted) {
      settle('reject', new AbortedError());
      return;
    }
    try {
      req = net.request({ url, method, redirect: 'manual' });
    } catch (e) {
      settle('reject', e);
      return;
    }
    timer = setTimeout(
      () => settle('reject', new TimeoutError(`请求超时（${Math.round(timeout / 1000)} 秒）`)),
      timeout
    );
    if (timer.unref) timer.unref();
    if (signal) {
      onAbort = () => settle('reject', new AbortedError());
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('redirect', (status, _m, redirectUrl, responseHeaders) => {
      const out = {};
      for (const [k, v] of Object.entries(responseHeaders || {})) {
        out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      settle('resolve', { redirect: true, status, url: redirectUrl, headers: out });
    });
    req.on('response', (res) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Headers are in: a body that stalls is the reader's job to police
      // (it has its own byte-level watchdog), so the header timer must not
      // linger and fire a bogus ETIMEDOUT mid-download.
      res.on?.('close', () => {
        if (timer) clearTimeout(timer);
      });
      const status = res.statusCode;
      settle('resolve', {
        redirect: false,
        status,
        statusCode: status,
        headers: res.headers,
        body: res,
        url,
        finalUrl: url,
      });
    });
    req.on('error', (e) => settle('reject', e));

    nested = true;
    try {
      const wanted = { 'User-Agent': 'HyperFetch/1.0', ...headers };
      if (body) {
        wanted['Content-Type'] = 'application/octet-stream';
        wanted['Content-Length'] = String(body.length);
      }
      for (const [k, v] of Object.entries(wanted)) req.setHeader(k, String(v));
      if (body) req.write(body);
      req.end();
    } catch (e) {
      settle('reject', e);
    }
    nested = false;
  });
}
const MAX_REDIRECTS = 10;

/**
 * Follows redirects manually and returns the final response plus an async
 * iterable for its body (stored under `iter`, never on the response itself).
 */
async function resolveResponse(ctx, url, opts = {}) {
  let current = url;
  for (let i = 0; i < MAX_REDIRECTS; i += 1) {
    const r = await requestOnce(ctx, current, opts);
    if (r.redirect) {
      if (!r.url) throw new Error('服务器返回了无效的重定向地址');
      current = r.url;
      continue;
    }
    return { ...r, iter: toAsyncIterable(r.body, { stallMs: opts.stallMs || 0 }), finalUrl: current, redirects: i };
  }
  throw new Error('重定向次数过多');
}

/* ------------------------------------------------------------------ */
/* SegmentedWriter — concurrent positional writes into one file        */
/* ------------------------------------------------------------------ */

class SegmentedWriter extends EventEmitter {
  constructor(fileHandle, size) {
    super();
    this.fh = fileHandle;
    this.size = size;
    this.written = 0;
    this.closed = false;
    this.queue = [];
    this.flushing = false;
    this.flushScheduled = false;
    this.flushIntervalMs = 120;
    this.lastEmit = 0;
    this.active = 0;
    let lastT = Date.now();
    const samples = [];
    this.ticker = setInterval(() => {
      const now = Date.now();
      const dt = now - lastT;
      lastT = now;
      const delta = this.written - (this._lastSample ?? 0);
      this._lastSample = this.written;
      if (dt > 0) {
        samples.push((delta / dt) * 1000);
        if (samples.length > 12) samples.shift();
      }
      const speed = samples.length
        ? samples.reduce((a, b) => a + b, 0) / samples.length
        : 0;
      this.emit('stats', { speed, written: this.written });
      this.lastSpeed = speed;
      if (!this.closed && this.written >= this.size) this._emitDoneIfComplete();
    }, 250);
    this.ticker.unref?.();
  }

  _emitDoneIfComplete() {
    if (this._doneEmitted) return;
    if (this.written < this.size) return;
    // wait one tick so a final few writes can land
    this._doneEmitted = true;
    this._maybeDone = true;
  }

  get done() {
    return this.written >= this.size && !this.closed;
  }

  /** True when every byte produced by callers has been written to disk. */
  get idle() {
    return this.queue.length === 0 && !this.flushing;
  }

  _schedule() {
    if (this.flushScheduled || this.closed) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      this.flush();
    }, 0);
  }

  async write(buf, position) {
    if (this.closed) throw new AbortedError('写入已关闭');
    return new Promise((resolve, reject) => {
      this.queue.push({ position, buf, resolve, reject });
      this._schedule();
    });
  }

  /** Coalesce contiguous queued ops into single writes. */
  async flush() {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const ops = this.queue.splice(0, this.queue.length);
        const groups = [];
        const pending = [...ops].sort((a, b) => a.position - b.position);
        let cur = null;
        for (const op of pending) {
          const start = op.position;
          const end = op.position + op.buf.length;
          if (cur && start === cur.end) {
            cur.ops.push(op);
            cur.end = end;
          } else {
            cur = { ops: [op], start, end };
            groups.push(cur);
          }
        }
        for (const g of groups) {
          const total = g.end - g.start;
          let buf;
          if (g.ops.length === 1) {
            buf = g.ops[0].buf;
          } else {
            buf = Buffer.allocUnsafe(total);
            for (const op of g.ops) op.buf.copy(buf, op.position - g.start);
          }
          try {
            await this.fh.write(buf, 0, buf.length, g.start);
          } catch (e) {
            for (const op of g.ops) op.reject(e);
            continue;
          }
          this.written += total;
          for (const op of g.ops) op.resolve();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async close() {
    if (this.closed) return;
    while (this.queue.length) await sleep(20);
    this.closed = true;
    clearInterval(this.ticker);
    await this.flush();
    await this.fh.close();
  }
}

/**
 * Streams an Electron / Node response body as an async iterable.
 * Electron hands us a proper Readable, but any event-emitter-like stream works.
 *
 * Safety net: if a callback delivered a response *wrapper* instead of the
 * response itself, the real stream is one level down — unwrap it rather than
 * silently returning an unreadable body.
 */
/**
 * Wraps an EventEmitter body into an async iterable that can be cancelled and
 * that never waits forever: if no byte arrives for `stallMs`, it throws a
 * retryable STALL error instead of hanging.
 */
function toAsyncIterable(stream, { stallMs = 0 } = {}) {
  if (!stream) return null;
  if (typeof stream.on !== 'function') {
    if (stream.body && typeof stream.body === 'object') return toAsyncIterable(stream.body, { stallMs });
    return typeof stream[Symbol.asyncIterator] === 'function' ? stream : null;
  }
  // Node readable streams support for-await natively, but that path cannot be
  // time-boxed, so a silent connection would hang forever. Only take the fast
  // path when no stall budget was requested.
  if (!stallMs && typeof stream.pipe === 'function' && typeof stream[Symbol.asyncIterator] === 'function') {
    return stream;
  }

  const chunks = [];
  let ended = false;
  let failure = null;
  let wake = null;
  let cancelled = false;
  let lastByteAt = Date.now();

  const notify = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  const cleanup = () => {
    try {
      stream.removeListener?.('data', onData);
      stream.removeListener?.('end', onEnd);
      stream.removeListener?.('error', onError);
    } catch {
      /* ignore */
    }
  };

  const onData = (chunk) => {
    lastByteAt = Date.now();
    chunks.push(chunk);
    notify();
  };
  const onEnd = () => {
    ended = true;
    notify();
  };
  const onError = (e) => {
    failure = e || new Error('读取响应失败');
    notify();
  };

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('error', onError);

  const iterator = {
    /** Unblocks a pending read and makes the next step throw. */
    cancel(reason) {
      cancelled = true;
      failure = reason || new Error('已取消');
      notify();
      try {
        stream.destroy?.();
      } catch {
        /* ignore */
      }
    },
    async next() {
      for (;;) {
        if (chunks.length) return { value: chunks.shift(), done: false };
        if (cancelled) return { value: undefined, done: true };
        if (failure) {
          cleanup();
          throw failure;
        }
        if (ended) {
          cleanup();
          return { value: undefined, done: true };
        }
        // Wait for data, but never longer than the stall budget.
        const waitMs = stallMs > 0 ? Math.max(250, stallMs - (Date.now() - lastByteAt)) : 0;
        await new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            if (wake === done) wake = null;
            clearTimeout(timer);
            resolve();
          };
          wake = done;
          const timer = waitMs > 0 ? setTimeout(done, waitMs) : null;
        });
        if (stallMs > 0 && !chunks.length && !ended && !failure && Date.now() - lastByteAt >= stallMs) {
          cleanup();
          const err = new Error('连接长时间无响应');
          err.code = 'ESTALL';
          throw err;
        }
      }
    },
    return() {
      iterator.cancel();
      cleanup();
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
}

/**
 * Follows redirects with a body-less request and returns `{ url, status, headers }`.
 * Used to learn the final URL before deciding what to do with the download.
 */
async function resolveFinalUrlOnly(ctx, url, opts = {}) {
  let current = url;
  for (let i = 0; i < MAX_REDIRECTS; i += 1) {
    const r = await requestOnce(ctx, current, { ...opts, method: 'HEAD' });
    if (r.redirect && r.url) {
      current = r.url;
      continue;
    }
    return { ...r, finalUrl: current };
  }
  return { finalUrl: current, status: 0, headers: {} };
}

function isNetError(err) {
  return !!(err && typeof err === 'object' && err.cause && err.cause.code);
}

/* ------------------------------------------------------------------ */
/* Stream a whole response to a file (used when ranges unsupported)    */
/* ------------------------------------------------------------------ */

async function saveStreamToFile(ctx, url, filePath, { headers = {}, signal } = {}) {
  const resp = await ctx.request(url, { responseType: 'stream', headers });
  if (resp.statusCode >= 400) {
    throw new Error(`HTTP ${resp.statusCode}`);
  }
  const stream = resp.body || resp;
  const out = fs.createWriteStream(filePath);
  let written = 0;
  const counter = new Transform({
    transform(chunk, enc, cb) {
      written += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    await pipeline(stream, counter, out, { signal });
  } catch (e) {
    try {
      out.destroy();
    } catch {
      /* ignore */
    }
    throw e;
  }
  return written;
}

module.exports = {
  sleep,
  clamp,
  AbortedError,
  TimeoutError,
  isAbort,
  isRetryable,
  friendlyError,
  formatBytes,
  sanitizeFilename,
  parseContentDisposition,
  filenameFromContentDisposition,
  filenameFromUrl,
  ensureUniquePath,
  openOrCreateSized,
  resolveResponse,
  resolveFinalUrlOnly,
  toAsyncIterable,
  isNetError,
  SegmentedWriter,
  saveStreamToFile,
};
