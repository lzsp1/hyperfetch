'use strict';

/**
 * DownloadManager — owns the list of DownloadJobs, the concurrency queue and
 * the persisted task list (configDir/tasks.json).
 */

const fs = require('fs');
const { EventEmitter } = require('events');
const { DownloadJob } = require('./download');
const i18n = require('./i18n-main');
const { sanitizeFilename } = require('./util');

const MAX_LOG_LINES = 400;
const SAVE_DEBOUNCE = 300;

class DownloadManager extends EventEmitter {
  /**
   * @param ctx  { getNetFor(proxy), reservedPaths }
   * @param opts { config, storePath }
   */
  constructor(ctx, opts) {
    super();
    this.ctx = ctx;
    this.storePath = opts.storePath;
    this.config = opts.config; // live settings object
    this.jobs = [];
    this.logs = [];
    this._saveTimer = null;
  }

  /* -------------------------------------------------------------- */
  /* config                                                          */
  /* -------------------------------------------------------------- */

  get maxConcurrent() {
    return Math.max(1, Number(this.config.maxConcurrent) || 3);
  }

  get proxy() {
    return {
      mode: this.config.proxyMode || 'system',
      url: this.config.proxyUrl || '',
    };
  }

  /* -------------------------------------------------------------- */
  /* logs                                                            */
  /* -------------------------------------------------------------- */

  log(message) {
    const line = {
      t: Date.now(),
      m: message,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    };
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    this.emit('log', line);
  }

