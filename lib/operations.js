/**
 * 操作层：Agent 工具（lib/tools.js）和界面 HTTP API（lib/api.js）共用的同一套语义。
 * 不 import 任何 dsh 包，所以可以被 node:test 直接单测。
 *
 * 这一层的职责有两件事：
 *   1. **多远程**：把 config.json 里的远程清单 + credentials.json 里的凭据 + 环境变量
 *      合成一组「可用的远程」，并按 id / 默认远程选出这次要操作的那一个。
 *   2. **自愈**：服务端实现差异不往上抛，而是在这里消化掉
 *      （PUT 不自动建目录就补 MKCOL、MOVE 撞名就删目标重试、500 这类模糊错误做二次诊断）。
 */

import path from 'node:path';
import { presetForUrl } from './presets.js';
import { normalizeRemote, ENV_KEYS } from './remotes.js';
import {
  DEFAULT_BIG_FILE_WARN,
  DEFAULT_READ_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  UnsupportedError,
  WebdavClient,
  WebdavError,
  expandHome,
  explainStatus,
  humanSize,
  normalizeRemotePath,
} from './webdav.js';

export const DEFAULT_MAX_LIST = 1000;

/* ------------------------------------------------------------------ 配置归一 */

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 全局偏好（与具体远程无关的那些）。 */
export function normalizePrefs(prefs = {}) {
  return {
    timeoutMs: toPositiveInt(prefs.timeoutMs, DEFAULT_TIMEOUT_MS),
    readMaxBytes: toPositiveInt(prefs.readMaxBytes, DEFAULT_READ_MAX_BYTES),
    maxListEntries: toPositiveInt(prefs.maxListEntries, DEFAULT_MAX_LIST),
    bigFileWarnBytes: toPositiveInt(prefs.bigFileWarnBytes, DEFAULT_BIG_FILE_WARN),
  };
}

/* ------------------------------------------------------------------ 远程解析 */

/**
 * 合成可用远程列表。字段优先级（高 → 低）：
 *   1. 环境变量——只在「没有 WEBDAV_REMOTE」或它正好点名这个远程时生效，
 *      这样多远程场景下全局环境变量不会串台，同时保留老版本的「环境变量优先」行为。
 *   2. config.json 里的地址
 *   3. credentials.json 里的账号/密码
 * 此外：一个远程都没有但环境变量里有地址时，会合成一个隐式远程（id = default）。
 */
export function resolveRemotes(config = {}, env = process.env) {
  const stored = config.credentials && typeof config.credentials === 'object' ? config.credentials : {};
  const rawList = Array.isArray(config.remotes) ? config.remotes : [];
  const named = env?.[ENV_KEYS.remote] ? String(env[ENV_KEYS.remote]) : '';
  const remotes = [];
  const seen = new Set();

  for (const raw of rawList) {
    const remote = normalizeRemote(raw);
    if (!remote || seen.has(remote.id)) continue;
    seen.add(remote.id);
    remotes.push(remote);
  }

  let defaultId = remotes.some((remote) => remote.id === config.default) ? config.default : remotes[0]?.id ?? '';

  // 隐式远程：完全没配置，但环境变量给了地址（兼容老版本与 CI/脚本用法）
  if (remotes.length === 0 && (env?.WEBDAV_URL || env?.WEBDAV_USER || env?.WEBDAV_PASSWORD)) {
    const preset = presetForUrl(env.WEBDAV_URL);
    remotes.push(
      normalizeRemote({
        id: named || 'default',
        label: preset.id === 'custom' ? 'WebDAV 网盘' : preset.label,
        preset: preset.id,
        url: env.WEBDAV_URL ?? preset.urlTemplate,
      }),
    );
    defaultId = remotes[0].id;
  }

  return {
    defaultId,
    remotes: remotes.map((remote) => {
      const saved = stored[remote.id] ?? {};
      const sources = {};
      let url = remote.url;
      let user = saved.user ?? '';
      let password = saved.password ?? '';
      if (url) sources.url = 'config';
      if (user) sources.user = 'credentials';
      if (password) sources.password = 'credentials';

      const envApplies = named ? named === remote.id : remote.id === defaultId;
      if (envApplies) {
        if (env?.WEBDAV_URL) {
          url = String(env.WEBDAV_URL);
          sources.url = 'env';
        }
        if (env?.WEBDAV_USER) {
          user = String(env.WEBDAV_USER);
          sources.user = 'env';
        }
        if (env?.WEBDAV_PASSWORD) {
          password = String(env.WEBDAV_PASSWORD);
          sources.password = 'env';
        }
      }
      return { ...remote, url, user, password, sources };
    }),
  };
}

