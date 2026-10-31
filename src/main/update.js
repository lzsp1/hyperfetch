'use strict';

/**
 * update.js — version checks against GitHub Releases (with CDN acceleration)
 * and download of the new installer through the app's own multi-threaded
 * engine (no browser involvement).
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { app, shell } = require('electron');

const { formatBytes } = require('./util');
const { netGetJson } = require('./netfetch');
const i18n = require('./i18n-main');
const { DownloadJob } = require('./download');

/* ------------------------------------------------------------------ */
/* version helpers                                                     */
/* ------------------------------------------------------------------ */

function parseVersion(v) {
  const m = String(v || '')
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return [+m[1], +m[2], +m[3], m[4] || null];
}

/** Compare two semantic versions. >0 if a is newer. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  // a release (no prerelease) outranks a prerelease with the same numbers
  if (!pa[3] && pb[3]) return 1;
  if (pa[3] && !pb[3]) return -1;
  if (pa[3] === pb[3]) return 0;
  return String(pa[3]).localeCompare(String(pb[3]));
}

/* ------------------------------------------------------------------ */
/* CDN + GitHub endpoints                                              */
/* ------------------------------------------------------------------ */

const GITHUB_API = 'https://api.github.com';

/** Prefixes tried in order for release assets (first that works wins). */
const CDN_PREFIXES = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  '',
];

/** Prefixes for the releases API JSON (api.github.com is often blocked). */
const API_PREFIXES = ['https://api.github.com', 'https://gh-proxy.com/https://api.github.com', ''];

