import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as ops from '../lib/operations.js';
import { Pan123Runtime } from '../lib/runtime.js';
import {
  readCredentialsFile,
  readSettings,
  writeCredentialsFile,
  writeSettings,
} from '../lib/settings-store.js';
import { resolveCredentials } from '../lib/webdav.js';
import { startFakeWebdav } from './fake-webdav.js';

let dir;
let dav;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-pan123-settings-'));
  dav = await startFakeWebdav({ user: '13800000000', password: 'app-pass' });
});

after(async () => {
  await dav.close();
  rmSync(dir, { recursive: true, force: true });
  for (const folder of tempDirs) rmSync(folder, { recursive: true, force: true });
});

const tempDirs = [];

/** 每个用例一份独立的临时目录，避免用例之间互相污染设置文件。 */
const paths = () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'dsh-pan123-s-'));
  tempDirs.push(folder);
  return {
    settingsFile: path.join(folder, 'settings.json'),
    credentialsFile: path.join(folder, 'webdav.env'),
  };
};

test('settings.json 只保留已知偏好键，并与旧值合并', () => {
  const { settingsFile } = paths();
  writeSettings({ defaultUploadDir: 'dsh', timeoutMs: 30000, 未知键: 1 }, settingsFile);
  assert.deepEqual(readSettings(settingsFile), { defaultUploadDir: 'dsh', timeoutMs: 30000 });

  writeSettings({ maxListEntries: 500 }, settingsFile);
  assert.deepEqual(readSettings(settingsFile), { defaultUploadDir: 'dsh', timeoutMs: 30000, maxListEntries: 500 });

  writeSettings({ defaultUploadDir: '' }, settingsFile);
  assert.equal(readSettings(settingsFile).defaultUploadDir, undefined, '空字符串表示清除');
});

test('凭据文件写入保留其它键，空字符串表示删除', () => {
  const { credentialsFile } = paths();
  writeFileSync(credentialsFile, 'WEBDAV_URL=https://x/dav\nWEBDAV_USER=u1\nWEBDAV_PASSWORD=p1\nCUSTOM=keep\n', 'utf8');
  writeCredentialsFile({ WEBDAV_PASSWORD: 'p2' }, credentialsFile);
  assert.deepEqual(readCredentialsFile(credentialsFile), {
    WEBDAV_URL: 'https://x/dav',
    WEBDAV_USER: 'u1',
    WEBDAV_PASSWORD: 'p2',
  });
  assert.match(readFileSync(credentialsFile, 'utf8'), /CUSTOM=keep/);

  writeCredentialsFile({ WEBDAV_PASSWORD: '' }, credentialsFile);
  assert.equal(readCredentialsFile(credentialsFile).WEBDAV_PASSWORD, undefined);
});

test('凭据优先级：config > 设置页保存值 > 环境变量 > 凭据文件', async () => {
  const { settingsFile, credentialsFile } = paths();
  const env = { WEBDAV_URL: 'https://env/dav', WEBDAV_USER: 'env-user', WEBDAV_PASSWORD: 'env-pass' };

  const runtime = new Pan123Runtime({ envFile: credentialsFile }, {
    settingsFile,
    credentialsFile,
  });

  // 只有凭据文件
  writeCredentialsFile({ WEBDAV_URL: 'https://file/dav', WEBDAV_USER: 'file-user', WEBDAV_PASSWORD: 'file-pass' }, credentialsFile);
  runtime.settings = {};
  runtime.recompute();
  let resolved = await resolveCredentials(runtime.config, env);
  assert.deepEqual(resolved.sources, { url: 'env', user: 'env', password: 'env' });
  assert.equal(resolved.url, 'https://env/dav', '环境变量优先于凭据文件');

  // 设置页保存的凭据写进 webdav.env；环境变量仍然更高（设置页会明确提示这一点）
  await runtime.save({ url: 'https://file/dav', user: 'file-user', password: 'file-pass' }, env);
  const described = await runtime.describe(env);
  assert.deepEqual(described.sources, { url: 'env', user: 'env', password: 'env' });
  assert.deepEqual(described.envOverrides.sort(), ['password', 'url', 'user']);

  // 没有环境变量时，设置页保存的值生效
  resolved = await resolveCredentials(runtime.config, {});
  assert.deepEqual(resolved.sources, { url: 'file', user: 'file', password: 'file' });
  assert.equal(resolved.url, 'https://file/dav');

  // 插件 config 盖过一切
  const withConfig = new Pan123Runtime(
    { url: 'https://config/dav', user: 'config-user', password: 'config-pass', envFile: credentialsFile },
    { settingsFile, credentialsFile },
  );
  resolved = await resolveCredentials(withConfig.config, env);
  assert.deepEqual(resolved.sources, { url: 'config', user: 'config', password: 'config' });
});

