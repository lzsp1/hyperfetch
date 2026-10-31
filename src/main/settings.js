'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  theme: 'system', // system | dark | light  accent: 'aurora', // aurora | cyan | violet | sunset | lime | rose
  downloadDir: '',
  connections: 16,
  maxConcurrent: 3,
  maxSpeed: 0, // bytes/s, 0 = unlimited
  proxyMode: 'system', // system | direct | custom
  proxyUrl: '',
  glass: true,
  animations: true,
  autoCloseWhenDone: false,
  confirmRemove: false,
  openFolderWhenDone: false,
  // updates (GitHub Releases + mirrors for mainland networks)
  updateRepo: 'lzsp1/hyperfetch', // "owner/repo"
  updateUseCdn: true,
  updatePrerelease: false,
  autoCheckUpdate: true,
  // interface language: system language is detected on first run
  language: '',
  // completion feedback
  soundOnDone: true,
  soundOnFail: true,
  soundVolume: 0.8, // 0..1
  notifyOnDone: true,
};

class Settings {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = this._sanitize({ ...DEFAULTS, ...parsed });
    } catch {
      /* first run */
    }
    return this.data;
  }

  /**
   * Repairs values that must be strings. Older builds could persist an IPC
   * error envelope as `downloadDir`; without this the UI would show
   * "[object Object]" on every launch.
   */
  _sanitize(data) {
    const out = { ...data };
    // an empty update repository would silently disable update checks
    if (!out.updateRepo) out.updateRepo = DEFAULTS.updateRepo;
    for (const key of ['downloadDir', 'proxyUrl', 'language', 'updateRepo', 'accent', 'theme', 'proxyMode']) {
      if (typeof out[key] !== 'string') out[key] = DEFAULTS[key];
    }
    return out;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      /* ignore */
    }
  }

  set(patch = {}) {
    const allowed = Object.keys(DEFAULTS);
    for (const [k, v] of Object.entries(patch)) {
      if (allowed.includes(k)) this.data[k] = v;
    }
    this.data = this._sanitize(this.data);
    this.save();
    return this.data;
  }

  get all() {
    return { ...this.data };
  }

  reset() {
    this.data = { ...DEFAULTS };
    this.save();
    return this.all;
  }
}

module.exports = { Settings, DEFAULTS };
