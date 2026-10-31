/* =====================================================================
   HyperFetch — renderer
   ===================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------------------------------------------------------- */
/* i18n                                                              */
/* ---------------------------------------------------------------- */

const I18N = window.HF_I18N;
let t = I18N.createTranslator('en');
let currentLang = 'en';

function parseVars(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Applies translations to every element carrying a data-i18n* attribute. */
function localizeStatic() {
  $$('[data-i18n]').forEach((el) => {
    const text = t(el.dataset.i18n, parseVars(el.dataset.i18nVars));
    if (text.includes('<br')) el.innerHTML = text;
    else el.textContent = text;
  });
  $$('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  $$('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  $$('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  $$('[data-i18n-accent]').forEach((el) => {
    el.title = t(`accent.${el.dataset.i18nAccent}`);
  });
  // shell strings the HTML cannot express (document title)
  document.title = 'HyperFetch';
  // the tab labels changed width: re-measure the sliding indicator
  if (typeof refreshGlider === 'function') requestAnimationFrame(refreshGlider);
}

/** Re-typesets the tab indicator after a language switch. */
var refreshGlider = function () {
  const tabs = $('#tabs');
  const glider = $('#tabGlider');
  const active = tabs && tabs.querySelector('.tab.active');
  if (!glider || !active) return;
  glider.style.width = `${active.offsetWidth}px`;
  glider.style.transform = `translateX(${active.offsetLeft - 4}px)`;
};

/** Switches the interface language; everything is re-rendered in place. */
function applyLanguage(code) {
  currentLang = I18N.MESSAGES[code] ? code : I18N.normalizeLocale(code);
  t = I18N.createTranslator(currentLang);
  const lang = I18N.LANGUAGES.find((l) => l.code === currentLang);
  document.documentElement.lang = currentLang;
  document.documentElement.dir = lang && lang.rtl ? 'rtl' : 'ltr';
  localizeStatic();
  renderLangGrid();
  if (state.settings && Object.keys(state.settings).length) syncSettingsForm();
  if (state.tasks.size) syncList(false);
  if (state.drawerId) renderDrawer();
  if (updateUI.open) renderUpdateDialog();
  if (state.probe.status && state.probe.status !== 'idle') setProbe(state.probe.status, state.probe.data || {});
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const state = {
  tasks: new Map(), // id -> task
  order: [], // id order (newest first)
  filter: 'all',
  settings: {},
  logs: [],
  probe: { url: '', status: 'idle', token: 0, timer: null },
  drawerId: null,
  maximized: false,
  env: {},
};

const ICONS = {
  pause: '<svg viewBox="0 0 24 24"><path d="M8.5 6v12M15.5 6v12"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7.5 5.3v13.4L18.6 12 7.5 5.3Z" fill="currentColor" stroke="none"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.4l1.8 2.2h6.8a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2v-9Z"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4.5h5.5V10M19 5 11 13"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5.5h4V7M7.2 7l.7 11a1.6 1.6 0 0 0 1.6 1.5h5a1.6 1.6 0 0 0 1.6-1.5L16.8 7"/><path d="M10.5 10.5v5.5M13.5 10.5v5.5"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.7"/><path d="M12 11v5.5M12 7.8v.4"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 13.5a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5"/><path d="M14 10.5a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.5-1.5"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6.5 3.5h7l4 4v13h-11v-17Z"/><path d="M13.5 3.5v4h4M9.5 12.5h5M9.5 16h5"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4.5 17 5-5 4 4 2.5-2.5 4 4"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="3" y="5.5" width="13" height="13" rx="2.5"/><path d="m16 10.5 4.5-2.6v8.2L16 13.5"/></svg>',
  zip: '<svg viewBox="0 0 24 24"><path d="M6 3.5h12v17H6z"/><path d="M12 3.5v2M12 7.5v2M12 11.5v2M10.2 15h3.6v3.5h-3.6z"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M9 17.5V6l10-2v11.5"/><circle cx="6.5" cy="17.5" r="2.6"/><circle cx="16.5" cy="15.5" r="2.6"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M6 4.5h12v15H6zM9 9h6M9 12.5h6M9 16h3.5"/></svg>',
  dot: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>',
  rename: '<svg viewBox="0 0 24 24"><path d="M4 16.5 15 5.5l3.5 3.5L7.5 20H4v-3.5Z"/><path d="m13.5 7 3.5 3.5"/></svg>',
  rename: '<svg viewBox="0 0 24 24"><path d="M4 16.5 15 5.5l3.5 3.5L7.5 20H4v-3.5Z"/><path d="m13.5 7 3.5 3.5"/></svg>',
};

const EXT_KIND = {
  zip: 'zip', rar: 'zip', '7z': 'zip', gz: 'zip', xz: 'zip', tar: 'zip', iso: 'zip', cab: 'zip',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', ico: 'image', avif: 'image',
  mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', webm: 'video', flv: 'video', wmv: 'video', m4v: 'video',
  mp3: 'audio', flac: 'audio', wav: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio',
  js: 'code', ts: 'code', json: 'code', css: 'code', py: 'code', cpp: 'code', c: 'code', h: 'code', java: 'code', html: 'code', exe: 'code', dll: 'code', apk: 'code',
  txt: 'text', md: 'text', log: 'text', csv: 'text', pdf: 'text', docx: 'text', xlsx: 'text', pptx: 'text',
};

/* ---------------------------------------------------------------- */
/* formatting                                                        */
/* ---------------------------------------------------------------- */

function fmtBytes(b) {
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function fmtSpeed(b) {
  return `${fmtBytes(Math.max(0, b || 0))}/s`;
}

function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return t('time.seconds', { n: Math.ceil(sec) });
  const m = Math.floor(sec / 60);
  if (m < 60) return t('time.minutes', { m, s: Math.round(sec % 60) });
  return t('time.hours', { h: Math.floor(m / 60), m: m % 60 });
}

function pct(task) {
  if (task.state === 'completed') return 100;
  const total = Number(task.total) || 0;
  const received = Number(task.received) || 0;
  if (total <= 0) return 0;
  return Math.min(100, (received / total) * 100);
}

const STATE_TEXT = {
  queued: () => t('state.queued'),
  probing: () => t('state.probing'),
  downloading: () => t('state.downloading'),
  paused: () => t('state.paused'),
  completed: () => t('state.completed'),
  error: () => t('state.error'),
  cancelled: () => t('state.cancelled'),
};

/** Turns an engine error into a short, actionable hint for the user. */
function errorHint(err) {
  const e = String(err || '');
  if (/404|\u4e0d\u5b58\u5728|not found/i.test(e)) return t('hint.notFound');
  if (/403|forbidden/i.test(e)) return t('hint.forbidden');
  if (/CERT|SSL|TLS/i.test(e)) return t('hint.cert');
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(e)) return t('hint.dns');
  if (/ETIMEDOUT|timed out/i.test(e)) return t('hint.timeout');
  if (/ENOSPC/.test(e)) return t('hint.disk');
  if (/EACCES|EPERM|EBUSY/.test(e)) return t('hint.perm');
  if (/EPROTO|RANGE_IGNORED/.test(e)) return t('hint.range');
  if (/HTTP 40[0-9]|HTTP 5/.test(e) && /html/i.test(e)) return t('hint.html');
  return t('hint.generic');
}

function basename(p) {
  if (!p) return '';
  return p.split(/[\\/]/).pop();
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/* ---------------------------------------------------------------- */
/* toast                                                             */
/* ---------------------------------------------------------------- */

function toast(message, kind = 'info', duration = 3400) {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.style.setProperty('--dur', `${duration}ms`);
  const ico = kind === 'ok' ? '✓' : kind === 'err' ? '!' : 'i';
  el.innerHTML = `<span class="toast-ico">${ico}</span><span></span>`;
  el.lastElementChild.textContent = message;
  wrap.appendChild(el);
  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 360);
  };
  setTimeout(remove, duration);
  el.addEventListener('click', remove);
  while (wrap.children.length > 4) wrap.firstElementChild.remove();
}

/* ---------------------------------------------------------------- */
/* theme                                                             */
/* ---------------------------------------------------------------- */

const THEME_QUERY = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
let systemPrefersLight = THEME_QUERY ? THEME_QUERY.matches : false;

/** Resolves 'system' to the OS preference. */
function effectiveTheme(settings = state.settings) {
  const t = settings.theme || 'system';
  if (t === 'dark' || t === 'light') return t;
  return systemPrefersLight ? 'light' : 'dark';
}

