/**
 * 123云盘 WebDAV 客户端 —— 纯 Node 实现，零第三方依赖。
 *
 * 只用标准 WebDAV 动词（PROPFIND / GET / PUT / MKCOL / DELETE / MOVE）+ HTTP Basic 认证，
 * 不依赖 123 云盘的开放平台 client_id，也不需要开发者权益包。
 *
 * 凭据解析优先级（高 → 低）：
 *   1. 插件 config（cordis.patch.yml 里的 url / user / password）
 *   2. 环境变量 WEBDAV_URL / WEBDAV_USER / WEBDAV_PASSWORD
 *   3. 凭据文件（默认 ~/.config/123pan/webdav.env）
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat as fsStat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_URL = 'https://webdav.123pan.cn/webdav';
export const DEFAULT_ENV_FILE = path.join(homedir(), '.config', '123pan', 'webdav.env');
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_BIG_FILE_WARN = 200 * 1024 * 1024;
export const DEFAULT_READ_MAX_BYTES = 256 * 1024;
export const USER_AGENT = 'dsh-pan123/1.0';

/* ------------------------------------------------------------------ 错误 */

export class WebdavError extends Error {
  constructor(method, remotePath, status, body) {
    const snippet = typeof body === 'string' ? body.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    super(`${method} ${remotePath} -> HTTP ${status}${snippet ? ` ${snippet}` : ''}`);
    this.name = 'WebdavError';
    this.method = method;
    this.remotePath = remotePath;
    this.status = status;
    this.body = typeof body === 'string' ? body : '';
  }

  get notFound() {
    return this.status === 404;
  }
}

/** 把 WebDAV 状态码翻译成人话，帮模型/用户快速定位。 */
export function explainStatus(status, remotePath = '') {
  switch (status) {
    case 401:
      return 'HTTP 401：应用密码错误或被重置，或该应用授权已被删除（123云盘「工具中心-第三方挂载」）。';
    case 403:
      return 'HTTP 403：拒绝访问——可能超出授权目录范围，或会员权益/流量额度受限。';
    case 404:
      return `HTTP 404：路径不存在${remotePath ? `（${remotePath}）` : ''}，注意大小写与全角半角。`;
    case 405:
      return 'HTTP 405：该操作不被允许（例如对已存在的目录再次 MKCOL）。';
    case 409:
      return 'HTTP 409：父目录不存在。MKCOL 只建一级，请先建上级目录。';
    case 423:
      return 'HTTP 423：文件被占用（网盘端正在处理），稍后重试。';
    case 507:
      return 'HTTP 507：空间不足。';
    default:
      return `HTTP ${status}。`;
  }
}

/* -------------------------------------------------------------- 凭据解析 */

/** 解析 KEY=VALUE 形式的凭据文件内容。 */
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

