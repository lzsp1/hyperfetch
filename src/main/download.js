'use strict';

/**
 * DownloadJob — a resumable, multi-segment HTTP download.
 *
 *  probe ─► resolve target file ─► plan (pieces → segments) ─► workers ─► finalize
 *  resume (meta json + .part) ───────────────────────────────┘
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const {
  sleep,
  AbortedError,
  isAbort,
  isRetryable,
  friendlyError,
  formatBytes,
  resolveResponse,
  resolveFinalUrlOnly,
  filenameFromContentDisposition,
  filenameFromUrl,
  sanitizeFilename,
  ensureUniquePath,
  openOrCreateSized,
  SegmentedWriter,
} = require('./util');
const i18n = require('./i18n-main');

const MIN_PIECE = 256 * 1024; // never create pieces smaller than 256 KiB
// Time allowed for the response headers. A blocked tunnel usually drops the
// request outright, so a shorter budget means a faster recovery.
const DEFAULT_TIMEOUT = 12000;
const MAX_RETRIES = 5; // kept for compatibility with older metadata
const PATIENT_RETRIES = 40; // total attempts per segment on a flaky network
const MAX_BACKOFF_MS = 15000;
/** No bytes for this long means the connection is dead even if it looks open. */
const STALL_TIMEOUT_MS = 6000;
const MAX_PIECES = 64;

let seq = 0;
let quitHandlerInstalled = false;

/* -------------------------------------------------------------------- */
/* helpers                                                               */
/* -------------------------------------------------------------------- */

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  if (s < 60) return i18n.t('time.seconds', { n: s });
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return i18n.t('time.minutes', { m, s: r });
  const h = Math.floor(m / 60);
  return i18n.t('time.hours', { h, m: m % 60 });
}

function prettyStatus(code) {
  const map = {
    400: i18n.t('http.400'),
    401: i18n.t('http.401'),
    403: i18n.t('http.403'),
    404: i18n.t('http.404'),
    405: i18n.t('http.405'),
    410: i18n.t('http.410'),
    416: i18n.t('http.416'),
    429: i18n.t('http.429'),
    500: i18n.t('http.500'),
    502: i18n.t('http.502'),
    503: i18n.t('http.503'),
    504: i18n.t('http.504'),
  };
  return map[code] || null;
}

/* -------------------------------------------------------------------- */
/* DownloadJob                                                           */
/* -------------------------------------------------------------------- */

class DownloadJob extends EventEmitter {
  /**
   * @param ctx {{ getNetFor(proxy): Electron.Net }}
   * @param opts {{ url, dir, name?, connections, maxSpeed, proxy, restore?, reservedPaths? }}
   */
  constructor(ctx, opts = {}) {
    super();
    this.ctx = ctx;
    this.id = opts.id || `job_${Date.now().toString(36)}_${(seq += 1)}`;
    this.url = String(opts.url || '').trim();
    this.dir = opts.dir;
    this.name = opts.name || '';
    this.connections = Math.min(64, Math.max(1, Number(opts.connections) || 8));
    this.maxSpeed = Math.max(0, Number(opts.maxSpeed) || 0); // bytes / second
    this.proxy = opts.proxy || null; // { mode: 'system' | 'custom' | 'direct', url }

    this.state = 'queued';
    this.error = null;
    this.total = 0;
    this.received = 0;
    this.speed = 0;
    this.eta = 0;
    this.startedAt = 0;
    this.finishedAt = 0;
    this.createdAt = Date.now();
    this.segments = [];
    this.resumable = null;
    this.contentType = null;
    this.pieces = 0;
    this.piecesState = null;
    this.mode = null; // 'segmented' | 'stream'
    this.isResume = false;

    this.filePath = null;
    this.fileIndex = 0;
    this._finalUrl = null;

    this._abort = null;
    this._promise = null;
    this._pauseRequested = false;
    this._cancelRequested = false;
    this._running = false;
    this._file = null; // FileHandle (segmented) | WriteStream (stream)
    this._writer = null;
    this._writerComplete = false;
    this._dirty = false;
    this._persistTimer = null;
    this._chunkEstimate = 16 * 1024;

    if (opts.restore) this._restore(opts.restore);
    else this._recalc();
  }

  /* -------------------------------------------------------------- */
  /* paths                                                           */
  /* -------------------------------------------------------------- */

  get metaPath() {
    if (!this.filePath) return null;
    return `${this.filePath}.hfd`; // HyperFetch download metadata
  }

  get partPath() {
    if (!this.filePath) return null;
    return `${this.filePath}.part`;
  }

  get active() {
    return this.state === 'probing' || this.state === 'downloading';
  }

  /* -------------------------------------------------------------- */
  /* public API                                                      */
  /* -------------------------------------------------------------- */