/** 选出这次要操作的远程；校验地址与凭据是否齐全。 */
export function pickRemote(config = {}, id, env = process.env) {
  const { remotes } = resolveRemotes(config, env);
  if (remotes.length === 0) {
    throw badRequest(
      '还没有配置任何 WebDAV 远程。请打开「设置 → WebDAV 网盘」添加一个（选预设、填地址与应用密码）；' +
        '也可以临时用 WEBDAV_URL / WEBDAV_USER / WEBDAV_PASSWORD 环境变量。',
    );
  }
  if (id) {
    const found = remotes.find((remote) => remote.id === id);
    if (!found) {
      throw badRequest(`没有名为 ${id} 的远程。可用的远程：${remotes.map((remote) => remote.id).join('、')}`);
    }
    return assertUsable(found);
  }
  const fallback =
    remotes.find((remote) => remote.id === config.default) ??
    remotes.find((remote) => remote.enabled !== false) ??
    remotes[0];
  return assertUsable(fallback);
}

function assertUsable(remote) {
  if (!remote.url) {
    throw badRequest(`远程「${remote.label}」还没填 WebDAV 地址。请到「设置 → WebDAV 网盘」补上。`);
  }
  const missing = ['user', 'password'].filter((key) => !remote[key]);
  if (missing.length > 0) {
    throw badRequest(
      `远程「${remote.label}」缺少${missing.map((key) => (key === 'user' ? '账号' : '密码')).join('和')}。` +
        '请在「设置 → WebDAV 网盘」里填写（多数服务商要求用「应用密码」而不是登录密码）。凭据不要写进记忆或聊天正文。',
    );
  }
  return remote;
}

/** 建客户端，并把运行期学到/缓存的服务端能力带进去。 */
export function clientFor(config = {}, remote, options = {}) {
  const prefs = normalizePrefs(config.prefs);
  const caps = options.caps ?? config.capabilities?.get?.(remote.id, remote.url) ?? {};
  const client = new WebdavClient({
    url: remote.url,
    user: remote.user,
    password: remote.password,
    timeoutMs: options.timeoutMs ?? prefs.timeoutMs,
    fetchImpl: options.fetchImpl,
    caps,
  });
  return client;
}

/**
 * 统一入口：选远程 → 建客户端 → 跑操作 → 把学到的能力落盘。
 * 服务端能力（会不会自动建目录、吃不吃 PROPFIND body）是**跑出来的**，所以每次都要回收。
 */
async function withClient(config, args, run) {
  const remote = pickRemote(config, args?.remote, args?.env ?? process.env);
  const client = clientFor(config, remote, args);
  try {
    return await run(client, remote);
  } finally {
    try {
      config.capabilities?.set?.(remote.id, remote.url, client.caps);
    } catch {
      /* 能力缓存写不进去不影响主流程 */
    }
  }
}

/* ------------------------------------------------------------------- 各项操作 */

function signalOf(args = {}) {
  return args.signal;
}

/** 凭据自述（永不含密码）。 */
export function credentialStatus(config, args = {}) {
  const env = args.env ?? process.env;
  const { remotes, defaultId } = resolveRemotes(config, env);
  return {
    ok: remotes.length > 0,
    default: defaultId,
    remotes: remotes.map((remote) => ({
      id: remote.id,
      label: remote.label,
      preset: remote.preset,
      url: remote.url,
      user: remote.user ? maskUser(remote.user) : '',
      hasPassword: Boolean(remote.password),
      defaultUploadDir: remote.defaultUploadDir,
      enabled: remote.enabled !== false,
      sources: remote.sources,
    })),
  };
}

