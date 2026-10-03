/**
 * 插件自己的本地设置存储。
 *
 * 分工（凭据与偏好分开，避免把密码写进会进备份的配置里）：
 *   - 凭据（服务地址 / 账号 / 应用密码）→ ~/.config/123pan/webdav.env
 *     沿用原技能的文件格式，脚本与插件共用一份，且保持「凭据不入库」的约定。
 *   - 偏好（默认上传目录 / 上限 / 超时）→ ~/.config/123pan/settings.json
 *
 * 两者都在本机用户目录下，不参与 DSH profile 的配置与备份。
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnvText } from './webdav.js';

export const CONFIG_DIR = join(homedir(), '.config', '123pan');
export const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
export const CREDENTIALS_FILE = join(CONFIG_DIR, 'webdav.env');

/**
 * settings.json 里保留的键（只放偏好；凭据一律只进 webdav.env，避免密码出现两份）。
 */
const PREF_KEYS = ['defaultUploadDir', 'timeoutMs', 'readMaxBytes', 'maxListEntries', 'bigFileWarnBytes'];
const CREDENTIAL_KEYS = ['WEBDAV_URL', 'WEBDAV_USER', 'WEBDAV_PASSWORD'];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
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

/** 读取偏好（不存在或损坏时返回 {}）。 */
export function readSettings(file = SETTINGS_FILE) {
  const parsed = readJson(file);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const key of PREF_KEYS) {
    if (parsed[key] !== undefined && parsed[key] !== null && parsed[key] !== '') out[key] = parsed[key];
  }
  return out;
}

/** 写入偏好：与已有值合并；只有**显式传入**的键才会被改动，传空表示删除该键。 */
export function writeSettings(patch, file = SETTINGS_FILE) {
  const merged = { ...readSettings(file) };
  for (const key of PREF_KEYS) {
    if (!(key in (patch ?? {}))) continue;
    const value = patch[key];
    if (value === undefined || value === null || value === '') delete merged[key];
    else merged[key] = value;
  }
  atomicWrite(file, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
  return merged;
}

/** 读取凭据文件（不存在返回 {}）。 */
export function readCredentialsFile(file = CREDENTIALS_FILE) {
  if (!existsSync(file)) return {};
  try {
    const parsed = parseEnvText(readFileSync(file, 'utf8'));
    const out = {};
    for (const key of CREDENTIAL_KEYS) if (parsed[key]) out[key] = parsed[key];
    return out;
  } catch {
    return {};
  }
}

/**
 * 写入凭据文件：保留文件里其它键，只更新给定字段；
 * 传空字符串表示删除该字段。文件权限尽量收紧到仅当前用户（Windows 上尽力而为）。
 */
export function writeCredentialsFile(patch, file = CREDENTIALS_FILE) {
  const current = existsSync(file) ? parseEnvText(readFileSync(file, 'utf8')) : {};
  const next = { ...current };
  for (const key of CREDENTIAL_KEYS) {
    const value = patch?.[key];
    if (value === undefined) continue;
    if (value === null || value === '') delete next[key];
    else next[key] = String(value);
  }
  const order = [...CREDENTIAL_KEYS, ...Object.keys(next).filter((key) => !CREDENTIAL_KEYS.includes(key))];
  const lines = ['# 123云盘 WebDAV 凭据（由 dsh-pan123 插件管理；勿提交到任何会同步的位置）'];
  for (const key of order) {
    if (next[key] === undefined) continue;
    lines.push(`${key}=${next[key]}`);
  }
  atomicWrite(file, `${lines.join('\n')}\n`, 0o600);
  hardenWindowsAcl(file);
  return readCredentialsFile(file);
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

export function settingsPaths() {
  return { dir: CONFIG_DIR, settingsFile: SETTINGS_FILE, credentialsFile: CREDENTIALS_FILE };
}