  /** Starts (or re-enters) the download. Resolves when the attempt ends. */
  start() {
    // _promise is the handle of the *current* attempt; it is cleared on exit so
    // that a later resume() actually starts a fresh attempt.
    if (this._running) return this._attempt;
    this._pauseRequested = false;
    this._cancelRequested = false;
    this._writerComplete = false;
    this._rangeMisses = 0;
    this._fallbackToStream = false;
    const attempt = this._run()
      .catch((err) => this._fail(err))
      .finally(() => {
        if (this._runningAttempt === attempt) {
          this._running = false;
          this._runningAttempt = null;
          this.speed = 0;
          this._emitState();
          this._flushPersistNow();
        }
      });
    this._runningAttempt = attempt;
    this._attempt = attempt;
    return attempt;
  }

  /** Graceful pause: stops workers, keeps partial data + metadata. */
  pause() {
    if (!this.active) return false;
    this._pauseRequested = true;
    this._abort?.abort();
    return true;
  }

  /** Re-start a paused / failed / interrupted job. */
  resume() {
    if (this._running || this.active) return null;
    this.state = 'queued';
    this.error = null;
    this._emitState();
    return this.start();
  }

  /** Abort the job. With removeFiles the partial data is deleted. */
  cancel(removeFiles = false) {
    this._cancelRequested = true;
    this.state = 'cancelled';
    this.speed = 0;
    this._abort?.abort();
    this._emitState();
    if (removeFiles) {
      this._afterExit(async () => {
        for (const p of [this.partPath, this.metaPath]) {
          if (p) await fs.promises.unlink(p).catch(() => {});
        }
      });
    }
    return true;
  }

  _afterExit(fn) {
    (async () => {
      let guard = 0;
      while (this._running && guard < 200) {
        await sleep(50);
        guard += 1;
      }
      await fn();
    })().catch(() => {});
  }

  /* -------------------------------------------------------------- */
  /* serialization                                                   */
  /* -------------------------------------------------------------- */

  _restore(m) {
    this.id = m.id || this.id;
    this.url = m.url || this.url;
    this.dir = m.dir || this.dir;
    this.name = m.name || this.name;
    this.filePath = m.filePath || null;
    this.fileIndex = m.fileIndex || 0;
    this.connections = m.connections || this.connections;
    this.maxSpeed = m.maxSpeed ?? this.maxSpeed;
    this.total = m.total || 0;
    this.received = m.received || 0;
    this.resumable = m.resumable ?? null;
    this.contentType = m.contentType || null;
    this.pieces = m.pieces || 0;
    this.piecesState = m.piecesState || null;
    this.mode = m.mode || null;
    this.segments = (m.segments || []).map((s) => ({
      index: s.index,
      start: s.start,
      end: s.end,
      length: s.length,
      pos: s.done ? s.end : Math.min(s.end, Math.max(s.start, s.pos ?? s.start)),
      done: !!s.done,
      bytes: 0,
      speed: 0,
    }));
    for (const s of this.segments) s.bytes = s.pos - s.start;
    this.createdAt = m.createdAt || this.createdAt;
    this.startedAt = m.startedAt || 0;
    this.finishedAt = m.finishedAt || 0;
    this.isResume = true;
    this.state = m.state === 'completed' ? 'completed' : m.state || 'paused';
    if (this.state !== 'completed') this.state = 'paused';
    this.error = m.error || null;
    this._recalc();
  }