  /* -------------------------------------------------------------- */
  /* persistence                                                     */
  /* -------------------------------------------------------------- */

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.storePath, 'utf8');
    } catch {
      return;
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    const list = Array.isArray(data) ? data : data?.tasks || [];
    for (const task of list) {
      if (!task || !task.id) continue;
      try {
        const job = new DownloadJob(this.ctx, { restore: task });
        if (task.state === 'downloading' || task.state === 'probing') {
          job.state = 'paused';
          job._interrupted = true;
        }
        this._wire(job);
        this.jobs.push(job);
      } catch (e) {
        this.log(i18n.t('log.restoreFailed', { error: e.message }));
      }
    }
    if (this.jobs.length) this.log(i18n.t('log.restored', { n: this.jobs.length }));
  }

  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, SAVE_DEBOUNCE);
  }

  _saveNow() {
    const tasks = this.jobs.map((j) => j.toView());
    const payload = JSON.stringify({ version: 1, tasks }, null, 1);
    const tmp = `${this.storePath}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.storePath);
    } catch {
      try {
        fs.writeFileSync(this.storePath, payload, 'utf8');
      } catch {
        /* ignore */
      }
    }
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveNow();
  }

  /* -------------------------------------------------------------- */
  /* events                                                          */
  /* -------------------------------------------------------------- */

  _wire(job) {
    job.on('update', (data) => {
      this.emit('update', data);
      if (data.state === 'paused' || data.state === 'error' || data.state === 'completed') {
        this.save();
      }
    });
    job.on('log', (msg) => this.log(`「${job.name || job.url}」${msg}`));
    job.on('done', () => {
      this.emit('done', job.toView());
      this.save();
      this._pump();
    });
    job.on('failed', (view) => {
      // the engine only reports a failure once, so the UI can chime + notify
      this.emit('failed', view || job.toView());
      this.save();
      this._pump();
    });
  }

  /* -------------------------------------------------------------- */
  /* queue                                                           */
  /* -------------------------------------------------------------- */

  _running() {
    return this.jobs.filter((j) => j.active);
  }

  /** Starts queued jobs while concurrency slots remain. */
  _pump() {
    let running = this._running().length;
    const wanted = this.maxConcurrent;
    // newest first feels more natural: latest added starts first
    for (const job of this.jobs) {
      if (running >= wanted) break;
      if (job.state === 'queued' && !job._running) {
        job.applySettings({
          maxSpeed: this.config.maxSpeed || 0,
          connections: this.config.connections || 8,
          proxy: this.proxy,
        });
        this.log(`开始任务：${job.name || job.url}`);
        job.start();
        running += 1;
      }
    }
  }

  /** Pauses a running job if the concurrency limit would be exceeded. */
  _freeUpSlot(hint) {
    const running = this._running();
    if (running.length < this.maxConcurrent) return;
    const victim = running.find((j) => j.state === 'probing') || running[running.length - 1];
    if (!victim) return;
    this.log(`并发已满，暂停「${victim.name || victim.url}」以让出连接给「${hint || '新任务'}」`);
    victim.pause();
  }

  /* -------------------------------------------------------------- */
  /* commands                                                        */
  /* -------------------------------------------------------------- */

  add(input) {
    const url = String(input.url || '').trim();
    if (!url) throw new Error(i18n.t('toast.noUrl'));
    const dir = String(input.dir || '').trim();
    if (!dir) throw new Error(i18n.t('errors.noDir'));
    const job = new DownloadJob(this.ctx, {
      url,
      dir,
      name: input.name || '',
      connections: Math.min(64, Math.max(1, Number(input.connections) || this.config.connections || 8)),
      maxSpeed:
        input.maxSpeed !== undefined && input.maxSpeed !== ''
          ? Math.max(0, Number(input.maxSpeed) || 0)
          : Math.max(0, Number(this.config.maxSpeed) || 0),
      proxy: this.proxy,
    });
    this._wire(job);
    this.jobs.unshift(job);
    this.emit('update', job.toView());
    this.log(`已添加任务：${job.url}`);
    this.saveNow();
    this._pump();
    return job.toView();
  }

  get(id) {
    return this.jobs.find((j) => j.id === id) || null;
  }

  pause(id) {
    const job = this.get(id);
    if (job) job.pause();
    this.saveNow();
  }

  resume(id) {
    const job = this.get(id);
    if (!job || job.active || job._running || job.state === 'completed') return;
    this._freeUpSlot(job.name);
    job.error = null;
    job.state = 'queued';
    this.emit('update', { id: job.id, state: 'queued', error: null });
    this._pump();
    this.saveNow();
  }

  pauseAll() {
    for (const j of this.jobs) if (j.active) j.pause();
    this.log('已暂停全部任务');
    this.saveNow();
  }

  resumeAll() {
    let n = 0;
    for (const j of this.jobs) {
      if (!j.active && !j._running && ['paused', 'error'].includes(j.state)) {
        j.error = null;
        j.state = 'queued';
        this.emit('update', { id: j.id, state: 'queued', error: null });
        n += 1;
      }
    }
    this._pump();
    if (n) this.log(`已恢复 ${n} 个任务`);
    this.saveNow();
  }

  remove(id) {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    const job = this.jobs[idx];
    job.cancel(true);
    this.jobs.splice(idx, 1);
    this.emit('removed', id);
    this.log(`已移除任务：${job.name || job.url}`);
    this.saveNow();
    this._pump();
    return true;
  }

  clearCompleted() {
    const n = this.jobs.filter((j) => j.state === 'completed').length;
    this.jobs = this.jobs.filter((j) => j.state !== 'completed');
    this.emit('list-changed');
    if (n) this.log(`已清除 ${n} 条已完成记录`);
    this.saveNow();
  }

  clearErrors() {
    this.jobs = this.jobs.filter((j) => j.state !== 'error');
    this.emit('list-changed');
    this.saveNow();
  }

  setConnections(id, n) {
    const job = this.get(id);
    if (!job) return;
    job.connections = Math.min(64, Math.max(1, Number(n) || 1));
    this.emit('update', { id, state: job.state, connections: job.connections });
    this.saveNow();
  }

  setMaxSpeed(id, value) {
    const job = this.get(id);
    if (!job) return;
    job.maxSpeed = Math.max(0, Number(value) || 0);
    this.emit('update', { id, state: job.state, maxSpeed: job.maxSpeed });
    this.saveNow();
  }

  /**
   * Renames a download.
   *
   * - before it starts: only the target name changes
   * - while running / paused / failed: the `.part` + `.hfd` metadata follow
   * - when completed: the finished file is renamed on disk
   *
   * Returns the updated view so the UI can re-render immediately.
   */
  async rename(id, rawName) {
    const job = this.get(id);
    if (!job) throw new Error(i18n.t('rename.failed', { error: 'task not found' }));
    if (job.active) throw new Error(i18n.t('rename.busy'));
    const name = sanitizeFilename(String(rawName || '').trim());
    if (!name || name === 'download') throw new Error(i18n.t('rename.empty'));
    if (name === job.name) return job.toView();

    const fs = require('fs');
    const pathMod = require('path');
    const oldPath = job.filePath;
    const dir = job.dir;
    const target = pathMod.join(dir, name);
    if (job.filePath && target.toLowerCase() === job.filePath.toLowerCase()) {
      job.name = name;
      this.saveNow();
      return job.toView();
    }
    try {
      await fs.promises.access(target);
      throw new Error(i18n.t('rename.exists', { name }));
    } catch (e) {
      if (e && e.code !== 'ENOENT') throw e;
    }

    const hadFile = job.state === 'completed' && oldPath && fs.existsSync(oldPath);
    if (hadFile) {
      try {
        await fs.promises.rename(oldPath, target);
      } catch (e) {
        throw new Error(i18n.t('rename.failed', { error: e.message }));
      }
      job.name = name;
      job.filePath = target;
    } else {
      // move the partial data and its metadata, if any
      const pairs = [
        [`${oldPath}.part`, `${target}.part`],
        [`${oldPath}.hfd`, `${target}.hfd`],
      ];
      if (oldPath && fs.existsSync(oldPath)) pairs.push([oldPath, target]);
      for (const [from, to] of pairs) {
        if (!fs.existsSync(from)) continue;
        try {
          await fs.promises.rename(from, to);
        } catch (e) {
          throw new Error(i18n.t('rename.failed', { error: e.message }));
        }
      }
      job.name = name;
      if (oldPath) job.filePath = target;
    }

    this.log(i18n.t('rename.done', { name }));
    this.emit('update', { ...job.toView() });
    this.saveNow();
    return job.toView();
  }

  /** Re-applies live settings (global speed limit, concurrency) to running jobs. */
  applySettings() {
    const limit = Math.max(0, Number(this.config.maxSpeed) || 0);
    for (const job of this.jobs) {
      if (job.active && !job.maxSpeedExplicit) job.maxSpeed = limit;
      if (job.state === 'queued' && !job._running) {
        job.applySettings({ connections: this.config.connections, proxy: this.proxy });
      }
    }
    this._pump();
  }

  get totalSpeed() {
    return this._running().reduce((a, j) => a + (j.speed || 0), 0);
  }

  persistAllSync() {
    for (const j of this.jobs) j.persistNowSync();
    this.saveNow();
  }
}

module.exports = { DownloadManager };
