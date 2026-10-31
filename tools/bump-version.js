'use strict';

/**
 * bump-version.js — HyperFetch version scheme.
 *
 *   YY.MM.DD<n>   e.g. 26.10.311
 *     YY       two-digit year
 *     MM       month (01-12)
 *     DD       day (01-31)
 *     n        n-th release of that day (1, 2, 3 …)
 *
 * `node tools/bump-version.js` bumps the counter for today and writes it into
 * package.json (the running app reads app.getVersion() from there).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');

function todayParts(now = new Date()) {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return { yymmdd: `${yy}.${mm}.${dd}`, prefix: `${yy}.${mm}.${dd}` };
}

/** Parses 26.10.311 -> { prefix:'26.10.31', n:1 } */
function parseVersion(v) {
  const m = /^(\d{2}\.\d{2}\.\d{2})(\d{1,2})$/.exec(String(v || '').trim());
  if (m) return { prefix: m[1], n: Number(m[2]) };
  return null;
}

module.exports = { todayParts, parseVersion };

if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const { prefix } = todayParts();
  const current = parseVersion(pkg.version);
  const n = current && current.prefix === prefix ? current.n + 1 : 1;
  const next = `${prefix}${n}`;
  pkg.version = next;
  fs.writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`${pkg.version === next ? 'version' : 'version'} = ${next}`);
}
