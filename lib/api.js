/**
 * 界面层 HTTP：把同一个 WebDAV 语义暴露成同源 JSON API，并托管一个零依赖的文件浏览器 / 设置页面。
 *
 * 路由（都挂在 /pan123 前缀下）：
 *   GET  /pan123                      文件浏览器页面（token 内嵌）；?view=settings 为设置页
 *   GET  /pan123/api/status           凭据 + 连通性
 *   GET  /pan123/api/config           当前有效配置 + 凭据来源（永不含密码）
 *   POST /pan123/api/config           保存设置（凭据 → webdav.env；偏好 → settings.json）
 *   POST /pan123/api/test             用（临时）凭据做连通性测试，不落盘
 *   GET  /pan123/api/list?path=/      列目录
 *   GET  /pan123/api/stat?path=/x     单个条目
 *   GET  /pan123/api/content?path=/x  读小文本文件（JSON）
 *   GET  /pan123/api/download?path=/x 下载（浏览器另存为）
 *   PUT  /pan123/api/upload?dir=/&name=a.bin   请求体即文件字节，直接流式 PUT 到网盘
 *   POST /pan123/api/mkdir            {path}
 *   POST /pan123/api/move             {from,to}
 *   POST /pan123/api/delete           {path,recursive}
 *
 * 页面本身不需要 token；/api/* 需要 token（页面里已内嵌），避免本机其它程序顺手驱动网盘。
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from './operations.js';
import { badRequest } from './operations.js';
import { normalizeRemotePath, openClient, WebdavError, humanSize } from './webdav.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(HERE, 'ui.html');
const MAX_JSON_BODY = 256 * 1024;

// 页面按 mtime 缓存：改完 ui.html 刷新浏览器即可看到，不必重启 host。
let uiCache = { mtimeMs: 0, html: null };

function uiHtml() {
  const info = statSync(UI_FILE);
  if (uiCache.html === null || uiCache.mtimeMs !== info.mtimeMs) {
    uiCache = { mtimeMs: info.mtimeMs, html: readFileSync(UI_FILE, 'utf8') };
  }
  return uiCache.html;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BODY) throw badRequest('请求体过大');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
}

function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * @param {{register:(route:{kind:'exact'|'prefix',path:string,handler:Function})=>Function}} webServer
 * @param {import('./runtime.js').Pan123Runtime} runtime 运行期配置（设置页可实时改动）
 * @param {{warn?:Function}} [logger] 可选的 host logger
 */
export function registerApi(webServer, runtime, logger) {
  const token = randomBytes(24).toString('hex');
  const config = () => runtime.config;

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendText(res, 400, 'bad request');
      return;
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/pan123';

    try {
      if (pathname === '/pan123') {
        sendText(res, 200, uiHtml().replaceAll('__PAN123_TOKEN__', token), 'text/html; charset=utf-8');
        return;
      }
      if (!pathname.startsWith('/pan123/api/')) {
        sendText(res, 404, 'not found');
        return;
      }

      const supplied = req.headers['x-pan123-token'] ?? url.searchParams.get('token');
      if (supplied !== token) {
        sendJson(res, 403, { error: { message: 'token 无效：请通过插件页面访问', hint: '直接打开 /pan123 获取带 token 的页面。' } });
        return;
      }

      const op = pathname.slice('/pan123/api/'.length);
      switch (op) {
        case 'status':
          return await handleStatus(res, config());
        case 'config':
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            return sendJson(res, 200, await runtime.save(body));
          }
          return sendJson(res, 200, await runtime.describe());
        case 'test': {
          const body = await readJsonBody(req);
          try {
            return sendJson(res, 200, { check: await runtime.test(body) });
          } catch (error) {
            // 凭据错/网络错都在这里变成 check.ok=false，设置页统一展示，不必区分 HTTP 状态
            return sendJson(res, 200, { check: { ok: false, ...ops.toErrorPayload(error) } });
          }
        }
        case 'list':
          return sendJson(res, 200, await ops.list(config(), { path: url.searchParams.get('path') ?? '/' }));
        case 'stat':
          return sendJson(res, 200, await ops.stat(config(), { path: url.searchParams.get('path') ?? '/' }));
        case 'content':
          return sendJson(
            res,
            200,
            await ops.readText(config(), {
              path: url.searchParams.get('path') ?? '/',
              maxBytes: Number(url.searchParams.get('maxBytes')) || undefined,
            }),
          );
        case 'download':
          return await handleDownload(res, config(), url.searchParams.get('path'));
        case 'upload':
          return await handleUpload(req, res, config(), url.searchParams);
        case 'mkdir': {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await ops.mkdir(config(), { path: body.path }));
        }
        case 'move': {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await ops.move(config(), { from: body.from, to: body.to }));
        }
        case 'delete': {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await ops.remove(config(), { path: body.path, recursive: body.recursive === true }));
        }
        default:
          return sendJson(res, 404, { error: { message: `未知接口 ${op}` } });
      }
    } catch (err) {
      const payload = ops.toErrorPayload(err);
      sendJson(res, payload.status && payload.status >= 400 && payload.status < 600 ? payload.status : 500, { error: payload });
    }
  };

  try {
    return webServer.register({ kind: 'prefix', path: '/pan123', handler });
  } catch (error) {
    // 热重载/重复挂载时旧实例可能还占着这条 prefix 路由（webserver 对重复 path 直接抛错）。
    // 此时沿用既有路由而不是让整个插件加载失败：页面仍在服务，只是 token/配置取旧实例的那份。
    if (!String(error?.message ?? '').includes('duplicate')) throw error;
    logger?.warn?.(
      'dsh-pan123: /pan123 路由已被占用（多半是热重载残留的旧实例），沿用既有路由；重启 DSH 可得到干净的单实例状态。',
    );
    return () => {};
  }
}

