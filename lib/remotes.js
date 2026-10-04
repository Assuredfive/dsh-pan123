/**
 * 多远程（remote）配置存储 —— 想同时挂 123云盘 + 坚果云 + 公司 Nextcloud + 家里的飞牛 NAS
 * 就靠这一层。文件分成三份，刻意把「密码」和「能进备份的配置」分开：
 *
 *   ~/.config/dsh-webdav/config.json        非机密：远程清单（id/名称/预设/地址/默认上传目录）+ 全局偏好
 *   ~/.config/dsh-webdav/credentials.json   机密：每个远程的账号与应用密码（0600 + Windows ACL 收紧）
 *   ~/.config/dsh-webdav/capabilities.json  运行时学到的服务端能力（PUT 会不会自动建目录、吃不吃 PROPFIND body…）
 *
 * 迁移：老版本 dsh-pan123 的 ~/.config/123pan/webdav.env 与 settings.json 会被**自动接管**，
 * 用户不需要重新输一次凭据；环境变量 WEBDAV_URL/WEBDAV_USER/WEBDAV_PASSWORD 也照旧生效。
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { findPreset, presetForUrl } from './presets.js';

export const CONFIG_DIR = join(homedir(), '.config', 'dsh-webdav');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.json');
export const CAPABILITIES_FILE = join(CONFIG_DIR, 'capabilities.json');

/** 老版本（dsh-pan123）留下的位置，只读，用于一次性迁移。 */
export const LEGACY_DIR = join(homedir(), '.config', '123pan');
export const LEGACY_ENV_FILE = join(LEGACY_DIR, 'webdav.env');
export const LEGACY_SETTINGS_FILE = join(LEGACY_DIR, 'settings.json');

export const PREF_KEYS = ['timeoutMs', 'readMaxBytes', 'maxListEntries', 'bigFileWarnBytes'];
/** 环境变量名（常量导出，便于测试与文档引用）。 */
export const ENV_KEYS = { url: 'WEBDAV_URL', user: 'WEBDAV_USER', password: 'WEBDAV_PASSWORD', remote: 'WEBDAV_REMOTE' };

/**
 * 挑出已知偏好键并**统一成数字**。
 * 老版本把数字写成了字符串（`"timeoutMs": "120000"`），照搬下去会让配置文件看起来像配置坏了；
 * 转不成合法正数的值保留原样（不静默丢用户数据，读取侧本来就有兜底）。
 */
function pickPrefs(source) {
  const out = {};
  const table = source && typeof source === 'object' ? source : {};
  for (const key of PREF_KEYS) {
    const value = table[key];
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    out[key] = Number.isFinite(n) && n > 0 ? Math.floor(n) : value;
  }
  return out;
}

/* ------------------------------------------------------------------ 基础 IO */

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function atomicWrite(file, content, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    if (mode !== undefined) chmodSync(tmp, mode);
  } catch {
    /* Windows 上 chmod 语义有限，忽略 */
  }
  renameSync(tmp, file);
}

/** Windows 下用 icacls 把文件收紧到仅当前用户可读（失败就算了）。 */
function hardenWindowsAcl(file) {
  if (process.platform !== 'win32') return;
  try {
    const user = process.env.USERNAME;
    if (!user) return;
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
  } catch {
    /* 尽力而为 */
  }
}

/** 解析 KEY=VALUE 形式的凭据文件内容（兼容老的 webdav.env）。 */
export function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ 远程清单 */

