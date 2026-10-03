import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as ops from '../lib/operations.js';
import { startFakeWebdav } from './fake-webdav.js';

const USER = '13800000000';
const PASSWORD = 'app-password';

let server;
let config;
let workdir;

before(async () => {
  server = await startFakeWebdav({ user: USER, password: PASSWORD });
  config = ops.normalizeConfig({ url: server.url, user: USER, password: PASSWORD, defaultUploadDir: '' });
  workdir = await mkdtemp(path.join(tmpdir(), 'dsh-pan123-'));
});

after(async () => {
  await server.close();
  await rm(workdir, { recursive: true, force: true });
});

test('check 连通性自检', async () => {
  const result = await ops.check(config);
  assert.equal(result.ok, true);
  assert.equal(result.status, 207);
  assert.equal(result.rootCount, 0);
  assert.equal(result.user, '138****00');
});

test('mkdir / ls / stat 的基本语义', async () => {
  await ops.mkdir(config, { path: '/学习' });
  await ops.mkdir(config, { path: '/学习/2026' });

  const listing = await ops.list(config, { path: '/学习' });
  assert.equal(listing.path, '/学习');
  assert.deepEqual(
    listing.entries.map((e) => [e.name, e.isDir]),
    [['2026', true]],
  );

  const st = await ops.stat(config, { path: '/学习/2026' });
  assert.equal(st.exists, true);
  assert.equal(st.entry.isDir, true);

  const missing = await ops.stat(config, { path: '/不存在的东西' });
  assert.deepEqual(missing, { path: '/不存在的东西', exists: false, status: 404 });
});

test('mkdir 父目录缺失时把 409 翻译成可读错误', async () => {
  const error = await ops.mkdir(config, { path: '/a/b/c' }).then(
    () => null,
    (err) => err,
  );
  assert.ok(error, '应该报错');
  assert.equal(error.status, 409);
  assert.match(error.message, /HTTP 409/);
  assert.match(error.hint ?? '', /父目录不存在/);
});

test('put 会自动建缺失目录，get 能取回内容', async () => {
  const local = path.join(workdir, '报表 2026.xlsx');
  await writeFile(local, Buffer.from('hello 123pan'));

  const uploaded = await ops.upload(config, { local, remoteDir: 'dsh/自动创建' });
  assert.equal(uploaded.remote, '/dsh/自动创建/报表 2026.xlsx');
  assert.equal(uploaded.bytes, 12);
  assert.equal(server.read('/dsh/自动创建/报表 2026.xlsx'), 'hello 123pan');

  const target = path.join(workdir, 'copy.xlsx');
  const downloaded = await ops.download(config, { remote: '/dsh/自动创建/报表 2026.xlsx', local: target });
  assert.equal(downloaded.bytes, 12);
  assert.equal((await readFile(target, 'utf8')), 'hello 123pan');
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
  await ops.move(config, { from: '/dsh/old.txt', to: '/dsh/new.txt' });
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
  await assert.rejects(
    () => ops.remove(config, { path: '/dsh/tree' }),
    /递归删除[\s\S]*recursive=true/,
  );
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
  await assert.rejects(() => ops.download(config, { remote: '/dsh/dir', local: path.join(workdir, 'x') }), /是目录/);
  await assert.rejects(() => ops.readText(config, { path: '/dsh/dir' }), /是目录/);
});

test('URL 与直连地址', async () => {
  const result = await ops.url(config, { path: '/dsh/报表 2026.xlsx' });
  assert.equal(result.url, `${server.url}/dsh/%E6%8A%A5%E8%A1%A8%202026.xlsx`);
});

test('错误的凭据得到 401 和可读提示', async () => {
  const bad = ops.normalizeConfig({ url: server.url, user: USER, password: 'wrong' });
  const error = await ops.check(bad).then(
    () => null,
    (err) => err,
  );
  assert.ok(error);
  assert.equal(error.status, 401);
  assert.match(error.hint ?? '', /应用密码/);
});

test('credentialStatus 不回显密码', async () => {
  const status = await ops.credentialStatus(config);
  assert.equal(status.ok, true);
  assert.equal(status.user, '138****00');
  assert.ok(!JSON.stringify(status).includes(PASSWORD));
});

test('uploads 会给大文件警告', async () => {
  const local = path.join(workdir, 'big.bin');
  await writeFile(local, Buffer.alloc(2048));
  const small = ops.normalizeConfig({ ...config, bigFileWarnBytes: 1024 });
  const result = await ops.upload(small, { local, remoteDir: '/dsh' });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /WebDAV 搬大文件/);
});
