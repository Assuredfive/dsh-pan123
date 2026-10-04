/**
 * 假 WebDAV 服务端（**多服务端档位版**）：用一个 in-process HTTP server 复刻各家服务端的真实行为差异，
 * 让客户端/操作层的自愈逻辑可以被同一套用例反复压。
 *
 * 档位（profile）都不是拍脑袋编的，来自对真机的 OPTIONS + 主动试探：
 *   standard       —— 标准 RFC 4918：PUT 父目录缺失 409、MKCOL 已存在 405、MOVE 覆盖 204、
 *                     MOVE 源缺失 404 / 目标父目录缺失 409、COPY 可用、有 ETag、PROPFIND 有/无 body 都吃
 *   123pan         —— 123云盘实测：PUT 自动逐级建目录并 201；MOVE 撞名 / 源缺失 / 父目录缺失**一律 500**
 *                     （它根本不用状态码区分用户错误，也不认 Overwrite 头）；Allow 里声明 COPY 但 COPY 一律 500；
 *                     MKCOL 已存在回 201；getetag 是空的；不支持的属性再回一个 404 propstat，里面是**同名空元素**，
 *                     而且 404 段排在 200 段之前
 *   minimal        —— 最小实现：只吃 allprop（带显式 <prop> 的 PROPFIND 一律 400，客户端要自己退化）、
 *                     不支持 MOVE/COPY（405）、没有 ETag
 *   login-redirect —— 被反向代理到了登录页：任何方法都回 200 + text/html（根本不是 207 multistatus）
 *
 * 设计约束：档位之间的差异**全部**由下面的 PROFILES 配置对象描述，请求处理器只读配置，
 * 不按档位名字写分支——加一个新服务端只需要加一份配置。
 */

import http from 'node:http';

const BASE = '/webdav';

/** login-redirect 档位返回的假登录页：注意它**没有** multistatus，最容易被误判成空目录。 */
const LOGIN_PAGE =
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>请先登录</title></head>' +
  '<body><h1>请先登录</h1><form action="/login" method="post">' +
  '<input name="user" autocomplete="username"><input name="password" type="password" autocomplete="current-password">' +
  '<button type="submit">登录</button></form></body></html>';

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

/** COPY 要真的复制一棵子树（目录的 DELETE 一删就是递归删，所以这里的克隆必须深）。 */
function cloneNode(node) {
  if (!node.dir) return makeFile(node.data);
  const copy = makeDir();
  for (const [name, child] of node.children) copy.children.set(name, cloneNode(child));
  return copy;
}

/**
 * 从 PROPFIND 请求体里取出客户端**点名要**的属性（只看 local name，忽略命名空间前缀）。
 * 返回 null 表示客户端没给 body（allprop）。
 */
