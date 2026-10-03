import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { registerApi } from '../lib/api.js';
import { normalizeConfig } from '../lib/operations.js';
import { Pan123Runtime } from '../lib/runtime.js';
import { startFakeWebdav } from './fake-webdav.js';

let dav;
let web;
let base;
let token;
let routeHandler;
let runtime;
let dir;

before(async () => {
  dav = await startFakeWebdav({ user: 'u', password: 'p' });
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-pan123-api-'));
  const webServer = {
    register(route) {
      routeHandler = route.handler;
      return () => {
        routeHandler = null;
      };
    },
  };
  const credentialsFile = path.join(dir, 'webdav.env');
  // 传原始 config（不预先 normalize），否则偏好键已被默认值填满、设置页改动无法生效
  runtime = new Pan123Runtime({ url: dav.url, user: 'u', password: 'p', envFile: credentialsFile }, {
    settingsFile: path.join(dir, 'settings.json'),
    credentialsFile,
  });
  registerApi(webServer, runtime);
  web = http.createServer((req, res) => routeHandler(req, res));
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${web.address().port}`;

  const html = await (await fetch(`${base}/pan123`)).text();
  const match = /const TOKEN = '([0-9a-f]{16,})'/.exec(html);
  assert.ok(match, '页面必须内嵌 token');
  token = match[1];
});

after(async () => {
  // 同上：keep-alive 连接不清掉会让 node --test 在 Node 20 上挂住
  web.closeAllConnections?.();
  web.closeIdleConnections?.();
  await new Promise((resolve) => web.close(resolve));
  await dav.close();
  rmSync(dir, { recursive: true, force: true });
});

const api = (path, options = {}) =>
  fetch(`${base}/pan123/api/${path}`, {
    ...options,
    headers: { 'X-Pan123-Token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });

test('GET /pan123 返回内嵌 token 的页面', async () => {
  const res = await fetch(`${base}/pan123`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(!html.includes('__PAN123_TOKEN__'), 'token 占位符必须被替换');
  assert.match(html, /123云盘/);
});

test('GET /pan123?view=settings 是同一条路由下的设置页', async () => {
  const res = await fetch(`${base}/pan123?view=settings`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /id="settings-view"/);
  assert.match(html, /测试连接/);
  assert.match(html, /id="s-password"/);
});

test('GET/POST /api/config 读写设置且不回显密码', async () => {
  const before = await (await api('config')).json();
  assert.equal(before.config.url, dav.url);
  assert.equal(before.stored.hasPassword, false);
  assert.ok(before.stored.credentialsFile.includes('dsh-pan123-api-'));

  const saved = await (
    await api('config', {
      method: 'POST',
      body: JSON.stringify({
        url: dav.url,
        user: 'u',
        password: 'p',
        defaultUploadDir: 'dsh',
        maxListEntries: 42,
      }),
    })
  ).json();
  assert.equal(saved.stored.hasPassword, true);
  assert.equal(saved.config.defaultUploadDir, 'dsh');
  assert.equal(saved.stored.password, undefined, 'stored 不得出现密码键');
  assert.ok(['config', 'settings', 'env', 'file'].includes(saved.sources.password), 'sources.password 只应是层级名');

  const detail = await (await api('config')).json();
  assert.equal(detail.config.maxListEntries, 42);
});

test('POST /api/test 用临时凭据测试连通性', async () => {
  const ok = await (await api('test', { method: 'POST', body: JSON.stringify({ url: dav.url, user: 'u', password: 'p' }) })).json();
  assert.equal(ok.check.ok, true);
  assert.equal(ok.check.status, 207);

  const bad = await (
    await api('test', { method: 'POST', body: JSON.stringify({ url: dav.url, user: 'u', password: 'wrong' }) })
  ).json();
  assert.equal(bad.check.ok, false);
  assert.match(bad.check.message ?? '', /401/);
});

test('未知路径与非 /pan123 前缀返回 404', async () => {
  assert.equal((await fetch(`${base}/pan123/api/nope`, { headers: { 'X-Pan123-Token': token } })).status, 404);
  assert.equal((await fetch(`${base}/other`)).status, 404);
});

test('/api/* 必须带 token', async () => {
  const res = await fetch(`${base}/pan123/api/list?path=/`);
  assert.equal(res.status, 403);
  const payload = await res.json();
  assert.match(payload.error.message, /token 无效/);
});

test('status 返回凭据来源与连通性', async () => {
  const payload = await (await api('status')).json();
  assert.equal(payload.check.ok, true);
  assert.equal(payload.check.status, 207);
  assert.equal(payload.credentials.user, '*');
});

test('mkdir / list / stat 走同源 API', async () => {
  const created = await api('mkdir', { method: 'POST', body: JSON.stringify({ path: '/学习' }) });
  assert.equal(created.status, 200);

  const listing = await (await api('list?path=' + encodeURIComponent('/'))).json();
  assert.deepEqual(listing.entries.map((e) => [e.name, e.isDir]), [['学习', true]]);

  const st = await (await api('stat?path=' + encodeURIComponent('/学习'))).json();
  assert.equal(st.exists, true);
  assert.equal(st.entry.isDir, true);
});

test('upload 把请求体直接流式 PUT 到网盘', async () => {
  const body = 'hello from the browser 你好';
  const res = await api(`upload?dir=${encodeURIComponent('/学习')}&name=${encodeURIComponent('a b.txt')}`, {
    method: 'PUT',
    body,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).remote, '/学习/a b.txt');
  assert.equal(dav.read('/学习/a b.txt'), body);
});

test('upload 拒绝带路径分隔符的文件名', async () => {
  const res = await api(`upload?dir=/&name=${encodeURIComponent('../evil.txt')}`, { method: 'PUT', body: 'x' });
  assert.equal(res.status, 400);
});

test('download 返回文件字节与 Content-Disposition', async () => {
  const res = await fetch(`${base}/pan123/api/download?token=${token}&path=${encodeURIComponent('/学习/a b.txt')}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello from the browser 你好');
  const disposition = res.headers.get('content-disposition');
  assert.match(disposition, /attachment/);
  assert.match(disposition, /filename\*=UTF-8''/);
});