async function handleStatus(res, config) {
  const credentials = await ops.credentialStatus(config);
  if (!credentials.ok) {
    sendJson(res, 200, { credentials });
    return;
  }
  try {
    const result = await ops.check(config);
    sendJson(res, 200, { credentials, check: result });
  } catch (err) {
    sendJson(res, 200, { credentials, check: { ok: false, ...ops.toErrorPayload(err) } });
  }
}

async function handleDownload(res, config, remotePath) {
  if (!remotePath) throw badRequest('缺少 path 参数');
  const target = normalizeRemotePath(remotePath);
  const { client } = await openClient(config);
  const entry = await client.stat(target);
  if (!entry) {
    const error = new WebdavError('GET', target, 404, '');
    error.hint = '路径不存在。';
    throw error;
  }
  if (entry.isDir) throw badRequest(`${target} 是目录，不能下载`);

  const upstream = await client.request('GET', target);
  if (upstream.status !== 200 || !upstream.body) {
    const body = await upstream.text().catch(() => '');
    throw new WebdavError('GET', target, upstream.status, body);
  }
  const headers = {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'Content-Disposition': contentDisposition(entry.name),
    'Cache-Control': 'no-store',
  };
  const length = upstream.headers.get('content-length');
  if (length) headers['Content-Length'] = length;
  res.writeHead(200, headers);
  await new Promise((resolve, reject) => {
    const source = Readable.fromWeb(upstream.body);
    source.on('error', reject);
    res.on('close', () => source.destroy());
    source.pipe(res);
    res.on('finish', resolve);
  });
}

async function handleUpload(req, res, config, searchParams) {
  const dir = normalizeRemotePath(searchParams.get('dir') ?? config.defaultUploadDir ?? '');
  const rawName = searchParams.get('name');
  if (!rawName || rawName.includes('/') || rawName.includes('\\') || rawName === '.' || rawName === '..') {
    throw badRequest(`上传文件名不合法: ${rawName ?? '(空)'}`);
  }
  const target = normalizeRemotePath(dir === '/' ? `/${rawName}` : `${dir}/${rawName}`);
  const { client } = await openClient(config);
  const declared = Number(req.headers['content-length']);
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (Number.isFinite(declared) && declared >= 0) headers['Content-Length'] = String(declared);

  const upstream = await client.request('PUT', target, { headers, body: req });
  if (![200, 201, 204].includes(upstream.status)) {
    const body = await upstream.text().catch(() => '');
    throw new WebdavError('PUT', target, upstream.status, body);
  }
  sendJson(res, 200, {
    remote: target,
    bytes: Number.isFinite(declared) ? declared : null,
    size: Number.isFinite(declared) ? humanSize(declared) : '未知',
  });
}