  _snapshot() {
    return {
      v: 1,
      id: this.id,
      url: this.url,
      dir: this.dir,
      name: this.name,
      filePath: this.filePath,
      fileIndex: this.fileIndex,
      connections: this.connections,
      maxSpeed: this.maxSpeed,
      total: this.total,
      received: this.received,
      resumable: this.resumable,
      contentType: this.contentType,
      pieces: this.pieces,
      piecesState: this.piecesState,
      mode: this.mode,
      state: this.state,
      error: this.error,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      segments: this.segments.map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        length: s.length,
        pos: s.pos,
        done: s.done,
      })),
    };
  }

  /** Public view sent to the renderer. */
  toView() {
    return {
      id: this.id,
      url: this.url,
      dir: this.dir,
      name: this.name,
      filePath: this.filePath,
      fileIndex: this.fileIndex,
      connections: this.connections,
      maxSpeed: this.maxSpeed,
      total: this.total,
      received: this.received,
      speed: this.speed,
      eta: this.eta,
      state: this.state,
      error: this.error,
      resumable: this.resumable,
      contentType: this.contentType,
      pieces: this.pieces,
      mode: this.mode,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      segments: this.segments.map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        pos: s.pos,
        done: s.done,
      })),
    };
  }

  _emitState(extra = {}) {
    this.emit('update', {
      id: this.id,
      state: this.state,
      error: this.error,
      total: this.total,
      received: this.received,
      speed: this.speed,
      eta: this.eta,
      filePath: this.filePath,
      name: this.name,
      resumable: this.resumable,
      mode: this.mode,
      segments: this.segments.map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        pos: s.pos,
        done: s.done,
      })),
      ...extra,
    });
  }

  _log(message) {
    this.emit('log', message);
  }

  /* -------------------------------------------------------------- */
  /* persistence                                                     */
  /* -------------------------------------------------------------- */

  async _persist() {
    if (!this.filePath) return;
    const tmp = `${this.metaPath}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(this._snapshot(), null, 2), 'utf8');
      await fs.promises.rename(tmp, this.metaPath);
    } catch (e) {
      this._log(i18n.t('log.metaWriteFailed', { error: friendlyError(e) }));
    }
  }

  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      if (this.active) this._persist();
    }, 1000);
  }

  _flushPersistNow() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (this.filePath && !['completed', 'cancelled'].includes(this.state)) {
      this._persist();
    }
  }

  /* -------------------------------------------------------------- */
  /* main flow                                                       */
  /* -------------------------------------------------------------- */

  /**
   * Re-targets a queued job from the live settings (called right before it
   * starts, so pooled jobs pick up global speed limits / proxy changes).
   */
  applySettings({ maxSpeed, connections, proxy } = {}) {
    if (this.active || this._running) return;
    this.resetFromSettings = { maxSpeed, connections, proxy: proxy || this.resetFromSettings?.proxy };
    if (proxy) this.proxy = proxy;
  }

  async _run() {
    // One attempt per start(); `attempt` identifies this run and stale runs
    // bail out after every await.
    this._resolveOptions();
    this._running = true;
    this._abort = new AbortController();
    const signal = this._abort.signal;
    const net = this.ctx.getNetFor(this.proxy);
    const attempt = { running: true };
    this._currentAttempt = attempt;
    const alive = () => this._currentAttempt === attempt;

    if (!this.filePath) {
      if (this.state !== 'paused') {
        this.state = 'probing';
        this._emitState();
      }
      await this._resolveTarget(net, signal);
    }
    if (!alive()) return;

    if (this.isResume) {
      const ready = await this._prepareResume();
      if (!alive()) return;
      if (!ready) {
        this.isResume = false;
        this.segments = [];
        this.pieces = 0;
        this.piecesState = null;
        this.mode = null;
      } else {
        this._emitState();
      }
    }

    if (!this.isResume) {
      this.state = 'downloading';
      this._emitState();
      await this._selectMode(net, signal);
      if (!alive()) return;
      this.startedAt = Date.now();
    }

    this.state = 'downloading';
    this.error = null;
    this._emitState();
    await this._persist();
    this._log(i18n.t('log.starting'));

    if (this.mode === 'segmented') await this._downloadSegmented(net, signal);
    else if (this.mode === 'stream') await this._downloadStream(net, signal);
    else throw new Error(i18n.t('log.unknownMode'));
  }

  /** Current throughput estimate for the UI (bytes / second). */
  get currentSpeed() {
    if (this._writer && this.state === 'downloading') return this._writer.lastSpeed || this.speed || 0;
    return this.state === 'downloading' ? this.speed || 0 : 0;
  }

  /** Applies live settings from the manager just before an attempt starts. */
  _resolveOptions() {
    if (this.resetFromSettings) {
      const s = this.resetFromSettings;
      if (!this.maxSpeedExplicit && s.maxSpeed !== undefined) this.maxSpeed = Math.max(0, Number(s.maxSpeed) || 0);
      if (!this.isResume && s.connections) {
        this.connections = Math.min(64, Math.max(1, Number(s.connections) || 1));
      }
      this.resetFromSettings = null;
    }
  }

  async _resolveTarget(net, signal) {
    let target = this.url;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^https?:\/\//i.test(target)) {
      throw new Error(i18n.t('errors.httpOnly'));
    }
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
    this.url = target;
    this._log(i18n.t('log.resolving', { url: target }));

    // Resolve the redirect chain without wasting bandwidth on a body.
    const head = await resolveFinalUrlOnly(net, target, {
      timeout: DEFAULT_TIMEOUT,
      signal,
    });
    const finalUrl = head.finalUrl || target;
    const probe = await resolveResponse(net, target, {
      method: 'GET',
      timeout: DEFAULT_TIMEOUT,
      signal,
      headers: {},
    });
    try {
      probe.body?.resume?.();
    } catch {
      /* drop the body */
    }
    let headers = probe.headers || {};
    const length = headers['content-length'] ? Number(headers['content-length']) : NaN;
    const type = headers['content-type'] || '';

    if (probe.statusCode >= 400) {
      const err = new Error(prettyStatus(probe.statusCode) || `HTTP ${probe.statusCode}`);
      err.code = 'HTTP_STATUS';
      throw err;
    }

    // Some servers only describe the attachment on a real GET. The GET probe
    // above carries that; when it has no name either, borrow the URL-derived
    // name from the HEAD redirect chain instead.
    if (probe.statusCode === 200 && head.status === 200) {
      const getDisposition = filenameFromContentDisposition(headers['content-disposition']);
      if (!getDisposition) {
        this._log(i18n.t('log.nameFromUrl'));
      }
    }

    if (!this.name) {
      const fromHeader = filenameFromContentDisposition(headers['content-disposition']);
      const fromUrl = filenameFromUrl(finalUrl);
      // When Content-Disposition carries no name, servers may still send one in
      // the URL. A URL without a usable last segment falls back to the host.
      let guess = fromHeader || fromUrl;
      if (!guess) {
        try {
          guess = new URL(finalUrl).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '') || 'download';
        } catch {
          guess = 'download';
        }
      }
      this.name = sanitizeFilename(guess);
    }
    this.name = sanitizeFilename(this.name || 'download');

    await fs.promises.mkdir(this.dir, { recursive: true });
    this.filePath = await ensureUniquePath(this.dir, this.name, this.ctx.reservedPaths);
    this.fileIndex = 0;
    this._finalUrl = finalUrl;
    this.total = Number.isFinite(length) && length > 0 ? length : 0;
    this.contentType = type || null;
    this.resumable = headers['accept-ranges'] === 'bytes' ? true : null;
    this._log(i18n.t('log.fileName', { name: this.name }));
    this._log(i18n.t('log.savingTo', { path: this.filePath }));
    if (this.total) this._log(i18n.t('log.fileSize', { size: i18n.formatBytesI18n(this.total) }));
  }

  /** Prepares an interrupted job for resuming. Returns false if it must restart. */
  async _prepareResume() {
    if (this.mode === 'segmented') {
      let st = null;
      try {
        st = await fs.promises.stat(this.partPath);
      } catch {
        st = null;
      }
      if (!st) {
        this._log(i18n.t('log.noPartRestart'));
        return false;
      }
      if (st.size < this.total) {
        await fs.promises.truncate(this.partPath, this.total).catch(() => {});
      } else if (st.size > this.total) {
        await fs.promises.truncate(this.partPath, this.total).catch(() => {});
      }
      const fh = await openOrCreateSized(this.partPath, this.total);
      this._file = fh;
      this._writer = new SegmentedWriter(fh, this.total);
      this._writer.on('stats', ({ speed }) => this._ingestProgress(speed));
      this._writer.on('complete', () => this._onWriterComplete());
      if (this._writer.written === 0) {
        // account for data that is already on disk (done + pos offsets)
        this._writer.written = this.segments.reduce((a, s) => a + (s.pos - s.start), 0);
      }
      this._log(i18n.t('log.resumedAt', { done: i18n.formatBytesI18n(this.received), total: i18n.formatBytesI18n(this.total) }));
      return true;
    }
    if (this.mode === 'stream') {
      let st = null;
      try {
        st = await fs.promises.stat(this.partPath);
      } catch {
        st = null;
      }
      const have = st ? st.size : 0;
      this.received = have;
      this._file = fs.createWriteStream(this.partPath, { flags: have ? 'r+' : 'w', start: have });
      this._file.on('error', (e) => this._log(i18n.t('log.writeError', { error: friendlyError(e) })));
      this._log(i18n.t('log.resumedHave', { size: i18n.formatBytesI18n(have) }));
      return true;
    }
    // metadata without a mode: probe again from scratch
    return false;
  }

  async _selectMode(net, signal) {
    const probe = (start, end) =>
      resolveResponse(net, this._finalUrl || this.url, {
        method: 'GET',
        timeout: DEFAULT_TIMEOUT,
        signal,
        headers: { Range: `bytes=${start}-${end}` },
      }).then((r) => {
        // we only need headers here, drop the body
        try {
          r.body?.resume?.();
        } catch {
          /* ignore */
        }
        return r;
      });

    if (!this.total) {
      try {
        const r = await probe(0, 0);
        const cr = (r.headers || {})['content-range'];
        const m = cr && /bytes\s+\d+-\d+\/(\d+|\*)/i.exec(cr);
        if (m && m[1] !== '*') this.total = Number(m[1]);
        if (r.statusCode === 200) this.resumable = false;
      } catch (e) {
        if (isAbort(e)) throw e;
        this._log(i18n.t('log.probeFailed', { error: friendlyError(e) }));
      }
    }
    if (this.resumable === null && this.total > 0) {
      try {
        const r = await probe(0, Math.min(1, this.total - 1));
        this.resumable = r.statusCode === 206;
      } catch (e) {
        if (isAbort(e)) throw e;
        this.resumable = false;
      }
    }

    if (this.total > 0 && this.resumable) {
      this._log(i18n.t('log.multiThread', { size: i18n.formatBytesI18n(this.total) }));
      await this._planSegments();
      this.mode = 'segmented';
    } else {
      this.mode = 'stream';
      this.resumable = false;
      this._log(
        this.total > 0 ? i18n.t('log.fallbackNoRange') : i18n.t('log.fallbackUnknownSize')
      );
      this.metaPath && (await fs.promises.writeFile(this.metaPath, JSON.stringify(this._snapshot(), null, 2)).catch(() => {}));
      this._file = fs.createWriteStream(this.partPath, { flags: 'w' });
      this._file.on('error', (e) => this._log(i18n.t('log.writeError', { error: friendlyError(e) })));
    }
  }

  async _planSegments() {
    const size = this.total;
    this._file = await openOrCreateSized(this.partPath, size);
    this._writer = new SegmentedWriter(this._file, size);
    this._writer.on('stats', ({ speed }) => this._ingestProgress(speed));
    this._writer.on('complete', () => this._onWriterComplete());

    if (this.segments.length) {
      // restored from the .hfd metadata: recompute progress from the offsets
      this._recalc();
      let got = 0;
      for (const s of this.segments) got += s.done ? s.length : s.pos - s.start;
      this._writer.written = got;
      this._log(i18n.t('log.reuseSegments', { n: this.segments.length }));
      return;
    }

    const n = this.connections;
    const P = Math.min(MAX_PIECES, Math.max(1, Math.floor(n * 4)));
    const pieceLen = Math.ceil(size / P);
    this.pieces = P;
    this.piecesState = Array.from({ length: P }, () => ({ pos: 0, done: false, active: 0 }));
    const piecesInfo = [];
    for (let i = 0; i < P; i += 1) {
      const start = i * pieceLen;
      const end = Math.min(size, start + pieceLen);
      if (end > start) piecesInfo.push({ start, end });
    }
    let idx = 0;
    for (const pi of piecesInfo) {
      const len = pi.end - pi.start;
      const k = Math.max(1, Math.min(n, Math.ceil(len / MIN_PIECE)));
      const chunk = Math.ceil(len / k);
      for (let s = pi.start; s < pi.end; s += chunk) {
        const e = Math.min(pi.end, s + chunk);
        this.segments.push({
          index: idx,
          start: s,
          end: e,
          length: e - s,
          pos: s,
          done: false,
          bytes: 0,
          speed: 0,
        });
        idx += 1;
      }
    }
    this._log(i18n.t('log.plan', { segments: this.segments.length, n }));
  }

  /* -------------------------------------------------------------- */
  /* segmented download                                              */
  /* -------------------------------------------------------------- */

  async _downloadSegmented(net, signal) {
    const pending = this.segments.filter((s) => !s.done);
    let running = [];
    let totalLen = this.total;
    let failed = null;

    const spawn = () => {
      while (!failed && running.length < this.connections && pending.length) {
        const seg = pending.shift();
        const p = this._runSegment(net, seg, signal)
          .then(() => {
            seg.done = true;
            seg.pos = seg.end;
            this._recalc();
          })
          .catch((e) => {
            if (!failed) failed = e;
          })
          .finally(() => {
            running = running.filter((r) => r !== p);
          });
        running.push(p);
      }
    };

    spawn();
    while (running.length) {
      await Promise.race(running);
      if (failed) {
        this._abort?.abort();
        break;
      }
      spawn();
    }
    if (failed) {
      if (this._fallbackToStream && !signal.aborted) {
        await this._switchToStream(net, signal);
        return;
      }
      throw failed;
    }
    await this._waitWriter();
    if (this._writer.written < totalLen) {
      throw new Error(
        i18n.t('log.incomplete', { got: i18n.formatBytesI18n(this._writer.written), total: i18n.formatBytesI18n(totalLen) })
      );
    }
    this.received = totalLen;
    await this._finalize();
  }

  /** Turns a segmented job into a single-connection stream job, starting over. */
  async _switchToStream(net, signal) {
    try {
      await this._writer?.close();
    } catch {
      /* ignore */
    }
    this._writer = null;
    this._file = null;
    await fs.promises.unlink(this.partPath).catch(() => {});
    this.mode = 'stream';
    this.resumable = false;
    this.segments = [];
    this.pieces = 0;
    this.piecesState = null;
    this.received = 0;
    this.speed = 0;
    this._emitState();
    await this._persist();
    await this._downloadStream(net, signal);
  }

  async _runSegment(net, seg, signal) {
    let attempt = 0;
    for (;;) {
      if (signal.aborted) throw new AbortedError();
      if (seg.done) return;
      try {
        await this._fetchRange(net, seg, signal);
        return;
      } catch (e) {
        if (signal.aborted || isAbort(e)) throw new AbortedError();
        attempt += 1;
        // network errors are retried patiently: a dropped tunnel must not kill
        // the download. Non-network errors (404, disk full) still fail fast.
        if (attempt > PATIENT_RETRIES || !isRetryable(e)) throw e;
        const wait = Math.min(MAX_BACKOFF_MS, 400 * 2 ** Math.min(attempt - 1, 7));
        this._log(
          i18n.t('log.segmentRetry', {
            index: seg.index,
            error: friendlyError(e),
            wait: (wait / 1000).toFixed(1),
            attempt,
            max: PATIENT_RETRIES,
          })
        );
        // a stalled connection resumes where it stopped, so retry it a little
        // less eagerly than a reset (which usually recovers immediately)
        await sleep(e.code === 'ESTALL' ? Math.min(3000, 500 * attempt) : wait);
      }
    }
  }

  async _fetchRange(net, seg, signal) {
    const start = seg.pos;
    const end = seg.end - 1;
    if (start > end) return;
    const headers = { Range: `bytes=${start}-${end}` };
    const resp = await resolveResponse(net, this._finalUrl || this.url, {
      method: 'GET',
      timeout: DEFAULT_TIMEOUT,
      signal,
      headers,
      stallMs: STALL_TIMEOUT_MS,
    });

    if (resp.statusCode === 200) {
      // Electron rejects a Range request with "net::ERR_ABORTED" when the
      // server (or a proxy / CDN) answers with a full-file 200. A fresh ranged
      // request almost always succeeds, so retry a few times first.
      let msg = '';
      try {
        msg = String(resp.body?.message || '');
        resp.body?.destroy?.();
      } catch {
        /* ignore */
      }
      this._rangeMisses = (this._rangeMisses || 0) + 1;
      const err = new Error(msg ? `${i18n.t('log.notRanged')} (${msg})` : i18n.t('log.notRanged'));
      err.code = 'ECONNRESET';
      if (this._rangeMisses > 5) {
        this._log(i18n.t('log.rangeIgnored'));
        this._fallbackToStream = true;
        const fatal = new Error(i18n.t('log.rangeRefused'));
        fatal.code = 'EPROTO';
        throw fatal;
      }
      throw err;
    }
    if (resp.statusCode !== 206) {
      const err = new Error(prettyStatus(resp.statusCode) || `HTTP ${resp.statusCode}`);
      err.code = resp.statusCode >= 500 || resp.statusCode === 429 ? 'ECONNRESET' : 'HTTP_STATUS';
      throw err;
    }
    this._rangeMisses = 0;
    const body = resp.iter;
    if (!body) {
      const err = new Error(i18n.t('log.emptyResponse'));
      err.code = 'ECONNRESET';
      throw err;
    }

    let pos = start;
    // Watchdog: a "half-dead" connection sends nothing but never closes. Without
    // this the segment would wait forever and the UI would sit at 0 B/s.
    let lastByteAt = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (stalled || Date.now() - lastByteAt <= STALL_TIMEOUT_MS) return;
      stalled = true;
      try {
        resp.body?.destroy?.();
      } catch {
        /* ignore */
      }
    }, 1000);
    if (watchdog.unref) watchdog.unref();

    try {
      for await (const chunk of body) {
        lastByteAt = Date.now();
        if (signal.aborted) throw new AbortedError();
        let buf = chunk;
        const remain = end + 1 - pos;
        if (buf.length > remain) buf = buf.subarray(0, remain);
        await this._writer.write(buf, pos);
        pos += buf.length;
        seg.pos = pos;
        seg.bytes = pos - seg.start;
        this._chunkEstimate = Math.max(4096, buf.length);
        this._dirty = true;
        this._scheduleTick();
      }
    } catch (e) {
      if (signal.aborted || isAbort(e)) throw new AbortedError();
      if (stalled) {
        // retryable: the caller backs off and asks for the rest again
        const err = new Error(i18n.t('log.stalled'));
        err.code = 'ECONNRESET';
        throw err;
      }
      if (pos === start) throw e;
      const err = new Error(i18n.t('log.interrupted', { error: e.message || e || e.code || i18n.t('errors.unknown') }));
      err.code = 'ECONNRESET';
      throw err;
    } finally {
      clearInterval(watchdog);
    }
    if (stalled) {
      const err = new Error(i18n.t('log.stalled'));
      err.code = 'ECONNRESET';
      throw err;
    }
    if (pos !== end + 1) {
      const err = new Error(i18n.t('log.earlyClose'));
      err.code = 'ECONNRESET';
      throw err;
    }
  }

  /* -------------------------------------------------------------- */
  /* single-connection fallback                                      */
  /* -------------------------------------------------------------- */

  async _downloadStream(net, signal) {
    const url = this._finalUrl || this.url;
    const from = this.received || 0;
    const resp = await resolveResponse(net, url, {
      method: 'GET',
      timeout: DEFAULT_TIMEOUT,
      signal,
      headers: from > 0 ? { Range: `bytes=${from}-` } : {},
      stallMs: STALL_TIMEOUT_MS,
    });
    if (resp.statusCode >= 400) {
      const err = new Error(prettyStatus(resp.statusCode) || `HTTP ${resp.statusCode}`);
      err.code = 'HTTP_STATUS';
      throw err;
    }
    let base = from;
    if (resp.statusCode !== 206 && from > 0) {
      // server cannot continue: start over
      base = 0;
      this.received = 0;
      this._file.destroy();
      await fs.promises.truncate(this.partPath, 0).catch(() => {});
      this._file = fs.createWriteStream(this.partPath, { flags: 'w' });
    }
    const cl = resp.headers && resp.headers['content-length'];
    if (!this.total && cl) this.total = Number(cl) + base;

    const body = resp.iter;
    if (!body) throw new Error(i18n.t('log.emptyResponse'));

    let got = base;
    let windowBytes = 0;
    let windowStart = Date.now();
    // same stall watchdog as the segmented mode
    let lastByteAt = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (stalled || Date.now() - lastByteAt <= STALL_TIMEOUT_MS) return;
      stalled = true;
      try {
        resp.body?.destroy?.();
      } catch {
        /* ignore */
      }
    }, 1000);
    if (watchdog.unref) watchdog.unref();
    try {
      for await (const chunk of body) {
        lastByteAt = Date.now();
        if (signal.aborted) throw new AbortedError();
        const ok = this._file.write(chunk);
        got += chunk.length;
        this.received = got;
        windowBytes += chunk.length;
        const now = Date.now();
        if (now - windowStart >= 400) {
          this._ingestProgress((windowBytes / (now - windowStart)) * 1000);
          windowBytes = 0;
          windowStart = now;
        }
        if (!ok) await new Promise((r) => this._file.once('drain', r));
      }
      await new Promise((resolve, reject) => this._file.end((err) => (err ? reject(err) : resolve())));
    } catch (e) {
      if (signal.aborted || isAbort(e)) throw new AbortedError();
      if (stalled) {
        // leave what we have on disk; resume will continue from there
        this.received = got;
        this._file = null;
        const err = new Error(i18n.t('log.stalled'));
        err.code = 'ECONNRESET';
        throw err;
      }
      throw e;
    } finally {
      clearInterval(watchdog);
    }
    if (!this.total) this.total = got;
    if (got !== this.total) {
      throw new Error(
        i18n.t('log.incomplete', { got: i18n.formatBytesI18n(got), total: i18n.formatBytesI18n(this.total) })
      );
    }
    this.received = got;
    this._file = null;
    await this._finalize();
  }

  /* -------------------------------------------------------------- */
  /* progress                                                        */
  /* -------------------------------------------------------------- */

  _scheduleTick() {
    if (this._tickScheduled) return;
    this._tickScheduled = true;
    setTimeout(() => {
      this._tickScheduled = false;
      if (!this._dirty) return;
      this._dirty = false;
      this._ingestProgress(null);
    }, 120);
  }

  /** Effective throughput used for the ETA (smoothed, ignores dead moments). */
  _etaSpeed(raw) {
    const eff = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    // never show an ETA based on a near-zero sample: that is what produced
    // "estimated 3 days" the moment a connection hiccupped
    return eff < 4096 ? 0 : eff;
  }

  _recalc() {
    let got = 0;
    for (const s of this.segments) {
      // Math.max keeps the result a number even if a restored record is odd
      got += s.done ? s.length : Math.min(s.length, Math.max(0, (s.pos ?? s.start) - s.start));
    }
    this.received = Number.isFinite(got) ? got : 0;
    const speed = this._etaSpeed(this.speed);
    this.eta = this.total > 0 && speed > 0 ? Math.max(0, this.total - this.received) / speed : 0;
  }

  _ingestProgress(speed) {
    if (Number.isFinite(speed) && speed >= 0) this.speed = speed;
    if (this.mode === 'segmented') {
      this._recalc();
      if (this.piecesState && this.total > 0) {
        const pieceLen = Math.ceil(this.total / this.piecesState.length);
        for (let i = 0; i < this.piecesState.length; i += 1) {
          const pStart = i * pieceLen;
          const pEnd = Math.min(this.total, pStart + pieceLen);
          let got = 0;
          for (const s of this.segments) {
            if (s.end <= pStart || s.start >= pEnd) continue;
            got += s.done ? s.length : Math.min(s.length, Math.max(0, s.pos - s.start));
          }
          const p = this.piecesState[i];
          p.pos = pEnd > pStart ? pStart + got : pStart;
          p.done = got >= pEnd - pStart;
        }
      }
    } else {
      const speed = this._etaSpeed(this.speed);
      this.eta = this.total > 0 && speed > 0 ? Math.max(0, this.total - this.received) / speed : 0;
    }
    this._emitState();
    this._schedulePersist();
  }

  _onWriterComplete() {
    this._writerComplete = true;
  }

  async _waitWriter() {
    if (!this._writer) return;
    if (this._writerComplete) return;
    const w = this._writer;
    while (w.written < w.size || !w.idle) {
      await sleep(40);
    }
    this._writerComplete = true;
  }

  /* -------------------------------------------------------------- */
  /* finalize / failure                                              */
  /* -------------------------------------------------------------- */

  async _finalize() {
    if (this._writer) {
      await this._writer.close();
      this._writer = null;
      this._file = null;
    }
    if (this._file && typeof this._file.close === 'function' && !this._file.writable) {
      this._file = null;
    }
    await this._movePartIntoPlace();
    if (this.metaPath) await fs.promises.unlink(this.metaPath).catch(() => {});
    this.speed = 0;
    this.eta = 0;
    this.received = this.total || this.received;
    this.state = 'completed';
    this.finishedAt = Date.now();
    this._emitState({ finalPath: this.filePath });
    this.emit('done', this.toView());
    this._log(
        i18n.t('log.completed', {
          size: i18n.formatBytesI18n(this.received),
          time: formatDuration((this.finishedAt - (this.startedAt || this.finishedAt)) / 1000),
        })
      );
  }

  /** Renames `<name>.part` to `<name>`, creating `<name> (n)` when taken. */
  async _movePartIntoPlace() {
    for (;;) {
      try {
        await fs.promises.rename(this.partPath, this.filePath);
        return;
      } catch (e) {
        if (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES') {
          try {
            await fs.promises.access(this.filePath);
            // target exists -> pick the next free name
            this.fileIndex += 1;
            this.filePath = await ensureUniquePath(this.dir, this.name, this.ctx.reservedPaths);
            this._log(i18n.t('log.renamed', { name: path.basename(this.filePath) }));
            continue;
          } catch {
            /* target does not exist: fall through to copy */
          }
        }
        this._log(i18n.t('log.renameFallback', { error: friendlyError(e) }));
        await fs.promises.copyFile(this.partPath, this.filePath);
        await fs.promises.unlink(this.partPath).catch(() => {});
        return;
      }
    }
  }

  _fail(err) {
    if (!err) return;
    this.speed = 0;
    this.eta = 0;
    if (this._cancelRequested) {
      this.state = 'cancelled';
      this._emitState();
      return;
    }
    if (this._pauseRequested || isAbort(err)) {
      if (this.state === 'completed') return;
      this._recalc();
      this.state = 'paused';
      this._emitState();
      this._log(i18n.t('log.paused', { done: i18n.formatBytesI18n(this.received), total: i18n.formatBytesI18n(this.total || this.received) }));
      this._flushPersistNow();
      return;
    }
    if (this.state === 'completed' || this.state === 'cancelled') return;
    this._recalc();
    this.error = friendlyError(err);
    this.state = 'error';
    this._emitState();
    this._log(i18n.t('log.failed', { error: this.error }));
    this._flushPersistNow();
    this.emit('failed', this.toView());
  }

  /** Best-effort final save, used when the app is quitting. */
  persistNowSync() {
    if (!this.filePath) return;
    if (['completed', 'cancelled'].includes(this.state)) return;
    try {
      const snap = this._snapshot();
      if (this.active) snap.state = 'paused';
      fs.writeFileSync(this.metaPath, JSON.stringify(snap, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------------------- */
/* quit safety net                                                       */
/* -------------------------------------------------------------------- */

function installQuitHandler(app, getJobs) {
  if (quitHandlerInstalled) return;
  quitHandlerInstalled = true;
  app.on('before-quit', () => {
    for (const job of getJobs()) job.persistNowSync();
  });
}

module.exports = {
  DownloadJob,
  formatDuration,
  formatBytes,
  installQuitHandler,
  MAX_RETRIES,
  prettyStatus,
};
