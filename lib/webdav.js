/**
 * 通用 WebDAV 客户端 —— 纯 Node 实现，零第三方依赖，**不绑定任何服务商**。
 *
 * 只用标准 WebDAV 动词（PROPFIND / GET / PUT / MKCOL / DELETE / MOVE / COPY / OPTIONS）
 * + HTTP Basic 认证。任何遵循 RFC 4918 的服务端都能用：
 * 123云盘、坚果云、Nextcloud/ownCloud、群晖 DSM、飞牛 fnOS、极空间、Alist/OpenList、
 * Seafile、InfiniCLOUD、Koofr、Box、Yandex Disk…（内置预设见 lib/presets.js）
 *
 * 互操作上刻意做过的「脏活」（都是被真实服务端逼出来的）：
 *   1. PROPFIND 先带显式 <prop> body；服务端不吃（400/403/405/415/501）就自动退回无 body 的 allprop。
 *   2. 207 解析认命名空间前缀（d: / D: / lp1: / 无前缀）、认得 href 是绝对 URI 或相对路径。
 *   3. **多 propstat 取值**：只在状态为 2xx 的 propstat 段里取属性值，避免读到 404 段里的空元素。
 *   4. **重定向守卫**：PROPFIND 返回 200 但不是 multistatus（常见于被反代到登录页）直接报错，
 *      否则会被误判成「空目录」，这是最难查的一类故障。
 *   5. **MOVE 撞名自愈**：RFC 的 Overwrite 头不是所有服务端都认（123云盘撞名一律 500），
 *      所以失败时先确认源存在（防止误删目标），再删目标重试；MOVE 完全不支持时退到 COPY+DELETE。
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat as fsStat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_BIG_FILE_WARN = 200 * 1024 * 1024;
export const DEFAULT_READ_MAX_BYTES = 256 * 1024;
export const USER_AGENT = 'dsh-webdav/0.4';

/* ------------------------------------------------------------------ 错误 */

export class WebdavError extends Error {
  constructor(method, remotePath, status, body, options = {}) {
    const snippet = typeof body === 'string' ? body.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    // 服务端把 XML/HTML 当错误页返回时，别把它塞进一行错误消息里
    const printable = /^<[!?]|<\w+[\s>]/.test(snippet) ? '' : snippet;
    super(`${method} ${remotePath} -> HTTP ${status}${printable ? ` ${printable}` : ''}`);
    this.name = 'WebdavError';
    this.method = method;
    this.remotePath = remotePath;
    this.status = status;
    this.body = typeof body === 'string' ? body : '';
    if (options.hint) this.hint = options.hint;
  }

  get notFound() {
    return this.status === 404;
  }
}

/** 服务端不支持某个 WebDAV 方法（MOVE / COPY / LOCK…）时抛这个，便于上层给替代方案。 */
export class UnsupportedError extends Error {
  constructor(method, message, options = {}) {
    super(message ?? `该 WebDAV 服务端不支持 ${method}`);
    this.name = 'UnsupportedError';
    this.method = method;
    this.status = options.status ?? null;
    if (options.hint) this.hint = options.hint;
  }
}

/**
 * 把 WebDAV 状态码翻译成人话。**刻意不假设是哪家服务商**：
 * 各家对同一件事的状态码并不一致（123云盘就用 500 表示「路径不存在」「目标已存在」这类用户错误）。
 */
