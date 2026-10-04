/**
 * 互操作测试：**同一套操作**分别跑在 standard / 123pan / minimal 三个档位上，断言用户可见的结果一致 ——
 * 这就是「通用 WebDAV 客户端」这句话的证据。
 *
 * 另有几个专项：noPrefix（不带命名空间前缀）、login-redirect（反代到登录页）、123云盘的 propstat 怪癖、
 * 以及 PUT 父目录 / MKCOL 已存在 / COPY 这几处**服务端之间真有分歧**的地方。
 *
 * 约定：每个档位里的 ops 调用共享同一个 memoryCapabilities（真实运行期能力是**跑出来的**，
 * 第一次 PROPFIND 学到服务端吃哪种形式，之后复用，所以这里也按这个形状来）。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { UnsupportedError, WebdavClient, WebdavError } from '../lib/webdav.js';
import { makeConfig, memoryCapabilities, ops, rejection, TEST_PASSWORD, TEST_USER } from './helpers.js';
import { startFakeWebdav } from './fake-webdav.js';

/** 三个能跑完整套 CRUD 的档位；login-redirect 根本不是 WebDAV，单独测。 */
const DATA_PROFILES = ['standard', '123pan', 'minimal'];

/** 起一台服务端 + 一份配置，跑完一定收干净（keep-alive 连接不清掉会让 node --test 挂住）。 */
async function withServer(profile, run, options = {}) {
  const server = await startFakeWebdav({ profile, user: TEST_USER, password: TEST_PASSWORD, ...options });
  const workdir = await mkdtemp(path.join(tmpdir(), 'dsh-interop-'));
  try {
    return await run({ server, workdir, config: makeConfig(server, { capabilities: memoryCapabilities() }) });
  } finally {
    await server.close();
    await rm(workdir, { recursive: true, force: true });
  }
}

/* ==================================================================== 参数化 */

