import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { findPreset, presetForUrl, PRESETS } from '../lib/presets.js';
import {
  CapabilityStore,
  makeRemoteId,
  migrateLegacy,
  normalizeRemote,
  parseEnvText,
  readCapabilities,
  readConfig,
  readCredentials,
  removeCredentials,
  writeConfig,
  writeCredentials,
} from '../lib/remotes.js';

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 每个用例一份独立临时目录，互不污染。 */
function paths() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-webdav-remotes-'));
  tempDirs.push(dir);
  return {
    dir,
    configFile: path.join(dir, 'config.json'),
    credentialsFile: path.join(dir, 'credentials.json'),
    capabilitiesFile: path.join(dir, 'capabilities.json'),
  };
}

test('parseEnvText 读 KEY=VALUE，忽略注释与引号', () => {
  const parsed = parseEnvText(
    ['# comment', 'WEBDAV_URL=https://webdav.123pan.cn/webdav', 'WEBDAV_USER="13800000000"', "WEBDAV_PASSWORD='secret'", '', 'BAD_LINE'].join('\n'),
  );
  assert.deepEqual(parsed, {
    WEBDAV_URL: 'https://webdav.123pan.cn/webdav',
    WEBDAV_USER: '13800000000',
    WEBDAV_PASSWORD: 'secret',
  });
});

test('makeRemoteId 生成稳定 id 并自动去重', () => {
  assert.equal(makeRemoteId('坚果云'), 'remote', '中文名转不出 slug 时退回 remote');
  assert.equal(makeRemoteId('Home NAS'), 'home-nas');
  assert.equal(makeRemoteId('Work'), 'work');
  assert.equal(makeRemoteId('work', ['work']), 'work-1', '重名要自动加后缀');
  assert.equal(makeRemoteId('work', ['work', 'work-1']), 'work-2');
});

test('normalizeRemote 补全字段、纠正未知预设', () => {
  const remote = normalizeRemote({ id: 'x', label: ' 我的盘 ', preset: '不存在的东西', url: ' https://a/dav ' });
  assert.equal(remote.id, 'x');
  assert.equal(remote.label, '我的盘');
  assert.equal(remote.preset, 'custom', '未知预设退回 custom，不能留个死 id');
  assert.equal(remote.url, 'https://a/dav');
  assert.equal(remote.enabled, true);
  assert.equal(normalizeRemote(null), null);
});

test('config.json 读写：去重、只保留已知偏好键、默认远程必须存在', () => {
  const { configFile } = paths();
  const written = writeConfig(
    {
      default: 'nope',
      prefs: { timeoutMs: 30000, 未知键: 1 },
      remotes: [
        { id: 'a', label: 'A', preset: '123pan', url: 'https://a/webdav' },
        { id: 'a', label: '重复的 A', preset: '123pan', url: 'https://a2/webdav' },
        { id: 'b', label: 'B', preset: 'fnos', url: 'http://nas:5005/' },
      ],
    },
    configFile,
  );
  assert.equal(written.remotes.length, 2, '重复 id 要去掉');
  assert.deepEqual(Object.keys(written.prefs), ['timeoutMs']);
  assert.equal(written.default, 'a', 'default 指向不存在的远程时回落到第一个');

  const reread = readConfig(configFile);
  assert.deepEqual(reread, written);
  assert.match(readFileSync(configFile, 'utf8'), /"fnos"/);
});

test('config.json 不存在或损坏时给空配置而不是抛错', () => {
  const { configFile } = paths();
  assert.deepEqual(readConfig(configFile).remotes, []);
  writeFileSync(configFile, '{ 这不是 json', 'utf8');
  assert.deepEqual(readConfig(configFile).remotes, []);
});

test('凭据按远程分别保存：undefined 不动、空串清除、删空即移除整条', () => {
  const { credentialsFile } = paths();
  writeCredentials('a', { user: 'u1', password: 'p1' }, credentialsFile);
  writeCredentials('b', { user: 'u2', password: 'p2' }, credentialsFile);
  assert.deepEqual(readCredentials(credentialsFile), {
    a: { user: 'u1', password: 'p1' },
    b: { user: 'u2', password: 'p2' },
  });

  writeCredentials('a', { password: 'p1-new' }, credentialsFile);
  assert.equal(readCredentials(credentialsFile).a.user, 'u1', 'undefined 的字段不能被清掉');
  assert.equal(readCredentials(credentialsFile).a.password, 'p1-new');

  writeCredentials('a', { password: '' }, credentialsFile);
  assert.deepEqual(readCredentials(credentialsFile).a, { user: 'u1' });

  writeCredentials('a', { user: '' }, credentialsFile);
  assert.equal(readCredentials(credentialsFile).a, undefined, '两个字段都空时整条移除');

  removeCredentials('b', credentialsFile);
  assert.deepEqual(readCredentials(credentialsFile), {});
});

test('凭据文件损坏时回落到空表，不把明文密码弄丢成崩溃', () => {
  const { credentialsFile } = paths();
  writeFileSync(credentialsFile, 'not json at all', 'utf8');
  assert.deepEqual(readCredentials(credentialsFile), {});
});