/** 生成一个稳定、可用于 URL 的远程 id。 */
export function makeRemoteId(label, taken = []) {
  const used = new Set(taken);
  const base =
    String(label ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'remote';
  if (!used.has(base)) return base;
  for (let i = 1; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** 把一条用户/文件里的远程条目补全成规范形状；无效条目返回 null。 */
export function normalizeRemote(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const url = typeof entry.url === 'string' ? entry.url.trim() : '';
  const preset = findPreset(entry.preset).id;
  const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : makeRemoteId(entry.label);
  return {
    id,
    label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : findPreset(preset).label,
    preset,
    url,
    defaultUploadDir: typeof entry.defaultUploadDir === 'string' ? entry.defaultUploadDir.trim() : '',
    enabled: entry.enabled !== false,
  };
}

const EMPTY_CONFIG = { version: 1, default: '', prefs: {}, remotes: [] };

/** 读取 config.json（不存在或损坏时给空配置，不抛错）。 */
export function readConfig(file = CONFIG_FILE) {
  const parsed = readJson(file);
  if (!parsed) return { ...EMPTY_CONFIG, remotes: [] };
  const remotes = [];
  const seen = new Set();
  for (const raw of Array.isArray(parsed.remotes) ? parsed.remotes : []) {
    const normalized = normalizeRemote(raw);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    remotes.push(normalized);
  }
  const prefs = pickPrefs(parsed.prefs);
  return {
    version: 1,
    default: remotes.some((remote) => remote.id === parsed.default) ? parsed.default : remotes[0]?.id ?? '',
    prefs,
    remotes,
  };
}

export function writeConfig(config, file = CONFIG_FILE) {
  // 只写「已知键 + 非空值」：清空一个偏好（传 ''）时不该在文件里留下 `"key": ""` 这种脏键，
  // 虽然读取时会过滤掉，但手翻配置文件的人会以为它还生效着。
  const prefs = pickPrefs(config.prefs);
  const next = {
    version: 1,
    default: config.default ?? '',
    prefs,
    remotes: (config.remotes ?? []).map(normalizeRemote).filter(Boolean),
  };
  atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return readConfig(file);
}

/* ------------------------------------------------------------------ 凭据 */

/** 读取凭据表：{ remotes: { [id]: { user, password } } }。 */
export function readCredentials(file = CREDENTIALS_FILE) {
  const parsed = readJson(file);
  const out = {};
  const table = parsed?.remotes;
  if (!table || typeof table !== 'object') return out;
  for (const [id, value] of Object.entries(table)) {
    if (!value || typeof value !== 'object') continue;
    const entry = {};
    if (typeof value.user === 'string') entry.user = value.user;
    if (typeof value.password === 'string') entry.password = value.password;
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}

/**
 * 写入某个远程的凭据；`undefined` 的字段保持不变，`''`/null 表示删除该字段。
 * 删到两个字段都空时，整条凭据一并移除。
 */
export function writeCredentials(id, patch, file = CREDENTIALS_FILE) {
  const current = readCredentials(file);
  const next = { ...current };
  const merged = { ...(next[id] ?? {}) };
  for (const key of ['user', 'password']) {
    if (!(key in (patch ?? {}))) continue;
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || value === '') delete merged[key];
    else merged[key] = String(value);
  }
  if (Object.keys(merged).length === 0) delete next[id];
  else next[id] = merged;
  atomicWrite(file, `${JSON.stringify({ version: 1, remotes: next }, null, 2)}\n`, 0o600);
  hardenWindowsAcl(file);
  return readCredentials(file);
}

export function removeCredentials(id, file = CREDENTIALS_FILE) {
  const current = readCredentials(file);
  delete current[id];
  if (existsSync(file)) {
    atomicWrite(file, `${JSON.stringify({ version: 1, remotes: current }, null, 2)}\n`, 0o600);
    hardenWindowsAcl(file);
  }
  return current;
}

/* ------------------------------------------------------------------ 能力缓存 */

/** 读取能力缓存：{ [id]: { url, caps, probedAt } }。 */
export function readCapabilities(file = CAPABILITIES_FILE) {
  const parsed = readJson(file);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/** 服务端能力缓存（按远程 id + 地址存，地址变了就作废）。 */
export function capsFor(id, url, file = CAPABILITIES_FILE) {
  const entry = readCapabilities(file)[id];
  if (!entry || entry.url !== url || !entry.caps || typeof entry.caps !== 'object') return {};
  return entry.caps;
}

export function rememberCaps(id, url, caps, file = CAPABILITIES_FILE) {
  if (!id || !url || !caps || typeof caps !== 'object') return;
  const all = readCapabilities(file);
  const merged = { ...(all[id]?.url === url ? all[id].caps : {}), ...caps };
  all[id] = { url, caps: merged, probedAt: new Date().toISOString() };
  atomicWrite(file, `${JSON.stringify(all, null, 2)}\n`, 0o600);
}

/**
 * 能力缓存的门面。运行期只跟它打交道：
 * `get(id, url)` 拿上次学到的能力，`set(id, url, caps)` 把这次学到的写回去。
 * 地址变了缓存自动作废（同一个远程改了地址，旧能力不适用）。
 */
export class CapabilityStore {
  constructor(file = CAPABILITIES_FILE) {
    this.file = file;
    this.memo = readCapabilities(file);
  }

  get(id, url) {
    const entry = this.memo?.[id];
    if (!entry || entry.url !== url || !entry.caps) return {};
    return { ...entry.caps };
  }

  set(id, url, caps) {
    if (!id || !url || !caps || typeof caps !== 'object') return;
    this.memo = readCapabilities(this.file);
    const merged = { ...(this.memo?.[id]?.url === url ? this.memo[id].caps : {}), ...caps };
    this.memo[id] = { url, caps: merged, probedAt: new Date().toISOString() };
    atomicWrite(this.file, `${JSON.stringify(this.memo, null, 2)}\n`, 0o600);
  }

  all() {
    return this.memo;
  }
}

/* ------------------------------------------------------------------ 迁移 */

/**
 * 读取老版本 dsh-pan123 留下的凭据/偏好（没有就返回 null）。
 * 可以通过 options 指定/关闭老文件的位置（测试用来模拟「全新用户」：
 * 传 `{ envFile: null, settingsFile: null }` 就完全不看老文件）。
 */
export function readLegacy(env = process.env, options = {}) {
  const envFile = options.envFile === undefined ? LEGACY_ENV_FILE : options.envFile;
  const settingsFile = options.settingsFile === undefined ? LEGACY_SETTINGS_FILE : options.settingsFile;
  let url = '';
  let user = '';
  let password = '';
  let source = null;

  if (env.WEBDAV_URL || env.WEBDAV_USER || env.WEBDAV_PASSWORD) {
    url = env.WEBDAV_URL ?? '';
    user = env.WEBDAV_USER ?? '';
    password = env.WEBDAV_PASSWORD ?? '';
    source = 'env';
  }
  if ((!url || !user || !password) && envFile && existsSync(envFile)) {
    const parsed = parseEnvText(readFileSync(envFile, 'utf8'));
    url = url || parsed.WEBDAV_URL || '';
    user = user || parsed.WEBDAV_USER || '';
    password = password || parsed.WEBDAV_PASSWORD || '';
    source = source ?? 'legacy-file';
  }
  const legacySettings = settingsFile ? readJson(settingsFile) ?? {} : {};
  if (!url && !user && !password && Object.keys(legacySettings).length === 0) return null;
  return { url, user, password, source, settings: legacySettings };
}

/**
 * 一次性迁移：老配置 → 新的多远程结构。
 * 幂等：新的 config.json 已存在（哪怕没有任何远程）就不再迁移。
 * @returns {{migrated:boolean, config:object, reason?:string}}
 */
export function migrateLegacy(options = {}) {
  const configFile = options.configFile ?? CONFIG_FILE;
  const credentialsFile = options.credentialsFile ?? CREDENTIALS_FILE;
  // 注意用 'legacy' in options 而不是 ??：显式传 null 表示「确定没有老配置」，
  // 用 ?? 会当成没传而回落到读真实用户目录，测试和调用方都会被这个坑到。
  const legacy =
    'legacy' in options
      ? options.legacy
      : readLegacy(options.env ?? process.env, {
          envFile: options.legacyEnvFile,
          settingsFile: options.legacySettingsFile,
        });
  const existing = readConfig(configFile);
  if (existsSync(configFile)) return { migrated: false, config: existing, reason: 'already-initialized' };
  if (!legacy) return { migrated: false, config: existing, reason: 'nothing-to-migrate' };

  const preset = presetForUrl(legacy.url);
  const label = preset.id === 'custom' ? 'WebDAV 网盘' : preset.label;
  const remote = normalizeRemote({
    id: makeRemoteId(preset.id === 'custom' ? 'default' : preset.id),
    label,
    preset: preset.id,
    url: legacy.url || preset.urlTemplate,
    defaultUploadDir: legacy.settings?.defaultUploadDir ?? '',
  });

  const prefs = pickPrefs(legacy.settings);

  const config = writeConfig({ version: 1, default: remote.id, prefs, remotes: [remote] }, configFile);
  if (legacy.user || legacy.password) {
    writeCredentials(remote.id, { user: legacy.user, password: legacy.password }, credentialsFile);
  }
  return { migrated: true, config, reason: `from ${legacy.source ?? 'legacy'}` };
}

/** 给界面/工具用：所有落盘位置。 */
export function settingsPaths() {
  return {
    dir: CONFIG_DIR,
    configFile: CONFIG_FILE,
    credentialsFile: CREDENTIALS_FILE,
    capabilitiesFile: CAPABILITIES_FILE,
    legacyEnvFile: LEGACY_ENV_FILE,
    legacySettingsFile: LEGACY_SETTINGS_FILE,
  };
}

/**
 * 把配置目录换到别处（插件 config 的 `configDir`）。
 * 用处：便携安装、同一台机器上跑多套配置、以及**测试不去碰用户的真实凭据**。
 *
 * 语义：自定义目录**完全自包含** —— 三份配置文件都在里面，也**不会**去读
 * `~/.config/123pan/` 的老配置。老配置迁移只针对默认位置（那才是老版本真正写过的位置），
 * 否则「换个目录」就会把用户真实的老凭据悄悄带进来，既意外又难排查。
 */
export function pathsForDir(dir) {
  const text = String(dir ?? '').trim();
  const base = text === '~' ? homedir() : text.startsWith('~/') || text.startsWith('~\\') ? join(homedir(), text.slice(2)) : text;
  if (!base) return settingsPaths();
  return {
    dir: base,
    configFile: join(base, 'config.json'),
    credentialsFile: join(base, 'credentials.json'),
    capabilitiesFile: join(base, 'capabilities.json'),
    legacyEnvFile: null,
    legacySettingsFile: null,
  };
}