for (const profile of DATA_PROFILES) {
  describe(`profile = ${profile}`, () => {
    let server;
    let config;
    let workdir;

    before(async () => {
      server = await startFakeWebdav({ profile, user: TEST_USER, password: TEST_PASSWORD });
      config = makeConfig(server, { capabilities: memoryCapabilities() });
      workdir = await mkdtemp(path.join(tmpdir(), `dsh-interop-${profile}-`));
    });

    after(async () => {
      await server.close();
      await rm(workdir, { recursive: true, force: true });
    });

    test('list / stat / mkdir / upload（多级目录）/ download / readText / remove 全部成功', async () => {
      await ops.mkdir(config, { path: '/学习' });
      await ops.mkdir(config, { path: '/学习/2026' });

      const listing = await ops.list(config, { path: '/学习' });
      assert.equal(listing.path, '/学习');
      assert.deepEqual(
        listing.entries.map((entry) => [entry.name, entry.isDir]),
        [['2026', true]],
      );

      const dir = await ops.stat(config, { path: '/学习/2026' });
      assert.equal(dir.exists, true);
      assert.equal(dir.entry.isDir, true);
      assert.equal((await ops.stat(config, { path: '/没有这个' })).exists, false, '不存在的路径要给 exists:false，而不是抛错');

      // 一次上传到三级都不存在的目录：standard/minimal 靠「PUT 409 → ensureDirs → 重试」，
      // 123pan 靠它自己的 PUT 自动建目录 —— 客户端两种都得活
      const local = path.join(workdir, '报表.txt');
      await writeFile(local, 'hello webdav');
      const uploaded = await ops.upload(config, { local, remoteDir: '/a/b/c' });
      assert.equal(uploaded.remotePath, '/a/b/c/报表.txt');
      assert.equal(uploaded.bytes, 12);
      assert.equal(server.read('/a/b/c/报表.txt'), 'hello webdav', '内容必须真的落到这台服务端上');

      const target = path.join(workdir, 'copy.txt');
      const downloaded = await ops.download(config, { path: '/a/b/c/报表.txt', local: target });
      assert.equal(downloaded.bytes, 12);
      assert.equal(await readFile(target, 'utf8'), 'hello webdav');

      const text = await ops.readText(config, { path: '/a/b/c/报表.txt' });
      assert.equal(text.content, 'hello webdav');
      assert.equal(text.truncated, false);

      const removed = await ops.remove(config, { path: '/a/b/c/报表.txt' });
      assert.equal(removed.removed, true);
      assert.equal(server.read('/a/b/c/报表.txt'), null);
    });

    test('move：目标不存在时是普通重命名', async () => {
      server.seed('/移动/源.txt', 'payload');

      if (profile === 'minimal') {
        // minimal 明确不支持 MOVE（405），COPY 也不行（405）。这不是缺陷，是它的能力边界：
        // 有价值的是「如实报不支持 + 两个文件都原样在」，而不是假装搬成功。
        const error = await rejection(ops.move(config, { from: '/移动/源.txt', to: '/移动/目标.txt' }));
        assert.ok(error instanceof UnsupportedError, `期望 UnsupportedError，实际 ${error?.name}: ${error?.message}`);
        assert.equal(error.status, 405);
        assert.match(error.hint ?? '', /下载到本机再上传/);
        assert.equal(server.read('/移动/源.txt'), 'payload', '搬到一半失败时源文件必须还在');
        assert.equal(server.read('/移动/目标.txt'), null);
        return;
      }

      const result = await ops.move(config, { from: '/移动/源.txt', to: '/移动/目标.txt' });
      assert.equal(result.via, 'move');
      assert.equal(result.replaced, false);
      assert.equal(server.read('/移动/目标.txt'), 'payload');
      assert.equal(server.read('/移动/源.txt'), null);
    });

    test('move：目标已存在（撞名）时结果一致 —— 内容换过去、源消失', async () => {
      server.seed('/src.txt', '新的内容');
      server.seed('/dst.txt', '旧的内容');

      if (profile === 'minimal') {
        const error = await rejection(ops.move(config, { from: '/src.txt', to: '/dst.txt' }));
        assert.ok(error instanceof UnsupportedError);
        assert.equal(server.read('/dst.txt'), '旧的内容', '不支持就是不动，绝不许把目标删了');
        assert.equal(server.read('/src.txt'), '新的内容');
        return;
      }

      const result = await ops.move(config, { from: '/src.txt', to: '/dst.txt' });
      assert.equal(server.read('/dst.txt'), '新的内容');
      assert.equal(server.read('/src.txt'), null);

      if (profile === '123pan') {
        // 123云盘不认 Overwrite 头（撞名一律 500），只能靠「删目标再重试」——
        // 所以它必须如实报告 replaced，否则上层无法知道目标被替换过
        assert.equal(result.replaced, true);

        // 学到「这个服务端不认 Overwrite」之后，再搬一次到**不存在**的目标也不能反而变死路
        server.seed('/再搬.txt', 'again');
        const second = await ops.move(config, { from: '/再搬.txt', to: '/再搬-目标.txt' });
        assert.equal(second.via, 'move');
        assert.equal(server.read('/再搬-目标.txt'), 'again');
        assert.equal(server.read('/再搬.txt'), null);
      } else {
        // 标准服务端一次 MOVE（Overwrite: T）就覆盖完成，不该乱报 replaced
        assert.equal(result.replaced, false);
      }
    });

    test('安全护栏：源不存在时拒绝移动，且目标内容原样保留', async () => {
      server.seed('/guard/dst.txt', '不能被删掉');

      const error = await rejection(ops.move(config, { from: '/guard/没有这个.txt', to: '/guard/dst.txt' }));
      assert.equal(error.status, 404);
      assert.match(error.hint ?? '', /不存在/);
      // 这是「删了目标又没搬成」这类静默数据丢失的唯一防线
      assert.equal(server.read('/guard/dst.txt'), '不能被删掉');
    });

    test('目录删除护栏：不带 recursive 必须拒绝，带 recursive 才删整棵子树', async () => {
      server.seed('/tree/a.txt', 'a');
      server.seed('/tree/sub/b.txt', 'b');

      const error = await rejection(ops.remove(config, { path: '/tree' }));
      assert.equal(error.status, 400);
      assert.match(error.message, /递归删除[\s\S]*recursive=true/);
      assert.equal(server.read('/tree/sub/b.txt'), 'b', '没确认之前不能真的删');

      const result = await ops.remove(config, { path: '/tree', recursive: true });
      assert.equal(result.removed, true);
      assert.equal(result.wasDir, true);
      assert.equal(server.read('/tree/sub/b.txt'), null);
    });

    test('propfindMode 自动适配服务端，check 自检可用', async () => {
      const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });
      assert.equal(client.propfindMode, 'body', '新客户端默认先带显式 <prop>（更省流量）');
      await client.propfind('/', 1);
      assert.equal(client.propfindMode, profile === 'minimal' ? 'nobody' : 'body');

      const checked = await ops.check(config);
      assert.equal(checked.ok, true);
      assert.equal(checked.status, 207);
      assert.equal(checked.propfindMode, profile === 'minimal' ? 'nobody' : 'body');
    });

    test('目录拿不到可读长度、文件拿到真实大小（缺失不能变成 0）', async () => {
      server.seed('/大小/子目录');
      server.seed('/大小/文件.bin', '你好12345');

      const dir = await ops.stat(config, { path: '/大小/子目录' });
      assert.equal(dir.entry.isDir, true);
      assert.ok(dir.entry.size === undefined || dir.entry.size === null, `目录的 size 只能是「无」，实际 ${JSON.stringify(dir.entry)}`);
      assert.notStrictEqual(dir.entry.size, 0, '拿不到长度时绝不能编一个 0 出来');

      const file = await ops.stat(config, { path: '/大小/文件.bin' });
      assert.equal(file.entry.isDir, false);
      assert.equal(file.entry.size, Buffer.byteLength('你好12345'));
    });
  });
}

