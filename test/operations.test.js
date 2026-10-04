import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as ops from '../lib/operations.js';
import { TEST_PASSWORD, TEST_USER, makeConfig, memoryCapabilities, rejection } from './helpers.js';
import { startFakeWebdav } from './fake-webdav.js';

let server;
let config;
let workdir;

before(async () => {
  server = await startFakeWebdav({ user: TEST_USER, password: TEST_PASSWORD, profile: 'standard' });
  config = makeConfig(server);
  workdir = await mkdtemp(path.join(tmpdir(), 'dsh-webdav-ops-'));
});

after(async () => {
  await server.close();
  await rm(workdir, { recursive: true, force: true });
});

/* ------------------------------------------------------ 多远程解析（纯逻辑） */

test('resolveRemotes：多远程各自取自己的凭据，默认远程可指定', () => {
  const multi = {
    remotes: [
      { id: 'pan', label: '123云盘', preset: '123pan', url: 'https://a/webdav' },
      { id: 'nas', label: '家里 NAS', preset: 'fnos', url: 'http://192.168.1.9:5005/' },
    ],
    default: 'nas',
    credentials: { pan: { user: 'u1', password: 'p1' }, nas: { user: 'u2', password: 'p2' } },
    prefs: {},
  };
  const resolved = ops.resolveRemotes(multi, {});
  assert.equal(resolved.defaultId, 'nas');
  assert.equal(resolved.remotes.length, 2);
  const nas = resolved.remotes.find((remote) => remote.id === 'nas');
  assert.equal(nas.user, 'u2');
  assert.equal(nas.sources.user, 'credentials');
  assert.equal(ops.pickRemote(multi, undefined, {}).id, 'nas', '省略 remote 时用默认');
  assert.equal(ops.pickRemote(multi, 'pan', {}).id, 'pan');
});

test('resolveRemotes：环境变量只作用于被点名（或默认）的那个网盘，不串台', () => {
  const multi = {
    remotes: [
      { id: 'pan', label: 'A', preset: '123pan', url: 'https://a/webdav' },
      { id: 'nas', label: 'B', preset: 'fnos', url: 'http://nas:5005/' },
    ],
    default: 'pan',
    credentials: {},
    prefs: {},
  };
  const env = { WEBDAV_USER: 'env-user', WEBDAV_PASSWORD: 'env-pass' };

  // 没点名 → 只落给默认远程
  const byDefault = ops.resolveRemotes(multi, env);
  assert.equal(byDefault.remotes.find((r) => r.id === 'pan').user, 'env-user');
  assert.equal(byDefault.remotes.find((r) => r.id === 'nas').user, '');

  // 点名 nas → 环境变量改给 nas，默认的 pan 不受影响
  const byName = ops.resolveRemotes(multi, { ...env, WEBDAV_REMOTE: 'nas' });
  assert.equal(byName.remotes.find((r) => r.id === 'pan').user, '');
  assert.equal(byName.remotes.find((r) => r.id === 'nas').user, 'env-user');
});

test('resolveRemotes：一个网盘都没配时，用环境变量合成隐式远程（兼容老用法）', () => {
  const resolved = ops.resolveRemotes({ remotes: [], default: '', credentials: {}, prefs: {} }, {
    WEBDAV_URL: 'https://dav.jianguoyun.com/dav/',
    WEBDAV_USER: 'me@example.com',
    WEBDAV_PASSWORD: 'app-pass',
  });
  assert.equal(resolved.remotes.length, 1);
  assert.equal(resolved.remotes[0].preset, 'jianguoyun');
  assert.equal(resolved.remotes[0].url, 'https://dav.jianguoyun.com/dav/');
});

test('pickRemote：完全没有远程 / id 写错 / 缺凭据 都给出可操作提示', () => {
  const empty = { remotes: [], default: '', credentials: {}, prefs: {} };
  assert.throws(() => ops.pickRemote(empty, undefined, {}), /还没有配置任何 WebDAV 远程/);

  const multi = {
    remotes: [
      { id: 'pan', label: '123云盘', preset: '123pan', url: 'https://a/webdav' },
      { id: 'nas', label: 'NAS', preset: 'fnos', url: 'http://nas:5005/' },
    ],
    default: 'pan',
    credentials: {},
    prefs: {},
  };
  assert.throws(() => ops.pickRemote(multi, 'typo', {}), /没有名为 typo 的远程[\s\S]*pan、nas/);
  assert.throws(() => ops.pickRemote(multi, 'pan', {}), /缺少账号和密码/);
});

