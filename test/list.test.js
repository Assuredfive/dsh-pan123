import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

/**
 * 搜索 / 排序 / 筛选是嵌在 lib/ui.html 里的纯函数（页面对 DOM 负责，逻辑必须可测）。
 * 这里把那段源码抽出来在沙箱里跑，防止排序规则（目录永远在前、数字序、回退名称）被改坏。
 */
function loadListHelpers() {
  const html = readFileSync(new URL('../lib/ui.html', import.meta.url), 'utf8');
  const start = html.indexOf('/* ============================ 列表：搜索 / 排序 / 筛选');
  const end = html.indexOf('/* ============================ 文件浏览器');
  assert.ok(start > 0 && end > start, 'ui.html 里应能找到列表排序/筛选源码段');
  const snippet = html.slice(start, end);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${snippet}\nglobalThis.__visibleEntries = visibleEntries; globalThis.__defaultDirFor = defaultDirFor;`,
    sandbox,
    { filename: 'ui.html#list' },
  );
  return { visibleEntries: sandbox.__visibleEntries, defaultDirFor: sandbox.__defaultDirFor };
}

const { visibleEntries, defaultDirFor } = loadListHelpers();

const file = (name, extra = {}) => ({ name, path: '/' + name, isDir: false, ...extra });
const dir = (name) => ({ name, path: '/' + name, isDir: true });
// 沙箱（vm）里的数组来自另一个 realm，deepStrictEqual 会因原型不同而失败：
// 统一先转成本地数组再比较。
const names = (list) => Array.from(list, (entry) => entry.name);

test('目录永远排在文件前面（倒序也一样）', () => {
  const entries = [file('a.txt', { mtime: '2026-01-01T00:00:00Z' }), dir('z-folder'), file('b.txt', { mtime: '2026-09-09T00:00:00Z' })];
  const asc = visibleEntries(entries, { sortKey: 'name', sortDir: 'asc' });
  assert.deepEqual(names(asc), ['z-folder', 'a.txt', 'b.txt']);
  const desc = visibleEntries(entries, { sortKey: 'mtime', sortDir: 'desc' });
  assert.deepEqual(names(desc), ['z-folder', 'b.txt', 'a.txt']);
});

test('按名称排序是数字序（item2 在 item10 前）', () => {
  const entries = [file('item10.txt'), file('item2.txt'), file('item1.txt')];
  assert.deepEqual(names(visibleEntries(entries, { sortKey: 'name', sortDir: 'asc' })), [
    'item1.txt',
    'item2.txt',
    'item10.txt',
  ]);
});

test('按修改时间排序：缺失或非法时间按 0 处理', () => {
  const entries = [
    file('old.txt', { mtime: '2025-05-05T00:00:00Z' }),
    file('new.txt', { mtime: '2026-10-03T12:00:00Z' }),
    file('none.txt'),
    file('bad.txt', { mtime: '不是时间' }),
  ];
  assert.deepEqual(names(visibleEntries(entries, { sortKey: 'mtime', sortDir: 'desc' })), [
    'new.txt',
    'old.txt',
    'bad.txt',
    'none.txt',
  ]);
});

test('按大小排序：非整数（目录/未知）视为 0', () => {
  const entries = [file('big.bin', { size: 4096 }), file('small.bin', { size: 12 }), file('unknown.bin')];
  assert.deepEqual(names(visibleEntries(entries, { sortKey: 'size', sortDir: 'desc' })), [
    'big.bin',
    'small.bin',
    'unknown.bin',
  ]);
});

test('按类型排序：比较扩展名，同扩展名回退名称', () => {
  const entries = [file('c.zip'), file('b.md'), file('a.md'), file('noext')];
  assert.deepEqual(names(visibleEntries(entries, { sortKey: 'type', sortDir: 'asc' })), [
    'noext',
    'a.md',
    'b.md',
    'c.zip',
  ]);
});

test('搜索：大小写不敏感的子串匹配', () => {
  const entries = [file('Report-2026.pdf'), file('notes.md'), file('report-old.pdf')];
  assert.deepEqual(names(visibleEntries(entries, { filter: 'REPORT' })), ['Report-2026.pdf', 'report-old.pdf']);
  assert.equal(visibleEntries(entries, { filter: '   ' }).length, 3, '纯空白视作不过滤');
});

test('筛选：仅文件夹', () => {
  const entries = [dir('alpha'), file('a.md'), dir('beta')];
  assert.deepEqual(names(visibleEntries(entries, { foldersOnly: true })), ['alpha', 'beta']);
  const cn = [dir('考研'), file('a.md'), dir('技术')];
  const onlyDirs = names(visibleEntries(cn, { foldersOnly: true }));
  assert.equal(onlyDirs.length, 2, '两个中文目录都应保留');
  assert.deepEqual([...onlyDirs].sort(), [...['考研', '技术']].sort(), '中文名不丢（具体顺序交给 ICU，不在断言里绑定）');
});

test('搜索 + 仅文件夹 + 排序可以叠加', () => {
  const entries = [dir('2026-考研'), file('2026-考研.md'), dir('2025-考研'), dir('2024-技术')];
  const out = visibleEntries(entries, { filter: '考研', foldersOnly: true, sortKey: 'name', sortDir: 'desc' });
  assert.deepEqual(names(out), ['2026-考研', '2025-考研']);
});

test('不修改入参数组，也不丢条目', () => {
  const entries = [file('b.txt'), file('a.txt'), dir('z')];
  const before = names(entries);
  const out = visibleEntries(entries, { sortKey: 'name', sortDir: 'asc' });
  assert.deepEqual(names(entries), before, '入参数组顺序不应被改动');
  assert.equal(out.length + 0, 3);
  assert.notEqual(out, entries, '应返回新数组');
});

test('未知 sortKey 回退到名称；未知 sortDir 回退到升序；非数组安全', () => {
  const entries = [file('b.txt'), file('a.txt')];
  assert.deepEqual(names(visibleEntries(entries, { sortKey: 'nope', sortDir: 'sideways' })), ['a.txt', 'b.txt']);
  assert.deepEqual(names(visibleEntries(null, {})), []);
  assert.deepEqual(names(visibleEntries([null, undefined, file('a.txt')], {})), ['a.txt']);
});

test('切换排序键时的默认方向：时间/大小倒序，名称/类型升序', () => {
  assert.equal(defaultDirFor('mtime'), 'desc');
  assert.equal(defaultDirFor('size'), 'desc');
  assert.equal(defaultDirFor('name'), 'asc');
  assert.equal(defaultDirFor('type'), 'asc');
  assert.equal(defaultDirFor('unknown'), 'asc');
});
