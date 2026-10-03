import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

/**
 * Markdown 渲染器内嵌在 lib/ui.html 里（页面必须自包含、零依赖）。
 * 这里把那段源码抽出来在沙箱里跑，保证预览渲染不会悄悄退化。
 */
function loadRenderer() {
  const html = readFileSync(new URL('../lib/ui.html', import.meta.url), 'utf8');
  const start = html.indexOf('const escapeHtml =');
  const end = html.indexOf('/* ============================ 列表：搜索 / 排序 / 筛选');
  assert.ok(start > 0 && end > start, 'ui.html 里应能找到渲染器源码段');
  const snippet = html.slice(start, end);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${snippet}\nglobalThis.__renderMarkdown = renderMarkdown; globalThis.__renderInline = renderInline;`, sandbox, {
    filename: 'ui.html#markdown',
  });
  return { renderMarkdown: sandbox.__renderMarkdown, renderInline: sandbox.__renderInline };
}

const { renderMarkdown, renderInline } = loadRenderer();

test('标题 / 段落 / 分隔线', () => {
  const html = renderMarkdown('# 一级\n\n正文一行\n第二行\n\n---\n\n### 三级');
  assert.match(html, /<h1>一级<\/h1>/);
  assert.match(html, /<p>正文一行<br \/>第二行<\/p>/);
  assert.match(html, /<hr \/>/);
  assert.match(html, /<h3>三级<\/h3>/);
});

test('行内样式：粗体/斜体/行内代码/删除线/链接', () => {
  assert.equal(renderInline('**粗** *斜* `x=1` ~~删~~ [站](https://a.b)'), '<strong>粗</strong> <em>斜</em> <code>x=1</code> <del>删</del> <a href="https://a.b" target="_blank" rel="noopener noreferrer">站</a>');
});

test('HTML 被转义，不会执行注入', () => {
  assert.equal(renderInline('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'), '不得原样输出 script 标签');
  assert.match(html, /&lt;script&gt;/);
});

test('代码块保持原样并转义', () => {
  const html = renderMarkdown('```bash\nsudo apt install <pkg> && echo "hi"\n```');
  assert.match(html, /<pre class="md-code" data-lang="bash"><code>/);
  assert.match(html, /sudo apt install &lt;pkg&gt; &amp;&amp; echo &quot;hi&quot;/);
});

test('有序/无序/嵌套/任务列表', () => {
  const html = renderMarkdown('1. 第一步\n2. 第二步\n\n- 甲\n  - 甲一\n- [x] 完成\n- [ ] 未完成');
  assert.match(html, /<ol>\s*<li>第一步<\/li>\s*<li>第二步<\/li>\s*<\/ol>/);
  assert.match(html, /<ul>\s*<li>甲<\/li>/);
  assert.match(html, /<ul>\s*<li>甲一<\/li>\s*<\/ul>/);
  assert.match(html, /<input type="checkbox" disabled checked \/> 完成/);
  assert.match(html, /<input type="checkbox" disabled \/> 未完成/);
});

test('引用与表格', () => {
  const quote = renderMarkdown('> 提示：先备份');
  assert.match(quote, /<blockquote>提示：先备份<\/blockquote>/);

  const table = renderMarkdown('| 项目 | 值 |\n| --- | --- |\n| 分辨率 | 1920x1080 |\n| 网络 | DHCP |');
  assert.match(table, /<table class="md-table">/);
  assert.match(table, /<th>项目<\/th><th>值<\/th>/);
  assert.match(table, /<td>分辨率<\/td><td>1920x1080<\/td>/);
  assert.match(table, /<td>网络<\/td><td>DHCP<\/td>/);
});

test('真实教学文档片段能整段渲染（标题+列表+粗体+代码）', () => {
  const doc = [
    '# Ubuntu 安装配置文档',
    '',
    '本教程涵盖 Ubuntu 安装后的常用配置流程：',
    '1. 调整分辨率（`xrandr`）',
    '2. 设置网络',
    '3. 修改 root 密码',
    '',
    '## 一、安装 Ubuntu 系统',
    '',
    '### 1. 准备启动盘（U盘）',
    '- 下载 Ubuntu ISO 镜像（官网：https://ubuntu.com/download）',
    '- 使用 **Rufus**（Windows）/ balenaEtcher 制作启动盘',
  ].join('\n');
  const html = renderMarkdown(doc);
  assert.match(html, /<h1>Ubuntu 安装配置文档<\/h1>/);
  assert.match(html, /<ol>\s*<li>调整分辨率（<code>xrandr<\/code>）<\/li>/);
  assert.match(html, /<h2>一、安装 Ubuntu 系统<\/h2>/);
  assert.match(html, /<strong>Rufus<\/strong>/);
  assert.ok(!html.includes('#'), '标题井号不应残留在正文里');
});