/* ------------------------------------------------------------ 真服务端往返 */

test('check 连通性自检（含服务端能力回显）', async () => {
  const result = await ops.check(config);
  assert.equal(result.ok, true);
  assert.equal(result.status, 207);
  assert.equal(result.remote, 'test');
  assert.equal(result.user, '138****00');
  assert.ok(result.dav !== undefined);
});

test('mkdir / ls / stat 的基本语义', async () => {
  await ops.mkdir(config, { path: '/学习' });
  await ops.mkdir(config, { path: '/学习/2026' });

  const listing = await ops.list(config, { path: '/学习' });
  assert.equal(listing.path, '/学习');
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.isDir]),
    [['2026', true]],
  );

  const st = await ops.stat(config, { path: '/学习/2026' });
  assert.equal(st.exists, true);
  assert.equal(st.entry.isDir, true);

  const missing = await ops.stat(config, { path: '/不存在的东西' });
  assert.equal(missing.exists, false);
  assert.equal(missing.status, 404);
});

test('mkdir 父目录缺失时把 409 翻译成可读错误', async () => {
  const error = await rejection(ops.mkdir(config, { path: '/a/b/c' }));
  assert.equal(error.status, 409);
  assert.match(error.hint ?? '', /父目录不存在/);
});

test('put 能一次上传到多级都不存在的目录（自愈建目录），get 能取回内容', async () => {
  const local = path.join(workdir, '报表 2026.xlsx');
  await writeFile(local, Buffer.from('hello webdav'));

  const uploaded = await ops.upload(config, { local, remoteDir: 'dsh/自动创建/再深一层' });
  assert.equal(uploaded.remotePath, '/dsh/自动创建/再深一层/报表 2026.xlsx');
  assert.equal(uploaded.bytes, 12);
  assert.equal(server.read('/dsh/自动创建/再深一层/报表 2026.xlsx'), 'hello webdav');

  const target = path.join(workdir, 'copy.xlsx');
  const downloaded = await ops.download(config, { path: '/dsh/自动创建/再深一层/报表 2026.xlsx', local: target });
  assert.equal(downloaded.bytes, 12);
  assert.equal(await readFile(target, 'utf8'), 'hello webdav');
});

test('readText 截断到 maxBytes', async () => {
  server.seed('/notes.md', 'x'.repeat(5000));
  const result = await ops.readText(config, { path: '/notes.md', maxBytes: 100 });
  assert.equal(result.bytes, 100);
  assert.equal(result.content.length, 100);
  assert.equal(result.truncated, true);

  const whole = await ops.readText(config, { path: '/notes.md' });
  assert.equal(whole.truncated, false);
  assert.equal(whole.bytes, 5000);
});

test('move 移动/重命名', async () => {
  server.seed('/dsh/old.txt', 'data');
  const result = await ops.move(config, { from: '/dsh/old.txt', to: '/dsh/new.txt' });
  assert.equal(result.via, 'move');
  assert.equal(server.read('/dsh/new.txt'), 'data');
  assert.equal(server.read('/dsh/old.txt'), null);
});

test('rm 对文件直接删除；对目录强制 recursive 确认', async () => {
  server.seed('/dsh/tmp.txt', 'x');
  const removed = await ops.remove(config, { path: '/dsh/tmp.txt' });
  assert.equal(removed.removed, true);
  assert.equal(removed.wasDir, false);

  server.seed('/dsh/tree/a.txt', 'a');
  server.seed('/dsh/tree/sub/b.txt', 'b');
  await assert.rejects(() => ops.remove(config, { path: '/dsh/tree' }), /递归删除[\s\S]*recursive=true/);
  assert.equal(server.read('/dsh/tree/sub/b.txt'), 'b', '未确认时不能真的删掉');

  const ok = await ops.remove(config, { path: '/dsh/tree', recursive: true });
  assert.equal(ok.removed, true);
  assert.equal(ok.wasDir, true);
  assert.equal(server.read('/dsh/tree/sub/b.txt'), null);
});

test('rm 删除根目录被拒绝', async () => {
  await assert.rejects(() => ops.remove(config, { path: '/' }), /拒绝删除根目录/);
});