function applyTheme(settings) {
  const html = document.documentElement;
  const theme = effectiveTheme(settings);
  html.dataset.theme = theme;
  html.dataset.accent = settings.accent || 'aurora';
  html.dataset.glass = settings.glass === false ? 'false' : 'true';
  html.dataset.anim = settings.animations === false ? 'false' : 'true';
  html.style.colorScheme = theme;
}

/* Follow the OS when the app runs on its system theme. */
if (THEME_QUERY) {
  THEME_QUERY.addEventListener('change', (e) => {
    systemPrefersLight = e.matches;
    if ((state.settings.theme || 'system') === 'system') applyTheme(state.settings);
  });
}

/* ---------------------------------------------------------------- */
/* probe (URL metadata preview)                                      */
/* ---------------------------------------------------------------- */

function scheduleProbe(url) {
  const p = state.probe;
  const target = url.trim();
  if (target === p.url && p.status !== 'error') return;
  p.url = target;
  clearTimeout(p.timer);
  if (!target) {
    setProbe('idle');
    return;
  }
  if (!/^https?:\/\/[^\s]+$/i.test(target) && !/^[\w.-]+\.[a-z]{2,}\//i.test(target)) {
    setProbe('idle');
    return;
  }
  setProbe('loading');
  p.timer = setTimeout(async () => {
    const token = ++p.token;
    const res = await window.api.probe(target);
    if (token !== p.token) return;
    if (!res.ok) {
      setProbe('error', { message: res.error });
      return;
    }
    setProbe('ok', res.data);
  }, 600);
}

function setProbe(status, data = {}) {
  const card = $('#probe');
  const icon = $('#probeIcon');
  const title = $('#probeTitle');
  const meta = $('#probeMeta');
  const tags = $('#probeTags');
  state.probe.status = status;

  if (status === 'idle') {
    card.classList.remove('show', 'ok', 'err', 'loading');
    tags.innerHTML = '';
    title.textContent = t('probe.idleTitle');
    meta.textContent = t('probe.idleMeta');
    icon.textContent = '…';
    return;
  }
  card.classList.add('show');
  card.classList.toggle('loading', status === 'loading');
  card.classList.toggle('ok', status === 'ok');
  card.classList.toggle('err', status === 'error');

  if (status === 'loading') {
    icon.textContent = '';
    title.textContent = t('probe.loadingTitle');
    meta.textContent = t('probe.loadingMeta');
    tags.innerHTML = '';
    return;
  }
  if (status === 'error') {
    icon.textContent = '!';
    title.textContent = t('probe.errorTitle');
    meta.textContent = data.message || t('probe.errorMeta');
    tags.innerHTML = '';
    return;
  }
  const d = data;
  const kind = extOf(d.name);
  icon.textContent = (kind || 'FILE').slice(0, 4).toUpperCase();
  title.textContent = d.name || t('probe.unknownFile');
  let path = '';
  try {
    path = basename(new URL(d.finalUrl || d.url).pathname);
  } catch {
    path = '';
  }
  meta.textContent = [d.sizeText, d.type ? d.type.split(';')[0] : '', path]
    .filter(Boolean)
    .join('  ·  ');
  const tagList = [];
  if (d.acceptsRanges) tagList.push(`<span class="tag good">${t('probe.multiThread')}</span>`);
  else tagList.push(`<span class="tag warn">${t('probe.singleThread')}</span>`);
  if (d.size) tagList.push(`<span class="tag">${d.sizeText}</span>`);
  tags.innerHTML = tagList.join('');
}

/* ---------------------------------------------------------------- */
/* task rendering                                                    */
/* ---------------------------------------------------------------- */

function stateLabel(state) {
  const entry = STATE_TEXT[state];
  return typeof entry === 'function' ? entry() : entry || state;
}

function stateClass(task) {
  if (task.state === 'completed') return 'done';
  if (task.state === 'error') return 'error';
  return task.state;
}

function kindIcon(task) {
  const kind = EXT_KIND[extOf(task.name)] || 'file';
  return `<span class="icon-badge">${ICONS[kind] || ICONS.file}</span>`;
}

function escapeAttr(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function actionsFor(task) {
  const a = [];
  if (['downloading', 'probing'].includes(task.state)) {
    a.push(`<button class="icon-btn" data-act="pause" title="${t('task.pause')}">${ICONS.pause}</button>`);
  } else if (['paused', 'error', 'queued'].includes(task.state)) {
    a.push(`<button class="icon-btn accent" data-act="resume" title="${t('task.resume')}">${ICONS.play}</button>`);
  }
  if (task.state === 'completed') {
    a.push(`<button class="icon-btn" data-act="open" title="${t('task.openFile')}">${ICONS.open}</button>`);
  }
  if (task.state !== 'downloading' && task.state !== 'probing') {
    a.push(`<button class="icon-btn" data-act="rename" title="${t('task.rename')}">${ICONS.rename}</button>`);
  }
  a.push(`<button class="icon-btn" data-act="reveal" title="${t('task.reveal')}">${ICONS.folder}</button>`);
  a.push(`<button class="icon-btn" data-act="details" title="${t('task.details')}">${ICONS.info}</button>`);
  a.push(`<button class="icon-btn danger" data-act="remove" title="${t('task.remove')}">${ICONS.trash}</button>`);
  return a.join('');
}

/** The file name for display; falls back to a readable form of the URL. */
function displayName(task) {
  const name = (task.name || '').trim();
  if (name && name !== 'download') return name;
  try {
    const u = new URL(task.url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last) return last;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return task.url;
  }
}

function buildCard(task) {
  const el = document.createElement('article');
  el.className = 'task';
  el.dataset.id = task.id;
  el.innerHTML = `
    <div class="task-row">
      <div class="file-badge">${''}</div>
      <div class="task-main">
        <div class="task-title-row">
          <span class="task-name"></span>
          <span class="task-state"></span>
        </div>
        <div class="task-sub"></div>
      </div>
      <div class="task-pct"></div>
      <div class="task-actions">${actionsFor(task)}</div>
    </div>
    <div class="task-progress"><div class="fill"></div></div>
    <div class="seg-map"></div>
  `;
  el.querySelector('.task-name').textContent = displayName(task);
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) {
      e.stopPropagation();
      handleAction(btn.dataset.act, task.id);
      return;
    }
    openDrawer(task.id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openDrawer(task.id);
  });
  updateCard(el, task, true);
  return el;
}

function pieceHtml(task) {
  const total = task.total || 0;
  const P = Math.min(48, Math.max(8, Math.round((task.connections || 8) * 1.5)));
  let spans = '';
  const segs = task.segments || [];
  if (!total || !segs.length) {
    const w = pct(task);
    spans = `<span class="done" style="--w:${w}%"><i style="width:${w}%"></i></span>`;
    return `<div class="seg-map">${spans}</div>`;
  }
  const plen = Math.ceil(total / P);
  for (let i = 0; i < P; i += 1) {
    const s = i * plen;
    const e = Math.min(total, s + plen);
    let got = 0;
    for (const seg of segs) {
      if (seg.end <= s || seg.start >= e) continue;
      const pos = seg.done ? seg.end : Math.min(seg.end, Math.max(seg.start, seg.pos));
      got += Math.max(0, pos - Math.max(seg.start, s));
    }
    const w = e > s ? Math.min(100, (got / (e - s)) * 100) : 0;
    const cls = w >= 100 ? 'done' : w > 0 && w < 100 ? 'hot' : '';
    spans += `<span class="${cls}"><i style="width:${w.toFixed(1)}%"></i></span>`;
  }
  return `<div class="seg-map">${spans}</div>`;
}