/* ============================================== PROPFIND body 退化（minimal） */

test('minimal：带 body 被 400 后自动退回 allprop，只多花一次往返', async () => {
  await withServer('minimal', async ({ server }) => {
    const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });
    await client.propfind('/', 1);

    assert.equal(client.propfindMode, 'nobody', '服务端不吃 body，就必须退化成 allprop 并记住');
    assert.equal(client.caps.propfindMode, 'nobody', '学到的选择要落进 caps，好让上层持久化');
    assert.equal(server.log.filter((entry) => entry.method === 'PROPFIND').length, 2, '一次被拒 + 一次成功，不许无限重试');

    // 记住之后不再浪费往返
    const mark = server.log.length;
    await client.propfind('/', 1);
    assert.equal(server.log.length - mark, 1);
  });
});

test('minimal：能力缓存跨 ops 调用复用，ops.check 直接报 propfindMode=nobody', async () => {
  await withServer('minimal', async ({ server, config }) => {
    await ops.list(config, { path: '/' }); // 第一次接触：学到「这台只吃 allprop」

    const checked = await ops.check(config);
    assert.equal(checked.propfindMode, 'nobody');

    // 后续的 stat 不会再多挨一次 400
    const mark = server.log.length;
    assert.equal((await ops.stat(config, { path: '/没有这个' })).exists, false);
    assert.equal(server.log.length - mark, 1, '已经知道该用 allprop 了，不该再试一次带 body 的');
  });
});

test('PUT 父目录缺失：standard 回 409、123pan 自动建目录（同一段客户端代码两种都得活）', async () => {
  await withServer('standard', async ({ server }) => {
    const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });
    const res = await client.request('PUT', '/x/y/z.txt', { body: 'hello' });
    assert.equal(res.status, 409, '标准服务端要求先 MKCOL');
    await res.text();
  });

  await withServer('123pan', async ({ server }) => {
    const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });
    const res = await client.request('PUT', '/x/y/z.txt', { body: 'hello' });
    assert.equal(res.status, 201, '123云盘会自己逐级把目录建出来');
    await res.text();
    assert.equal(server.read('/x/y/z.txt'), 'hello');
  });
});

test('另一种真实服务端：必须先带显式 <prop>（无 body 回 400）—— 客户端保持 body 模式，不该乱退化', async () => {
  // 真机里同时存在相反的两类服务端：一类只吃显式 prop body，一类只吃 allprop。
  // 档位默认只认 allprop（用来逼出退化自愈），这里用 propfindBody 覆盖成另一种，确保两边都测到。
  await withServer(
    'minimal',
    async ({ server, config }) => {
      const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });
      await client.propfind('/', 1);
      assert.equal(client.propfindMode, 'body', '服务端要 body，而我们本来就带 body，没有退化的必要');
      assert.equal(server.log.filter((entry) => entry.method === 'PROPFIND').length, 1, '一次就成功，不该白试一次');

      const listing = await ops.list(config, { path: '/' });
      assert.deepEqual(listing.entries, []);
    },
    { propfindBody: 'require' },
  );
});

/* ==================================================== 命名空间前缀容错 noPrefix */

for (const profile of ['standard', '123pan']) {
  test(`noPrefix：${profile} 用默认命名空间（裸 <multistatus>）也能解析出目录与文件大小`, async () => {
    await withServer(
      profile,
      async ({ server, config }) => {
        server.seed('/学习/2026/报告.txt', 'hello');

        // 先确认这台假服务端真的没写前缀，否则这个用例等于没测
        const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });
        const xml = await client.propfind('/', 1);
        assert.match(xml, /xmlns="DAV:"/);
        assert.doesNotMatch(xml, /D:multistatus/);

        const listing = await ops.list(config, { path: '/学习' });
        assert.deepEqual(
          listing.entries.map((entry) => [entry.name, entry.isDir]),
          [['2026', true]],
        );

        const dir = await ops.stat(config, { path: '/学习/2026' });
        assert.equal(dir.entry.isDir, true);

        const file = await ops.stat(config, { path: '/学习/2026/报告.txt' });
        assert.equal(file.entry.isDir, false);
        assert.equal(file.entry.size, 5, '裸标签里的 <getcontentlength> 也要读得到');
      },
      { noPrefix: true },
    );
  });
}