test('content 返回文本正文', async () => {
  const payload = await (await api('content?path=' + encodeURIComponent('/学习/a b.txt'))).json();
  assert.equal(payload.content, 'hello from the browser 你好');
  assert.equal(payload.truncated, false);
});

test('delete 对目录要求 recursive，带 recursive 才真的删', async () => {
  const refused = await api('delete', { method: 'POST', body: JSON.stringify({ path: '/学习' }) });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error.message, /递归删除/);

  const ok = await api('delete', { method: 'POST', body: JSON.stringify({ path: '/学习', recursive: true }) });
  assert.equal(ok.status, 200);
  assert.equal(dav.read('/学习/a b.txt'), null);
});

test('move 重命名', async () => {
  dav.seed('/dsh/old.txt', 'data');
  const res = await api('move', { method: 'POST', body: JSON.stringify({ from: '/dsh/old.txt', to: '/dsh/new.txt' }) });
  assert.equal(res.status, 200);
  assert.equal(dav.read('/dsh/new.txt'), 'data');
});

test('WebDAV 404 原样透出状态码与提示', async () => {
  const res = await api('stat?path=' + encodeURIComponent('/没有这个'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).exists, false);

  const download = await fetch(`${base}/pan123/api/download?token=${token}&path=${encodeURIComponent('/没有这个')}`);
  assert.equal(download.status, 404);
  const payload = await download.json();
  assert.equal(payload.error.status, 404);
});

test('非法 JSON 请求体返回 400', async () => {
  const res = await api('mkdir', { method: 'POST', body: '{oops' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /不是合法 JSON/);
});
