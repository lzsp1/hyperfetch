const u = require('../src/main/util');
const cases = [
  ["attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E4%BB%B6.zip", '测试文件.zip'],
  ['attachment; filename="a b.zip"', 'a b.zip'],
  ["attachment; filename*=UTF-8''abc%20def.txt", 'abc def.txt'],
  ["attachment; filename*0*=UTF-8''%E6%B5%8B; filename*1*=%E8%AF%95.zip", '测试.zip'],
  ["attachment; filename=plain.tar.gz", 'plain.tar.gz'],
];
let bad = 0;
for (const [h, want] of cases) {
  const got = u.filenameFromContentDisposition(h);
  const ok = got === want;
  if (!ok) bad++;
  console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(got), '<=', h);
}
// misc util checks
const checks = [
  ['sanitize', u.sanitizeFilename('a/b\\c:d?e*.zip'), 'c_d_e_.zip'],
  ['sanitize-reserved', u.sanitizeFilename('CON.txt'), '_CON.txt'],
  ['fromUrl', u.filenameFromUrl('https://x.com/a/%E4%B8%AD%E6%96%87.rar'), '中文.rar'],
  ['fromUrl2', u.filenameFromUrl('https://x.com/'), null],
  ['bytes', u.formatBytes(12 * 1024 * 1024 + 12345), '12.0 MB'],
];
for (const [name, got, want] of checks) {
  const ok = got === want;
  if (!ok) bad++;
  console.log(ok ? 'ok  ' : 'FAIL', name, JSON.stringify(got), 'want', JSON.stringify(want));
}
process.exit(bad ? 1 : 0);