/* =========================================================== 反代到登录页的坑 */

test('login-redirect：200 + HTML 登录页必须被识破，绝不能当成空目录', async () => {
  await withServer('login-redirect', async ({ server, config }) => {
    // 先坐实这台服务端确实是「200 + HTML」：它最容易被当成「目录是空的」
    const auth = `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`, 'utf8').toString('base64')}`;
    const raw = await fetch(server.url, { method: 'PROPFIND', headers: { Depth: '1', Authorization: auth } });
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get('content-type'), /text\/html/);
    assert.match(await raw.text(), /请先登录/);

    const listError = await rejection(ops.list(config, { path: '/' }));
    assert.equal(listError.notWebdav, true, '必须带 notWebdav 标记，别让上层当空目录');
    assert.match(listError.hint, /不是 WebDAV/);

    const checkError = await rejection(ops.check(config));
    assert.equal(checkError.notWebdav, true);

    const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });
    const propfindError = await rejection(client.propfind('/', 1));
    assert.ok(propfindError instanceof WebdavError);
    assert.equal(propfindError.notWebdav, true);
  });
});

/* ===================================================== 123云盘的 propstat 怪癖 */

test('123pan：不支持的属性回的是 404 propstat 里的同名空元素，且 404 段排在 200 段之前', async () => {
  await withServer('123pan', async ({ server }) => {
    server.seed('/怪癖/目录');
    server.seed('/怪癖/文件.txt', '12345');
    const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });

    const xml = await client.propfind('/怪癖/目录', 0);
    assert.ok(xml.indexOf('404') < xml.indexOf('200'), '404 段排在前面：只取「第一个匹配」的解析器会在这里翻车');
    assert.match(xml, /<(?:D:)?getcontentlength><\/(?:D:)?getcontentlength>/, '不支持的长度属性是用同名空元素占位的');

    const dir = await client.stat('/怪癖/目录');
    assert.equal(dir.isDir, true);
    assert.equal(dir.size, null, '空元素不能被解析成 0');

    const file = await client.stat('/怪癖/文件.txt');
    assert.equal(file.isDir, false);
    assert.equal(file.size, 5, '文件支持 getcontentlength，必须拿到真实大小');
    assert.equal(file.etag, '', '123云盘的 getetag 本来就是空的，不要编');
  });
});

test('123pan：撞名 MOVE 无论 Overwrite 是 T / F / 不发，一律 500（它根本不支持覆盖）', async () => {
  await withServer('123pan', async ({ server }) => {
    server.seed('/src.txt', 'AAA');
    server.seed('/dst.txt', 'BBB');
    const auth = `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`, 'utf8').toString('base64')}`;
    const move = (overwrite) =>
      fetch(`${server.url}/src.txt`, {
        method: 'MOVE',
        headers: { Authorization: auth, Destination: `${server.url}/dst.txt`, ...(overwrite ? { Overwrite: overwrite } : {}) },
      });

    // 真机实测：三种写法都是 500 —— 所以客户端不能指望 Overwrite 头，只能自己「删目标再重试」
    for (const overwrite of ['T', 'F', undefined]) {
      const res = await move(overwrite);
      assert.equal(res.status, 500, `Overwrite: ${overwrite ?? '(不发)'} 也必须是 500`);
      await res.text();
    }
    assert.equal(server.read('/dst.txt'), 'BBB', '失败的 MOVE 不能碰目标');
    assert.equal(server.read('/src.txt'), 'AAA');
  });
});

/* ============================================ COPY：声明支持 ≠ 真的能用 */

test('123pan：Allow 里声明支持 COPY，实测一律 500 → 必须翻译成「不支持」而不是裸 500', async () => {
  await withServer('123pan', async ({ server }) => {
    server.seed('/复制/源.txt', 'x');
    const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });

    const info = await client.options();
    assert.match(info.allow, /COPY/, '它确实在 Allow 里声明了 COPY（所以 Allow 头不能信）');

    const error = await rejection(client.copy('/复制/源.txt', '/复制/目标.txt'));
    assert.ok(error instanceof UnsupportedError);
    assert.equal(error.status, 500);
    assert.match(error.hint, /下载到本机再上传/);
    assert.equal(server.read('/复制/目标.txt'), null);
  });
});