test('download/read 对目录报错', async () => {
  await ops.mkdir(config, { path: '/dsh/dir' });
  await assert.rejects(() => ops.download(config, { path: '/dsh/dir', local: path.join(workdir, 'x') }), /是目录/);
  await assert.rejects(() => ops.readText(config, { path: '/dsh/dir' }), /是目录/);
});

test('url 打印直连地址', async () => {
  const result = await ops.url(config, { path: '/dsh/报表 2026.xlsx' });
  assert.equal(result.url, `${server.url}/dsh/%E6%8A%A5%E8%A1%A8%202026.xlsx`);
});

test('错误的凭据得到 401 和可读提示', async () => {
  const bad = makeConfig(server, { password: 'wrong' });
  const error = await rejection(ops.check(bad));
  assert.equal(error.status, 401);
  assert.match(error.hint ?? '', /应用密码/);
});

test('credentialStatus / remotes 都不回显密码', async () => {
  const status = ops.credentialStatus(config);
  assert.equal(status.ok, true);
  assert.equal(status.remotes[0].user, '138****00');
  assert.ok(!JSON.stringify(status).includes(TEST_PASSWORD));

  const listed = await ops.remotes(config);
  assert.equal(listed.default, 'test');
  assert.equal(listed.remotes[0].hasPassword, true);
  assert.ok(!JSON.stringify(listed).includes(TEST_PASSWORD));
});

test('上传大文件会给警告（措辞不绑定服务商）', async () => {
  const local = path.join(workdir, 'big.bin');
  await writeFile(local, Buffer.alloc(2048));
  const small = makeConfig(server, { prefs: { bigFileWarnBytes: 1024 } });
  const result = await ops.upload(small, { local, remoteDir: '/dsh' });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /WebDAV 没有秒传/);
});

test('上传缺 local / 下载缺 path 都是可读的 400', async () => {
  const noLocal = await rejection(ops.upload(config, {}));
  assert.equal(noLocal.status, 400);
  assert.match(noLocal.message, /需要 local/);

  const noPath = await rejection(ops.download(config, { local: path.join(workdir, 'x') }));
  assert.equal(noPath.status, 400);
  assert.match(noPath.message, /需要 path/);
});

/* ------------------------------------------------- 能力缓存与 123 的自愈路径 */

test('能力缓存会被回写：撞名 MOVE 之后记下「这个服务端不认 Overwrite」', async () => {
  const cloud = await startFakeWebdav({ user: TEST_USER, password: TEST_PASSWORD, profile: '123pan' });
  try {
    const capabilities = memoryCapabilities();
    const cloudConfig = makeConfig(cloud, { capabilities });
    cloud.seed('/src.txt', 'AAA');
    cloud.seed('/dst.txt', 'BBB');

    const result = await ops.move(cloudConfig, { from: '/src.txt', to: '/dst.txt' });
    assert.equal(result.replaced, true, '撞名必须自愈成「先删目标再移动」');
    assert.equal(cloud.read('/dst.txt'), 'AAA');
    assert.equal(cloud.read('/src.txt'), null);
    assert.equal(capabilities.memo.test.caps.moveOverwrite, false, '学到的能力要落盘给下次用');
  } finally {
    await cloud.close();
  }
});

test('源不存在时移动必须失败，且目标原样保留（123 用 500 表示源不存在）', async () => {
  const cloud = await startFakeWebdav({ user: TEST_USER, password: TEST_PASSWORD, profile: '123pan' });
  try {
    const cloudConfig = makeConfig(cloud);
    cloud.seed('/dst.txt', 'BBB-必须保住');
    const error = await rejection(ops.move(cloudConfig, { from: '/幽灵.txt', to: '/dst.txt' }));
    assert.equal(error.status, 404);
    assert.match(error.hint ?? '', /不存在/);
    assert.equal(cloud.read('/dst.txt'), 'BBB-必须保住', '不许因为移动失败就把目标删了');
  } finally {
    await cloud.close();
  }
});

test('目标目录不存在时移动给出「先建目录」的提示（123 用 500 表示这种情况）', async () => {
  const cloud = await startFakeWebdav({ user: TEST_USER, password: TEST_PASSWORD, profile: '123pan' });
  try {
    const error = await rejection(ops.move(makeConfig(cloud), { from: '/src.txt', to: '/没有这个目录/x.txt' }));
    assert.ok(error.status >= 400);
    assert.match(String(error.hint ?? error.message), /不存在|先建目录/);
  } finally {
    await cloud.close();
  }
});