/**
 * 解析出 { url, user, password, sources }；缺少任一必填项时抛出可读错误。
 * 优先级（高 → 低）：插件 config > 设置页保存的 settings > 环境变量 > 凭据文件 > 内置默认地址。
 * @param {{url?:string,user?:string,password?:string,envFile?:string,settings?:object}} config
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function resolveCredentials(config = {}, env = process.env) {
  const sources = {};
  const resolved = { url: '', user: '', password: '' };

  const fromEnv = {
    url: env.WEBDAV_URL,
    user: env.WEBDAV_USER,
    password: env.WEBDAV_PASSWORD,
  };
  for (const key of ['url', 'user', 'password']) {
    if (fromEnv[key]) {
      resolved[key] = String(fromEnv[key]);
      sources[key] = 'env';
    }
  }

  // 设置页保存的偏好在环境变量之后、插件 config 之前生效
  const fromSettings = config.settings ?? {};
  for (const key of ['url', 'user', 'password']) {
    if (fromSettings[key]) {
      resolved[key] = String(fromSettings[key]);
      sources[key] = 'settings';
    }
  }

  const explicit = {
    url: config.url,
    user: config.user,
    password: config.password,
  };
  for (const key of ['url', 'user', 'password']) {
    if (explicit[key]) {
      resolved[key] = String(explicit[key]);
      sources[key] = 'config';
    }
  }

  const needFile = !resolved.url || !resolved.user || !resolved.password;
  const envFile = config.envFile ? path.resolve(expandHome(String(config.envFile))) : DEFAULT_ENV_FILE;
  if (needFile) {
    const { readFile } = await import('node:fs/promises');
    let text = null;
    try {
      text = await readFile(envFile, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
    if (text !== null) {
      const parsed = parseEnvText(text);
      const fromFile = {
        url: parsed.WEBDAV_URL,
        user: parsed.WEBDAV_USER,
        password: parsed.WEBDAV_PASSWORD,
      };
      for (const key of ['url', 'user', 'password']) {
        if (!resolved[key] && fromFile[key]) {
          resolved[key] = fromFile[key];
          sources[key] = 'file';
        }
      }
    }
  }

  if (!resolved.url) resolved.url = DEFAULT_URL;

  const missing = ['user', 'password'].filter((key) => !resolved[key]);
  if (missing.length > 0) {
    throw new Error(
      `缺少 123云盘 WebDAV 凭据: ${missing.join(', ')}。\n` +
        `请打开 DSH 设置 → 123云盘 填写账号与应用密码（推荐），` +
        `或设置环境变量 WEBDAV_USER / WEBDAV_PASSWORD，或写入凭据文件 ${envFile}：\n` +
        '  WEBDAV_URL=https://webdav.123pan.cn/webdav\n' +
        '  WEBDAV_USER=<手机号>\n' +
        '  WEBDAV_PASSWORD=<应用密码>\n' +
        '凭据禁止写入记忆、聊天正文或任何会同步的位置。',
    );
  }

  return { url: resolved.url, user: resolved.user, password: resolved.password, sources, envFile };
}

export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2));
  return p;
}

/* ------------------------------------------------------------ 路径与 XML */

/**
 * 规范化远端路径：统一斜杠、去掉空段、拒绝 `.` 与 `..`（防止越出授权目录）。
 * @returns {string} 以 '/' 开头且不以 '/' 结尾（根目录为 '/'）
 */
export function normalizeRemotePath(input) {
  const raw = String(input ?? '').trim().replace(/\\/g, '/');
  const segments = raw.split('/').filter((seg) => seg.length > 0);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') throw new Error(`非法远端路径（不允许 . 或 .. 段）: ${input}`);
  }
  return `/${segments.join('/')}`;
}

/** 逐段 URL 编码（远端路径里的中文/空格由这里处理，调用方不要手工编码）。 */
export function encodeRemotePath(input) {
  const normalized = normalizeRemotePath(input);
  if (normalized === '/') return '';
  return normalized
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export function decodeXmlEntities(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    switch (entity.toLowerCase()) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'nbsp':
        return '\u00a0';
      default:
        return match;
    }
  });
}

function safeFromCodePoint(code, fallback) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

