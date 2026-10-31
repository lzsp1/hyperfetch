'use strict';

/**
 * patch-app-builder.js — Windows-only build workaround.
 *
 * electron-builder's `app-builder` unpacks the winCodeSign archive with
 * `7za ... -snld`, which restores macOS dylib symlinks. A non-elevated Windows
 * account cannot create symlinks, so the unpack fails and the build aborts even
 * though every Windows binary is fine. Patching the flag to `-snl-` (do not
 * restore symlinks) makes the extraction succeed; the macOS files are never
 * used on Windows.
 *
 * The original binary is kept as `app-builder.exe.orig` and restored first, so
 * this script is idempotent and safe to run before every build.
 */

const fs = require('fs');
const path = require('path');

const BIN = path.join(__dirname, '..', 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe');
if (!fs.existsSync(BIN)) {
  console.log('[patch-app-builder] 未找到 app-builder.exe，跳过');
  process.exit(0);
}
const ORIG = `${BIN}.orig`;

if (process.platform !== 'win32') {
  console.log('[patch-app-builder] 非 Windows，跳过');
  process.exit(0);
}

if (!fs.existsSync(ORIG)) {
  // sanity check before touching an unknown binary
  const probe = fs.readFileSync(BIN);
  if (!probe.includes(Buffer.from('-snld'))) {
    console.log('[patch-app-builder] 该版本无需补丁，跳过');
    process.exit(0);
  }
  fs.copyFileSync(BIN, ORIG);
}

const buf = fs.readFileSync(ORIG);
const idx = buf.indexOf(Buffer.from('-snld'));
if (idx < 0) {
  console.log('[patch-app-builder] 找不到 -snld 标记，跳过');
  process.exit(0);
}
buf.write('-snl-', idx, 'ascii');
fs.writeFileSync(BIN, buf);
console.log('[patch-app-builder] 已修正解压参数（-snld → -snl-），打包可正常进行');
