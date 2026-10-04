import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { registerApi, ROUTE_PREFIX } from '../lib/api.js';
import { WebdavRuntime } from '../lib/runtime.js';
import { startFakeWebdav } from './fake-webdav.js';

let dav;
let web;
let base;
let token;
let routeHandler;
let runtime;
let dir;
let paths;

/** 页面里的 token 由 host 注入（48 位十六进制），从返回的 HTML 里抓出来。 */
function extractToken(html) {
  const match = /([0-9a-f]{48})/.exec(html);
  assert.ok(match, '页面必须内嵌 48 位十六进制的 token');
  return match[1];
}

before(async () => {
  dav = await startFakeWebdav({ user: 'u', password: 'p', profile: 'standard' });
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-webdav-api-'));
  paths = {
    configFile: path.join(dir, 'config.json'),
    credentialsFile: path.join(dir, 'credentials.json'),
    capabilitiesFile: path.join(dir, 'capabilities.json'),
  };
  writeFileSync(
    paths.configFile,
    JSON.stringify(
      {
        version: 1,
        default: 'main',
        prefs: {},
        remotes: [
          { id: 'main', label: '主网盘', preset: 'custom', url: dav.url, defaultUploadDir: 'dsh' },
          { id: 'other', label: '备用网盘', preset: 'custom', url: dav.url, defaultUploadDir: '' },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(paths.credentialsFile, JSON.stringify({ version: 1, remotes: { main: { user: 'u', password: 'p' }, other: { user: 'u', password: 'p' } } }, null, 2));

  const webServer = {
    register(route) {
      routeHandler = route.handler;
      return () => {
        routeHandler = null;
      };
    },
  };
  runtime = new WebdavRuntime({}, paths);
  registerApi(webServer, runtime);
  web = http.createServer((req, res) => routeHandler(req, res));
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${web.address().port}`;

  token = extractToken(await (await fetch(`${base}${ROUTE_PREFIX}`)).text());
});

after(async () => {
  // keep-alive 连接不清掉会让 node --test 在 Node 20 上挂住
  web.closeAllConnections?.();
  web.closeIdleConnections?.();
  await new Promise((resolve) => web.close(resolve));
  await dav.close();
  rmSync(dir, { recursive: true, force: true });
});

const api = (suffix, options = {}) =>
  fetch(`${base}${ROUTE_PREFIX}/api/${suffix}`, {
    ...options,
    headers: { 'X-Webdav-Token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });

/* ------------------------------------------------------------------ 页面 */

test('GET /webdav 返回内嵌 token 的页面', async () => {
  const res = await fetch(`${base}${ROUTE_PREFIX}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(!html.includes('__WEBDAV_TOKEN__'), 'token 占位符必须被替换');
  assert.ok(html.includes(token), '页面要带上真 token');
  assert.match(html, /网盘/, '文案应该通用化成「网盘」');
});

test('GET /webdav?view=settings 与浏览器视图同源（设置视图在前端切换）', async () => {
  const res = await fetch(`${base}${ROUTE_PREFIX}?view=settings`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes('__WEBDAV_TOKEN__'));
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('非 /webdav 前缀与未知接口都是 404', async () => {
  assert.equal((await fetch(`${base}${ROUTE_PREFIX}/api/nope`, { headers: { 'X-Webdav-Token': token } })).status, 404);
  assert.equal((await fetch(`${base}/other`)).status, 404);
  assert.equal((await fetch(`${base}/pan123`)).status, 404, '旧路由不再挂着');
});

test('/api/* 必须带 token', async () => {
  const res = await fetch(`${base}${ROUTE_PREFIX}/api/list?path=/`);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error.message, /token 无效/);
});

/* ------------------------------------------------------------------ 配置 */

test('GET /api/config 给出多网盘清单、预设表与配置文件位置，且不含密码', async () => {
  const payload = await (await api('config')).json();
  assert.equal(payload.default, 'main');
  assert.deepEqual(payload.remotes.map((remote) => remote.id), ['main', 'other']);
  assert.equal(payload.remotes[0].label, '主网盘');
  assert.equal(payload.remotes[0].isDefault, true);
  assert.equal(payload.remotes[1].isDefault, false);
  assert.equal(payload.remotes[0].hasPassword, true);
  assert.ok(payload.remotes[0].url.includes('127.0.0.1'));
  assert.equal(payload.remotes[0].defaultUploadDir, 'dsh');
  assert.ok(Array.isArray(payload.presets) && payload.presets.length >= 15, '预设表要一起下发');
  assert.ok(payload.presets.some((preset) => preset.id === 'fnos'));
  assert.ok(payload.paths.configFile.endsWith('config.json'));
  assert.ok(!JSON.stringify(payload).includes('"p"'), '密码不得出现在任何响应里');
});

test('POST /api/config 能新增网盘：凭据进 credentials.json，元数据进 config.json', async () => {
  const saved = await (
    await api('config', {
      method: 'POST',
      body: JSON.stringify({
        remote: { label: '家里的飞牛', preset: 'fnos', url: 'http://192.168.1.9:5005/', user: 'feiniu', password: 'secret-pass', defaultUploadDir: 'docs' },
      }),
    })
  ).json();
  const added = saved.remotes.find((remote) => remote.label === '家里的飞牛');
  assert.ok(added, '新网盘必须出现在清单里');
  assert.equal(added.preset, 'fnos');
  assert.equal(added.hasPassword, true);
  assert.equal(added.defaultUploadDir, 'docs');
  assert.equal(added.isDefault, false, '新增不该抢走默认');

  const storedConfig = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  const storedCredentials = JSON.parse(readFileSync(paths.credentialsFile, 'utf8'));
  assert.ok(!JSON.stringify(storedConfig).includes('secret-pass'), '密码不能写进 config.json');
  assert.equal(storedCredentials.remotes[added.id].password, 'secret-pass');
});

test('POST /api/config 能改、能设默认、能删', async () => {
  const before = await (await api('config')).json();
  const added = before.remotes.find((remote) => remote.label === '家里的飞牛');

  const renamed = await (
    await api('config', { method: 'POST', body: JSON.stringify({ remote: { id: added.id, label: '改过名的盘' } }) })
  ).json();
  assert.equal(renamed.remotes.find((remote) => remote.id === added.id).label, '改过名的盘');
  assert.equal(renamed.remotes.find((remote) => remote.id === added.id).hasPassword, true, '不传 password 不该清掉已有密码');

  const selected = await (await api('config', { method: 'POST', body: JSON.stringify({ select: added.id }) })).json();
  assert.equal(selected.default, added.id);
  assert.equal(selected.remotes.find((remote) => remote.id === added.id).isDefault, true);
  assert.equal(selected.remotes.find((remote) => remote.id === 'main').isDefault, false);

  const removed = await (await api('config', { method: 'POST', body: JSON.stringify({ remove: added.id }) })).json();
  assert.equal(removed.remotes.some((remote) => remote.id === added.id), false);
  assert.equal(removed.default, 'main', '删掉默认网盘后要回落到另一个');
  assert.equal(JSON.parse(readFileSync(paths.credentialsFile, 'utf8')).remotes[added.id], undefined, '凭据要一起删');

  await api('config', { method: 'POST', body: JSON.stringify({ select: 'main' }) });
});

test('POST /api/config 保存全局偏好并立即生效', async () => {
  const saved = await (await api('config', { method: 'POST', body: JSON.stringify({ prefs: { maxListEntries: 42, timeoutMs: 30000 } }) })).json();
  assert.equal(saved.prefs.maxListEntries, 42);
  assert.equal(saved.prefs.timeoutMs, 30000);
  assert.equal(runtime.config.prefs.maxListEntries, 42, '运行期配置要立刻反映出来');
});

test('POST /api/test 用临时凭据测连通性，不落盘', async () => {
  const ok = await (await api('test', { method: 'POST', body: JSON.stringify({ remote: 'main', url: dav.url, user: 'u', password: 'p' }) })).json();
  assert.equal(ok.check.ok, true);
  assert.equal(ok.check.status, 207);

  const bad = await (await api('test', { method: 'POST', body: JSON.stringify({ remote: 'main', url: dav.url, user: 'u', password: 'wrong' }) })).json();
  assert.equal(bad.check.ok, false);
  assert.match(bad.check.message ?? '', /401/);
});

test('GET /api/status 返回凭据来源与连通性', async () => {
  const payload = await (await api('status')).json();
  assert.equal(payload.check.ok, true);
  assert.equal(payload.credentials.default, 'main');
  assert.equal(payload.credentials.remotes[0].user, '*', '一字符账号打码后仍是 *');
});

/* -------------------------------------------------------------- 多网盘选择 */

test('所有内容接口都认 remote 参数，省略时用默认网盘', async () => {
  dav.seed('/only-here.txt', 'x');
  const byDefault = await (await api('list?path=/')).json();
  assert.equal(byDefault.remote, 'main');
  const byName = await (await api('list?path=/&remote=other')).json();
  assert.equal(byName.remote, 'other');
});

test('remote 写错时报错要列出可用网盘', async () => {
  const res = await api('list?path=/&remote=typo');
  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.match(payload.error.message, /没有名为 typo 的远程/);
  assert.match(payload.error.message, /main/);
});

/* ------------------------------------------------------------ 文件操作往返 */

test('mkdir / list / stat 走同源 API', async () => {
  const created = await api('mkdir', { method: 'POST', body: JSON.stringify({ path: '/学习' }) });
  assert.equal(created.status, 200);

  const listing = await (await api(`list?path=${encodeURIComponent('/')}`)).json();
  const entry = listing.entries.find((item) => item.name === '学习');
  assert.ok(entry, '新建的目录要出现在列表里');
  assert.equal(entry.isDir, true);

  const st = await (await api(`stat?path=${encodeURIComponent('/学习')}`)).json();
  assert.equal(st.exists, true);
  assert.equal(st.entry.isDir, true);
});

test('upload 把请求体直接流式 PUT 到远端，并自动补建目录', async () => {
  const body = 'hello from the browser 你好';
  const res = await api(`upload?dir=${encodeURIComponent('/学习/新建/更深')}&name=${encodeURIComponent('a b.txt')}`, {
    method: 'PUT',
    body,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).remotePath, '/学习/新建/更深/a b.txt');
  assert.equal(dav.read('/学习/新建/更深/a b.txt'), body, '父目录不存在也要能传上去');
});

test('upload 拒绝带路径分隔符的文件名', async () => {
  const res = await api(`upload?dir=/&name=${encodeURIComponent('../evil.txt')}`, { method: 'PUT', body: 'x' });
  assert.equal(res.status, 400);
});

test('download 返回文件字节与 Content-Disposition', async () => {
  const res = await fetch(`${base}${ROUTE_PREFIX}/api/download?token=${token}&path=${encodeURIComponent('/学习/新建/更深/a b.txt')}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello from the browser 你好');
  const disposition = res.headers.get('content-disposition');
  assert.match(disposition, /attachment/);
  assert.match(disposition, /filename\*=UTF-8''/);
});

test('content 返回文本正文', async () => {
  const payload = await (await api(`content?path=${encodeURIComponent('/学习/新建/更深/a b.txt')}`)).json();
  assert.equal(payload.content, 'hello from the browser 你好');
  assert.equal(payload.truncated, false);
});

test('delete 对目录要求 recursive，带 recursive 才真的删', async () => {
  const refused = await api('delete', { method: 'POST', body: JSON.stringify({ path: '/学习' }) });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error.message, /递归删除/);

  const ok = await api('delete', { method: 'POST', body: JSON.stringify({ path: '/学习', recursive: true }) });
  assert.equal(ok.status, 200);
  assert.equal(dav.read('/学习/新建/更深/a b.txt'), null);
});

test('move 重命名与撞名覆盖都走同一接口', async () => {
  dav.seed('/dsh/old.txt', 'data');
  const res = await api('move', { method: 'POST', body: JSON.stringify({ from: '/dsh/old.txt', to: '/dsh/new.txt' }) });
  assert.equal(res.status, 200);
  assert.equal(dav.read('/dsh/new.txt'), 'data');

  dav.seed('/dsh/a.txt', 'AAA');
  dav.seed('/dsh/b.txt', 'BBB');
  const collide = await api('move', { method: 'POST', body: JSON.stringify({ from: '/dsh/a.txt', to: '/dsh/b.txt' }) });
  assert.equal(collide.status, 200);
  assert.equal(dav.read('/dsh/b.txt'), 'AAA', '撞名要覆盖而不是报错');
});

test('WebDAV 404 原样透出状态码与提示', async () => {
  const st = await api(`stat?path=${encodeURIComponent('/没有这个')}`);
  assert.equal(st.status, 200);
  assert.equal((await st.json()).exists, false);

  const download = await fetch(`${base}${ROUTE_PREFIX}/api/download?token=${token}&path=${encodeURIComponent('/没有这个')}`);
  assert.equal(download.status, 404);
  assert.equal((await download.json()).error.status, 404);
});

test('非法 JSON 请求体返回 400', async () => {
  const res = await api('mkdir', { method: 'POST', body: '{oops' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /不是合法 JSON/);
});

test('配置没有默认网盘（全新用户）时报错可读', async () => {
  const freshDir = mkdtempSync(path.join(tmpdir(), 'dsh-webdav-api-fresh-'));
  const freshPaths = {
    configFile: path.join(freshDir, 'config.json'),
    credentialsFile: path.join(freshDir, 'credentials.json'),
    capabilitiesFile: path.join(freshDir, 'capabilities.json'),
    // 关掉老配置迁移，才能真的模拟「全新用户」
    legacyEnvFile: null,
    legacySettingsFile: null,
  };
  let freshHandler;
  const freshRuntime = new WebdavRuntime({ env: {} }, freshPaths);
  registerApi({ register: (route) => {
    freshHandler = route.handler;
    return () => {};
  } }, freshRuntime);
  const freshWeb = http.createServer((req, res) => freshHandler(req, res));
  await new Promise((resolve) => freshWeb.listen(0, '127.0.0.1', resolve));
  const freshBase = `http://127.0.0.1:${freshWeb.address().port}`;
  try {
    const freshToken = extractToken(await (await fetch(`${freshBase}${ROUTE_PREFIX}`)).text());
    const res = await fetch(`${freshBase}${ROUTE_PREFIX}/api/list?path=/`, { headers: { 'X-Webdav-Token': freshToken } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /还没有配置任何 WebDAV 远程/);
    // 页面本身仍然可用，用户能进设置页
    assert.equal((await fetch(`${freshBase}${ROUTE_PREFIX}?view=settings`)).status, 200);
  } finally {
    freshWeb.closeAllConnections?.();
    freshWeb.closeIdleConnections?.();
    await new Promise((resolve) => freshWeb.close(resolve));
    rmSync(freshDir, { recursive: true, force: true });
  }
});
