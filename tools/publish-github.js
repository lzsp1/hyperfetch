'use strict';

/**
 * publish-github.js — one-shot GitHub publisher for HyperFetch.
 *
 * Creates the repository (if missing), pushes the source and opens a Release
 * whose assets are the NSIS installer (and optional portable build).
 *
 * Usage (token is read from the environment, never stored):
 *   set GH_TOKEN=ghp_xxx
 *   node tools/publish-github.js [--repo HyperFetch] [--version 1.1.0]
 *       [--notes "..." ] [--installer path\to\setup.exe] [--portable path\to\portable.exe]
 *       [--private]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const API_HOST = 'api.github.com';

/* ------------------------------------------------------------------ */
/* args                                                                */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REPO_NAME = opt('repo', 'HyperFetch');
const VERSION = opt('version', pkg.version).replace(/^v/, '');
const NOTES = opt('notes', '');
const PRIVATE = flag('private');
const INSTALLER = opt('installer', findInRelease(/setup\.exe$/i));
const PORTABLE = opt('portable', findInRelease(/portable\.exe$/i));

function findInRelease(re) {
  const dir = path.join(ROOT, 'release');
  try {
    const f = fs.readdirSync(dir).find((n) => re.test(n) && !fs.statSync(path.join(dir, n)).isDirectory());
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

function die(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}
function log(msg) {
  console.log(`• ${msg}`);
}
function ok(msg) {
  console.log(`✔ ${msg}`);
}

/* ------------------------------------------------------------------ */
/* http helpers                                                        */
/* ------------------------------------------------------------------ */

function request(method, urlPath, { body, headers = {}, host = API_HOST, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        host,
        path: urlPath,
        method,
        headers: {
          'User-Agent': 'HyperFetch-Publisher',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${TOKEN}`,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          if (raw) {
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
            return;
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Uploads to uploads.github.com; the redirect target is followed by hand. */
function uploadAsset(uploadUrl, filePath, name) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const u = new URL(uploadUrl.replace('{?name,label}', ''));
    u.searchParams.set('name', name);
    const req = https.request(
      {
        host: u.host,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'User-Agent': 'HyperFetch-Publisher',
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const loc = new URL(res.headers.location);
          const r2 = https.request(
            {
              host: loc.host,
              path: loc.pathname + loc.search,
              method: 'POST',
              headers: {
                'User-Agent': 'HyperFetch-Publisher',
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${TOKEN}`,
                'Content-Type': 'application/octet-stream',
                'Content-Length': size,
              },
            },
            (res2) => {
              const chunks = [];
              res2.on('data', (c) => chunks.push(c));
              res2.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res2.statusCode >= 200 && res2.statusCode < 300) resolve(JSON.parse(text));
                else reject(new Error(`upload failed ${res2.statusCode}: ${text.slice(0, 300)}`));
              });
            }
          );
          r2.on('error', reject);
          fs.createReadStream(filePath).pipe(r2);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(text));
          else reject(new Error(`upload failed ${res.statusCode}: ${text.slice(0, 300)}`));
        });
      }
    );
    req.on('error', reject);
    fs.createReadStream(filePath).pipe(req);
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  if (!TOKEN) die('缺少 GitHub 令牌：请先设置环境变量 GH_TOKEN（一次 Fine-grained/Classic token，需 repo 权限）');

  // 1. who am I
  const me = await request('GET', '/user');
  if (me.status !== 200) die(`令牌无效（HTTP ${me.status}）`);
  const OWNER = me.json.login;
  ok(`已登录 GitHub：${OWNER}`);
  const fullRepo = `${OWNER}/${REPO_NAME}`;

  // 2. make sure the repository exists
  let repo = await request('GET', `/repos/${fullRepo}`);
  if (repo.status === 404) {
    log(`创建仓库 ${fullRepo}（${PRIVATE ? '私有' : '公开'}）…`);
    const created = await request('POST', '/user/repos', {
      body: {
        name: REPO_NAME,
        description: pkg.description || 'HyperFetch — 多线程分段加速下载器',
        private: PRIVATE,
        has_issues: true,
        has_wiki: false,
        auto_init: false,
      },
    });
    if (created.status >= 300) die(`创建仓库失败：${created.text.slice(0, 300)}`);
    repo = created;
    ok(`仓库已创建：${repo.json.html_url}`);
  } else if (repo.status === 200) {
    ok(`仓库已存在：${repo.json.html_url}`);
  } else {
    die(`无法访问仓库：HTTP ${repo.status} ${(repo.text || '').slice(0, 200)}`);
  }
  const htmlUrl = repo.json.html_url;

  // 3. LICENSE through the dedicated endpoint (keeps GitHub's license badge)
  // A LICENSE may already exist (created from the web UI); updates need its sha.
  const existingLicense = await request('GET', `/repos/${fullRepo}/contents/LICENSE`);
  const licenseSha = existingLicense.status === 200 && existingLicense.json ? existingLicense.json.sha : null;

  const licenseBody = {
    message: licenseSha ? 'Update MIT License' : 'Add MIT License',
    content: Buffer.from(fs.readFileSync(path.join(ROOT, 'LICENSE'))).toString('base64'),
  };
  if (licenseSha) licenseBody.sha = licenseSha;
  const lic = await request('PUT', `/repos/${fullRepo}/contents/LICENSE`, { body: licenseBody });
  if (lic.status < 300) {
    ok(licenseSha ? 'LICENSE 已更新为 MIT 全文' : 'LICENSE 已提交');
  } else {
    die(`提交 LICENSE 失败：${(lic.text || '').slice(0, 300)}`);
  }

  // 4. push the source
  const remote = `https://x-access-token:${TOKEN}@github.com/${fullRepo}.git`;
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  try {
    // the remote command only works inside a repository
    if (!fs.existsSync(path.join(ROOT, '.git'))) {
      log('初始化本地 git 仓库…');
      git('init', '-b', 'main');
      git('config', 'user.name', 'HyperFetch');
      git('config', 'user.email', 'hyperfetch@users.noreply.github.com');
      fs.writeFileSync(
        path.join(ROOT, '.gitignore'),
        ['node_modules/', 'release/', 'exe/', '.tools/', '.uitest*/', 'screenshots/', '*.log', ''].join('\n'),
        'utf8'
      );
    }
    try {
      git('remote', 'get-url', 'origin');
      git('remote', 'set-url', 'origin', remote);
    } catch {
      git('remote', 'add', 'origin', remote);
    }
    git('add', '-A');
    try {
      git('commit', '-m', 'HyperFetch: 多线程下载器（MIT）');
    } catch {
      log('没有新的改动需要提交');
    }
    git('branch', '-M', 'main');
    log('正在推送源码到 GitHub…');
    git('push', '-u', 'origin', 'main', '--force');
    ok('源码已推送');
  } catch (e) {
    const stderr = (e.stderr || '').toString().replace(TOKEN, '***');
    die(`git 推送失败：${stderr.split('\n').slice(0, 4).join(' ')}`);
  }

  // 5. release with the installer(s)
  const tag = `v${VERSION}`;
  let release = await request('GET', `/repos/${fullRepo}/releases/tags/${tag}`);
  if (release.status === 200) {
    ok(`Release ${tag} 已存在，将补充资源`);
  } else {
    log(`创建 Release ${tag} …`);
    const r = await request('POST', `/repos/${fullRepo}/releases`, {
      body: {
        tag_name: tag,
        target_commitish: 'main',
        name: `HyperFetch ${tag}`,
        body:
          NOTES ||
          [
            `# HyperFetch ${tag}`,
            '',
            '- 多线程分段下载 / 断点续传 / 单线程自动回退',
            '- 深色 & 浅色主题',
            '- 应用内更新（GitHub Releases + 国内 CDN 加速，内置下载器直接下载安装包）',
            '',
            '## 安装',
            `下载 \`HyperFetch-${VERSION}-x64-setup.exe\` 运行安装程序即可（或使用免安装版 portable）。`,
          ].join('\n'),
        draft: false,
        prerelease: VERSION.includes('-'),
      },
    });
    if (r.status >= 300) die(`创建 Release 失败：${r.text.slice(0, 300)}`);
    release = r;
    ok(`Release 已创建：${release.json.html_url}`);
  }

  const assets = [INSTALLER, PORTABLE].filter(Boolean);
  if (!assets.length) {
    log('没有找到安装包，跳过上传（可先运行 build.cmd dist）');
  }
  for (const file of assets) {
    const name = path.basename(file);
    const size = fs.statSync(file).size;
    log(`上传 ${name}（${(size / 1024 / 1024).toFixed(1)} MB）…`);
    try {
      await uploadAsset(release.json.upload_url, file, name);
      ok(`${name} 已上传`);
    } catch (e) {
      if (/already_exists/.test(e.message)) ok(`${name} 已存在，跳过`);
      else die(e.message);
    }
  }

  // 6. summary
  console.log('\n==================== 完成 ====================');
  console.log(`仓库地址 : ${htmlUrl}`);
  console.log(`开源许可 : MIT  ${htmlUrl}/blob/main/LICENSE`);
  console.log(`发行页面 : ${htmlUrl}/releases/tag/${tag}`);
  console.log(`应用内更新仓库设置需要填写：${OWNER}/${REPO_NAME}`);
  console.log(`（应用内默认已写入：${fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8').match(/const GITHUB_USER = '([^']+)'/)?.[1]}/${REPO_NAME}）`);
  console.log('==============================================\n');
})().catch((e) => die(e.message));
