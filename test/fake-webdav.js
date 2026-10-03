/**
 * 假 WebDAV 服务端：用一个 in-process HTTP server 模拟 123云盘的 WebDAV 行为，
 * 让客户端/操作层可以做真正的端到端测试（含 Basic 认证、207 Multi-Status、各类状态码）。
 *
 * 刻意复刻的 123云盘行为：
 *   - 目录不存在 → 404；MKCOL 父目录缺失 → 409；对已存在目录 MKCOL → 405
 *   - PUT 自动创建缺失的远端目录
 *   - DELETE 对目录是递归删除
 *   - 207 响应使用 `D:` 命名空间前缀，href 为百分号编码
 */

import http from 'node:http';

const BASE = '/webdav';

const xmlEscape = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function makeDir() {
  return { dir: true, children: new Map(), mtime: Date.now() };
}

function makeFile(data) {
  return { dir: false, data: Buffer.from(data), mtime: Date.now() };
}

export async function startFakeWebdav(options = {}) {
  const expectedAuth =
    options.user && options.password
      ? `Basic ${Buffer.from(`${options.user}:${options.password}`, 'utf8').toString('base64')}`
      : null;
  const root = makeDir();
  const log = [];

  const segmentsOf = (pathname) =>
    pathname
      .slice(BASE.length)
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));

  const lookup = (segments) => {
    let node = root;
    for (const segment of segments) {
      if (!node.dir) return null;
      node = node.children.get(segment);
      if (!node) return null;
    }
    return node;
  };

  const parentOf = (segments) => (segments.length === 0 ? null : lookup(segments.slice(0, -1)));

  const hrefFor = (segments) => `${BASE}/${segments.map((s) => encodeURIComponent(s)).join('')}`.replace(/\/$/, '');

  const entryXml = (segments, node) => {
    const href = segments.length === 0 ? `${BASE}/` : `${BASE}/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
    const name = segments.length === 0 ? 'root' : segments[segments.length - 1];
    return (
      '<D:response>' +
      `<D:href>${xmlEscape(href)}</D:href>` +
      '<D:propstat><D:prop>' +
      `<D:displayname>${xmlEscape(name)}</D:displayname>` +
      `<D:resourcetype>${node.dir ? '<D:collection/>' : ''}</D:resourcetype>` +
      (node.dir ? '' : `<D:getcontentlength>${node.data.length}</D:getcontentlength>`) +
      `<D:getlastmodified>${new Date(node.mtime).toUTCString()}</D:getlastmodified>` +
      '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
      '</D:response>'
    );
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    log.push({ method: req.method, path: url.pathname });

    if (expectedAuth && req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    if (!url.pathname.startsWith(BASE)) {
      res.writeHead(404);
      res.end();
      return;
    }

    const segments = segmentsOf(url.pathname);
    const node = lookup(segments);

    const finish = (status, body, headers = {}) => {
      const payload = body === undefined || body === null ? '' : body;
      res.writeHead(status, { 'Content-Length': Buffer.byteLength(payload), ...headers });
      res.end(payload);
    };

    switch (req.method) {
      case 'PROPFIND': {
        if (!node) return finish(404, 'not found');
        const depth = req.headers.depth === '0' ? 0 : 1;
        const parts = [entryXml(segments, node)];
        if (depth === 1 && node.dir) {
          for (const [childName, child] of node.children) {
            parts.push(entryXml([...segments, childName], child));
          }
        }
        return finish(207, `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${parts.join('')}</D:multistatus>`, {
          'Content-Type': 'application/xml; charset=utf-8',
        });
      }

      case 'GET': {
        if (!node) return finish(404, 'not found');
        if (node.dir) return finish(405, 'is a collection');
        return finish(200, node.data, { 'Content-Type': 'application/octet-stream' });
      }

      case 'PUT': {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          const data = Buffer.concat(chunks);
          if (segments.length === 0) return finish(405, 'cannot PUT root');
          let parent = parentOf(segments);
          if (parent && !parent.dir) return finish(409, 'parent is a file');
          if (!parent) {
            // 复刻 123云盘：PUT 自动创建缺失的目录层级
            parent = root;
            for (const segment of segments.slice(0, -1)) {
              let next = parent.children.get(segment);
              if (!next) {
                next = makeDir();
                parent.children.set(segment, next);
              }
              parent = next;
            }
          }
          const exist = parent.children.get(segments[segments.length - 1]);
          if (exist && exist.dir) return finish(405, 'target is a collection');
          parent.children.set(segments[segments.length - 1], makeFile(data));
          return finish(exist ? 204 : 201);
        });
        return;
      }

      case 'MKCOL': {
        if (segments.length === 0) return finish(405, 'root exists');
        if (node) return finish(405, 'already exists');
        const parent = parentOf(segments);
        if (!parent || !parent.dir) return finish(409, 'conflict');
        parent.children.set(segments[segments.length - 1], makeDir());
        return finish(201);
      }

      case 'DELETE': {
        if (!node) return finish(404, 'not found');
        if (segments.length === 0) return finish(403, 'refuse root');
        const parent = parentOf(segments);
        parent.children.delete(segments[segments.length - 1]);
        return finish(204);
      }

      case 'MOVE': {
        if (!node) return finish(404, 'not found');
        const destination = req.headers.destination;
        if (!destination) return finish(400, 'missing Destination');
        const destUrl = new URL(destination, 'http://127.0.0.1');
        const destSegments = segmentsOf(destUrl.pathname);
        if (destSegments.length === 0) return finish(403, 'refuse root');
        const destExisting = lookup(destSegments);
        if (destExisting && req.headers.overwrite === 'F') return finish(412, 'exists');
        const destParent = parentOf(destSegments);
        if (!destParent || !destParent.dir) return finish(409, 'conflict');
        const sourceParent = parentOf(segments);
        sourceParent.children.delete(segments[segments.length - 1]);
        destParent.children.set(destSegments[destSegments.length - 1], node);
        return finish(destExisting ? 204 : 201);
      }

      default:
        return finish(405, 'method not allowed');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}${BASE}`,
    log,
    root,
    /** 测试辅助：直接往树里塞内容，避免每个用例都走 HTTP。 */
    seed(path, content) {
      const segments = path.split('/').filter(Boolean);
      let parent = root;
      for (const segment of segments.slice(0, -1)) {
        let next = parent.children.get(segment);
        if (!next) {
          next = makeDir();
          parent.children.set(segment, next);
        }
        parent = next;
      }
      parent.children.set(segments[segments.length - 1], content === undefined ? makeDir() : makeFile(content));
    },
    list(segments = []) {
      const node = lookup(segments);
      return node && node.dir ? [...node.children.keys()] : null;
    },
    read(path) {
      const node = lookup(path.split('/').filter(Boolean));
      return node && !node.dir ? node.data.toString('utf8') : null;
    },
    async close() {
      // fetch 用的是 keep-alive 连接：只调 close() 会一直等这些空闲连接，
      // 在 Node 20 上会让 `node --test` 永久挂住。先主动掐掉所有连接。
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