test('runtime.save 分流：凭据进 webdav.env，偏好进 settings.json，并立即生效', async () => {
  const { settingsFile, credentialsFile } = paths();
  const runtime = new Pan123Runtime({ envFile: credentialsFile }, { settingsFile, credentialsFile });

  const described = await runtime.save({
    url: dav.url,
    user: '13800000000',
    password: 'app-pass',
    defaultUploadDir: 'dsh',
    maxListEntries: 7,
    readMaxBytes: 1024,
    timeoutMs: 5000,
  });

  assert.deepEqual(readCredentialsFile(credentialsFile), {
    WEBDAV_URL: dav.url,
    WEBDAV_USER: '13800000000',
    WEBDAV_PASSWORD: 'app-pass',
  });
  assert.deepEqual(readSettings(settingsFile), {
    defaultUploadDir: 'dsh',
    maxListEntries: 7,
    readMaxBytes: 1024,
    timeoutMs: 5000,
  });

  // 密码只以"是否有"的形式出现，绝不回显原文
  assert.equal(described.stored.hasPassword, true);
  assert.ok(!JSON.stringify(described).includes('app-pass'));

  // 立即生效：同一个 runtime 的 config 已经用了新值
  assert.equal(runtime.config.defaultUploadDir, 'dsh');
  assert.equal(runtime.config.maxListEntries, 7);
  const status = await ops.check(runtime.config);
  assert.equal(status.ok, true);
  assert.equal(status.user, '138****00');
});

test('runtime.test 用临时凭据测试，不落盘，且能盖过插件 config', async () => {
  const { settingsFile, credentialsFile } = paths();
  const runtime = new Pan123Runtime(
    { url: 'http://127.0.0.1:1/webdav', user: 'config-user', password: 'config-pass', envFile: credentialsFile },
    { settingsFile, credentialsFile },
  );

  const ok = await runtime.test({ url: dav.url, user: '13800000000', password: 'app-pass' });
  assert.equal(ok.ok, true);
  assert.equal(ok.rootCount, 0);

  await assert.rejects(() => runtime.test({ url: dav.url, user: '13800000000', password: 'wrong' }), /HTTP 401/);

  // 临时测试不写入任何文件
  assert.deepEqual(readCredentialsFile(credentialsFile), {});
  assert.deepEqual(readSettings(settingsFile), {});
});

test('运行期改动对工具可见：defaultUploadDir 影响 pan123_put 的默认落点', async () => {
  const { settingsFile, credentialsFile } = paths();
  const runtime = new Pan123Runtime({ envFile: credentialsFile }, { settingsFile, credentialsFile });
  await runtime.save({ url: dav.url, user: '13800000000', password: 'app-pass' });

  const local = path.join(dir, 'report.txt');
  writeFileSync(local, 'hello');

  const withoutDefault = await ops.upload(runtime.config, { local });
  assert.equal(withoutDefault.remote, '/report.txt');

  await runtime.save({ defaultUploadDir: 'dsh' });
  const withDefault = await ops.upload(runtime.config, { local });
  assert.equal(withDefault.remote, '/dsh/report.txt');
});
