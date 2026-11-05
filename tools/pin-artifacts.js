'use strict';
/**
 * pin-artifacts.js — electron-builder normalises the version as semver, which
 * strips the zero padding from 26.11.051. The artifact names are therefore
 * pinned explicitly so the released files keep the date-based version intact.
 */
const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const v = pkg.version;
pkg.build = pkg.build || {};
pkg.build.win = pkg.build.win || {};
pkg.build.nsis = pkg.build.nsis || {};
pkg.build.portable = pkg.build.portable || {};

pkg.build.nsis.artifactName = `HyperFetch-${v}-x64-setup.exe`;
pkg.build.portable.artifactName = `HyperFetch-${v}-portable.exe`;
pkg.build.win.artifactName = `HyperFetch-${v}-\${arch}-setup.\${ext}`;

fs.writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log('version:', v);
console.log('nsis:', pkg.build.nsis.artifactName);
console.log('portable:', pkg.build.portable.artifactName);
console.log('win:', pkg.build.win.artifactName);