function updateCard(el, task, forInit = false) {
  // (the name element is refreshed below so a rename shows immediately)
  // (the name element is refreshed below so a rename shows immediately)
  const st = stateClass(task);
  el.className = `task ${st}`;
  if (el.dataset.filtered === '1') el.classList.add('hidden');

  const nameEl = el.querySelector('.task-name');
  const niceName = displayName(task);
  if (nameEl.textContent !== niceName) {
    nameEl.textContent = niceName;
    nameEl.title = task.url;
  }

  const badge = el.querySelector('.file-badge');
  const badgeKey = `${task.name}|${task.contentType}`;
  if (badge.dataset.key !== badgeKey) {
    badge.dataset.key = badgeKey;
    badge.innerHTML = kindIcon(task);
  }

  const stateEl = el.querySelector('.task-state');
  stateEl.textContent = stateLabel(task.state);

  const sub = el.querySelector('.task-sub');
  const p = pct(task);
  const parts = [];
  if (task.state === 'error') {
    parts.push(`<span class="err-text">${escapeHtml(task.error || t('task.downloadFailed'))}</span>`);
    parts.push(`<span class="dot-sep"></span><span class="hint-text">${escapeHtml(errorHint(task.error))}</span>`);
  } else if (task.state === 'completed') {
    parts.push(`<span class="mono">${fmtBytes(task.total || task.received)}</span>`);
    parts.push(`<span class="dot-sep"></span><span>${escapeHtml(shortDir(task.filePath))}</span>`);
  } else if (task.state === 'queued') {
    parts.push(`<span>${t('state.waiting')}</span>`);
    if (task.total) parts.push(`<span class="dot-sep"></span><span class="mono">${fmtBytes(task.total)}</span>`);
  } else {
    if (task.state === 'downloading' || task.state === 'probing') {
      parts.push(`<span class="speed">${task.state === 'probing' ? t('state.parsing') : fmtSpeed(task.speed)}</span>`);
    }
    parts.push(
      `<span class="mono">${fmtBytes(task.received)} / ${task.total ? fmtBytes(task.total) : t('task.unknownTotal')}</span>`
    );
    if (task.state === 'downloading' && task.eta > 0) {
      parts.push(`<span class="dot-sep"></span><span>${t('task.remaining', { time: fmtEta(task.eta) })}</span>`);
    }
    if (task.connections && task.total && task.state !== 'probing') {
      parts.push(`<span class="dot-sep"></span><span>${t('task.threads', { n: task.connections })}</span>`);
    }
    if (task.maxSpeed) parts.push(`<span class="dot-sep"></span><span>${t('task.limited', { speed: fmtSpeed(task.maxSpeed) })}</span>`);
  }
  sub.innerHTML = parts.join('');

  const pctEl = el.querySelector('.task-pct');
  if (task.state === 'completed') {
    pctEl.innerHTML = `<small style="font-size:13px;color:var(--ok)">${t('task.finished')}</small>`;
  } else if (task.state === 'error') {
    pctEl.innerHTML = `<small style="font-size:13px;color:var(--danger)">${t('task.failed')}</small>`;
  } else if (task.state === 'queued') {
    pctEl.innerHTML = `<small style="font-size:13px">${t('task.queued')}</small>`;
  } else {
    pctEl.innerHTML = `${p.toFixed(p >= 99.95 ? 0 : 1)}<small>%</small>`;
  }

  const fill = el.querySelector('.task-progress .fill');
  fill.style.width = `${task.state === 'completed' ? 100 : p}%`;

  const segWrap = el.querySelector('.seg-map');
  if (task.state === 'completed') {
    if (segWrap.dataset.lock !== '1') {
      segWrap.dataset.lock = '1';
      segWrap.innerHTML = pieceHtml(task);
    }
  } else {
    segWrap.dataset.lock = '0';
    if (!forInit) segWrap.innerHTML = pieceHtml(task);
    else segWrap.innerHTML = pieceHtml(task);
  }

  el.querySelector('.task-actions').innerHTML = actionsFor(task);
}

function shortDir(p) {
  if (!p) return '—';
  const name = basename(p);
  const dir = p.slice(0, p.length - name.length).replace(/[\\/]+$/, '');
  return dir ? `…\\${basename(dir)}` : name;
}

/* ---------------------------------------------------------------- */
/* list management                                                   */
/* ---------------------------------------------------------------- */

const cardEls = new Map();

function ensureCard(task) {
  let el = cardEls.get(task.id);
  if (!el) {
    el = buildCard(task);
    cardEls.set(task.id, el);
  }
  return el;
}

function matchesFilter(task) {
  switch (state.filter) {
    case 'active':
      return ['downloading', 'probing', 'queued'].includes(task.state);
    case 'paused':
      return task.state === 'paused';
    case 'completed':
      return task.state === 'completed';
    case 'error':
      return task.state === 'error';
    default:
      return true;
  }
}

/**
 * Rebuilds the visible task list.
 *
 * The cards are reconciled against state.order: unknown ids are dropped, new
 * ones created, and DOM order matches the model. Cards that are no longer in
 * the model are removed immediately (with a CSS exit animation) instead of
 * lingering until a timer fires.
 */
function syncList(animate = true) {
  const list = $('#taskList');
  const empty = $('#listEmpty');
  const ids = state.order.filter((id) => state.tasks.has(id) && matchesFilter(state.tasks.get(id)));

  // 1. drop cards whose task no longer exists or no longer matches the filter
  for (const [id, el] of Array.from(cardEls)) {
    if (!ids.includes(id)) {
      cardEls.delete(id);
      el.classList.add('leaving');
      el.style.pointerEvents = 'none';
      setTimeout(() => el.remove(), 360);
      // detach right away so the grid does not reserve space for it
      if (el.parentNode) el.parentNode.removeChild(el);
    }
  }

  // 2. build / order the remaining cards
  let prev = null;
  for (const id of ids) {
    const task = state.tasks.get(id);
    const el = ensureCard(task);
    el.classList.remove('hidden', 'leaving');
    el.dataset.filtered = '0';
    if (!animate) el.style.animation = 'none';
    const target = prev ? prev.nextSibling : list.firstChild;
    if (target !== el) list.insertBefore(el, target);
    prev = el;
  }

  // 3. empty state
  empty.classList.toggle('hidden', ids.length > 0);
  if (!ids.length && state.order.length > 0) {
    empty.querySelector('h3').textContent = t('empty.filteredTitle');
    empty.querySelector('p').innerHTML = t('empty.filteredBody');
  } else if (!ids.length) {
    empty.querySelector('h3').textContent = t('empty.title');
    empty.querySelector('p').innerHTML = t('empty.body');
  }
  updateCounters();
}

function updateCounters() {
  const c = { all: 0, active: 0, paused: 0, completed: 0, error: 0 };
  for (const t of state.tasks.values()) {
    c.all += 1;
    if (['downloading', 'probing', 'queued'].includes(t.state)) c.active += 1;
    else if (t.state === 'paused') c.paused += 1;
    else if (t.state === 'completed') c.completed += 1;
    else if (t.state === 'error') c.error += 1;
  }
  $('#cAll').textContent = c.all;
  $('#cActive').textContent = c.active;
  $('#cPaused').textContent = c.paused;
  $('#cDone').textContent = c.completed;
  $('#cErr').textContent = c.error;

  let speed = 0;
  let active = 0;
  for (const t of state.tasks.values()) {
    if (t.state === 'downloading') {
      speed += t.speed || 0;
      active += 1;
    }
  }
  const pill = $('#globalSpeed').closest('.net-pill');
  $('#globalSpeed').textContent = fmtSpeed(speed);
    $('#activeCount').textContent = active ? t('speed.active', { n: active }) : t('speed.idle');
  pill.classList.toggle('busy', speed > 0);
  updateDocTitle(speed, active);
}

let lastTitle = '';
function updateDocTitle(speed, active) {
  const title = active > 0 ? `${fmtSpeed(speed)} · ${active} ↓ — HyperFetch` : 'HyperFetch';
  if (title !== lastTitle) {
    lastTitle = title;
    document.title = title;
  }
}

/**
 * Ids the user removed. Late progress events for them must be ignored,
 * otherwise a cancelled job final update recreates the card after removal.
 */
const removedIds = new Set();

function upsertTask(task, { prependOrder = true } = {}) {
  if (!task || !task.id) return;
  if (removedIds.has(task.id)) return; // already removed by the user
  const existed = state.tasks.has(task.id);
  state.tasks.set(task.id, task);
  if (!state.order.includes(task.id)) {
    if (prependOrder) state.order.unshift(task.id);
    else state.order.push(task.id);
    syncList(true);
    return;
  }
  const el = cardEls.get(task.id);
  if (el) {
    // re-render the action buttons only when the state actually changes
    if (el.dataset.state !== task.state) {
      el.dataset.state = task.state;
      el.querySelector('.task-actions').innerHTML = actionsFor(task);
    }
    updateCard(el, task);
  } else if (!existed) {
    syncList(true);
  }
}

/* ---- frame-throttled live updates --------------------------------------- */
/*
 * Progress events can arrive several times a second per task. Instead of
 * re-rendering on every event, we store the newest snapshot and flush the
 * visible updates at up to 30 fps, so numbers animate smoothly without
 * dominating the UI thread.
 */
const pendingUpdates = new Map();
let frameScheduled = false;

function scheduleFrame() {
  if (frameScheduled) return;
  frameScheduled = true;
  setTimeout(() => {
    frameScheduled = false;
    const now = performance.now();
    for (const [id, patch] of pendingUpdates) {
      pendingUpdates.delete(id);
      if (removedIds.has(id)) continue;
      const prev = state.tasks.get(id);
      if (!prev) continue;
      const merged = { ...prev, ...patch };
      state.tasks.set(id, merged);
      const el = cardEls.get(id);
      if (el) {
        if (el.dataset.state !== merged.state) {
          el.dataset.state = merged.state;
          el.querySelector('.task-actions').innerHTML = actionsFor(merged);
        }
        updateCard(el, merged);
      }
      if (state.drawerId === id && now - (lastDrawerRender || 0) > 250) {
        lastDrawerRender = now;
        renderDrawer();
      }
    }
    updateCounters();
  }, 33);
}
let lastDrawerRender = 0;

