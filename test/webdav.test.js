import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WebdavClient,
  WebdavError,
  encodeRemotePath,
  explainStatus,
  hrefToRemotePath,
  humanSize,
  normalizeRemotePath,
  parseEnvText,
  parseMultiStatus,
  resolveCredentials,
} from '../lib/webdav.js';

test('parseEnvText 读 KEY=VALUE，忽略注释与引号', () => {
  const parsed = parseEnvText(
    ['# comment', 'WEBDAV_URL=https://webdav.123pan.cn/webdav', 'WEBDAV_USER="13800000000"', 'WEBDAV_PASSWORD=\'secret\'', '', 'BAD_LINE'].join(
      '\n',
    ),
  );
  assert.deepEqual(parsed, {
    WEBDAV_URL: 'https://webdav.123pan.cn/webdav',
    WEBDAV_USER: '13800000000',
    WEBDAV_PASSWORD: 'secret',
  });
});

test('resolveCredentials 优先级：config > env > 文件', async () => {
  const env = { WEBDAV_URL: 'https://env.example/dav', WEBDAV_USER: 'env-user', WEBDAV_PASSWORD: 'env-pass' };
  const fromEnv = await resolveCredentials({}, env);
  assert.equal(fromEnv.url, 'https://env.example/dav');
  assert.equal(fromEnv.user, 'env-user');
  assert.deepEqual(fromEnv.sources, { url: 'env', user: 'env', password: 'env' });

  const fromConfig = await resolveCredentials({ url: 'https://cfg.example/dav', user: 'cfg-user', password: 'cfg-pass' }, env);
  assert.equal(fromConfig.url, 'https://cfg.example/dav');
  assert.equal(fromConfig.user, 'cfg-user');
  assert.deepEqual(fromConfig.sources, { url: 'config', user: 'config', password: 'config' });
});

test('resolveCredentials 缺凭据时给出可操作的报错', async () => {
  await assert.rejects(
    () => resolveCredentials({ envFile: 'Z:/definitely/not/here.env' }, {}),
    /缺少 123云盘 WebDAV 凭据: user, password/,
  );
});

test('normalizeRemotePath 规范化并拒绝目录穿越', () => {
  assert.equal(normalizeRemotePath(''), '/');
  assert.equal(normalizeRemotePath('/'), '/');
  assert.equal(normalizeRemotePath('学习/2026/'), '/学习/2026');
  assert.equal(normalizeRemotePath('/dsh//a.txt'), '/dsh/a.txt');
  assert.equal(normalizeRemotePath('\\dsh\\a.txt'), '/dsh/a.txt');
  assert.throws(() => normalizeRemotePath('/dsh/../etc/passwd'), /非法远端路径/);
  assert.throws(() => normalizeRemotePath('/./x'), /非法远端路径/);
});

test('encodeRemotePath 逐段编码，中文不用手工处理', () => {
  assert.equal(encodeRemotePath('/'), '');
  assert.equal(encodeRemotePath('/学习/x y.pdf'), '%E5%AD%A6%E4%B9%A0/x%20y.pdf');
  assert.equal(encodeRemotePath('/a%2Fb'), 'a%252Fb');
});

test('hrefToRemotePath 去掉 WebDAV 基路径并解码', () => {
  assert.equal(hrefToRemotePath('/webdav/', '/webdav'), '/');
  assert.equal(hrefToRemotePath('/webdav/%E5%AD%A6%E4%B9%A0/', '/webdav'), '/学习');
  assert.equal(hrefToRemotePath('https://webdav.123pan.cn/webdav/dsh/a.txt', '/webdav'), '/dsh/a.txt');
  assert.equal(hrefToRemotePath('/dsh/a.txt', ''), '/dsh/a.txt');
  assert.equal(hrefToRemotePath('/webdav/dsh/a.txt', '/other'), '/webdav/dsh/a.txt');
});

test('parseMultiStatus 兼容 d: / D: / 无前缀，并跳过目录自身外的条目', () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/webdav/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <D:response>
    <D:href>/webdav/%E5%AD%A6%E4%B9%A0/</D:href>
    <D:propstat><D:prop>
      <D:displayname>学习</D:displayname>
      <D:resourcetype><D:collection/></D:resourcetype>
      <D:getlastmodified>Mon, 22 Sep 2025 10:00:00 GMT</D:getlastmodified>
    </D:prop></D:propstat>
  </D:response>
  <response>
    <href>/webdav/a&amp;b.txt</href>
    <propstat><prop>
      <resourcetype/>
      <getcontentlength>1234</getcontentlength>
      <getlastmodified>Tue, 23 Sep 2025 11:00:00 GMT</getlastmodified>
    </prop></propstat>
  </response>
</d:multistatus>`;

  const entries = parseMultiStatus(xml, '/webdav');
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => [e.path, e.isDir, e.size]),
    [
      ['/', true, null],
      ['/学习', true, null],
      ['/a&b.txt', false, 1234],
    ],
  );
  assert.equal(entries[2].name, 'a&b.txt');
  assert.equal(entries[1].name, '学习');
});

test('humanSize / explainStatus 输出稳定', () => {
  assert.equal(humanSize(null), '-');
  assert.equal(humanSize(0), '0B');
  assert.equal(humanSize(1536), '1.5KB');
  assert.equal(humanSize(200 * 1024 * 1024), '200.0MB');
  assert.match(explainStatus(409), /409/);
  assert.match(explainStatus(401), /应用密码/);
});

test('WebdavClient 拒绝非法 url 与非 file 上传', async () => {
  assert.throws(() => new WebdavClient({ url: 'not-a-url', user: 'u', password: 'p' }), /不是合法 URL/);
  const client = new WebdavClient({ url: 'https://example.com/webdav', user: 'u', password: 'p' });
  await assert.rejects(() => client.upload('Z:/nope/nope.bin', '/x.bin'), /本地文件不存在/);
  assert.equal(client.urlFor('/学习/x y.pdf'), 'https://example.com/webdav/%E5%AD%A6%E4%B9%A0/x%20y.pdf');
  await assert.rejects(() => client.remove('/'), /拒绝删除根目录/);
});

test('WebdavError 暴露状态码与 notFound', () => {
  const error = new WebdavError('PROPFIND', '/x', 404, '<html>nope</html>');
  assert.equal(error.notFound, true);
  assert.equal(error.status, 404);
  assert.match(error.message, /HTTP 404/);
});