test('能力缓存：按地址缓存，地址变了自动作废', () => {
  const { capabilitiesFile } = paths();
  const store = new CapabilityStore(capabilitiesFile);
  assert.deepEqual(store.get('a', 'https://a/dav'), {});

  store.set('a', 'https://a/dav', { putAutoMkdir: false, propfindMode: 'nobody' });
  assert.equal(store.get('a', 'https://a/dav').putAutoMkdir, false);

  // 同一个远程换了地址，旧能力不适用
  assert.deepEqual(store.get('a', 'https://elsewhere/dav'), {});

  store.set('a', 'https://elsewhere/dav', { propfindMode: 'body' });
  assert.equal(store.get('a', 'https://elsewhere/dav').propfindMode, 'body');
  assert.equal(store.get('a', 'https://elsewhere/dav').putAutoMkdir, undefined, '换地址后旧能力要丢掉');

  // 落盘了，重开也在
  const reopened = new CapabilityStore(capabilitiesFile);
  assert.equal(reopened.get('a', 'https://elsewhere/dav').propfindMode, 'body');
  assert.ok(readCapabilities(capabilitiesFile).a.probedAt);
});

test('迁移：老的 123pan 凭据会被自动接管，且推断出正确的预设', () => {
  const { configFile, credentialsFile } = paths();
  const legacy = {
    url: 'https://webdav.123pan.cn/webdav',
    user: '15900000000',
    password: 'app-pass',
    source: 'legacy-file',
    settings: { defaultUploadDir: 'dsh', maxListEntries: 500, 未知键: 1 },
  };

  const result = migrateLegacy({ configFile, credentialsFile, legacy });
  assert.equal(result.migrated, true);
  assert.equal(result.config.remotes.length, 1);
  assert.equal(result.config.remotes[0].preset, '123pan', '按地址反推出预设');
  assert.equal(result.config.remotes[0].defaultUploadDir, 'dsh');
  assert.equal(result.config.default, result.config.remotes[0].id);
  assert.deepEqual(result.config.prefs, { maxListEntries: 500 }, '未知识别键被丢掉');
  assert.deepEqual(readCredentials(credentialsFile)[result.config.default], {
    user: '15900000000',
    password: 'app-pass',
  });
});

test('迁移幂等：新配置已存在就不再动它', () => {
  const { configFile, credentialsFile } = paths();
  writeConfig({ default: 'mine', prefs: {}, remotes: [{ id: 'mine', label: '我的', preset: 'custom', url: 'https://mine/dav' }] }, configFile);
  const result = migrateLegacy({
    configFile,
    credentialsFile,
    legacy: { url: 'https://webdav.123pan.cn/webdav', user: 'u', password: 'p', source: 'legacy-file', settings: {} },
  });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'already-initialized');
  assert.deepEqual(readConfig(configFile).remotes.map((r) => r.id), ['mine'], '不能被老配置覆盖');
});

test('迁移：没有老配置时什么都不做', () => {
  const { configFile, credentialsFile } = paths();
  const result = migrateLegacy({ configFile, credentialsFile, legacy: null });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'nothing-to-migrate');
});

test('预设表覆盖用户点名的那几家，且自建 NAS 都给了端口提示', () => {
  const ids = PRESETS.map((preset) => preset.id);
  for (const wanted of ['123pan', 'jianguoyun', 'nextcloud', 'synology', 'fnos', 'zspace', 'alist', 'custom']) {
    assert.ok(ids.includes(wanted), `预设缺了 ${wanted}`);
  }
  assert.equal(ids.at(-1), 'custom', '自定义必须排最后，方便用户挑');
  for (const preset of PRESETS) {
    if (preset.id === 'custom') continue;
    assert.ok(preset.urlTemplate, `${preset.id} 必须有地址模板`);
    assert.ok(Array.isArray(preset.tips) && preset.tips.length > 0, `${preset.id} 必须告诉用户怎么拿凭据`);
  }
  const fnos = findPreset('fnos');
  assert.match(fnos.urlTemplate, /5005/);
  assert.ok(fnos.quirks.some((quirk) => /中文/.test(quirk)), 'fnOS 的中文文件夹名坑必须写进预设');
  assert.match(findPreset('不存在').id, /custom/);
});

test('presetForUrl 能从地址认出常见的几家', () => {
  assert.equal(presetForUrl('https://webdav.123pan.cn/webdav').id, '123pan');
  assert.equal(presetForUrl('https://dav.jianguoyun.com/dav/').id, 'jianguoyun');
  assert.equal(presetForUrl('https://cloud.example.com/remote.php/dav/files/me/').id, 'nextcloud');
  assert.equal(presetForUrl('http://192.168.1.9:5244/dav/').id, 'alist');
  assert.equal(presetForUrl('https://webdav.teracloud.jp/dav/').id, 'teracloud');
  assert.equal(presetForUrl('https://something-unknown.example/x').id, 'custom');
  assert.equal(presetForUrl('').id, 'custom');
});