/**
 * Removes a task from the UI. Called both after the user clicks "remove" and
 * when the main process reports that a task is gone, so it is idempotent.
 */
function removeTask(id) {
  removedIds.add(id);
  pendingUpdates.delete(id);
  const existed = state.tasks.has(id);
  state.tasks.delete(id);
  state.order = state.order.filter((x) => x !== id);
  const el = cardEls.get(id);
  if (el) {
    cardEls.delete(id);
    el.classList.add('leaving');
    el.style.pointerEvents = 'none';
    setTimeout(() => el.remove(), 360);
    if (el.parentNode) el.parentNode.removeChild(el);
  }
  if (state.drawerId === id) closeDrawer();
  syncList(false);
  return existed;
}

/* ---------------------------------------------------------------- */
/* actions                                                           */
/* ---------------------------------------------------------------- */

async function handleAction(act, id) {
  const task = state.tasks.get(id);
  if (!task) return;
  switch (act) {
    case 'pause':
      await window.api.pause(id);
      break;
    case 'resume':
      await window.api.resume(id);
      break;
    case 'open':
      {
        const r = await window.api.openPath(task.filePath);
        if (!r.ok) toast(r.error || t('toast.cannotOpen'), 'err');
      }
      break;
    case 'reveal':
      if (task.filePath) await window.api.revealPath(task.filePath);
      else await window.api.revealPath(task.dir);
      break;
    case 'details':
      openDrawer(id);
      break;
    case 'rename':
      openRenameDialog(id);
      break;
    case 'remove':
      el_remove(id);
      break;
    default:
      break;
  }
}

function el_remove(id) {
  window.api.remove(id).then((r) => {
    if (r && r.ok === false) {
      toast(r.error || t('task.removeFailed'), 'err', 3000);
      return;
    }
    removeTask(id);
    toast(t('task.removed'), 'info', 2400);
  });
}

/* ---------------------------------------------------------------- */
/* rename                                                            */
/* ---------------------------------------------------------------- */

const renameUI = { id: null, busy: false };

/** Splits "name.ext" so the stem can be pre-selected in the input. */
function splitName(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

function openRenameDialog(id) {
  const task = state.tasks.get(id);
  if (!task) return;
  if (task.state === 'downloading' || task.state === 'probing') {
    toast(t('rename.busy'), 'err', 2600);
    return;
  }
  renameUI.id = id;
  renameUI.busy = false;
  const name = displayName(task);
  $('#renameSub').textContent = task.state === 'completed' ? task.filePath || name : name;
  $('#renameInput').value = name;
  $('#renameError').hidden = true;
  $('#renameModal').classList.add('open');
  $('#renameModal').setAttribute('aria-hidden', 'false');
  $('#renameScrim').classList.add('open');
  const input = $('#renameInput');
  requestAnimationFrame(() => {
    input.focus();
    // preselect the file stem, keeping the extension editable
    const { stem } = splitName(name);
    input.setSelectionRange(0, Math.max(0, stem.length));
  });
}

function closeRenameDialog() {
  renameUI.id = null;
  $('#renameModal').classList.remove('open');
  $('#renameModal').setAttribute('aria-hidden', 'true');
  $('#renameScrim').classList.remove('open');
}

async function submitRename() {
  if (!renameUI.id || renameUI.busy) return;
  const name = $('#renameInput').value.trim();
  const errEl = $('#renameError');
  if (!name) {
    errEl.textContent = t('rename.empty');
    errEl.hidden = false;
    return;
  }
  renameUI.busy = true;
  const btn = $('#renameSave');
  btn.disabled = true;
  const r = await window.api.rename(renameUI.id, name);
  btn.disabled = false;
  renameUI.busy = false;
  if (!r.ok) {
    errEl.textContent = r.error || t('rename.failed', { error: '' });
    errEl.hidden = false;
    return;
  }
  const updated = r.data;
  state.tasks.set(updated.id, { ...(state.tasks.get(updated.id) || {}), ...updated });
  const el = cardEls.get(updated.id);
  if (el) {
    el.querySelector('.task-name').textContent = displayName(updated);
    updateCard(el, updated);
  }
  if (state.drawerId === updated.id) renderDrawer();
  closeRenameDialog();
  toast(t('rename.done', { name: displayName(updated) }), 'ok', 2400);
}

/* ---------------------------------------------------------------- */
/* drawer                                                            */
/* ---------------------------------------------------------------- */

function openDrawer(id) {
  state.drawerId = id;
  const task = state.tasks.get(id);
  if (!task) return;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawerScrim').classList.add('open');
  document.body.classList.add('drawer-open');
  renderDrawer();
}

function closeDrawer() {
  state.drawerId = null;
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawerScrim').classList.remove('open');
  document.body.classList.remove('drawer-open');
}

function renderDrawer() {
  const task = state.tasks.get(state.drawerId);
  if (!task) return closeDrawer();
  $('#drawerFile').textContent = displayName(task);
  $('#drawerSub').textContent = `${stateLabel(task.state)} · ${fmtBytes(task.received)}${
    task.total ? ` / ${fmtBytes(task.total)}` : ''
  }${task.state === 'downloading' ? ` · ${fmtSpeed(task.speed)}` : ''}`;

  const segs = task.segments || [];
  const P = Math.min(64, Math.max(0, task.pieces || 0));
  let pieceGrid = '';
  if (P > 0 && task.total) {
    const plen = Math.ceil(task.total / P);
    const cells = [];
    for (let i = 0; i < P; i += 1) {
      const s = i * plen;
      const e = Math.min(task.total, s + plen);
      let got = 0;
      for (const seg of segs) {
        if (seg.end <= s || seg.start >= e) continue;
        const pos = seg.done ? seg.end : Math.min(seg.end, Math.max(seg.start, seg.pos));
        got += Math.max(0, pos - Math.max(seg.start, s));
      }
      const w = e > s ? Math.min(100, (got / (e - s)) * 100) : 0;
      cells.push(`<i class="${w >= 99.9 ? 'full' : ''}"><b style="width:${w.toFixed(1)}%"></b></i>`);
    }
    pieceGrid = `<div class="piece-grid">${cells.join('')}</div>`;
  }

  const segList = segs
    .slice(0, 12)
    .map((s, i) => {
      const pos = s.done ? s.end : Math.min(s.end, Math.max(s.start, s.pos));
      const w = ((pos - s.start) / Math.max(1, s.end - s.start)) * 100;
      return `<div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-3);margin-bottom:5px">
        <span style="width:58px;font-variant-numeric:tabular-nums">#${i + 1}</span>
        <span style="flex:1;height:4px;border-radius:9px;background:color-mix(in srgb,var(--text) 8%,transparent);overflow:hidden"><b style="display:block;height:100%;width:${w.toFixed(
          1
        )}%;background:linear-gradient(90deg,var(--acc-a),var(--acc-b))"></b></span>
        <span style="width:84px;text-align:right;font-variant-numeric:tabular-nums">${fmtBytes(pos - s.start)} / ${fmtBytes(
        s.end - s.start
      )}</span>
      </div>`;
    })
    .join('');

  const isActive = ['downloading', 'probing'].includes(task.state);
  $('#drawerBody').innerHTML = `
    <div class="drawer-section">
      <h4>${t('drawer.overview')}</h4>
      <dl class="kv">
        <dt>${t('drawer.status')}</dt><dd>${stateLabel(task.state)}${task.error ? ` — ${escapeHtml(task.error)}` : ''}</dd>
        <dt>${t('drawer.size')}</dt><dd>${task.total ? fmtBytes(task.total) : t('drawer.unknown')}</dd>
        <dt>${t('drawer.downloaded')}</dt><dd>${fmtBytes(task.received)} (${pct(task).toFixed(1)}%)</dd>
        <dt>${t('drawer.speed')}</dt><dd>${isActive ? fmtSpeed(task.speed) : '—'}</dd>
        <dt>${t('drawer.eta')}</dt><dd>${isActive && task.eta ? fmtEta(task.eta) : '—'}</dd>
        <dt>${t('drawer.connections')}</dt><dd>${task.connections || '—'}${task.resumable === false ? t('drawer.noRanges') : ''}</dd>
        <dt>${t('drawer.savedTo')}</dt><dd class="mono" title="${escapeAttr(task.filePath || task.dir)}">${escapeHtml(task.filePath || task.dir)}</dd>
        <dt>${t('drawer.url')}</dt><dd class="mono" title="${escapeAttr(task.url)}">${escapeHtml(task.url)}</dd>
      </dl>
    </div>
    ${P ? `<div class="drawer-section"><h4>${t('drawer.pieces', { n: P })}</h4>${pieceGrid}</div>` : ''}
    ${segs.length ? `<div class="drawer-section"><h4>${t('drawer.segments')}${segs.length > 12 ? ' ' + t('drawer.segmentsOf', { n: segs.length }) : ''}</h4>${segList}</div>` : ''}
    <div class="drawer-section">
      <h4>${t('drawer.actions')}</h4>
      <div class="drawer-actions">
        ${
          isActive
            ? `<button class="ghost-btn" data-dact="pause">${ICONS.pause} ${t('task.pause')}</button>`
            : ['paused', 'error', 'queued'].includes(task.state)
            ? `<button class="ghost-btn" data-dact="resume">${ICONS.play} ${t('task.resume')}</button>`
            : ''
        }
        ${task.state === 'completed' ? `<button class="ghost-btn" data-dact="open">${ICONS.open} ${t('drawer.open')}</button>` : ''}
        ${
          task.state === 'downloading' || task.state === 'probing'
            ? ''
            : `<button class="ghost-btn" data-dact="rename">${ICONS.rename} ${t('task.rename')}</button>`
        }
        <button class="ghost-btn" data-dact="reveal">${ICONS.folder} ${t('drawer.folder')}</button>
        <button class="ghost-btn" data-dact="copy">${ICONS.link} ${t('drawer.copy')}</button>
        <button class="ghost-btn" data-dact="remove" style="color:var(--danger);border-color:color-mix(in srgb,var(--danger) 30%,transparent)">${ICONS.trash} ${t('drawer.remove')}</button>
      </div>
    </div>
  `;
}

$('#drawerBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-dact]');
  if (!btn || !state.drawerId) return;
  const id = state.drawerId;
  const task = state.tasks.get(id);
  const act = btn.dataset.dact;
  if (act === 'copy') {
    navigator.clipboard.writeText(task.url);
    toast(t('toast.copied'), 'ok');
    return;
  }
  await handleAction(act, id);
});

