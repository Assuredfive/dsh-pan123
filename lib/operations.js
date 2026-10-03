/**
 * 操作层：Agent 工具（lib/tools.js）和界面 HTTP API（lib/api.js）共用的同一套语义。
 * 不 import 任何 dsh 包，所以可以被 node:test 直接单测。
 */

import { homedir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BIG_FILE_WARN,
  DEFAULT_ENV_FILE,
  DEFAULT_READ_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  WebdavError,
  explainStatus,
  expandHome,
  humanSize,
  normalizeRemotePath,
  openClient,
  resolveCredentials,
} from './webdav.js';

export const DEFAULT_MAX_LIST = 1000;

/**
 * 把用户/插件配置补全成完整配置。
 * url/user/password 留空表示「未显式指定」，交给凭据解析按优先级取；
 * 偏好项（defaultUploadDir 等）优先级：插件 config > 设置页保存的 settings > 默认值。
 */
export function normalizeConfig(raw = {}) {
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const pick = (key, fallback) => (raw[key] !== undefined && raw[key] !== '' && raw[key] !== null ? raw[key] : settings[key] ?? fallback);
  return {
    url: raw.url ? String(raw.url) : '',
    user: raw.user ? String(raw.user) : '',
    password: raw.password ? String(raw.password) : '',
    settings,
    envFile: raw.envFile ? String(raw.envFile) : DEFAULT_ENV_FILE,
    timeoutMs: toPositiveInt(pick('timeoutMs'), DEFAULT_TIMEOUT_MS),
    defaultUploadDir: pick('defaultUploadDir', '') ? String(pick('defaultUploadDir', '')) : '',
    bigFileWarnBytes: toPositiveInt(pick('bigFileWarnBytes'), DEFAULT_BIG_FILE_WARN),
    readMaxBytes: toPositiveInt(pick('readMaxBytes'), DEFAULT_READ_MAX_BYTES),
    maxListEntries: toPositiveInt(pick('maxListEntries'), DEFAULT_MAX_LIST),
    uiEnabled: raw.uiEnabled !== false,
  };
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 凭据自述（永不含密码）。 */
export async function credentialStatus(config, env = process.env) {
  const resolved = normalizeConfig(config);
  try {
    const creds = await resolveCredentials(resolved, env);
    return {
      ok: true,
      url: creds.url,
      user: creds.user ? maskUser(creds.user) : '',
      sources: creds.sources,
      envFile: expandHome(resolved.envFile),
    };
  } catch (err) {
    return { ok: false, error: err.message, envFile: expandHome(resolved.envFile) };
  }
}

function maskUser(user) {
  const text = String(user);
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${text.slice(0, 3)}****${text.slice(-2)}`;
}

async function clientFor(config, args = {}) {
  const { client, credentials } = await openClient(config, args.env ?? process.env);
  return { client, credentials };
}

function signalOf(args = {}) {
  return args.signal;
}

/* ------------------------------------------------------------------- 各项操作 */

export async function check(config, args = {}) {
  const resolved = normalizeConfig(config);
  const { client, credentials } = await clientFor(resolved, args);
  const result = await client.check({ signal: signalOf(args) });
  return {
    ok: true,
    url: result.url,
    status: result.status,
    rootCount: result.rootCount,
    user: credentials.user ? maskUser(credentials.user) : '',
    sources: credentials.sources,
  };
}

export async function list(config, args = {}) {
  const resolved = normalizeConfig(config);
  const target = normalizeRemotePath(args.path ?? '/');
  const { client } = await clientFor(resolved, args);
  const entries = await client.list(target, { signal: signalOf(args) });
  const shown = entries.slice(0, resolved.maxListEntries);
  return {
    path: target,
    total: entries.length,
    truncated: entries.length > shown.length,
    entries: shown.map(toView),
  };
}

export async function stat(config, args = {}) {
  const resolved = normalizeConfig(config);
  const target = normalizeRemotePath(args.path);
  const { client } = await clientFor(resolved, args);
  const entry = await client.stat(target, { signal: signalOf(args) });
  if (!entry) return { path: target, exists: false, status: 404 };
  return { path: target, exists: true, entry: toView(entry) };
}

export async function download(config, args = {}) {
  const resolved = normalizeConfig(config);
  if (!args.remote) throw badRequest('download 需要 remote（远端文件路径）');
  const remote = normalizeRemotePath(args.remote);
  const local = args.local
    ? path.resolve(expandHome(String(args.local)))
    : path.resolve(process.cwd(), path.basename(remote));
  const { client } = await clientFor(resolved, args);
  await assertNotDirectory(client, remote, signalOf(args));
  const result = await client.download(remote, local, { signal: signalOf(args) });
  return { remote, local: result.localPath, bytes: result.bytes, size: humanSize(result.bytes) };
}

export async function upload(config, args = {}) {
  const resolved = normalizeConfig(config);
  if (!args.local) throw badRequest('upload 需要 local（本地文件路径）');
  const local = path.resolve(expandHome(String(args.local)));
  const remoteDir = normalizeRemotePath(args.remoteDir ?? resolved.defaultUploadDir ?? '');
  const name = args.remoteName ? String(args.remoteName) : path.basename(local);
  if (!name || name === '/' || name === '.') throw badRequest(`无法确定远端文件名: ${args.local}`);
  const target = normalizeRemotePath(remoteDir === '/' ? `/${name}` : `${remoteDir}/${name}`);

  const { client } = await clientFor(resolved, args);
  const existing = await client.stat(remoteDir, { signal: signalOf(args) }).catch(() => null);
  if (existing && !existing.isDir) {
    throw badRequest(`远端目标 ${remoteDir} 已存在且不是目录，不能作为上传目录`);
  }
  const result = await client.upload(local, target, { signal: signalOf(args) });
  const warnings = [];
  if (result.bytes > resolved.bigFileWarnBytes) {
    warnings.push(
      `文件 ${humanSize(result.bytes)} 超过 ${humanSize(resolved.bigFileWarnBytes)}：123 官方不建议用 WebDAV 搬大文件（无秒传/断点续传），失败请改用 123云盘客户端。`,
    );
  }
  return {
    local: result.localPath,
    remote: result.remotePath,
    bytes: result.bytes,
    size: humanSize(result.bytes),
    warnings,
  };
}

export async function mkdir(config, args = {}) {
  const resolved = normalizeConfig(config);
  const target = normalizeRemotePath(args.path);
  const { client } = await clientFor(resolved, args);
  const result = await client.mkdir(target, { signal: signalOf(args) });
  return { path: result.remotePath };
}

export async function move(config, args = {}) {
  const resolved = normalizeConfig(config);
  const from = normalizeRemotePath(args.from);
  const to = normalizeRemotePath(args.to);
  if (from === to) throw badRequest('源路径与目标路径相同');
  const { client } = await clientFor(resolved, args);
  const result = await client.move(from, to, { signal: signalOf(args) });
  return { from: result.from, to: result.to };
}

/**
 * 删除。123云盘对目录是递归删除且不返回任何确认，所以这里强制二次确认：
 * 目标是目录时必须显式传 recursive=true，否则先报错并要求列目录确认。
 */
export async function remove(config, args = {}) {
  const resolved = normalizeConfig(config);
  const target = normalizeRemotePath(args.path);
  if (target === '/') throw badRequest('拒绝删除根目录');
  const { client } = await clientFor(resolved, args);
  const entry = await client.stat(target, { signal: signalOf(args) });
  if (!entry) return { path: target, removed: false, status: 404, note: '路径不存在（无需删除）。' };

  if (entry.isDir && args.recursive !== true) {
    let childCount = null;
    try {
      childCount = (await client.list(target, { signal: signalOf(args) })).length;
    } catch {
      /* 列不动就不报数量 */
    }
    throw badRequest(
      `拒绝删除目录 ${target}：123云盘对目录是**递归删除**，会连同子项一起删除且没有确认。` +
        (childCount === null ? '' : `当前子项数量：${childCount}。`) +
        ' 请先用 pan123_ls 看清内容，确认后再以 recursive=true 重试。',
    );
  }

  await client.remove(target, { signal: signalOf(args) });
  return {
    path: target,
    removed: true,
    wasDir: entry.isDir,
    note: '123云盘删除后有短暂的最终一致性窗口：立刻复查可能读到陈旧结果，以随后的 404 为准。',
  };
}

export async function readText(config, args = {}) {
  const resolved = normalizeConfig(config);
  const target = normalizeRemotePath(args.path);
  const maxBytes = toPositiveInt(args.maxBytes, resolved.readMaxBytes);
  const { client } = await clientFor(resolved, args);
  await assertNotDirectory(client, target, signalOf(args));
  const result = await client.readText(target, { maxBytes, signal: signalOf(args) });
  return {
    path: target,
    bytes: result.bytes,
    truncated: result.truncated,
    content: result.content,
  };
}

export async function url(config, args = {}) {
  const resolved = normalizeConfig(config);
  const target = normalizeRemotePath(args.path ?? '/');
  const { client } = await clientFor(resolved, args);
  return {
    path: target,
    url: client.urlFor(target),
    note: '这是 WebDAV 直连地址（需要凭据，不是公开分享链接）。',
  };
}

/* ------------------------------------------------------------------- 工具函数 */

/** 下载/读取前确认目标不是目录（WebDAV 对目录 GET 的行为各服务端不一致）。 */
async function assertNotDirectory(client, remotePath, signal) {
  const entry = await client.stat(remotePath, { signal }).catch(() => null);
  if (entry?.isDir) throw badRequest(`${remotePath} 是目录，不是文件`);
}

/**
 * 用户可修正的错误（参数缺失、语义冲突、安全护栏）→ HTTP 400。
 * WebDAV 自身的状态码由 WebdavError 携带。
 */
export function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.guard = true;
  return error;
}


function toView(entry) {
  const view = {
    name: entry.name,
    path: entry.path,
    isDir: entry.isDir,
    sizeText: entry.isDir ? '-' : humanSize(entry.size),
    mtime: entry.mtime,
  };
  // 只有真正拿到数字才给 size：目录/服务端未返回长度时是 null，
  // 而工具输出 schema 把 size 声明成 integer，null 会被 harness 判为非法输出。
  if (Number.isInteger(entry.size)) view.size = entry.size;
  return view;
}

/** 给界面用：把错误翻译成 {status, message, hint}。 */
export function toErrorPayload(err) {
  if (err instanceof WebdavError) {
    return {
      status: err.status,
      message: err.message,
      hint: err.hint ?? explainStatus(err.status, err.remotePath),
    };
  }
  return {
    status: Number.isInteger(err?.status) ? err.status : null,
    message: err?.message ?? String(err),
    hint: undefined,
  };
}

export function localHome() {
  return homedir();
}