function cdnCandidates(url) {
  const seen = new Set();
  const out = [];
  for (const p of CDN_PREFIXES) {
    if (p.startsWith('https://ghproxy.net/')) {
      // ghproxy.net uses a /path style prefix
      const u = `https://ghproxy.net/${url}`;
      if (!seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
      continue;
    }
    const u = `${p}${url}`;
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* UpdateManager                                                       */
/* ------------------------------------------------------------------ */

class UpdateManager extends EventEmitter {
  /**
   * @param opts { config, getNetFor, getConnections, onDownloadProgress }
   *   config: live settings object (repo, updateCdn, updatePrerelease, ...)
   */
  constructor(opts) {
    super();
    this.config = opts.config;
    this.getNetFor = opts.getNetFor;
    this.settingsSnapshot = opts.getSettings || (() => ({}));
    this.state = 'idle'; // idle | checking | available | downloading | downloading-installer | ready | error
    this.info = null;
    this.error = null;
    this.job = null;
    this.filePath = null;
    this.installer = null;
    this.progress = null;
    this.checkedAt = 0;
    this._checkPromise = null;
  }

  get repo() {
    return (this.config.updateRepo || '').trim() || 'OWNER/REPO';
  }

  get enabled() {
    return !!this.config.updateRepo && !/^OWNER\//.test(this.config.updateRepo);
  }

  status() {
    return {
      state: this.state,
      info: this.info,
      error: this.error,
      progress: this.progress,
      installer: this.installer ? normalizeInstaller(this.installer) : null,
      checkedAt: this.checkedAt,
      repo: this.repo,
      enabled: this.enabled,
      current: app.getVersion(),
    };
  }

  _set(state, extra = {}) {
    this.state = state;
    Object.assign(this, extra);
    this.emit('update', this.status());
  }

  /* ---------------------------------------------------------------- */
  /* checking                                                          */
  /* ---------------------------------------------------------------- */

  check({ silent = false } = {}) {
    if (this._checkPromise) return this._checkPromise;
    if (!this.enabled) {
      this._set('error', { error: i18n.t('update.notConfigured') });
      return Promise.resolve(this.status());
    }
    this._checkPromise = this._doCheck(silent)
      .catch((e) => {
        this._set('error', { error: e.message || String(e) });
        return this.status();
      })
      .finally(() => {
        this._checkPromise = null;
      });
    return this._checkPromise;
  }

  async _doCheck(silent) {
    this._silentCheck = silent;
    if (!silent || this.state === 'idle') this._set('checking', { error: null });
    const release = await this._fetchLatestRelease();
    if (!release) throw new Error(i18n.t('update.checkFailed'));
    const version = String(release.tag_name || release.name || '').replace(/^v/i, '');
    const isNewer = compareVersions(version, app.getVersion()) > 0;
    const assets = (release.assets || []).filter((a) => /\.(exe|msi)$/i.test(a.name));
    const preferred =
      assets.find((a) => /setup|install|安装/i.test(a.name)) || assets.find((a) => /\.msi$/i.test(a.name)) || assets[0] || null;
    this.info = {
      version,
      tag: release.tag_name,
      name: release.name || release.tag_name,
      body: release.body || '',
      htmlUrl: release.html_url,
      publishedAt: release.published_at,
      prerelease: !!release.prerelease,
      newVersion: isNewer,
      asset: preferred
        ? {
            name: preferred.name,
            size: preferred.size,
            browser_download_url: preferred.browser_download_url || `${GITHUB_API.replace('/api.github.com', '')}`,
            content_type: preferred.content_type,
          }
        : null,
      assets: assets.map((a) => ({ name: a.name, size: a.size, browser_download_url: a.browser_download_url })),
    };
    this.checkedAt = Date.now();
    this._set(isNewer ? 'available' : 'idle', { error: null });
    this.emit('checked', this.status());
    return this.status();
  }

  async _fetchLatestRelease() {
    const repo = this.repo;
    const { net } = this.getNetFor();
    const prerelease = !!this.config.updatePrerelease;
    // Try "latest" (stable) first unless prereleases are requested.
    const paths = prerelease ? [] : [`/repos/${repo}/releases/latest`];
    paths.push(`/repos/${repo}/releases?per_page=5`);
    let lastErr = null;
    for (const prefix of API_PREFIXES) {
      for (const p of paths) {
        const url = `${prefix.replace(/\/$/, '')}${p}`;
        try {
          const r = await netGetJson({ net }, url, { timeout: 12000 });
          if (r.status !== 200 || !r.json) continue;
          const json = r.json;
          if (Array.isArray(json)) {
            const found = json.find((x) => x && !x.draft);
            if (found) return found;
            continue;
          }
          if (json && json.tag_name) return json;
        } catch (e) {
          lastErr = e;
        }
      }
    }
    if (lastErr && !this._silentCheck) throw lastErr;
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* downloading the new installer                                     */
  /* ---------------------------------------------------------------- */

  async startUpdate() {
    if (!this.info?.newVersion || !this.info.asset) {
      throw new Error(i18n.t('update.noPackage'));
    }
    if (this.job) throw new Error(i18n.t('update.inProgress'));
    const asset = this.info.asset;
    const dir = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, asset.name);

    const cfg = this.settingsSnapshot() || {};
    const proxy = { mode: cfg.proxyMode || 'system', url: cfg.proxyUrl || '' };

    // Try each mirror until one of them actually serves the file.
    const candidates = cdnCandidates(asset.browser_download_url);
    let lastErr = null;
    for (const url of candidates) {
      if (this._cancelled) break;
      this._set('downloading', { error: null, progress: { url, name: asset.name, size: asset.size || 0 } });
      const job = new DownloadJob(
        { getNetFor: this.getNetFor, reservedPaths: new Set() },
        {
          url,
          dir,
          name: asset.name,
          connections: Math.min(32, Math.max(1, Number(cfg.connections) || 8)),
          maxSpeed: 0,
          proxy,
        }
      );
      this.job = job;
      job.on('update', (d) => {
        this.progress = {
          url,
          name: asset.name,
          size: asset.size || d.total || 0,
          received: d.received || 0,
          total: d.total || asset.size || 0,
          speed: job.currentSpeed,
          eta: d.eta || 0,
          state: d.state,
        };
        this.emit('progress', this.progress);
      });
      job.on('log', (m) => this.emit('log', `${i18n.t('update.logPrefix')} ${m}`));
      try {
        await job.start();
        if (job.state !== 'completed') {
          throw new Error(job.error || i18n.t('update.notFinished', { state: job.state }));
        }
        // Guard: an HTML error page from a mirror is not an installer.
        const st = fs.statSync(job.filePath);
        if (asset.size && Math.abs(st.size - asset.size) > 1024) {
          throw new Error(
            i18n.t('update.sizeMismatch', { got: i18n.formatBytesI18n(st.size), expected: i18n.formatBytesI18n(asset.size) })
          );
        }
        this.filePath = job.filePath;
        this.job = null;
        this._cancelled = false;
        this.installer = {
          path: job.filePath,
          size: st.size,
          name: path.basename(job.filePath),
          version: this.info.version,
        };
        this.progress = { ...this.progress, state: 'completed', received: st.size, total: st.size };
        this._set('ready');
        this.emit('ready', normalizeInstaller(this.installer));
        return normalizeInstaller(this.installer);
      } catch (e) {
        lastErr = e;
        this.job = null;
        this.emit('log', `${i18n.t('update.logPrefix')} ${i18n.t('update.mirrorFailed', { url, error: e.message })}`);
        // clean the broken partial file before trying the next mirror
        try {
          if (job.filePath) fs.rmSync(job.metaPath, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
    this._cancelled = false;
    const msg = lastErr ? lastErr.message : i18n.t('update.allMirrorsFailed');
    this._set('error', { error: i18n.t('update.downloadFailed', { error: msg }) });
    throw new Error(msg);
  }

  cancelUpdate() {
    this._cancelled = true;
    this.job?.cancel(true);
    this.job = null;
    this._set('available', { error: null });
  }

  /** Launches the downloaded installer and quits the app. */
  async installAndQuit() {
    if (!this.installer || !fs.existsSync(this.installer.path)) {
      throw new Error(i18n.t('update.noInstallerFile'));
    }
    const p = this.installer.path;
    setTimeout(() => {
      try {
        if (/\.msi$/i.test(p)) {
          // msiexec detaches from the app so the update survives our exit
          require('child_process').spawn('msiexec.exe', ['/i', p], { detached: true, stdio: 'ignore' }).unref();
        } else {
          require('child_process').spawn(p, [], { detached: true, stdio: 'ignore' }).unref();
        }
      } catch (e) {
        shell.openPath(p);
      }
      app.quit();
    }, 120);
    return true;
  }

  /** Opens the releases page in the system browser (manual fallback). */
  openReleasePage() {
    if (this.info?.htmlUrl) return shell.openExternal(this.info.htmlUrl);
    return shell.openExternal(`https://github.com/${this.repo}/releases/latest`);
  }
}

function normalizeInstaller(i) {
  if (!i) return null;
  let exists = false;
  try {
    exists = fs.existsSync(i.path);
  } catch {
    exists = false;
  }
  return { ...i, exists };
}

module.exports = {
  UpdateManager,
  compareVersions,
  parseVersion,
  cdnCandidates,
  GITHUB_API,
  CDN_PREFIXES,
};