/* ---------------------------------------------------------------- */
/* composer                                                          */
/* ---------------------------------------------------------------- */

function renderDir() {
  // The stored value is always a string, but guard anyway: an object here is
  // what used to render as "[object Object]".
  const raw = state.settings.downloadDir;
  const dir = typeof raw === 'string' && raw.trim() ? raw : state.settings.defaultDownloadDir || '—';
  $('#dirValue').textContent = dir;
  $('#dirValue').title = dir;
  $('#setDirValue').textContent = dir;
  $('#setDirValue').title = dir;
}

/* ---------------------------------------------------------------- */
/* updates & repo links                                              */
/* ---------------------------------------------------------------- */

const GITHUB_USER = 'lzsp1';
let REPO_URL = '';
let LICENSE_URL = '';
let RELEASES_URL = '';

function repoSlug() {
  const r = String(state.settings.updateRepo || '').trim();
  return r || `${GITHUB_USER}/hyperfetch`;
}

function renderRepoLinks() {
  const slug = repoSlug();
  REPO_URL = `https://github.com/${slug}`;
  LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
  RELEASES_URL = `${REPO_URL}/releases`;
  const t = $('#setRepoText');
  if (t) t.textContent = `github.com/${slug}`;
  const v = $('#setVersion');
  if (v) v.textContent = `v${state.settings.version || state.env.version || '—'}`;
}

function fmtUpdateState(u) {
  if (!u) return t('settings.notChecked');
  if (u.state === 'checking') return t('settings.checking');
  if (u.state === 'available') return t('settings.updateAvailable', { version: u.info?.version });
  if (u.state === 'downloading') return t('settings.downloadingUpdate');
  if (u.state === 'ready') return t('settings.updateReady');
  if (u.state === 'error') return u.error || t('settings.checkFailed');
  if (u.checkedAt) return t('settings.upToDate');
  return '尚未检查更新';
}

function refreshUpdateBadge(u) {
  const el = $('#setUpdateState');
  if (el) el.textContent = fmtUpdateState(u);
  const btn = $('#btnCheckUpdate');
  if (btn) btn.classList.toggle('busy', u?.state === 'checking');
}

/* ---- modal ---- */
const updateUI = { open: false, status: null };

function openUpdateDialog(autoCheck = true) {
  updateUI.open = true;
  $('#updateModal').classList.add('open');
  $('#updateModal').setAttribute('aria-hidden', 'false');
  $('#updateScrim').classList.add('open');
  if (autoCheck) {
    // clearing the old status shows the live "checking" state
    updateUI.status = { ...(updateUI.status || {}), state: 'checking' };
  }
  renderUpdateDialog();
  if (autoCheck) checkUpdates();
}

function closeUpdateDialog() {
  updateUI.open = false;
  $('#updateModal').classList.remove('open');
  $('#updateModal').setAttribute('aria-hidden', 'true');
  $('#updateScrim').classList.remove('open');
}

async function checkUpdates() {
  if (!window.api.update) return;
  const r = await window.api.update.check();
  if (!r.ok) {
    updateUI.status = { state: 'error', error: r.error, current: state.settings.version };
    renderUpdateDialog();
    refreshUpdateBadge(updateUI.status);
    return;
  }
  updateUI.status = r.data;
  renderUpdateDialog();
  refreshUpdateBadge(updateUI.status);
  if (r.data?.state === 'idle' && r.data.checkedAt) toast(t('update.toastLatest', { version: r.data.current }), 'ok', 2400);
}

function showUpdatePart(which) {
  for (const id of ['umChecking', 'umUpToDate', 'umError', 'umAvailable', 'umDownloading', 'umReady']) {
    const el = $(`#${id}`);
    if (el) el.hidden = id !== which;
  }
}

function renderUpdateDialog() {
  const u = updateUI.status;
  const modal = $('#updateModal');
  const cur = u?.current || state.settings.version || state.env.version || '—';
  $('#updateCurrent').textContent = `v${cur}`;
  const latestEl = $('#updateLatest');
  const arrow = $('#updateArrow');
  const box = $('#updateAsset');
  const notes = $('#updateNotes');
  const foot = $('#updateFoot');
  modal.classList.toggle('available', u?.state === 'available');

  const showLatest = !!u?.info?.version && u.state !== 'checking';
  latestEl.hidden = !showLatest;
  arrow.hidden = !showLatest;
  if (showLatest) latestEl.textContent = `v${u.info.version}`;

  // foot buttons
  const btn = (id, label, cls = 'ghost-btn') => `<button class="${cls}" data-uact="${id}">${label}</button>`;
  if (!u || u.state === 'idle' || u.state === 'error') {
    $('#updateSub').textContent = u?.state === 'error' ? t('update.subtitleError') : t('update.subtitle');
    showUpdatePart(u?.state === 'error' ? 'umError' : u?.checkedAt ? 'umUpToDate' : 'umChecking');
    if (u?.state === 'error') $('#updateError').textContent = u.error || t('update.failed');
    foot.innerHTML = `<span class="spacer"></span>${btn('releases', t('update.btnReleases'))}${btn('check', t('update.btnRetry'), 'btn-primary small')}`;
    return;
  }
  if (u.state === 'checking') {
    $('#updateSub').textContent = t('update.subtitleChecking');
    showUpdatePart('umChecking');
    foot.innerHTML = `<span class="spacer"></span>${btn('close', t('update.btnCancelCheck'))}`;
    return;
  }
  if (u.state === 'available') {
    $('#updateSub').textContent = t('update.subtitleNew', { version: u.info.version, current: cur });
    showUpdatePart('umAvailable');
    const a = u.info.asset;
    const ext = a ? (a.name.match(/\.([a-z0-9]+)$/i) || [, 'EXE'])[1].toUpperCase() : 'EXE';
    box.innerHTML = a
      ? `<span class="um-asset-icon">${escapeHtml(ext)}</span>
         <div style="min-width:0">
           <div class="um-asset-name">${escapeHtml(a.name)}</div>
           <div class="um-asset-meta">${a.size ? fmtBytes(a.size) : t('update.unknownSize')}${t('update.engineHint')}</div>
         </div>`
      : `<div class="um-asset-name">${t('update.noAsset')}</div>`;
    notes.textContent = (u.info.body || t('update.noNotes')).slice(0, 4000);
    foot.innerHTML =
      `<span class="spacer"></span>${btn('releases', t('update.btnReleases'))}<button class="btn-primary small" data-uact="${a ? 'download' : 'releases'}">${
        a ? t('update.btnUpdate') : t('update.btnReleases')
      }</button>`;
    return;
  }
  if (u.state === 'downloading') {
    $('#updateSub').textContent = t('update.subtitleDownloading');
    showUpdatePart('umDownloading');
    updateDlProgress(u.progress || {});
    foot.innerHTML = `<span class="spacer"></span>${btn('cancel', t('update.btnCancel'))}`;
    return;
  }
  if (u.state === 'ready') {
    $('#updateSub').textContent = t('update.subtitleReady');
    showUpdatePart('umReady');
    $('#updateReadyName').textContent = u.installer?.name || t('update.dlName');
    foot.innerHTML =
      `<span class="spacer"></span>${btn('folder', t('update.btnFolder'))}<button class="btn-primary small" data-uact="install">${t('update.btnInstall')}</button>`;
    return;
  }
}