function requestedProps(body) {
  const section = /<(?:[\w.-]+:)?prop(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?prop>/i.exec(String(body ?? ''));
  if (!section) return null;
  const names = [];
  // 这个正则只匹配开标签/自闭合标签：`</D:prop>` 这类闭标签的 `/` 不在字符集里，会被跳过
  for (const match of section[1].matchAll(/<(?:([\w.-]+):)?([\w.-]+)/g)) names.push(match[2].toLowerCase());
  return [...new Set(names)];
}

/** 标准档位作为「基线」；各档位只写自己与基线不同的部分，避免复制粘贴抄错。 */
const BASE_PROFILE = {
  label: '标准 RFC 4918',
  loginPage: false,
  dav: '1,2',
  allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY',
  propfind: {
    body: 'accept', // accept=有/无 body 都吃；reject=带 body 一律 400（逼客户端退回 allprop）；require=无 body 一律 400
    etag: true, // 是否回真实 ETag
    unsupported: 'omit', // omit=不返回；empty404=用 404 propstat 里的同名空元素占位
    notFoundFirst: false, // 404 propstat 是否排在 200 propstat 之前（123云盘就是反的）
  },
  put: { autoMkdir: false, missingParent: 409, targetIsDir: 405 },
  mkcol: { existing: 405, missingParent: 409 },
  move: { mode: 'normal', missingSource: 404, missingParent: 409, unsupported: 405, overwrite: 'honor', overwriteRefused: 412, overwriteStatus: 500 },
  copy: { mode: 'normal', missingSource: 404, missingParent: 409, unsupported: 405, failStatus: 500 },
  delete: { root: 403 },
};

function defineProfile(overrides = {}) {
  const merged = { ...BASE_PROFILE, ...overrides };
  for (const key of ['propfind', 'put', 'mkcol', 'move', 'copy', 'delete']) {
    merged[key] = { ...BASE_PROFILE[key], ...overrides[key] };
  }
  return merged;
}

const PROFILES = {
  standard: defineProfile(),

  // 123云盘：用户错误全压成 500；PUT 自带建目录；MKCOL 已存在当成功；不支持的属性用 404 空元素占位
  '123pan': defineProfile({
    label: '123云盘 WebDAV（实测行为）',
    propfind: { etag: false, unsupported: 'empty404', notFoundFirst: true },
    put: { autoMkdir: true },
    mkcol: { existing: 201 },
    move: { overwrite: 'fail', overwriteStatus: 500, missingSource: 500, missingParent: 500 },
    copy: { mode: 'alwaysFail', failStatus: 500 },
  }),

  // 最小实现：只认 allprop（显式 prop body 回 400，客户端必须自己退化成无 body），没有 MOVE/COPY/ETag
  minimal: defineProfile({
    label: '最小实现',
    dav: '1',
    allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL',
    propfind: { body: 'reject', etag: false },
    move: { mode: 'unsupported' },
    copy: { mode: 'unsupported' },
  }),

  // 反代到了登录页：所有方法都回 200 + HTML，是最容易把「配置写错」伪装成「空目录」的坑
  'login-redirect': defineProfile({
    label: '被反向代理到登录页',
    loginPage: true,
  }),
};

/**
 * 起一台假服务端。
 *
 * @param {object} [options]
 * @param {'standard'|'123pan'|'minimal'|'login-redirect'} [options.profile='standard']
 * @param {string} [options.user] 给了 user+password 才校验 Basic 认证（不传则不校验）
 * @param {string} [options.password]
 * @param {boolean} [options.noPrefix] 207 里不用命名空间前缀（默认命名空间 xmlns="DAV:"），验证解析器的前缀容错
 * @param {'accept'|'reject'|'require'} [options.propfindBody] 单点覆盖 PROPFIND 的 body 策略
 *        （例如 { profile: 'minimal', propfindBody: 'require' } 模拟「必须先带显式 <prop>」的那种服务端）
 * @returns {Promise<{url:string,log:Array<{method:string,path:string}>,root:object,
 *   seed:Function,list:Function,read:Function,close:Function}>}
 */
export async function startFakeWebdav(options = {}) {
  const profileName = options.profile ?? 'standard';
  const preset = PROFILES[profileName];
  if (!preset) throw new Error(`未知的 profile: ${profileName}（可选：${Object.keys(PROFILES).join('、')}）`);

  const profile = defineProfile({
    ...preset,
    propfind: { ...preset.propfind, ...(options.propfindBody ? { body: options.propfindBody } : {}) },
  });

  const noPrefix = options.noPrefix === true;
  const ns = noPrefix ? '' : 'D:'; // 命名空间前缀：noPrefix 时用 xmlns="DAV:" 的裸标签
  const nsDecl = noPrefix ? ' xmlns="DAV:"' : ' xmlns:D="DAV:"';
  const tag = (name) => `${ns}${name}`;

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

  const hrefFor = (segments, isDir) => {
    const tail = segments.map((segment) => encodeURIComponent(segment)).join('/');
    const base = tail ? `${BASE}/${tail}` : `${BASE}/`;
    // 集合的 href 带结尾斜杠（真实服务端都这样），文件不带——解析器两种都要认
    return isDir && !base.endsWith('/') ? `${base}/` : base;
  };

  // 「不支持的属性」在 404 段里用同名空元素占位（123云盘实测就是长这样）
  const emptyElem = (name) => `<${tag(name)}></${tag(name)}>`;
  const selfElem = (name) => `<${tag(name)}/>`;

  /** 一条 <response>：支持的属性进 200 propstat，不支持的属性按档位决定去哪。 */
  const responseXml = (segments, node, requested) => {
    const isDir = node.dir;
    const name = segments.length === 0 ? 'root' : segments[segments.length - 1];

    const supported = [
      ['resourcetype', isDir ? `<${tag('resourcetype')}><${tag('collection')}/></${tag('resourcetype')}>` : selfElem('resourcetype')],
      ['displayname', `<${tag('displayname')}>${xmlEscape(name)}</${tag('displayname')}>`],
      ['getlastmodified', `<${tag('getlastmodified')}>${new Date(node.mtime).toUTCString()}</${tag('getlastmodified')}>`],
    ];
    if (!isDir) {
      supported.push(['getcontentlength', `<${tag('getcontentlength')}>${node.data.length}</${tag('getcontentlength')}>`]);
      supported.push(['getcontenttype', `<${tag('getcontenttype')}>application/octet-stream</${tag('getcontenttype')}>`]);
    }
    if (profile.propfind.etag) {
      supported.push(['getetag', `<${tag('getetag')}>"${isDir ? 'dir' : node.data.length}-${node.mtime}"</${tag('getetag')}>`]);
    }

    // 无 body = allprop：只回自己支持的属性；有 body：按客户端点名的清单回，缺的按档位丢进 404 段
    const wanted = requested ?? supported.map(([propName]) => propName);
    const okXml = supported
      .filter(([propName]) => wanted.includes(propName))
      .map(([, xml]) => xml)
      .join('');
    const missing = requested ? requested.filter((propName) => !supported.some(([supportedName]) => supportedName === propName)) : [];

    const okStat = `<${tag('propstat')}><${tag('prop')}>${okXml}</${tag('prop')}><${tag('status')}>HTTP/1.1 200 OK</${tag('status')}></${tag('propstat')}>`;
    const missingStat =
      profile.propfind.unsupported === 'empty404' && missing.length > 0
        ? `<${tag('propstat')}><${tag('prop')}>${missing.map(emptyElem).join('')}</${tag('prop')}><${tag('status')}>HTTP/1.1 404 Not Found</${tag('status')}></${tag('propstat')}>`
        : '';
    // 段的先后顺序不保证：123云盘把 404 段排前面，只取「第一个匹配」的解析器会静默读到空值
    const propstats = profile.propfind.notFoundFirst ? `${missingStat}${okStat}` : `${okStat}${missingStat}`;

    return (
      `<${tag('response')}><${tag('href')}>${xmlEscape(hrefFor(segments, isDir))}</${tag('href')}>` +
      `${propstats}</${tag('response')}>`
    );
  };

  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    log.push({ method: req.method, path: url.pathname });

    const finish = (status, body, headers = {}) => {
      const payload = Buffer.isBuffer(body) ? body : body === undefined || body === null ? '' : String(body);
      res.writeHead(status, { 'Content-Length': Buffer.byteLength(payload), ...headers });
      res.end(payload);
    };

    try {
      if (expectedAuth && req.headers.authorization !== expectedAuth) {
        return finish(401, 'unauthorized');
      }
      if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) {
        return finish(404, '');
      }

      const body = await readBody(req);

      // 反代到登录页：任何方法都回 200 + HTML（连 OPTIONS 也是）
      if (profile.loginPage) {
        return finish(200, LOGIN_PAGE, { 'Content-Type': 'text/html; charset=utf-8' });
      }

      const segments = segmentsOf(url.pathname);
      const node = lookup(segments);

      switch (req.method) {
        case 'OPTIONS': {
          return finish(200, '', { DAV: profile.dav, Allow: profile.allow, Server: `fake-webdav/${profileName}` });
        }

        case 'PROPFIND': {
          const policy = profile.propfind.body;
          const hasBody = body.length > 0;
          // 三种真实服务端都见过：都吃 / 只吃显式 prop / 只吃 allprop
          if (policy === 'require' && !hasBody) return finish(400, 'PROPFIND 需要显式 <prop> 请求体');
          if (policy === 'reject' && hasBody) return finish(400, 'PROPFIND 只支持 allprop（不接受显式 prop 请求体）');
          if (!node) return finish(404, 'not found');

          const depth = req.headers.depth === '0' ? 0 : 1;
          const requested = hasBody ? requestedProps(body) : null;
          const parts = [responseXml(segments, node, requested)];
          if (depth === 1 && node.dir) {
            for (const [childName, child] of node.children) {
              parts.push(responseXml([...segments, childName], child, requested));
            }
          }
          return finish(
            207,
            `<?xml version="1.0" encoding="utf-8"?><${tag('multistatus')}${nsDecl}>${parts.join('')}</${tag('multistatus')}>`,
            { 'Content-Type': 'application/xml; charset=utf-8' },
          );
        }

        case 'GET': {
          if (!node) return finish(404, 'not found');
          if (node.dir) return finish(405, 'is a collection');
          return finish(200, node.data, { 'Content-Type': 'application/octet-stream' });
        }

        case 'PUT': {
          if (segments.length === 0) return finish(405, 'cannot PUT root');
          let parent = parentOf(segments);
          if (parent && !parent.dir) return finish(409, 'parent is a file');
          if (!parent) {
            // 标准服务端要你先把目录建好；123云盘会自己逐级建出来
            if (!profile.put.autoMkdir) return finish(profile.put.missingParent, 'conflict');
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
          const key = segments[segments.length - 1];
          const exist = parent.children.get(key);
          if (exist && exist.dir) return finish(profile.put.targetIsDir, 'target is a collection');
          parent.children.set(key, makeFile(body));
          return finish(exist ? 204 : 201);
        }

        case 'MKCOL': {
          if (segments.length === 0) return finish(405, 'root exists');
          // 123云盘把「已存在」也当成功（201），标准服务端回 405
          if (node) return finish(profile.mkcol.existing, profile.mkcol.existing === 201 ? '' : 'already exists');
          const parent = parentOf(segments);
          if (!parent || !parent.dir) return finish(profile.mkcol.missingParent, 'conflict');
          parent.children.set(segments[segments.length - 1], makeDir());
          return finish(201);
        }

        case 'DELETE': {
          if (!node) return finish(404, 'not found');
          if (segments.length === 0) return finish(profile.delete.root, 'refuse root');
          // RFC 4918：对集合的 DELETE 就是递归删除，服务端不会二次确认（Map 删一个 key 就是整棵子树）
          parentOf(segments).children.delete(segments[segments.length - 1]);
          return finish(204);
        }

        case 'MOVE': {
          const spec = profile.move;
          if (spec.mode === 'unsupported') return finish(spec.unsupported, 'MOVE not supported');
          if (!node) return finish(spec.missingSource, 'not found');
          const destination = req.headers.destination;
          if (!destination) return finish(400, 'missing Destination');
          const destSegments = segmentsOf(new URL(destination, 'http://127.0.0.1').pathname);
          if (destSegments.length === 0) return finish(403, 'refuse root');

          const destParent = parentOf(destSegments);
          if (!destParent || !destParent.dir) return finish(spec.missingParent, 'conflict');
          const destExisting = lookup(destSegments);
          if (destExisting) {
            // 123云盘不认 Overwrite 头：不管 T / F / 不发，撞名一律 500
            if (spec.overwrite === 'fail') return finish(spec.overwriteStatus, 'Internal Server Error');
            if (req.headers.overwrite === 'F') return finish(spec.overwriteRefused, 'precondition failed');
          }
          parentOf(segments).children.delete(segments[segments.length - 1]);
          destParent.children.set(destSegments[destSegments.length - 1], node);
          return finish(destExisting ? 204 : 201);
        }

        case 'COPY': {
          const spec = profile.copy;
          if (spec.mode === 'unsupported') return finish(spec.unsupported, 'COPY not supported');
          // 123云盘在 Allow 里声明支持 COPY，实测却一律 500——所以它绝不能只信 Allow 头
          if (spec.mode === 'alwaysFail') return finish(spec.failStatus, 'Internal Server Error');
          if (!node) return finish(spec.missingSource, 'not found');
          const destination = req.headers.destination;
          if (!destination) return finish(400, 'missing Destination');
          const destSegments = segmentsOf(new URL(destination, 'http://127.0.0.1').pathname);
          if (destSegments.length === 0) return finish(403, 'refuse root');

          const destParent = parentOf(destSegments);
          if (!destParent || !destParent.dir) return finish(spec.missingParent, 'conflict');
          const destExisting = lookup(destSegments);
          if (destExisting && req.headers.overwrite === 'F') return finish(412, 'precondition failed');
          destParent.children.set(destSegments[destSegments.length - 1], cloneNode(node));
          return finish(destExisting ? 204 : 201);
        }

        default:
          return finish(405, 'method not allowed');
      }
    } catch (err) {
      // 假服务端自己出错时也要回一个完整响应，否则测试会挂成超时，很难查
      try {
        finish(500, `fake-webdav 内部错误: ${err?.message ?? err}`);
      } catch {
        /* 响应已经发出去就忽略 */
      }
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}${BASE}`,
    log,
    root,
    /** 测试辅助：直接往树里塞内容，避免每个用例都走 HTTP。给了 content 是文件，不给是目录。 */
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
