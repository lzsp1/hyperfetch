'use strict';

/**
 * netfetch — a tiny fetch-alike on top of Electron's `net` module.
 * The app never uses a browser window for downloads or for the releases API.
 */

const { resolveResponse } = require('./util');

/**
 * @returns {Promise<{status:number, headers:object, text:string}>}
 */
async function netGetText(net, url, { timeout = 15000, signal, headers = {}, maxBytes = 4 * 1024 * 1024 } = {}) {
  const resp = await resolveResponse(
    { net },
    url,
    { method: 'GET', timeout, signal, headers: { Accept: 'application/vnd.github+json, */*', ...headers } }
  );
  const chunks = [];
  let size = 0;
  if (resp.iter) {
    for await (const chunk of resp.iter) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) break;
      chunks.push(buf);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return { status: resp.statusCode, headers: resp.headers, text, url: resp.finalUrl };
}

async function netGetJson(net, url, opts) {
  const r = await netGetText(net, url, opts);
  let json = null;
  try {
    json = JSON.parse(r.text);
  } catch {
    json = null;
  }
  return { ...r, json };
}

module.exports = { netGetText, netGetJson };