function updateDlProgress(p) {
  const total = p.total || 0;
  const got = p.received || 0;
  const pctv = total ? Math.min(100, (got / total) * 100) : 0;
  $('#updateDlName').textContent = p.name || t('update.dlName');
  $('#updateDlFill').style.width = `${pctv}%`;
  $('#updateDlPct').textContent = `${pctv.toFixed(1)}%`;
  $('#updateDlSize').textContent = total ? `${fmtBytes(got)} / ${fmtBytes(total)}` : fmtBytes(got);
  $('#updateDlSpeed').textContent = p.speed ? fmtSpeed(p.speed) : '—';
  $('#updateDlEta').textContent = p.eta > 0 ? t('update.dlRemaining', { time: fmtEta(p.eta) }) : '';
}

async function handleUpdateAction(act) {
  const api = window.api.update;
  if (!api) return;
  switch (act) {
    case 'check':
      await checkUpdates();
      break;
    case 'download': {
      updateUI.status = { ...(updateUI.status || {}), state: 'downloading', progress: {} };
      renderUpdateDialog();
      const r = await api.download();
      if (!r.ok) toast(r.error || t('update.toastFailed'), 'err', 5000);
      break;
    }
    case 'cancel':
      await api.cancel();
      break;
    case 'install': {
      const r = await api.install();
      if (!r.ok) toast(r.error || t('update.toastNoInstaller'), 'err', 4000);
      break;
    }
    case 'folder':
      await api.openInstallerFolder();
      break;
    case 'releases':
      await api.openReleases();
      break;
    case 'close':
      closeUpdateDialog();
      break;
    default:
      break;
  }
}

/**
 * Opens the system folder picker and stores the chosen folder.
 *
 * The IPC bridge always answers `{ ok, data }`, so the path lives in `data` —
 * treating the envelope as the path is what produced "[object Object]".
 */
async function pickDir() {
  const res = await window.api.chooseFolder();
  if (!res || !res.ok) {
    if (res && res.error) toast(res.error, 'err', 3200);
    return;
  }
  const dir = res.data;
  if (!dir || typeof dir !== 'string') return; // user cancelled the dialog
  const r = await window.api.setSettings({ downloadDir: dir });
  if (r && r.ok) {
    state.settings = mergeSettings(state.settings, r.data);
    renderDir();
    toast(t('toast.dirUpdated'), 'ok', 2200);
  } else {
    toast((r && r.error) || t('toast.settingsSaveFailed'), 'err', 3200);
  }
}

function mergeSettings(base, patch) {
  return { ...base, ...patch };
}

/* ---------------------------------------------------------------- */
/* completion feedback                                               */
/* ---------------------------------------------------------------- */

/** Plays a chime preview through the main process and animates the button. */
function playPreview(kind) {
  const btn = document.querySelector(`[data-preview="${kind}"]`);
  if (btn) {
    btn.classList.add('playing');
    setTimeout(() => btn.classList.remove('playing'), 900);
  }
  window.api.playSound(kind);
}

/* ---------------------------------------------------------------- */
/* language picker                                                   */
/* ---------------------------------------------------------------- */

const LANG_BADGE = { en: 'EN', 'zh-CN': '中', fr: 'FR', es: 'ES', ru: 'РУ', ar: 'AR' };

/** Renders the six UN languages as selectable cards. */
function renderLangGrid() {
  const grid = $('#langGrid');
  if (!grid) return;
  grid.innerHTML = I18N.LANGUAGES.map(
    (l) =>
      `<button type="button" class="lang-option ${l.code === currentLang ? 'active' : ''}" data-lang="${l.code}" title="${escapeAttr(l.native)}">
        <span class="lang-flag">${LANG_BADGE[l.code] || l.code.slice(0, 2).toUpperCase()}</span>
        <span class="lang-text">
          <span class="lang-native">${escapeHtml(l.native)}</span>
          <span class="lang-label">${escapeHtml(l.label)}</span>
        </span>
        <span class="lang-check">✓</span>
      </button>`
  ).join('');
}

/* ---------------------------------------------------------------- */
/* settings sync                                                     */
/* ---------------------------------------------------------------- */