const RESPONSE_RE = /<(?:\w+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?response>/gi;
const HREF_RE = /<(?:\w+:)?href(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?href>/i;
const COLLECTION_RE = /<(?:\w+:)?collection(?:\s[^>]*)?\/?>/i;
const CONTENT_LENGTH_RE = /<(?:\w+:)?getcontentlength(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?getcontentlength>/i;
const LAST_MODIFIED_RE = /<(?:\w+:)?getlastmodified(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?getlastmodified>/i;
const DISPLAY_NAME_RE = /<(?:\w+:)?displayname(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?displayname>/i;

function safeDecodeURI(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 把 WebDAV 响应里的 href 折算成不含 WebDAV 基路径的远端路径（已解码）。 */
export function hrefToRemotePath(rawHref, basePath = '') {
  let href = decodeXmlEntities(rawHref).trim();
  if (!href) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(href)) {
    try {
      href = new URL(href).pathname;
    } catch {
      /* 保持原样 */
    }
  }
  const queryless = href.split('?')[0];
  let trimmed = queryless;
  const base = basePath.replace(/\/+$/, '');
  if (base && (trimmed === base || trimmed.startsWith(`${base}/`))) trimmed = trimmed.slice(base.length);
  if (!trimmed.startsWith('/')) trimmed = `/${trimmed}`;
  trimmed = trimmed.replace(/\/{2,}/g, '/');
  const decoded = safeDecodeURI(trimmed);
  if (decoded.length > 1) return decoded.replace(/\/+$/, '');
  return '/';
}

/**
 * 解析 207 Multi-Status 响应体。刻意用容错的正则而不是 XML 依赖：
 * WebDAV 响应结构固定且浅，各服务端的命名空间前缀不一致（d: / D: / lp1: / 无前缀）。
 * @returns {Array<{name:string,path:string,isDir:boolean,size:number|null,mtime:string}>}
 */
export function parseMultiStatus(xmlText, basePath = '') {
  const entries = [];
  const text = String(xmlText ?? '');
  for (const match of text.matchAll(RESPONSE_RE)) {
    const block = match[1];
    const hrefMatch = HREF_RE.exec(block);
    if (!hrefMatch) continue;
    const remotePath = hrefToRemotePath(hrefMatch[1], basePath);
    if (remotePath === null) continue;

    const isDir = COLLECTION_RE.test(block);
    const sizeText = CONTENT_LENGTH_RE.exec(block)?.[1]?.trim() ?? '';
    const mtimeText = LAST_MODIFIED_RE.exec(block)?.[1]?.trim() ?? '';
    const displayName = DISPLAY_NAME_RE.exec(block)?.[1]?.trim();
    const segments = remotePath.split('/').filter(Boolean);
    const fallbackName = segments.length > 0 ? segments[segments.length - 1] : '/';
    const name = displayName ? decodeXmlEntities(displayName) : fallbackName;

    entries.push({
      name,
      path: remotePath,
      isDir,
      size: /^\d+$/.test(sizeText) ? Number.parseInt(sizeText, 10) : null,
      mtime: mtimeText,
    });
  }
  return entries;
}

/** 目录在前，然后按名称不区分大小写排序。 */
export function compareEntries(a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base', numeric: true });
}

function sameRemotePath(a, b) {
  const left = a.length > 1 ? a.replace(/\/+$/, '') : a;
  const right = b.length > 1 ? b.replace(/\/+$/, '') : b;
  return left === right;
}

/* ------------------------------------------------------------------ 客户端 */

export class WebdavClient {
  /**
   * @param {{url:string,user:string,password:string,timeoutMs?:number,fetchImpl?:typeof fetch}} options
   */
  constructor(options) {
    const { url, user, password } = options;
    if (!url) throw new Error('WebdavClient 需要 url');
    this.baseUrl = String(url).replace(/\/+$/, '');
    this.user = user;
    this.password = password;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('缺少 fetch 实现（需要 Node 20.3+）');
    this.auth = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

    let basePath = '';
    try {
      basePath = new URL(this.baseUrl).pathname;
    } catch {
      throw new Error(`WEBDAV_URL 不是合法 URL: ${url}`);
    }
    this.basePath = basePath.replace(/\/+$/, '');
  }

  urlFor(remotePath = '/') {
    const encoded = encodeRemotePath(remotePath);
    return encoded ? `${this.baseUrl}/${encoded}` : `${this.baseUrl}/`;
  }

  async request(method, remotePath, options = {}) {
    const { headers = {}, body, signal, timeoutMs } = options;
    const timeout = timeoutMs ?? this.timeoutMs;
    const signals = [];
    if (typeof AbortSignal.timeout === 'function' && timeout > 0) signals.push(AbortSignal.timeout(timeout));
    if (signal) signals.push(signal);
    const init = {
      method,
      headers: { Authorization: this.auth, 'User-Agent': USER_AGENT, ...headers },
      redirect: 'follow',
    };
    if (signals.length === 1) init.signal = signals[0];
    else if (signals.length > 1 && typeof AbortSignal.any === 'function') init.signal = AbortSignal.any(signals);
    if (body !== undefined) {
      init.body = body;
      // Node 的 fetch 用流做请求体时必须声明半双工。
      if (body && typeof body.pipe === 'function') init.duplex = 'half';
    }
    return this.fetchImpl(this.urlFor(remotePath), init);
  }

  /** PROPFIND，返回原始 XML 文本。 */
  async propfind(remotePath, depth = 1, options = {}) {
    const target = normalizeRemotePath(remotePath);
    const res = await this.request('PROPFIND', target, {
      headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      signal: options.signal,
    });
    const text = await res.text();
    if (res.status !== 207 && res.status !== 200) {
      const error = new WebdavError('PROPFIND', target, res.status, text);
      error.hint = explainStatus(res.status, target);
      throw error;
    }
    return text;
  }

  /** 列目录（Depth: 1），不含目录自身。 */
  async list(remotePath = '/', options = {}) {
    const target = normalizeRemotePath(remotePath);
    const entries = parseMultiStatus(await this.propfind(target, 1, options), this.basePath);
    return entries.filter((entry) => !sameRemotePath(entry.path, target)).sort(compareEntries);
  }

  /** 查单个条目；不存在返回 null（404 是可靠的“不存在”信号）。 */
  async stat(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    const res = await this.request('PROPFIND', target, {
      headers: { Depth: '0' },
      signal: options.signal,
    });
    if (res.status === 404) return null;
    const text = await res.text();
    if (res.status !== 207 && res.status !== 200) {
      const error = new WebdavError('PROPFIND', target, res.status, text);
      error.hint = explainStatus(res.status, target);
      throw error;
    }
    const entries = parseMultiStatus(text, this.basePath);
    if (entries.length === 0) return null;
    return entries.find((entry) => sameRemotePath(entry.path, target)) ?? entries[0];
  }

  async exists(remotePath, options = {}) {
    return (await this.stat(remotePath, options)) !== null;
  }

  /** 下载远端文件到本地文件（流式）。 */
  async download(remotePath, localPath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    if (!localPath) throw new Error('download 需要 localPath');
    const absolute = path.resolve(localPath);
    const existing = await fsStat(absolute).catch(() => null);
    if (existing?.isDirectory()) throw new Error(`本地目标是目录，请给出完整文件名: ${absolute}`);
    await mkdir(path.dirname(absolute), { recursive: true });

    const res = await this.request('GET', target, { signal: options.signal });
    if (res.status !== 200 || !res.body) {
      const body = await res.text().catch(() => '');
      const error = new WebdavError('GET', target, res.status, body);
      error.hint = explainStatus(res.status, target);
      throw error;
    }
    try {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(absolute));
    } catch (err) {
      await unlink(absolute).catch(() => {});
      throw err;
    }
    const info = await fsStat(absolute);
    return { bytes: info.size, localPath: absolute };
  }

  /** 上传本地文件到远端完整文件路径（流式，PUT 会自动创建缺失的远端目录）。 */
  async upload(localPath, remoteFilePath, options = {}) {
    const absolute = path.resolve(expandHome(String(localPath)));
    const info = await fsStat(absolute).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`本地文件不存在或不是文件: ${absolute}`);
    const target = normalizeRemotePath(remoteFilePath);
    if (target === '/') throw new Error('上传目标必须是文件路径，不能是根目录');
    const res = await this.request('PUT', target, {
      headers: { 'Content-Length': String(info.size), 'Content-Type': 'application/octet-stream' },
      body: createReadStream(absolute),
      signal: options.signal,
    });
    if (![200, 201, 204].includes(res.status)) {
      const body = await res.text().catch(() => '');
      const error = new WebdavError('PUT', target, res.status, body);
      error.hint = explainStatus(res.status, target);
      throw error;
    }
    return { bytes: info.size, remotePath: target, localPath: absolute };
  }

  /** MKCOL：只建一级，父目录不存在会 409。 */
  async mkdir(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    if (target === '/') throw new Error('根目录已存在，无需创建');
    const res = await this.request('MKCOL', target, { signal: options.signal });
    if (![200, 201, 204].includes(res.status)) {
      const body = await res.text().catch(() => '');
      const error = new WebdavError('MKCOL', target, res.status, body);
      error.hint = explainStatus(res.status, target);
      throw error;
    }
    return { remotePath: target };
  }

  /** MOVE：移动或重命名，Overwrite: T 覆盖同名目标。 */
  async move(from, to, options = {}) {
    const source = normalizeRemotePath(from);
    const destination = normalizeRemotePath(to);
    const res = await this.request('MOVE', source, {
      headers: { Destination: this.urlFor(destination), Overwrite: 'T' },
      signal: options.signal,
    });
    if (![200, 201, 204].includes(res.status)) {
      const body = await res.text().catch(() => '');
      const error = new WebdavError('MOVE', source, res.status, body);
      error.hint = explainStatus(res.status, source);
      throw error;
    }
    return { from: source, to: destination };
  }

  /** DELETE：123云盘对目录是**递归删除**，调用方必须先确认。 */
  async remove(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    if (target === '/') throw new Error('拒绝删除根目录');
    const res = await this.request('DELETE', target, { signal: options.signal });
    if (![200, 202, 204].includes(res.status)) {
      const body = await res.text().catch(() => '');
      const error = new WebdavError('DELETE', target, res.status, body);
      error.hint = explainStatus(res.status, target);
      throw error;
    }
    return { remotePath: target };
  }

  /** 读远端小文件正文到内存（有上限，避免把大文件灌进上下文）。 */
  async readText(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    const limit = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_READ_MAX_BYTES;
    const res = await this.request('GET', target, { signal: options.signal });
    if (res.status !== 200 || !res.body) {
      const body = await res.text().catch(() => '');
      const error = new WebdavError('GET', target, res.status, body);
      error.hint = explainStatus(res.status, target);
      throw error;
    }
    const chunks = [];
    let total = 0;
    let truncated = false;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      if (total + buf.length >= limit) {
        chunks.push(buf.subarray(0, Math.max(0, limit - total)));
        total = limit;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }
    return { content: Buffer.concat(chunks).toString('utf8'), bytes: total, truncated };
  }

  /** 连通性自检。 */
  async check(options = {}) {
    const res = await this.request('PROPFIND', '/', { headers: { Depth: '0' }, signal: options.signal });
    await res.text().catch(() => '');
    if (res.status !== 207 && res.status !== 200) {
      const error = new WebdavError('PROPFIND', '/', res.status, '');
      error.hint = explainStatus(res.status, '/');
      throw error;
    }
    const entries = await this.list('/', options);
    return { url: this.baseUrl, status: res.status, rootCount: entries.length };
  }
}

/** 便捷工厂：解析凭据 + 建客户端。 */
export async function openClient(config = {}, env = process.env) {
  const credentials = await resolveCredentials(config, env);
  const client = new WebdavClient({
    url: credentials.url,
    user: credentials.user,
    password: credentials.password,
    timeoutMs: config.timeoutMs,
    fetchImpl: config.fetchImpl,
  });
  return { client, credentials };
}

export function humanSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  for (const unit of units) {
    if (value < 1024 || unit === 'TB') {
      return unit === 'B' ? `${Math.round(value)}B` : `${value.toFixed(1)}${unit}`;
    }
    value /= 1024;
  }
  return `${value}`;
}
