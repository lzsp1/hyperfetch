'use strict';

/**
 * i18n-main.js — main-process localization.
 *
 * The main process produces user-visible strings (download errors, update
 * messages). It reads the language from the live settings object and formats
 * messages with the shared translation tables.
 */

const { createTranslator, normalizeLocale } = require('../shared/i18n.js');

let settingsRef = null;
let translator = null;
let translatorCode = null;

/** Called once settings exist; the translator follows the current language. */
function bindSettings(settings) {
  settingsRef = settings;
}

function getLocale() {
  const stored = settingsRef && settingsRef.data.language;
  if (stored) return stored;
  // Electron reports the OS locale; both forms ("zh-CN", "zh_CN") are handled.
  try {
    const sys = require('electron').app.getLocale();
    return normalizeLocale(sys);
  } catch {
    return 'en';
  }
}

function t(key, vars) {
  const code = getLocale();
  if (!translator || translatorCode !== code) {
    translator = createTranslator(code);
    translatorCode = code;
  }
  return translator(key, vars);
}

/** Formats a byte count in the interface language. */
function formatBytesI18n(b) {
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return `${b} ${t('size.bytes')}`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

module.exports = { bindSettings, t, getLocale, formatBytesI18n, normalizeLocale };
