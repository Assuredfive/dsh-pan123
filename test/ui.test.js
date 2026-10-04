import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

/**
 * ui.html 是插件自带的整页界面（无框架、无构建）。这里做**结构性回归**：
 * 断言多网盘改造后的关键钩子、路由、token 头、状态迁移都在，并且内联脚本能通过语法编译。
 * 页面真正的交互行为靠真机冒烟（打开 /webdav）验证，这里只保证「不会一打开就白屏/走错接口」。
 */
const html = readFileSync(new URL('../lib/ui.html', import.meta.url), 'utf8');

/** 取出最后一个 <script> 块（页面主逻辑）。 */
function mainScript() {
  const matches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(matches.length > 0, 'ui.html 必须有内联脚本');
  return matches.at(-1)[1];
}

test('内联脚本能通过语法编译（语法错会让整个页面白屏）', () => {
  const source = mainScript();
  assert.doesNotThrow(() => vm.compileFunction(source, [], { filename: 'ui.html:inline' }));
});

test('保留了测试与样式依赖的分段注释标记', () => {
  // test/list.test.js 与 test/markdown.test.js 靠这三行做代码切分
  for (const marker of [
    '/* ============ 轻量 Markdown 渲染（零依赖：标题/列表/表格/代码块/引用/分隔线/行内样式） ============ */',
    '/* ============================ 列表：搜索 / 排序 / 筛选 ============================ */',
    '/* ============================ 文件浏览器 ============================ */',
  ]) {
    assert.ok(html.includes(marker), `分段标记被改动了：${marker}`);
  }
});

test('token 与请求头都换成了新的名字', () => {
  assert.ok(html.includes("const TOKEN = '__WEBDAV_TOKEN__'"), 'host 端靠字符串替换注入 token');
  assert.ok(html.includes('X-Webdav-Token'), '请求头要用新的名字');
  assert.ok(!html.includes('PAN123'), '不该再残留旧的 token 占位符/请求头');
  assert.ok(!html.includes('X-Pan123-Token'));
});

test('所有接口都打到 /webdav/api/ 且不再有旧路由', () => {
  assert.ok(html.includes('/webdav/api/'));
  assert.ok(!html.includes('/pan123'), '旧路由必须清干净');
});

test('多网盘界面：切换器 + 设置页的关键钩子都在', () => {
  for (const id of ['files-view', 'settings-view', 'remote', 's-preset', 's-url', 's-label', 's-user', 's-password']) {
    assert.ok(html.includes(`id="${id}"`), `缺少钩子 id="${id}"`);
  }
  for (const label of ['测试连接', '添加网盘', '保存']) {
    assert.ok(html.includes(label), `缺少文案「${label}」`);
  }
  // 预设的「怎么拿应用密码」和「踩过的坑」是设置页最有价值的部分，必须真的渲染出来
  assert.match(html, /\.tips\b/, '要渲染预设的 tips');
  assert.match(html, /\.quirks\b/, '要渲染预设的 quirks');
});

test('每个内容请求都会带上当前网盘（remote 参数）', () => {
  const script = mainScript();
  // GET 走查询串，POST 走 JSON body —— 两条路都必须带上当前 remote
  assert.match(script, /set\('remote',\s*state\.remote\)/, 'GET 要用 URLSearchParams 带上 remote');
  assert.match(script, /remote:\s*state\.remote/, 'POST body 里也要带上 remote');
  assert.match(script, /X-Webdav-Token/, '并且带上 token 头');
});

test('localStorage 状态：用新键，但会读旧键做迁移', () => {
  assert.ok(html.includes('dsh-webdav.ui.v1'), '新状态键');
  assert.ok(html.includes('dsh-pan123.ui.v1'), '要读旧键，老用户上次浏览的目录不能丢');
});

test('密码不会被写进 localStorage', () => {
  const script = mainScript();
  // 允许出现「读密码输入框」的代码，但不允许把 password 值交给 localStorage
  for (const match of script.matchAll(/localStorage\.setItem\(([^)]*)\)/g)) {
    assert.doesNotMatch(match[1], /password/i, `localStorage.setItem 不该写入密码：${match[1]}`);
  }
});

test('文案通用化：标题不再是某一家网盘专用', () => {
  assert.match(html, /<h1>网盘<\/h1>/, '主标题应该是中性的「网盘」');
  const staleTitles = ['<h1>123云盘</h1>', '<h1>123网盘</h1>'];
  for (const stale of staleTitles) assert.ok(!html.includes(stale), `标题还是旧的：${stale}`);
});