export function explainStatus(status, remotePath = '') {
  switch (status) {
    case 400:
      return 'HTTP 400：请求被拒绝——地址可能写错，或该服务端不接受这种 PROPFIND 请求体。';
    case 401:
      return 'HTTP 401：认证失败。账号或密码不对/已失效；有些服务商要求用「应用密码」而不是登录密码。';
    case 403:
      return 'HTTP 403：拒绝访问——权限不足、超出授权目录，或该账号未开通 WebDAV 权限。';
    case 404:
      return `HTTP 404：路径不存在${remotePath ? `（${remotePath}）` : ''}，注意大小写与全角半角。`;
    case 405:
      return 'HTTP 405：该操作不被允许（服务端可能不支持这个 WebDAV 方法，或不允许对目标做此操作）。';
    case 409:
      return 'HTTP 409：父目录不存在或目标冲突（MKCOL 只建一级，需先建上级目录）。';
    case 412:
      return 'HTTP 412：目标已存在且服务端不接受覆盖（Overwrite 头被拒绝）。';
    case 423:
      return 'HTTP 423：资源被锁定（服务端正在处理，或被其它客户端占用），稍后重试。';
    case 429:
      return 'HTTP 429：请求太频繁，被服务端限流，稍后重试。';
    case 499:
      return 'HTTP 499：请求被中断（多半是本机取消了操作）。';
    case 500:
      return 'HTTP 500：服务端内部错误。注意有些服务端（如 123云盘）用它表示「路径不存在 / 目标已存在 / 父目录不存在」等用户错误。';
    case 502:
    case 503:
    case 504:
      return `HTTP ${status}：服务端或网关不可用（连不上、超时或被反代拦截），稍后重试。`;
    case 507:
      return 'HTTP 507：空间不足。';
    default:
      return `HTTP ${status}。`;
  }
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
const PROPSTAT_RE = /<(?:\w+:)?propstat(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?propstat>/gi;
const STATUS_RE = /<(?:\w+:)?status(?:\s[^>]*)?>\s*HTTP\/[\d.]+\s+(\d{3})/i;
const MULTISTATUS_RE = /<(?:\w+:)?multistatus[\s>]/i;

/** 属性名 → 该属性的匹配正则（懒加载缓存）。 */
const propReCache = new Map();
function propRe(localName) {
  let re = propReCache.get(localName);
  if (!re) {
    re = new RegExp(`<(?:\\w+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${localName}>`, 'i');
    propReCache.set(localName, re);
  }
  return re;
}

/**
 * 在一条 <response> 块里取属性值。
 *
 * 关键点：只在**状态为 2xx 的 propstat 段**里取值。
 * 服务端对不支持的属性会回一个 404 propstat 并在里面放同名空元素
 * （123云盘就是这样），而 propstat 的先后顺序并不保证 —— 只取「第一个匹配」会静默读到空值。
 */
export function pickProp(block, localName) {
  const re = propRe(localName);
  let fallback = null;
  let sawPropstat = false;
  for (const match of String(block).matchAll(PROPSTAT_RE)) {
    sawPropstat = true;
    const segment = match[1];
    const hit = re.exec(segment);
    if (!hit) continue;
    const value = hit[1].trim();
    const status = STATUS_RE.exec(segment)?.[1];
    const ok = status === undefined || (Number(status) >= 200 && Number(status) < 300);
    if (ok && value !== '') return value;
    if (fallback === null) fallback = value;
  }
  if (!sawPropstat) {
    // 简化实现可能不给 propstat 包裹，直接在整块里找
    const direct = re.exec(String(block));
    return direct ? direct[1].trim() : null;
  }
  return fallback;
}

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
 * WebDAV 响应结构固定且浅，各服务端的命名空间前缀不一致（d: / D: / lp1: / 无前缀 / 默认命名空间）。
 * @returns {Array<{name:string,path:string,isDir:boolean,size:number|null,mtime:string,etag:string,contentType:string}>}
 */
export function parseMultiStatus(xmlText, basePath = '') {
  const entries = [];
  const text = String(xmlText ?? '');
  for (const match of text.matchAll(RESPONSE_RE)) {
    const block = match[1];
    const hrefMatch = HREF_RE.exec(block);
    if (!hrefMatch) continue;
    const rawHref = decodeXmlEntities(hrefMatch[1]);
    const remotePath = hrefToRemotePath(hrefMatch[1], basePath);
    if (remotePath === null) continue;

    // 目录判定：优先看 resourcetype（只在 2xx propstat 里取）；拿不到就退回 href 结尾的 '/'
    const resourceType = pickProp(block, 'resourcetype');
    const isDir = resourceType !== null ? /collection/i.test(resourceType) : /\/\s*$/.test(rawHref);

    const sizeText = pickProp(block, 'getcontentlength') ?? '';
    const displayName = pickProp(block, 'displayname');
    const segments = remotePath.split('/').filter(Boolean);
    const fallbackName = segments.length > 0 ? segments[segments.length - 1] : '/';
    const name = displayName ? decodeXmlEntities(displayName) : fallbackName;

    entries.push({
      name,
      path: remotePath,
      isDir,
      size: /^\d+$/.test(sizeText) ? Number.parseInt(sizeText, 10) : null,
      mtime: pickProp(block, 'getlastmodified') ?? '',
      etag: pickProp(block, 'getetag') ?? '',
      contentType: pickProp(block, 'getcontenttype') ?? '',
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

/** 「拿到的不是 WebDAV 响应」——最容易被误判成空目录，所以单独构造一个带 notWebdav 标记的错误。 */
function notWebdavError(method, remotePath, status, detail = '') {
  const error = new WebdavError(method, remotePath, status, '');
  error.hint =
    '服务端返回的不是 WebDAV 响应' +
    (detail ? `（${detail}）` : '（没有 multistatus）') +
    '。多半是地址写错了、被反向代理重定向到了登录页，或者这个地址根本不是 WebDAV 端点。';
  error.notWebdav = true;
  return error;
}

/**
 * 登录页守卫。
 *
 * 为什么**不能**按「最终 URL 换了路径」判断：把下载重定向到签名 CDN 是完全正常的 WebDAV 实现方式。
 * 实测 123云盘每次 GET 都 302 到 `vip-download-cdn...` 并带上签名参数，正文是正儿八经的文件字节
 * （content-type 是 `binary/octet-stream`）。按 URL 判断会把这条**正常**路径全部拦死。
 *
 * 所以只认内容特征：正文开头就是一份 HTML 文档，那它显然不是我们要的那个文件。
 * 用户明确要 `.html` 文件时不拦（否则就没法下载网页了）。
 */
export function looksLikeLoginPage(headText, remotePath = '') {
  if (/\.html?$/i.test(String(remotePath))) return false;
  return /^<!doctype\s+html|^<html[\s>]/i.test(String(headText ?? '').trim());
}

const LOGIN_PAGE_DETAIL = '回来的是一份 HTML 文档而不是文件内容，多半是被反向代理到了登录页';

/**
 * 先读一小段正文做「是不是登录页」判断，再把**已读部分和剩余流拼成一条新流**返回。
 * 注意返回的流是完整的（含已读的那一段），调用方不要再单独处理 head，否则会重复计数。
 */
async function guardGetBody(res, method, remotePath) {
  const reader = res.body.getReader();
  const first = await reader.read();
  const head = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
  if (looksLikeLoginPage(head.subarray(0, 256).toString('utf8'), remotePath)) {
    await reader.cancel().catch(() => {});
    throw notWebdavError(method, remotePath, res.status, LOGIN_PAGE_DETAIL);
  }
  return Readable.from(
    (async function* replay() {
      if (head.length > 0) yield head;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield Buffer.from(value);
      }
    })(),
  );
}

/** 源不存在：明确告诉用户「没有对目标做任何改动」，这在撞名自愈的路径上尤其重要。 */
function sourceMissing(source) {
  const error = new WebdavError('MOVE', source, 404, '');
  error.hint = `源路径 ${source} 不存在，未对目标做任何改动。`;
  return error;
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

/** 显式声明要取的属性：比 allprop 更省流量，也是喂给「要求 body 的服务端」的那份请求体。 */
export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<D:propfind xmlns:D="DAV:"><D:prop>' +
  '<D:resourcetype/><D:displayname/><D:getcontentlength/><D:getlastmodified/>' +
  '<D:getcontenttype/><D:getetag/><D:quota-available-bytes/><D:quota-used-bytes/>' +
  '</D:prop></D:propfind>';

/** 用「不改动目标」的方式失败后，值得试一次「删目标再重试」的状态码。 */
const MOVE_CONFLICT_STATUSES = new Set([409, 412, 500, 403]);
/** 服务端明确不支持该方法。 */
const UNSUPPORTED_STATUSES = new Set([405, 501]);

/* ------------------------------------------------------------------ 客户端 */

export class WebdavClient {
  /**
   * @param {{url:string,user:string,password:string,timeoutMs?:number,fetchImpl?:typeof fetch,
   *          propfindMode?:'body'|'nobody', caps?:object}} options
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
    this.caps = options.caps && typeof options.caps === 'object' ? { ...options.caps } : {};
    this.propfindMode = options.propfindMode ?? this.caps.propfindMode ?? 'body';

    let basePath = '';
    try {
      basePath = new URL(this.baseUrl).pathname;
    } catch {
      throw new Error(`WebDAV 地址不是合法 URL: ${url}`);
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

  /** OPTIONS：拿 DAV 等级与 Allow（仅作参考——实测有服务端的 Allow 头是错的）。 */
  async options(options = {}) {
    const res = await this.request('OPTIONS', '/', { signal: options.signal });
    const info = {
      status: res.status,
      dav: res.headers.get('dav') ?? '',
      allow: res.headers.get('allow') ?? '',
      server: res.headers.get('server') ?? '',
    };
    await res.text().catch(() => '');
    return info;
  }

  /**
   * PROPFIND 的底层实现，返回 `{status, text}`。
   * 先按 propfindMode 发；服务端不吃显式 body（400/403/405/415/501）就自动退回无 body 并记住这个选择。
   * list / stat / check 全走这里，保证「要不要带 body」这件事只在一处决策。
   */
  async propfindRaw(target, depth, options = {}) {
    const send = (withBody) =>
      this.request('PROPFIND', target, {
        headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
        body: withBody ? PROPFIND_BODY : undefined,
        signal: options.signal,
      });

    // 这次到底带没带 body，必须先记下来：只有「带了 body 还成功」才能证明这个服务端吃 body。
    // 早期版本这里只看状态码，结果「已经学到 nobody」的客户端发一次无 body 的成功请求就把它翻回
    // body，下一次又白挨一个 400 —— 能力缓存在两者之间来回翻转。
    const sentBody = this.propfindMode !== 'nobody';
    let res = await send(sentBody);
    if (sentBody && [400, 403, 405, 415, 501].includes(res.status)) {
      await res.text().catch(() => '');
      res = await send(false);
      if (res.status === 207 || res.status === 200) {
        this.propfindMode = 'nobody';
        this.caps.propfindMode = 'nobody';
      }
    } else if (sentBody && res.status === 207) {
      this.propfindMode = 'body';
      this.caps.propfindMode = 'body';
    }
    return { status: res.status, text: await res.text() };
  }

  /**
   * PROPFIND，返回原始 XML 文本。
   * 200 而正文不是 multistatus 的情况必须拦住：典型场景是被反代/服务端重定向到登录页，
   * 不拦的话上层会把「没有 response 元素」理解成空目录——最难排查的一类故障。
   */
  async propfind(remotePath, depth = 1, options = {}) {
    const target = normalizeRemotePath(remotePath);
    const { status, text } = await this.propfindRaw(target, depth, options);
    if (status !== 207 && status !== 200) {
      const error = new WebdavError('PROPFIND', target, status, text);
      error.hint = explainStatus(status, target);
      throw error;
    }
    if (!MULTISTATUS_RE.test(text)) {
      throw notWebdavError('PROPFIND', target, status);
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
    const { status, text } = await this.propfindRaw(target, 0, options);
    if (status === 404) return null;
    if (status !== 207 && status !== 200) {
      const error = new WebdavError('PROPFIND', target, status, text);
      error.hint = explainStatus(status, target);
      throw error;
    }
    if (!MULTISTATUS_RE.test(text)) throw notWebdavError('PROPFIND', target, status);
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
    const body = await guardGetBody(res, 'GET', target);
    try {
      await pipeline(body, createWriteStream(absolute));
    } catch (err) {
      await unlink(absolute).catch(() => {});
      throw err;
    }
    const info = await fsStat(absolute);
    return { bytes: info.size, localPath: absolute };
  }

  /**
   * 上传本地文件到远端完整文件路径（流式）。
   * PUT 是否会自动创建缺失的父目录**各家不一**：123云盘会，多数服务端返回 409。
   * 所以这里失败时补一次「逐级 MKCOL 再重试」；已知不支持自动建目录（caps.putAutoMkdir === false）时直接先建。
   */
  async upload(localPath, remoteFilePath, options = {}) {
    const absolute = path.resolve(expandHome(String(localPath)));
    const info = await fsStat(absolute).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`本地文件不存在或不是文件: ${absolute}`);
    const target = normalizeRemotePath(remoteFilePath);
    if (target === '/') throw new Error('上传目标必须是文件路径，不能是根目录');
    const parent = parentDir(target);

    const created = [];
    let autoCreated = false;
    if (this.caps.putAutoMkdir === false && options.autoCreateDirs !== false) {
      created.push(...(await this.ensureDirs(parent, { signal: options.signal })));
    }

    let res = await this.put(absolute, target, info.size, options);
    if (![200, 201, 204].includes(res.status) && [404, 409, 424].includes(res.status) && options.autoCreateDirs !== false) {
      await res.text().catch(() => '');
      created.push(...(await this.ensureDirs(parent, { signal: options.signal })));
      autoCreated = true;
      res = await this.put(absolute, target, info.size, options);
    }
    if (![200, 201, 204].includes(res.status)) {
      const body = await res.text().catch(() => '');
      const error = new WebdavError('PUT', target, res.status, body);
      error.hint = explainStatus(res.status, target);
      throw error;
    }
    const tail = await res.text().catch(() => '');
    if (looksLikeLoginPage(tail.slice(0, 256), target)) {
      throw notWebdavError('PUT', target, res.status, LOGIN_PAGE_DETAIL);
    }
    if (autoCreated) this.caps.putAutoMkdir = false;
    return { bytes: info.size, remotePath: target, localPath: absolute, createdDirs: created };
  }

  put(absolutePath, target, size, options = {}) {
    return this.request('PUT', target, {
      headers: { 'Content-Length': String(size), 'Content-Type': 'application/octet-stream' },
      body: createReadStream(absolutePath),
      signal: options.signal,
    });
  }

  /** MKCOL：只建一级，父目录不存在会 409。 */
  async mkdir(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    if (target === '/') throw new Error('根目录已存在，无需创建');
    const res = await this.request('MKCOL', target, { signal: options.signal });
    const body = [200, 201, 204].includes(res.status) ? '' : await res.text().catch(() => '');
    if (![200, 201, 204].includes(res.status)) {
      const error = new WebdavError('MKCOL', target, res.status, body);
      error.hint = explainStatus(res.status, target);
      throw error;
    }
    return { remotePath: target };
  }

  /**
   * 逐级确保目录存在（MKCOL 只建一级，所以必须从根往下走）。
   * @returns {Promise<string[]>} 本次新建的目录路径
   */
  async ensureDirs(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    const created = [];
    let acc = '';
    for (const segment of target.split('/').filter(Boolean)) {
      acc += `/${segment}`;
      const entry = await this.stat(acc, { signal: options.signal });
      if (entry) {
        if (!entry.isDir) throw new Error(`远端 ${acc} 已存在且不是目录，无法作为上传目标`);
        continue;
      }
      try {
        await this.mkdir(acc, { signal: options.signal });
        created.push(acc);
      } catch (err) {
        // 409/405：并发下已被别人建好，或服务端语义不同——交给下一轮 stat 判定
        if (![405, 409].includes(err?.status)) throw err;
      }
    }
    return created;
  }

  /**
   * MOVE：移动或重命名。
   *
   * 服务端差异在这里被消化掉，顺序很重要——任何一步都不许动用户的数据：
   *   1. 已知这个服务端不认 Overwrite（caps.moveOverwrite === false）且目标已存在：
   *      直接走「先删目标再移动」，省掉一次注定失败的请求。**但删之前必须先确认源存在。**
   *   2. 否则先正常 MOVE，失败后再补救：
   *      a. 确认**源存在**。服务端可能用 500 表示「源不存在」（123云盘就是这样），
   *         不确认就直接删目标，会变成「删了目标又没搬成」的静默数据丢失。
   *      b. 目标存在且状态码属于「撞名冲突」→ 删掉目标再试一次（123云盘撞名一律 500）。
   *      c. MOVE 本身不被支持（405/501）→ 退到 COPY + DELETE；COPY 也不行就抛 UnsupportedError。
   */
  async move(from, to, options = {}) {
    const source = normalizeRemotePath(from);
    const destination = normalizeRemotePath(to);
    if (source === '/') throw new Error('拒绝移动根目录');
    if (destination === '/') throw new Error('拒绝把条目移动到根目录（目标是完整的新路径）');

    if (this.caps.moveOverwrite === false && options.overwrite !== false) {
      const shortcut = await this.replaceMove(source, destination, options).catch((err) => {
        if (err instanceof WebdavError && err.status === 404) throw err; // 源不存在：如实报错
        return null; // 其他情况退回常规路径，别把自愈搞成死路
      });
      if (shortcut) return shortcut;
    }

    try {
      return await this.moveOnce(source, destination, options);
    } catch (err) {
      const status = err?.status;
      const sourceExists = await this.exists(source, { signal: options.signal }).catch(() => false);
      if (!sourceExists) throw sourceMissing(source);

      const destExists = await this.exists(destination, { signal: options.signal }).catch(() => false);
      if (destExists && MOVE_CONFLICT_STATUSES.has(status)) {
        // 走到这里已经确认过「源在、目标也在」，直接删目标重试，不必再查一遍。
        this.caps.moveOverwrite = false; // 记下来，下次少一次注定失败的请求
        await this.remove(destination, { signal: options.signal });
        const result = await this.moveOnce(source, destination, options);
        return { ...result, replaced: true };
      }

      if (UNSUPPORTED_STATUSES.has(status)) {
        try {
          await this.copy(source, destination, { signal: options.signal });
          await this.remove(source, { signal: options.signal });
          return { from: source, to: destination, via: 'copy+delete' };
        } catch {
          throw new UnsupportedError('MOVE', `该服务端不支持 MOVE，且 COPY 也不可用：无法在服务端移动 ${source}`, {
            status,
            hint: '改用下载到本机再上传到目标位置。',
          });
        }
      }
      throw err;
    }
  }

  /**
   * 「先删目标再移动」。只有在**确认源存在**之后才允许删目标，
   * 否则一次拼错的源路径就会变成静默的数据丢失。目标不存在时什么都不做，返回 null。
   */
  async replaceMove(source, destination, options = {}) {
    const destExists = await this.exists(destination, { signal: options.signal }).catch(() => false);
    if (!destExists) return null;
    const sourceExists = await this.exists(source, { signal: options.signal }).catch(() => false);
    if (!sourceExists) throw sourceMissing(source);
    await this.remove(destination, { signal: options.signal });
    const result = await this.moveOnce(source, destination, options);
    this.caps.moveOverwrite = false;
    return { ...result, replaced: true };
  }

  async moveOnce(source, destination, options = {}) {
    const res = await this.request('MOVE', source, {
      headers: { Destination: this.urlFor(destination), Overwrite: 'T' },
      signal: options.signal,
    });
    const body = await res.text().catch(() => '');
    if (![200, 201, 204].includes(res.status)) {
      const error = new WebdavError('MOVE', source, res.status, body);
      error.hint = explainStatus(res.status, source);
      throw error;
    }
    return { from: source, to: destination };
  }

  /** COPY：服务端复制。不少服务端不支持（123云盘声明支持但实测 500）。 */
  async copy(from, to, options = {}) {
    const source = normalizeRemotePath(from);
    const destination = normalizeRemotePath(to);
    const res = await this.request('COPY', source, {
      headers: { Destination: this.urlFor(destination), Overwrite: 'T' },
      signal: options.signal,
    });
    const body = await res.text().catch(() => '');
    if (![200, 201, 204].includes(res.status)) {
      if ([...UNSUPPORTED_STATUSES, 500].includes(res.status)) {
        throw new UnsupportedError('COPY', `该服务端不支持在服务端复制（COPY -> HTTP ${res.status}）`, {
          status: res.status,
          hint: '改用下载到本机再上传。',
        });
      }
      const error = new WebdavError('COPY', source, res.status, body);
      error.hint = explainStatus(res.status, source);
      throw error;
    }
    return { from: source, to: destination };
  }

  /** DELETE。注意：按 RFC 4918，对目录的 DELETE 就是**递归删除**，任何服务端都不会再确认一次。 */
  async remove(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    if (target === '/') throw new Error('拒绝删除根目录');
    const res = await this.request('DELETE', target, { signal: options.signal });
    const body = await res.text().catch(() => '');
    if (![200, 202, 204].includes(res.status)) {
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
    const body = await guardGetBody(res, 'GET', target);
    const chunks = [];
    let total = 0;
    let truncated = false;
    for await (const value of body) {
      const buf = Buffer.from(value);
      if (total + buf.length >= limit) {
        chunks.push(buf.subarray(0, Math.max(0, limit - total)));
        total = limit;
        truncated = true;
        body.destroy();
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }
    return { content: Buffer.concat(chunks).toString('utf8'), bytes: total, truncated };
  }

  /** 连通性自检：OPTIONS + 根目录 PROPFIND + 列根目录。 */
  async check(options = {}) {
    const caps = await this.options(options).catch(() => null);
    const { status, text } = await this.propfindRaw('/', 0, options);
    if (status !== 207 && status !== 200) {
      const error = new WebdavError('PROPFIND', '/', status, text);
      error.hint = explainStatus(status, '/');
      throw error;
    }
    if (!MULTISTATUS_RE.test(text)) throw notWebdavError('PROPFIND', '/', status);
    const rootEntry = parseMultiStatus(text, this.basePath)[0] ?? null;
    const entries = await this.list('/', options);
    return {
      url: this.baseUrl,
      status,
      rootCount: entries.length,
      dav: caps?.dav ?? '',
      allow: caps?.allow ?? '',
      server: caps?.server ?? '',
      etag: rootEntry?.etag ?? '',
      propfindMode: this.propfindMode,
    };
  }
}

function parentDir(remotePath) {
  const normalized = normalizeRemotePath(remotePath);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2));
  return p;
}