function maskUser(user) {
  const text = String(user);
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${text.slice(0, 3)}****${text.slice(-2)}`;
}

export async function check(config, args = {}) {
  return withClient(config, args, async (client, remote) => {
    const result = await client.check({ signal: signalOf(args) });
    return {
      ok: true,
      remote: remote.id,
      label: remote.label,
      preset: remote.preset,
      url: result.url,
      status: result.status,
      rootCount: result.rootCount,
      dav: result.dav,
      allow: result.allow,
      server: result.server,
      propfindMode: result.propfindMode,
      user: remote.user ? maskUser(remote.user) : '',
      sources: remote.sources,
      capabilities: { ...client.caps },
    };
  });
}

/** 列出手上配置了哪些远程（给 Agent 用，不含密码）。 */
export async function remotes(config, args = {}) {
  const env = args.env ?? process.env;
  const { remotes: list, defaultId } = resolveRemotes(config, env);
  return {
    default: defaultId,
    remotes: list.map((remote) => ({
      id: remote.id,
      label: remote.label,
      preset: remote.preset,
      url: remote.url,
      user: remote.user ? maskUser(remote.user) : '',
      hasPassword: Boolean(remote.password),
      defaultUploadDir: remote.defaultUploadDir,
      isDefault: remote.id === defaultId,
    })),
  };
}

export async function list(config, args = {}) {
  const target = normalizeRemotePath(args.path ?? '/');
  return withClient(config, args, async (client, remote) => {
    const entries = await client.list(target, { signal: signalOf(args) });
    const max = normalizePrefs(config.prefs).maxListEntries;
    const shown = entries.slice(0, max);
    return {
      remote: remote.id,
      path: target,
      total: entries.length,
      truncated: entries.length > shown.length,
      entries: shown.map(toView),
    };
  });
}

export async function stat(config, args = {}) {
  const target = normalizeRemotePath(args.path);
  return withClient(config, args, async (client, remote) => {
    const entry = await client.stat(target, { signal: signalOf(args) });
    if (!entry) return { remote: remote.id, path: target, exists: false, status: 404 };
    return { remote: remote.id, path: target, exists: true, entry: toView(entry) };
  });
}

export async function download(config, args = {}) {
  // 注意：这里的 args.path 是**远端文件路径**；args.remote 是「哪个远程」（网盘）。
  if (!args.path) throw badRequest('download 需要 path（远端文件路径）');
  const remotePath = normalizeRemotePath(args.path);
  const local = args.local
    ? path.resolve(expandHome(String(args.local)))
    : path.resolve(process.cwd(), path.basename(remotePath));
  return withClient(config, args, async (client, remote) => {
    await assertNotDirectory(client, remotePath, signalOf(args));
    const result = await client.download(remotePath, local, { signal: signalOf(args) });
    return {
      remote: remote.id,
      path: remotePath,
      local: result.localPath,
      bytes: result.bytes,
      size: humanSize(result.bytes),
    };
  });
}

export async function upload(config, args = {}) {
  if (!args.local) throw badRequest('upload 需要 local（本地文件路径）');
  const local = path.resolve(expandHome(String(args.local)));
  const name = args.remoteName ? String(args.remoteName) : path.basename(local);
  if (!name || name === '/' || name === '.') throw badRequest(`无法确定远端文件名: ${args.local}`);

  return withClient(config, args, async (client, remote) => {
    const remoteDir = normalizeRemotePath(args.remoteDir ?? remote.defaultUploadDir ?? '');
    const filePath = normalizeRemotePath(remoteDir === '/' ? `/${name}` : `${remoteDir}/${name}`);

    // 目标目录存不存在先探一下；但「这地址不是 WebDAV」不能当成「目录不存在」吞掉
    const existing = await client.stat(remoteDir, { signal: signalOf(args) }).catch((err) => {
      if (err?.notWebdav) throw err;
      return null;
    });
    if (existing && !existing.isDir) {
      throw badRequest(`远端目标 ${remoteDir} 已存在且不是目录，不能作为上传目录`);
    }
    const result = await client.upload(local, filePath, { signal: signalOf(args) });
    const warnings = [];
    const bigWarn = normalizePrefs(config.prefs).bigFileWarnBytes;
    if (result.bytes > bigWarn) {
      warnings.push(
        `文件 ${humanSize(result.bytes)} 超过 ${humanSize(bigWarn)}：WebDAV 没有秒传/断点续传，` +
          '大文件在各家服务端都容易失败，必要时改用该网盘的官方客户端。',
      );
    }
    return {
      remote: remote.id,
      local: result.localPath,
      remotePath: result.remotePath,
      bytes: result.bytes,
      size: humanSize(result.bytes),
      createdDirs: result.createdDirs ?? [],
      warnings,
    };
  });
}

export async function mkdir(config, args = {}) {
  const target = normalizeRemotePath(args.path);
  return withClient(config, args, async (client, remote) => {
    const result = await client.mkdir(target, { signal: signalOf(args) });
    return { remote: remote.id, path: result.remotePath };
  });
}

/**
 * 移动/重命名。撞名、目标目录缺失、服务端不支持 MOVE 这三种情况都在这里被翻译成人话，
 * 而不是把裸的 HTTP 500 丢给用户（123云盘这三种情况全都返回 500）。
 */
export async function move(config, args = {}) {
  const from = normalizeRemotePath(args.from);
  const to = normalizeRemotePath(args.to);
  if (from === to) throw badRequest('源路径与目标路径相同');
  return withClient(config, args, async (client, remote) => {
    try {
      const result = await client.move(from, to, { signal: signalOf(args) });
      return {
        remote: remote.id,
        from: result.from,
        to: result.to,
        via: result.via ?? 'move',
        replaced: result.replaced === true,
      };
    } catch (err) {
      throw await diagnoseMove(client, from, to, err, signalOf(args));
    }
  });
}

/**
 * 服务端把很多用户错误都压成 500，所以出错后主动查一次「源在不在 / 目标目录在不在」，
 * 把「HTTP 500 Internal Server Error」变成能直接照着改的提示。
 */
async function diagnoseMove(client, from, to, err, signal) {
  if (err instanceof UnsupportedError) return err;
  if (!(err instanceof WebdavError)) return err;
  if (![500, 409, 403, 400].includes(err.status)) return err;
  const source = await client.exists(from, { signal }).catch(() => true);
  if (!source) {
    const error = new WebdavError('MOVE', from, 404, '');
    error.hint = `源路径 ${from} 不存在（该服务端可能用 HTTP ${err.status} 表示这种情况），未做任何改动。`;
    return error;
  }
  const targetParent = parentDir(to);
  const parentEntry = await client.stat(targetParent, { signal }).catch(() => null);
  if (!parentEntry) {
    const error = new WebdavError('MOVE', from, err.status, '');
    error.hint = `目标目录 ${targetParent} 不存在（该服务端用 HTTP ${err.status} 表示这种情况）。先建目录，或改用已有的目录作为目标。`;
    return error;
  }
  if (!parentEntry.isDir) {
    const error = new WebdavError('MOVE', from, err.status, '');
    error.hint = `目标目录 ${targetParent} 其实是个文件，不能把条目移进去。`;
    return error;
  }
  return err;
}

/**
 * 删除。按 RFC 4918，DELETE 作用在集合上就是**递归删除**，任何服务端都不会再确认一次，
 * 所以这里强制二次确认：目标是目录时必须显式传 recursive=true。
 */
export async function remove(config, args = {}) {
  const target = normalizeRemotePath(args.path);
  if (target === '/') throw badRequest('拒绝删除根目录');
  return withClient(config, args, async (client, remote) => {
    const entry = await client.stat(target, { signal: signalOf(args) });
    if (!entry) return { remote: remote.id, path: target, removed: false, status: 404, note: '路径不存在（无需删除）。' };

    if (entry.isDir && args.recursive !== true) {
      let childCount = null;
      try {
        childCount = (await client.list(target, { signal: signalOf(args) })).length;
      } catch {
        /* 列不动就不报数量 */
      }
      throw badRequest(
        `拒绝删除目录 ${target}：WebDAV 对目录的 DELETE 就是**递归删除**（RFC 4918），` +
          '会连同子项一起删掉且没有二次确认。' +
          (childCount === null ? '' : `当前子项数量：${childCount}。`) +
          ' 请先列目录看清内容，确认后再以 recursive=true 重试。',
      );
    }

    await client.remove(target, { signal: signalOf(args) });
    const notes = ['删除已提交。'];
    if (target.startsWith('/') && remote.preset === '123pan') {
      notes.push('123云盘删除后有约 10 秒的最终一致性窗口：立刻复查可能读到陈旧结果，以随后的 404 为准。');
    }
    return { remote: remote.id, path: target, removed: true, wasDir: entry.isDir, note: notes.join('') };
  });
}

export async function readText(config, args = {}) {
  const target = normalizeRemotePath(args.path);
  const maxBytes = toPositiveInt(args.maxBytes, normalizePrefs(config.prefs).readMaxBytes);
  return withClient(config, args, async (client, remote) => {
    await assertNotDirectory(client, target, signalOf(args));
    const result = await client.readText(target, { maxBytes, signal: signalOf(args) });
    return { remote: remote.id, path: target, bytes: result.bytes, truncated: result.truncated, content: result.content };
  });
}

export async function url(config, args = {}) {
  const target = normalizeRemotePath(args.path ?? '/');
  return withClient(config, args, async (client, remote) => {
    const caps = await client.options({ signal: signalOf(args) }).catch(() => null);
    return {
      remote: remote.id,
      path: target,
      url: client.urlFor(target),
      dav: caps?.dav ?? '',
      note: '这是 WebDAV 直连地址（需要凭据，不是公开分享链接）。',
    };
  });
}

/**
 * 设置页用：拿一组临时凭据测连通性，不落盘。
 *
 * 两个刻意的行为：
 *   1. **允许「先测后存」**：一个网盘都还没配时，只要这次把地址/账号/密码带齐了就能测，
 *      否则用户永远没法在保存前确认地址和密码对不对（第一次配置最需要这个）。
 *   2. 表单里**留空的字段只回落到「这次明确指定的那个已保存网盘」**的凭据。
 *      以前不管测谁都用 `args.x || stored.x` 兜底，于是「新增网盘时密码留空」会拿
 *      **默认网盘的密码**去测——测的根本不是用户填的那套，还可能把好密码判成可用。
 */
export async function testCredentials(config, args = {}) {
  const env = args.env ?? process.env;
  const named = args.remote !== undefined && args.remote !== null && args.remote !== '';
  const url = args.url ? String(args.url) : '';
  const user = args.user === undefined || args.user === null ? undefined : String(args.user);
  const password = args.password === undefined || args.password === null ? undefined : String(args.password);

  let base;
  try {
    base = pickRemote(config, args.remote, env);
  } catch (err) {
    // 一个网盘都没配 / remote 写错：
    //   - 连地址都没给 → 原来的「还没有配置任何 WebDAV 远程」更贴切，如实抛出去
    //   - 给了地址但凭据不全 → 报「需要账号和密码」，这才是用户下一步该补的东西
    if (!url) throw err;
    if (!user || !password) {
      throw badRequest('测试连接需要账号和密码。若只是想在编辑时沿用已保存的密码，请选中那个网盘再测。');
    }
    base = {
      id: args.remote || 'test',
      label: '临时测试',
      preset: presetForUrl(url).id,
      url: '',
      user: '',
      password: '',
      defaultUploadDir: '',
    };
  }

  const saved = named ? base : { url: '', user: '', password: '' };
  const remote = {
    ...base,
    url: url || saved.url,
    user: user === undefined || user === '' ? saved.user : user,
    password: password === undefined || password === '' ? saved.password : password,
  };

  if (!remote.url) throw badRequest('测试连接需要 WebDAV 地址。');
  if (!remote.user || !remote.password) {
    throw badRequest('测试连接需要账号和密码。若只是想在编辑时沿用已保存的密码，请选中那个网盘再测。');
  }

  const client = clientFor(config, remote, { timeoutMs: args.timeoutMs ?? 30_000, fetchImpl: args.fetchImpl, caps: {} });
  const result = await client.check({ signal: signalOf(args) });
  return {
    ok: true,
    remote: remote.id,
    label: remote.label,
    url: result.url,
    status: result.status,
    rootCount: result.rootCount,
    dav: result.dav,
    allow: result.allow,
    server: result.server,
    propfindMode: result.propfindMode,
    capabilities: { ...client.caps },
  };
}

/* ------------------------------------------------------------------- 工具函数 */

/**
 * 下载/读取前确认目标不是目录（WebDAV 对目录 GET 的行为各服务端不一致）。
 *
 * `notWebdav` 这类错误**必须往上抛**：那说明这个地址根本没在说 WebDAV（多半被反代到了登录页），
 * 把它当成「查不到」继续往下走，就会把登录页原样下载成本地文件。
 */
async function assertNotDirectory(client, remotePath, signal) {
  const entry = await client.stat(remotePath, { signal }).catch((err) => {
    if (err?.notWebdav) throw err;
    return null;
  });
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

function parentDir(remotePath) {
  const normalized = normalizeRemotePath(remotePath);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
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
  if (err instanceof UnsupportedError) {
    return { status: err.status ?? null, message: err.message, hint: err.hint ?? '该服务端不支持这个 WebDAV 方法。' };
  }
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
    hint: err?.hint,
  };
}