test('standard：COPY 正常可用（对照上面 123pan 的 500）', async () => {
  await withServer('standard', async ({ server }) => {
    server.seed('/复制/源.txt', 'x');
    const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });

    const result = await client.copy('/复制/源.txt', '/复制/目标.txt');
    assert.deepEqual(result, { from: '/复制/源.txt', to: '/复制/目标.txt' });
    assert.equal(server.read('/复制/目标.txt'), 'x');
    assert.equal(server.read('/复制/源.txt'), 'x', 'COPY 不能动源文件');
  });
});

test('MKCOL 已存在的分歧：123pan 回 201（当成功），standard 回 405（要报错）', async () => {
  await withServer('123pan', async ({ server }) => {
    server.seed('/已存在');
    const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });
    assert.deepEqual(await client.mkdir('/已存在'), { remotePath: '/已存在' });
  });

  await withServer('standard', async ({ server }) => {
    server.seed('/已存在');
    const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });
    const error = await rejection(client.mkdir('/已存在'));
    assert.equal(error.status, 405);
  });
});

/* ============================================================ 老行为不能丢 */

test('Basic 认证行为保留：不传凭据不校验；配了凭据就必须对上', async () => {
  const open = await startFakeWebdav({ profile: 'standard' });
  try {
    const client = new WebdavClient({ url: open.url, user: 'anyone', password: 'whatever' });
    assert.equal((await client.options()).status, 200, '没配凭据的服务端不该拦人');
  } finally {
    await open.close();
  }

  const guarded = await startFakeWebdav({ profile: 'standard', user: TEST_USER, password: TEST_PASSWORD });
  try {
    const good = new WebdavClient({ url: guarded.url, user: TEST_USER, password: TEST_PASSWORD });
    assert.equal((await good.options()).status, 200);

    const bad = new WebdavClient({ url: guarded.url, user: TEST_USER, password: 'wrong' });
    const error = await rejection(bad.propfind('/', 1));
    assert.equal(error.status, 401);
  } finally {
    await guarded.close();
  }
});

/* ================================================================ 曾经查实的 lib 缺陷
 *
 * 下面两条原本是「已查实但未修」的缺陷，以 skip 形式留在这里当证据。
 * 两条都已在 lib/ 里修掉（propfindRaw 只在**真的带了 body** 时才记 'body'；
 * download/upload/readText 增加重定向守卫，且 operations 层不再把 notWebdav 当成「查不到」吞掉），
 * 所以现在默认就跑。
 */

const strict = true;

test(
  '（回归）学过 nobody 的客户端，不该被一次成功的 allprop 请求翻回 body',
  { skip: strict ? false : 'lib/webdav.js propfindRaw 的 else-if 只看「状态码是 207」' },
  async () => {
    await withServer('minimal', async ({ server, config }) => {
      const client = new WebdavClient({
        url: server.url,
        user: TEST_USER,
        password: TEST_PASSWORD,
        caps: { propfindMode: 'nobody' },
      });
      assert.equal(client.propfindMode, 'nobody');
      await client.propfind('/', 1);
      // 这次请求根本没带 body，凭什么把已经学到的选择改回 body？
      assert.equal(client.propfindMode, 'nobody');
      assert.equal(client.caps.propfindMode, 'nobody');

      // 端到端后果：能力缓存来回翻，每两次 list 就有一次白挨 400
      const caps = memoryCapabilities();
      const cfg = makeConfig(server, { capabilities: caps });
      await ops.list(cfg, { path: '/' }); // 第一次：400 → 退化成 nobody，缓存写 nobody
      await ops.list(cfg, { path: '/' }); // 第二次：无 body 成功，却把缓存翻成 body
      assert.equal(caps.memo.test.caps.propfindMode, 'nobody', '学到的能力不该自己翻回去');
    });
  },
);

test(
  '（回归）被反代到登录页时，download / upload 必须报错而不是「假成功」',
  { skip: strict ? false : 'lib/webdav.js download/upload 只认 HTTP 200，不校验正文是不是 WebDAV 响应' },
  async () => {
    await withServer('login-redirect', async ({ server, workdir, config }) => {
      const client = new WebdavClient({ url: server.url, user: TEST_USER, password: TEST_PASSWORD });
      const statError = await rejection(client.stat('/x'));
      assert.equal(statError.notWebdav, true, 'stat 这一层已经能识别出来');

      // 但同一台服务端上，download 会把登录页原样写进本地文件，并回报成功
      const local = path.join(workdir, 'x.txt');
      const downloadError = await rejection(ops.download(config, { path: '/x.txt', local }));
      assert.equal(downloadError.notWebdav, true, '登录页不该被当成文件下载下来');
    });
  },
);
