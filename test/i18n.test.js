'use strict';
/** i18n.test.js — every language must define every key, with placeholders intact. */
const assert = require('assert');
const { MESSAGES, LANGUAGES, normalizeLocale, createTranslator } = require('../src/shared/i18n');

const base = Object.keys(MESSAGES.en);
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name + '  (' + e.message + ')');
  }
}

check('六种联合国工作语言', () => {
  assert.deepStrictEqual(LANGUAGES.map((l) => l.code), ['en', 'zh-CN', 'fr', 'es', 'ru', 'ar']);
});

for (const { code } of LANGUAGES) {
  check(code + ' 词条完整', () => {
    const table = MESSAGES[code];
    const missing = base.filter((k) => !(k in table));
    assert.strictEqual(missing.length, 0, 'missing: ' + missing.slice(0, 5).join(', '));
  });
  check(code + ' 占位符一致', () => {
    const table = MESSAGES[code];
    for (const k of base) {
      const want = (MESSAGES.en[k].match(/\{(\w+)\}/g) || []).sort().join(',');
      const got = (table[k].match(/\{(\w+)\}/g) || []).sort().join(',');
      assert.strictEqual(got, want, `${k}: "${got}" != "${want}"`);
    }
  });
}

check('紧跟系统的语言识别', () => {
  assert.strictEqual(normalizeLocale('zh-CN'), 'zh-CN');
  assert.strictEqual(normalizeLocale('zh_CN'), 'zh-CN');
  assert.strictEqual(normalizeLocale('zh-Hans-CN'), 'zh-CN');
  assert.strictEqual(normalizeLocale('fr-FR'), 'fr');
  assert.strictEqual(normalizeLocale('es-419'), 'es');
  assert.strictEqual(normalizeLocale('ru-RU'), 'ru');
  assert.strictEqual(normalizeLocale('ar-SA'), 'ar');
  assert.strictEqual(normalizeLocale('en-GB'), 'en');
  assert.strictEqual(normalizeLocale('de-DE'), 'en');
  assert.strictEqual(normalizeLocale(''), 'en');
});

check('占位符替换与回退', () => {
  const t = createTranslator('ru');
  assert.ok(t('task.remaining', { time: '3 мин' }).includes('3'));
  const fallback = createTranslator('xx');
  assert.strictEqual(fallback.locale, 'en');
  assert.strictEqual(fallback('definitely.not.a.key'), 'definitely.not.a.key');
});

console.log(`\n${(failed === 0 ? 'all' : '')} ${failed === 0 ? 'i18n checks passed' : failed + ' failed'}`);
process.exit(failed ? 1 : 0);