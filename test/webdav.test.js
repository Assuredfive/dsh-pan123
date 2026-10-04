import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROPFIND_BODY,
  UnsupportedError,
  WebdavClient,
  WebdavError,
  encodeRemotePath,
  explainStatus,
  hrefToRemotePath,
  humanSize,
  normalizeRemotePath,
  parseMultiStatus,
  pickProp,
} from '../lib/webdav.js';

/** 造一个可编排响应的 fetch 替身，用来测「服务端差异」而不必起真服务端。 */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body, headers: init?.headers ?? {} });
    // 请求体可能是文件读流：必须消费并等它真正关闭，否则 fd 还开着，
    // 测试结束时删临时目录会抛 ENOENT（表现为「测试结束后的异步活动」）。
    const requestBody = init?.body;
    if (requestBody && typeof requestBody.pipe === 'function') {
      await new Promise((resolve) => {
        requestBody.on('close', resolve);
        requestBody.on('error', resolve);
        requestBody.resume();
      });
    }
    const next = script.shift();
    if (!next) throw new Error(`fakeFetch: 第 ${calls.length} 次请求没有排期响应`);
    // 204/205/304 是「无正文状态」，Response 构造函数不接受给它们塞 body
    const body = [204, 205, 304].includes(next.status) ? null : next.body ?? '';
    return new Response(body, { status: next.status, headers: next.headers ?? {} });
  };
  return { impl, calls };
}

const MULTISTATUS_OK =
  '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
  '<D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype>' +
  '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
  '</D:multistatus>';

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
  // 服务端给的 href 不带基路径时不能误删
  assert.equal(hrefToRemotePath('/dav/dsh/a.txt', '/other'), '/dav/dsh/a.txt');
});

test('pickProp 只在 2xx 的 propstat 里取值——404 段的同名空元素不能顶掉真值', () => {
  // 复刻 123云盘：不支持的属性回一个 404 propstat，里面放同名空元素，而且排在使用值的那段**前面**
  const block =
    '<D:href>/webdav/a.txt</D:href>' +
    '<D:propstat><D:prop><D:getcontentlength></D:getcontentlength><D:getetag></D:getetag></D:prop>' +
    '<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>' +
    '<D:propstat><D:prop><D:getcontentlength>2048</D:getcontentlength></D:prop>' +
    '<D:status>HTTP/1.1 200 OK</D:status></D:propstat>';
  assert.equal(pickProp(block, 'getcontentlength'), '2048');
  // 只有 404 段有值时必须拿不到「真值」，返回空 → 上层转成 null，而不是把 0 当成大小
  const only404 =
    '<D:propstat><D:prop><D:getetag>x</D:getetag></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>';
  assert.equal(pickProp(only404, 'getetag'), 'x', '没有 2xx 段时退回原值，避免完全丢信息');
  assert.equal(pickProp(block, 'nonexistent'), null);
});