function syncSettingsForm() {
  const s = state.settings;
  $('#setConnections').value = s.connections ?? 16;
  $('#setConcurrent').value = s.maxConcurrent ?? 3;
  $('#setMaxSpeed').value = String(s.maxSpeed ?? 0);
  $('#setOpenFolder').checked = !!s.openFolderWhenDone;
  $('#setProxyMode').value = s.proxyMode || 'system';
  $('#setProxyUrl').value = s.proxyUrl || '';
  $('#setAnimations').checked = s.animations !== false;
  $('#setGlass').checked = s.glass !== false;
  // completion feedback
  $('#setSoundDone').checked = s.soundOnDone !== false;
  $('#setSoundFail').checked = s.soundOnFail !== false;
  $('#setNotifyDone').checked = s.notifyOnDone !== false;
  const vol = Math.round((s.soundVolume ?? 0.8) * 100);
  $('#setSoundVolume').value = String(vol);
  $('#setSoundVolumeText').textContent = `${vol}%`;
  const custom = (s.proxyMode || 'system') === 'custom';
  $('#proxyUrlRow').classList.toggle('hidden', !custom);
  $('#proxyUrlWrap').classList.toggle('hidden', !custom);
  $$('.theme-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.theme === (s.theme || 'system')));
  renderLangGrid();
  $$('#accentSwatches .swatch').forEach((b) => b.classList.toggle('active', b.dataset.accent === (s.accent || 'aurora')));
  const auto = $('#setAutoUpdate');
  if (auto) auto.checked = s.autoCheckUpdate !== false;
  const cdn = $('#setUpdateCdn');
  if (cdn) cdn.checked = s.updateUseCdn !== false;
  const pre = $('#setUpdatePre');
  if (pre) pre.checked = !!s.updatePrerelease;
  renderRepoLinks();
  $$('#threadSeg button').forEach((b) => b.classList.toggle('active', Number(b.dataset.conn) === Number(s.connections)));
  $('#speedSelect').value = String(s.maxSpeed ?? 0);
  if (![...$('#speedSelect').options].some((o) => o.value === String(s.maxSpeed ?? 0))) {
    $('#speedSelect').value = '0';
  }
  renderDir();
}

async function updateSetting(patch) {
  const r = await window.api.setSettings(patch);
  if (r.ok) {
    state.settings = mergeSettings(state.settings, r.data);
    applyTheme(state.settings);
    syncSettingsForm();
  } else {
    toast(r.error || t('toast.settingsSaveFailed'), 'err');
  }
}

/* ---------------------------------------------------------------- */
/* logs                                                              */
/* ---------------------------------------------------------------- */

/**
 * Appends one line to the activity log.
 *
 * Lines are buffered while the panel is closed and only written to the DOM
 * when the user opens it, so a long download never pays for hundreds of hidden
 * elements (set display:none hides it, the panel toggles `.open`).
 */
const logBuffer = [];
let logDirty = false;

function makeLogElement(line) {
  const el = document.createElement('div');
  el.className = 'log-line';
  const low = line.m || '';
  if (/error|failed|interrupted/i.test(low)) el.classList.add('err');
  if (/completed|finished|完成/i.test(low)) el.classList.add('ok');
  const time = document.createElement('time');
  time.textContent = line.time || '';
  const msg = document.createElement('span');
  msg.textContent = low;
  el.append(time, msg);
  return el;
}

/** Writes buffered lines into the panel (called when it opens). */
function flushLogBuffer(autoScroll = true) {
  const body = $('#consoleBody');
  if (!body || !logDirty) return;
  logDirty = false;
  const frag = document.createDocumentFragment();
  for (const line of logBuffer) frag.appendChild(makeLogElement(line));
  const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  body.appendChild(frag);
  while (body.children.length > 400) body.firstElementChild.remove();
  if (autoScroll && stick) body.scrollTop = body.scrollHeight;
}

function appendLog(line, autoScroll = true) {
  logBuffer.push(line);
  if (logBuffer.length > 400) logBuffer.shift();
  const panel = $('#console');
  const body = $('#consoleBody');
  if (!panel || !body) return;
  if (!panel.classList.contains('open')) {
    // keep the DOM untouched while the panel is collapsed
    logDirty = true;
    return;
  }
  const el = makeLogElement(line);
  const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  body.appendChild(el);
  while (body.children.length > 400) body.firstElementChild.remove();
  if (autoScroll && stick) body.scrollTop = body.scrollHeight;
}

/* ---------------------------------------------------------------- */
/* wire up                                                           */
/* ---------------------------------------------------------------- */

/* Hook used by the UI screenshot test to show a canned update state. */
window.__showFakeUpdate = (state = 'available', fake = null) => {
  updateUI.status = fake || {
    state,
    current: state.settings.version || state.env.version || '1.0.0',
    repo: repoSlug(),
    checkedAt: Date.now(),
    info: {
      version: '1.4.0',
      tag: 'v1.4.0',
      htmlUrl: RELEASES_URL,
      body: '- 新增浅色 / 深色主题切换\n- 应用内更新支持 CDN 加速\n- 单线程回退更稳定',
      asset: { name: 'HyperFetch-1.4.0-x64-setup.exe', size: 82 * 1024 * 1024 },
    },
    installer: null,
    error: null,
    progress: null,
  };
  openUpdateDialog(false);
  return true;
};

async function boot() {
  // Show the downloads page and keep <body> in sync: the activity-log panel is
  // only allowed on the downloads page (see .console in styles.css).
  function showPage(page) {
    $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === page));
    document.body.classList.toggle('on-downloads', page === 'downloads');
    // the activity log lives on the downloads page: collapse it when leaving
    if (page !== 'downloads') $('#console').classList.remove('open');
  }
  window.__showPage = showPage;

  // ---- window controls
  $('#btnMin').addEventListener('click', () => window.api.window.minimize());
  $('#btnMax').addEventListener('click', () => window.api.window.toggleMaximize());
  $('#btnClose').addEventListener('click', () => window.api.window.close());

  // ---- tabs
  const tabs = $('#tabs');
  const glider = $('#tabGlider');
  const moveGlider = () => {
    const active = tabs.querySelector('.tab.active');
    if (!active) return;
    glider.style.width = `${active.offsetWidth}px`;
    glider.style.transform = `translateX(${active.offsetLeft - 4}px)`;
  };
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || tab.classList.contains('active')) return;
    $$('.tab', tabs).forEach((t) => t.classList.toggle('active', t === tab));
    moveGlider();
    showPage(tab.dataset.page);
  });
  requestAnimationFrame(() => setTimeout(moveGlider, 60));
  window.addEventListener('resize', moveGlider);

  // ---- language picker: switching applies instantly and is remembered
  $('#langGrid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-lang]');
    if (!btn) return;
    const code = btn.dataset.lang;
    if (code === currentLang) return;
    applyLanguage(code);
    await updateSetting({ language: code });
  });

  // ---- settings loading first
  const sr = await window.api.getSettings();
  if (sr.ok) {
    state.settings = sr.data;
    // pick the stored language, otherwise the OS language
    applyLanguage(state.settings.language || I18N.normalizeLocale(navigator.language));
    applyTheme(state.settings);
    syncSettingsForm();
    renderDir();
  } else {
    toast(sr.error || t('toast.settingsLoadFailed'), 'err', 4000);
  }
  const env = await window.api.getEnv();
  if (env.ok) {
    state.env = env.data;
    $('#aboutGrid').innerHTML = `
      <div class="about-item"><span>${t('about.version')}</span><b>HyperFetch v${escapeHtml(env.data.version)}</b></div>
      <div class="about-item"><span>${t('about.engine')}</span><b>Electron ${escapeHtml(env.data.chrome)}</b></div>
      <div class="about-item"><span>${t('about.platform')}</span><b>${escapeHtml(env.data.platform)} / ${escapeHtml(env.data.arch)}</b></div>
      <div class="about-item"><span>${t('about.config')}</span><b title="${escapeAttr(env.data.configFile)}">${escapeHtml(env.data.configFile)}</b></div>
    `;
  }

  // ---- list
  const lr = await window.api.listDownloads();
  if (lr.ok) {
    const { tasks, logs } = lr.data;
    for (const t of tasks) {
      // keep server-side order (newest first)
      state.tasks.set(t.id, t);
      state.order.push(t.id);
    }
    syncList(true);
    if (logs) for (const l of logs) appendLog(l, false);
  }
  requestAnimationFrame(() => {
    $('#consoleBody').scrollTop = $('#consoleBody').scrollHeight;
  });

  // ---- composer
  const urlInput = $('#urlInput');
  urlInput.addEventListener('input', () => scheduleProbe(urlInput.value));
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') urlInput.value = '';
  });
  $('#btnPaste').addEventListener('click', async () => {
    const r = await window.api.pasteFromClipboard();
    if (r.ok && r.data) {
      urlInput.value = r.data.trim();
      scheduleProbe(r.data);
      urlInput.focus();
    } else {
      toast(t('toast.clipboardEmpty'), 'err', 2000);
    }
  });
  $('#btnDir').addEventListener('click', pickDir);

  $$('#threadSeg button').forEach((b) =>
    b.addEventListener('click', () => updateSetting({ connections: Number(b.dataset.conn) }))
  );
  $('#speedSelect').addEventListener('change', (e) => updateSetting({ maxSpeed: Number(e.target.value) }));

  $('#addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) {
      urlInput.focus();
      urlInput.parentElement.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
        { duration: 300, easing: 'ease-in-out' }
      );
      toast(t('toast.noUrl'), 'err', 2200);
      return;
    }
    if (!/^https?:\/\//i.test(url) && !/^[\w.-]+\.\w{2,}(\/|$)/i.test(url)) {
      toast(t('toast.badUrl'), 'err', 3000);
      return;
    }
    const btn = $('#btnAdd');
    btn.disabled = true;
    btn.classList.add('loading');
    btn.querySelector('.btn-label').textContent = t('composer.adding');
    const r = await window.api.addDownload({
      url,
      dir: state.settings.downloadDir,
      name: '',
      connections: state.settings.connections,
      maxSpeed: state.settings.maxSpeed,
    });
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.querySelector('.btn-label').textContent = t('composer.start');
    if (!r.ok) {
      toast(r.error || t('toast.addFailed'), 'err', 3600);
      return;
    }
    urlInput.value = '';
    setProbe('idle');
    toast(t('toast.added'), 'ok', 2200);
    urlInput.focus();
  });

  // ---- toolbar
  $('#filterChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $$('#filterChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    state.filter = chip.dataset.filter;
    syncList(false);
  });
  $('#btnPauseAll').addEventListener('click', () => window.api.pauseAll().then(() => toast(t('toast.pausedAll'), 'info', 2200)));
  $('#btnResumeAll').addEventListener('click', () => window.api.resumeAll().then(() => toast(t('toast.resumedAll'), 'ok', 2200)));
  $('#btnClearDone').addEventListener('click', async () => {
    const r = await window.api.clearCompleted();
    if (!r.ok) return toast(r.error, 'err');
    toast(t('toast.clearedDone'), 'ok', 2200);
  });

  // ---- drawer
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerScrim').addEventListener('click', closeDrawer);

  // ---- console
  const con = $('#console');
  $('#consoleToggle').addEventListener('click', () => {
    const opening = !con.classList.contains('open');
    con.classList.toggle('open', opening);
    // buffered lines are only materialised when the panel becomes visible
    if (opening) requestAnimationFrame(() => flushLogBuffer(true));
  });

  // ---- settings page
  $$('.stepper').forEach((s) => {
    s.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const input = s.querySelector('input');
      const key = s.dataset.key;
      const min = Number(input.min || 1);
      const max = Number(input.max || 64);
      const v = Math.min(max, Math.max(min, Number(input.value || min) + Number(b.dataset.step)));
      input.value = v;
      updateSetting({ [key]: v });
    });
  });
  $$('.stepper input').forEach((inp) =>
    inp.addEventListener('change', () => {
      const key = inp.closest('.stepper').dataset.key;
      const min = Number(inp.min || 1);
      const max = Number(inp.max || 64);
      const v = Math.min(max, Math.max(min, Number(inp.value) || min));
      inp.value = v;
      updateSetting({ [key]: v });
    })
  );
  $('#setMaxSpeed').addEventListener('change', (e) => updateSetting({ maxSpeed: Number(e.target.value) }));
  $('#setOpenFolder').addEventListener('change', (e) => updateSetting({ openFolderWhenDone: e.target.checked }));
  $('#setAnimations').addEventListener('change', (e) => updateSetting({ animations: e.target.checked }));
  $('#setGlass').addEventListener('change', (e) => updateSetting({ glass: e.target.checked }));

  // ---- completion feedback: switches, volume and preview buttons
  $('#setSoundDone').addEventListener('change', (e) => updateSetting({ soundOnDone: e.target.checked }));
  $('#setSoundFail').addEventListener('change', (e) => updateSetting({ soundOnFail: e.target.checked }));
  $('#setNotifyDone').addEventListener('change', (e) => updateSetting({ notifyOnDone: e.target.checked }));

  let volumeSaveTimer = null;
  $('#setSoundVolume').addEventListener('input', (e) => {
    const pct = Number(e.target.value) || 80;
    $('#setSoundVolumeText').textContent = `${pct}%`;
    clearTimeout(volumeSaveTimer);
    volumeSaveTimer = setTimeout(() => updateSetting({ soundVolume: pct / 100 }), 300);
  });
  $('#setSoundVolume').addEventListener('change', async () => {
    clearTimeout(volumeSaveTimer);
    await updateSetting({ soundVolume: (Number($('#setSoundVolume').value) || 80) / 100 });
    playPreview('done');
  });

  $$('[data-preview]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.preview;
      if (kind === 'notify') {
        const r = await window.api.previewNotification();
        if (!r.ok) {
          toast(t('toast.notifyBlocked'), 'err', 3200);
          return;
        }
        toast(t('preview.notification'), 'ok', 2400);
        return;
      }
      playPreview(kind === 'fail' ? 'fail' : 'done');
    })
  );
  $('#setProxyMode').addEventListener('change', (e) => {
    updateSetting({ proxyMode: e.target.value });
    const custom = e.target.value === 'custom';
    $('#proxyUrlRow').classList.toggle('hidden', !custom);
    $('#proxyUrlWrap').classList.toggle('hidden', !custom);
  });
  let proxyTimer = null;
  $('#setProxyUrl').addEventListener('input', (e) => {
    clearTimeout(proxyTimer);
    proxyTimer = setTimeout(() => updateSetting({ proxyUrl: e.target.value.trim() }), 700);
  });
  $$('.theme-toggle button').forEach((b) => b.addEventListener('click', () => updateSetting({ theme: b.dataset.theme })));
  $$('#accentSwatches .swatch').forEach((b) => b.addEventListener('click', () => updateSetting({ accent: b.dataset.accent })));
  $('#btnSetDir').addEventListener('click', pickDir);
  $('#btnOpenDir').addEventListener('click', () => window.api.openPath(state.settings.downloadDir));

  // ---- updates & open-source links
  $('#btnCheckUpdate').addEventListener('click', () => {
    openUpdateDialog(true);
  });
  $('#setAutoUpdate').addEventListener('change', (e) => updateSetting({ autoCheckUpdate: e.target.checked }));
  $('#setUpdateCdn').addEventListener('change', (e) => updateSetting({ updateUseCdn: e.target.checked }));
  $('#setUpdatePre').addEventListener('change', (e) => updateSetting({ updatePrerelease: e.target.checked }));
  $('#btnOpenRepo').addEventListener('click', () => window.api.openUrl(REPO_URL));
  $('#btnOpenLicense').addEventListener('click', () => window.api.openUrl(LICENSE_URL));
  $('#btnOpenReleases').addEventListener('click', () => window.api.openUrl(RELEASES_URL));
  $('#updateClose').addEventListener('click', closeUpdateDialog);

  // ---- rename dialog
  $('#renameClose').addEventListener('click', closeRenameDialog);
  $('#renameCancel').addEventListener('click', closeRenameDialog);
  $('#renameScrim').addEventListener('click', closeRenameDialog);
  $('#renameSave').addEventListener('click', submitRename);
  $('#renameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitRename();
    }
  });

  // ---- rename dialog
  $('#renameClose').addEventListener('click', closeRenameDialog);
  $('#renameCancel').addEventListener('click', closeRenameDialog);
  $('#renameScrim').addEventListener('click', closeRenameDialog);
  $('#renameSave').addEventListener('click', submitRename);
  $('#renameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitRename();
    }
  });
  $('#updateScrim').addEventListener('click', closeUpdateDialog);
  $('#updateFoot').addEventListener('click', (e) => {
    const b = e.target.closest('[data-uact]');
    if (b) handleUpdateAction(b.dataset.uact);
  });
  $('#btnResetSettings').addEventListener('click', async () => {
    const r = await window.api.resetSettings();
    if (r.ok) {
      state.settings = mergeSettings(state.settings, r.data);
      applyTheme(state.settings);
      syncSettingsForm();
      toast(t('toast.settingsReset'), 'ok', 2200);
    }
  });

  // ---- keyboard
  window.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      if ($('#renameModal').classList.contains('open')) closeRenameDialog();
      else if ($('#updateModal').classList.contains('open')) closeUpdateDialog();
      else if (state.drawerId) closeDrawer();
      else if (document.activeElement === urlInput) urlInput.blur();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !typing) {
      e.preventDefault();
      $('#btnPaste').click();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      urlInput.focus();
      urlInput.select();
    }
  });
}