test('parseMultiStatus 兼容 d: / D: / 无前缀，并按 propstat 取真实大小', () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/webdav/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <D:response>
    <D:href>/webdav/%E5%AD%A6%E4%B9%A0/</D:href>
    <D:propstat><D:prop>
      <D:displayname>学习</D:displayname>
      <D:resourcetype><D:collection/></D:resourcetype>
      <D:getlastmodified>Mon, 22 Sep 2025 10:00:00 GMT</D:getlastmodified>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <response>
    <href>/webdav/a&amp;b.txt</href>
    <propstat><prop>
      <resourcetype/>
      <getcontentlength>1234</getcontentlength>
      <getlastmodified>Tue, 23 Sep 2025 11:00:00 GMT</getlastmodified>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
</d:multistatus>`;

  const entries = parseMultiStatus(xml, '/webdav');
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

test('parseMultiStatus：目录判定不依赖 href 结尾的斜杠', () => {
  // 有些服务端不给 resourcetype，也不给结尾斜杠——此时只认 collection 会误判成文件
  const withSlash = parseMultiStatus('<multistatus><response><href>/dav/sub/</href><propstat><prop/></propstat></response></multistatus>', '/dav');
  assert.equal(withSlash[0].isDir, true, '没有 resourcetype 时用结尾斜杠兜底');
  const noSlash = parseMultiStatus('<multistatus><response><href>/dav/sub</href><propstat><prop/></propstat></response></multistatus>', '/dav');
  assert.equal(noSlash[0].isDir, false, '两者都没有只能当文件，不猜');
});

test('humanSize / explainStatus 输出稳定且不绑定服务商', () => {
  assert.equal(humanSize(null), '-');
  assert.equal(humanSize(0), '0B');
  assert.equal(humanSize(1536), '1.5KB');
  assert.equal(humanSize(200 * 1024 * 1024), '200.0MB');
  assert.match(explainStatus(409), /409/);
  assert.match(explainStatus(401), /应用密码/);
  assert.match(explainStatus(500), /123云盘/, '500 要提醒「有的服务端拿它表示用户错误」');
  assert.match(explainStatus(429), /限流/);
});

test('WebdavClient 拒绝非法 url 与非 file 上传', async () => {
  assert.throws(() => new WebdavClient({ url: 'not-a-url', user: 'u', password: 'p' }), /不是合法 URL/);
  const client = new WebdavClient({ url: 'https://example.com/webdav', user: 'u', password: 'p' });
  await assert.rejects(() => client.upload('Z:/nope/nope.bin', '/x.bin'), /本地文件不存在/);
  assert.equal(client.urlFor('/学习/x y.pdf'), 'https://example.com/webdav/%E5%AD%A6%E4%B9%A0/x%20y.pdf');
  await assert.rejects(() => client.remove('/'), /拒绝删除根目录/);
  await assert.rejects(() => client.move('/x', '/'), /移动到根目录/);
});

test('PROPFIND 先带显式 prop body；服务端不吃就自动退回无 body 并记住', async () => {
  const script = [
    { status: 400, body: 'body not allowed' },
    { status: 207, body: MULTISTATUS_OK },
  ];
  const { impl, calls } = fakeFetch(script);
  const client = new WebdavClient({ url: 'http://nas.local:5005/dav', user: 'u', password: 'p', fetchImpl: impl });
  assert.equal(client.propfindMode, 'body');

  await client.list('/');
  assert.equal(calls.length, 2, '第一次带 body 被拒，应立即退回无 body 重试');
  assert.ok(calls[0].body, '第一次必须带显式 <prop> 请求体');
  assert.equal(calls[1].body, undefined, '第二次必须不带 body');
  assert.equal(client.propfindMode, 'nobody', '学到的选择要记住');
  assert.equal(client.caps.propfindMode, 'nobody', '并落到 caps 里给上层持久化');

  // 记住之后不再浪费一次请求
  calls.length = 0;
  script.push({ status: 207, body: MULTISTATUS_OK });
  await client.list('/');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, undefined);
});

test('PROPFIND 显式 body 的内容是我们要的那几个属性', () => {
  assert.match(PROPFIND_BODY, /<D:resourcetype\/>/);
  assert.match(PROPFIND_BODY, /<D:getcontentlength\/>/);
  assert.match(PROPFIND_BODY, /<D:propfind/);
});

test('200 但不是 multistatus（被反代到登录页）必须报错，不能当空目录', async () => {
  const { impl } = fakeFetch([{ status: 200, body: '<!DOCTYPE html><html><body>请登录</body></html>' }]);
  const client = new WebdavClient({ url: 'http://nas.local/dav', user: 'u', password: 'p', fetchImpl: impl });
  const error = await client.list('/').then(
    () => null,
    (err) => err,
  );
  assert.ok(error, '必须抛错');
  assert.equal(error.notWebdav, true);
  assert.match(error.hint, /不是 WebDAV 响应/);
});

test('stat 复用同一套 body 回退逻辑（minimal 服务端下也能查条目）', async () => {
  const statXml =
    '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/a.txt</D:href>' +
    '<D:propstat><D:prop><D:resourcetype/><D:getcontentlength>7</D:getcontentlength></D:prop>' +
    '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
  const { impl, calls } = fakeFetch([
    { status: 400, body: 'nope' },
    { status: 207, body: statXml },
  ]);
  const client = new WebdavClient({ url: 'http://minimal.local/dav', user: 'u', password: 'p', fetchImpl: impl });
  const entry = await client.stat('/a.txt');
  assert.equal(entry.size, 7);
  assert.equal(client.propfindMode, 'nobody');
  assert.equal(calls[0].headers.Depth, '0');
});

test('stat 对 404 返回 null（判断「是否存在」的可靠手段）', async () => {
  const { impl } = fakeFetch([{ status: 404, body: 'not found' }]);
  const client = new WebdavClient({ url: 'http://x.local/dav', user: 'u', password: 'p', fetchImpl: impl });
  assert.equal(await client.stat('/nope'), null);
});

test('MOVE 撞名：先确认源存在，再删目标重试，并标记 replaced', async () => {
  const destXml = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/dst.txt</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>1</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
  const { impl, calls } = fakeFetch([
    { status: 500, body: 'Internal Server Error' }, // MOVE（123风格：撞名 500）
    { status: 207, body: destXml }, // exists(src)
    { status: 207, body: destXml }, // exists(dst)
    { status: 204 }, // DELETE dst
    { status: 201 }, // MOVE 重试
  ]);
  const client = new WebdavClient({ url: 'http://123.local/webdav', user: 'u', password: 'p', fetchImpl: impl });
  const result = await client.move('/src.txt', '/dst.txt');
  assert.equal(result.replaced, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['MOVE', 'PROPFIND', 'PROPFIND', 'DELETE', 'MOVE'],
  );
  assert.equal(calls[0].headers.Overwrite, 'T');
});

test('MOVE 源不存在时绝不碰目标（防止「删了目标又没搬成」）', async () => {
  const { impl, calls } = fakeFetch([
    { status: 500, body: 'Internal Server Error' }, // MOVE 失败
    { status: 404, body: 'not found' }, // exists(src) -> 不存在
  ]);
  const client = new WebdavClient({ url: 'http://123.local/webdav', user: 'u', password: 'p', fetchImpl: impl });
  const error = await client.move('/ghost.txt', '/dst.txt').then(
    () => null,
    (err) => err,
  );
  assert.ok(error);
  assert.equal(error.status, 404);
  assert.match(error.hint, /未对目标做任何改动/);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['MOVE', 'PROPFIND'],
    '确认源不存在之后不许再发 DELETE',
  );
});

test('MOVE 不被支持时退到 COPY + DELETE', async () => {
  const existsXml = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/src.txt</D:href><D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
  const { impl, calls } = fakeFetch([
    { status: 405, body: 'method not allowed' }, // MOVE 不支持
    { status: 207, body: existsXml }, // exists(src)
    { status: 404, body: 'not found' }, // exists(dst) -> 目标不存在
    { status: 201 }, // COPY
    { status: 204 }, // DELETE src
  ]);
  const client = new WebdavClient({ url: 'http://minimal.local/dav', user: 'u', password: 'p', fetchImpl: impl });
  const result = await client.move('/src.txt', '/dst.txt');
  assert.equal(result.via, 'copy+delete');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['MOVE', 'PROPFIND', 'PROPFIND', 'COPY', 'DELETE'],
  );
});

test('MOVE 与 COPY 都不支持时抛 UnsupportedError 并给替代方案', async () => {
  const existsXml = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/src.txt</D:href><D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
  const { impl } = fakeFetch([
    { status: 501, body: 'not implemented' }, // MOVE
    { status: 207, body: existsXml }, // exists(src)
    { status: 404, body: 'not found' }, // exists(dst)
    { status: 501, body: 'not implemented' }, // COPY
  ]);
  const client = new WebdavClient({ url: 'http://minimal.local/dav', user: 'u', password: 'p', fetchImpl: impl });
  const error = await client.move('/src.txt', '/dst.txt').then(
    () => null,
    (err) => err,
  );
  assert.ok(error instanceof UnsupportedError);
  assert.match(error.hint, /下载到本机再上传/);
});

test('upload 遇到 409 会逐级建目录后重试（适配「PUT 不自动建目录」的服务端）', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'dsh-webdav-up-'));
  const local = nodePath.join(dir, 'x.txt');
  writeFileSync(local, 'hello');

  const emptyMultistatus = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>';
  const { impl, calls } = fakeFetch([
    { status: 409, body: 'conflict' }, // PUT 父目录不存在
    { status: 404, body: 'not found' }, // stat /a  -> 不存在
    { status: 201 }, // MKCOL /a
    { status: 404, body: 'not found' }, // stat /a/b -> 不存在
    { status: 201 }, // MKCOL /a/b
    { status: 201 }, // PUT 重试
  ]);
  const client = new WebdavClient({ url: 'http://std.local/dav', user: 'u', password: 'p', fetchImpl: impl });
  const result = await client.upload(local, '/a/b/x.txt');
  assert.deepEqual(result.createdDirs, ['/a', '/a/b']);
  assert.equal(client.caps.putAutoMkdir, false, '学到「这个服务端不会自动建目录」');
  assert.equal(calls.at(-1).method, 'PUT');
  rmSync(dir, { recursive: true, force: true });
});

test('被反代重定向到登录页时，download 必须报错，而不是把登录页写成本地文件', async () => {
  // 用真 http server 才能造出「跟随重定向后的 200」（Response.redirected 需要真的经过 redirect）
  const http = await import('node:http');
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/dav/')) {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>请先登录</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'dsh-webdav-redirect-'));
  const local = nodePath.join(dir, 'x.txt');
  try {
    const client = new WebdavClient({ url: `http://127.0.0.1:${server.address().port}/dav`, user: 'u', password: 'p' });
    const error = await client.download('/x.txt', local).then(
      () => null,
      (err) => err,
    );
    assert.ok(error, '必须报错');
    assert.equal(error.notWebdav, true);
    assert.match(error.hint, /不是 WebDAV 响应/);
    assert.equal(existsSync(local), false, '不该在本地留下半截登录页');
  } finally {
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WebdavError 暴露状态码；XML 错误页不进错误消息', () => {
  const error = new WebdavError('PROPFIND', '/x', 404, '<html>nope</html>');
  assert.equal(error.notFound, true);
  assert.equal(error.status, 404);
  assert.match(error.message, /HTTP 404/);
  assert.doesNotMatch(error.message, /html/, 'XML/HTML 错误页不该糊进错误消息');
});