/* ---------------------------------------------------------------- */
/* events from main                                                  */
/* ---------------------------------------------------------------- */

window.api.onDownloadUpdate((data) => {
  const prev = state.tasks.get(data.id);
  if (!prev) {
    // a task we have never seen (e.g. added from another window/restore)
    upsertTask(data);
    return;
  }
  const wasDone = prev.state === 'completed';
  const merged = { ...prev, ...data };
  state.tasks.set(data.id, merged);
  // aggregate numbers (top bar) always go through the frame notifier too
  pendingUpdates.set(data.id, data);
  scheduleFrame();
  if (!wasDone && merged.state === 'completed') {
    const el = cardEls.get(data.id);
    if (el) {
      el.animate(
        [
          { boxShadow: '0 0 0 0 rgba(52,211,153,0.6)' },
          { boxShadow: '0 0 0 6px rgba(52,211,153,0)' },
        ],
        { duration: 1100, easing: 'ease-out' }
      );
    }
  }
});

window.api.onDownloadDone((task) => {
  if (task?.id) {
    upsertTask({ ...(state.tasks.get(task.id) || {}), ...task });
    if (state.drawerId === task.id) renderDrawer();
  }
});

window.api.onDownloadFailed((task) => {
  if (task?.id) {
    upsertTask({ ...(state.tasks.get(task.id) || {}), ...task });
    if (state.drawerId === task.id) renderDrawer();
  }
});

window.api.onDownloadRemoved((id) => removeTask(id));

window.api.onLog((line) => appendLog(line));

window.api.onSettingsChanged((s) => {
  state.settings = mergeSettings(state.settings, s);
  applyTheme(state.settings);
  syncSettingsForm();
});

window.api.onWindowState((s) => {
  state.maximized = s.maximized;
  $('#btnMax').title = s.maximized ? t('win.restore') : t('win.maximize');
});

/* ---- updates ---- */
if (window.api.update) {
  window.api.update.onState((s) => {
    const prev = updateUI.status;
    updateUI.status = s;
    refreshUpdateBadge(s);
    if (updateUI.open) renderUpdateDialog();
    const wasAvailable = prev?.state === 'available';
    if (s.state === 'available' && !wasAvailable && s.info) {
      if (!updateUI.open) {
        openUpdateDialog(false);
        toast(t('update.toastAvailable', { version: s.info.version }), 'ok', 5000);
      }
    }
    if (s.state === 'ready') toast(t('update.toastReady'), 'ok', 5000);
    if (s.state === 'error' && updateUI.open) toast(s.error || t('update.toastFailed'), 'err', 5000);
  });
  window.api.update.onProgress((p) => {
    updateUI.status = { ...(updateUI.status || {}), state: 'downloading', progress: p };
    if (updateUI.open) updateDlProgress(p);
  });
  window.api.update.onReady((inst) => {
    updateUI.status = { ...(updateUI.status || {}), state: 'ready', installer: inst };
    refreshUpdateBadge(updateUI.status);
    if (updateUI.open) renderUpdateDialog();
  });
  window.api.update.status().then((r) => {
    if (r.ok) {
      updateUI.status = r.data.state === 'idle' && !r.data.checkedAt ? null : r.data;
      refreshUpdateBadge(r.data);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch((e) => {
    console.error(e);
    toast(t('toast.initFailed', { error: e.message }), 'err', 6000);
  });
});
