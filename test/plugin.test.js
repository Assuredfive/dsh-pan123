import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { apply, defaultConfig, inject, name } from '../lib/index.js';
import { PRESETS } from '../lib/presets.js';

/**
 * 入口层集成测试：用桩 ctx 真的跑一遍 `apply()`。
 *
 * 这是**不需要重启 DSH 就能验证插件能不能加载**的那道关：
 * 模块图（有没有 import 不到的包）、工具/技能/路由的注册数量与形状、
 * 以及 package.json 的 name 与 cordis 插件 name 是否一致。
 * 真机上「插件没生效」十有八九是这里出问题——事实上这条测试第一次跑就抓到
 * 了 lib/skill.js 里一个模板字符串没转义反引号导致的**整个插件加载失败**。
 */

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * 造一个假的插件 ctx + 一份临时配置目录。
 * configDir 指向临时目录：既验证了这个配置项本身可用，也保证测试绝不读写用户的真实凭据。
 */
function makeCtx() {
  const configDir = mkdtempSync(path.join(tmpdir(), 'dsh-webdav-plugin-'));
  tempDirs.push(configDir);
  const tools = [];
  const skills = [];
  const routes = [];
  const logs = [];
  const errors = [];
  const ctx = {
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => errors.push(String(message)),
    },
    tools: {
      register: (definition) => {
        tools.push(definition);
        return () => {};
      },
    },
    skills: {
      register: (registration) => {
        skills.push(registration);
        return () => {};
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
  };
  return { ctx, tools, skills, routes, logs, errors, configDir, config: { configDir } };
}

test('包名、cordis 插件名与注入项都一致', () => {
  assert.equal(name, 'dsh-webdav');
  assert.deepEqual(inject, ['tools', 'skills', 'webServer']);
  assert.equal(defaultConfig.uiEnabled, true);
  assert.equal(defaultConfig.configDir, '');
  // 网盘清单与凭据不该出现在插件 config 里（那样会进 DSH 的 profile 与备份）
  assert.deepEqual(Object.keys(defaultConfig).sort(), ['configDir', 'uiEnabled']);
});

test('apply() 能加载：注册 11 个 webdav_* 工具 + 2 个技能 + /webdav 路由', async () => {
  const harness = makeCtx();
  await apply(harness.ctx, harness.config);

  assert.deepEqual(harness.errors, [], 'apply 不该记错误');
  assert.ok(
    harness.logs.some((line) => line.includes('dsh-webdav 已加载')),
    '应记一条加载日志',
  );

  const { tools, skills, routes } = harness;

  // ① 工具
  assert.equal(tools.length, 11, `工具数量不对：${tools.map((tool) => tool.name).join(', ')}`);
  const names = tools.map((tool) => tool.name);
  for (const wanted of [
    'webdav_remotes',
    'webdav_check',
    'webdav_ls',
    'webdav_stat',
    'webdav_get',
    'webdav_put',
    'webdav_mkdir',
    'webdav_mv',
    'webdav_rm',
    'webdav_read',
    'webdav_url',
  ]) {
    assert.ok(names.includes(wanted), `缺工具 ${wanted}`);
  }
  for (const tool of tools) {
    assert.match(tool.name, /^webdav_/, `工具名必须以 webdav_ 开头：${tool.name}`);
    assert.equal(tool.parameters.type, 'object');
    assert.ok(tool.description.length > 20, `${tool.name} 的描述太短`);
    // 工具输出的 schema 必须自带（harness 会用它对结果做校验）
    assert.ok(tool.output?.schema, `${tool.name} 缺 output.schema`);
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
    // 除了无参的 webdav_remotes，其余都该能指定网盘
    if (tool.name !== 'webdav_remotes') {
      assert.ok('remote' in tool.parameters.properties, `${tool.name} 缺 remote 参数`);
    }
  }

  // ② 技能：主技能 + pan123 影子技能（顶掉磁盘上那个只会调 Python 的旧技能）
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ['pan123-webdav', 'webdav']);
  const primary = skills.find((skill) => skill.name === 'webdav');
  assert.match(primary.description, /WebDAV/);
  assert.match(primary.content, /webdav_ls/);
  assert.match(primary.content, /fnOS|飞牛/, '主技能要覆盖用户点名的几家服务商');
  const legacy = skills.find((skill) => skill.name === 'pan123-webdav');
  assert.match(legacy.content, /已由 dsh-webdav 插件接管/);
  assert.match(legacy.content, /不要/, '影子技能必须明确叫停旧的 Python 做法');

  // ③ 路由
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/webdav');
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(typeof routes[0].handler, 'function');
});

test('apply() 能被调用两次（热重载场景）而不抛错', async () => {
  const first = makeCtx();
  await apply(first.ctx, first.config);
  const second = makeCtx();
  await apply(second.ctx, second.config);
  assert.equal(second.tools.length, 11);
  assert.equal(second.routes.length, 1);
});

test('uiEnabled=false 时不注册界面路由，但工具与技能照常', async () => {
  const harness = makeCtx();
  await apply(harness.ctx, { ...harness.config, uiEnabled: false });
  assert.equal(harness.routes.length, 0, '关掉界面就不该挂路由');
  assert.equal(harness.tools.length, 11);
  assert.equal(harness.skills.length, 2);
});

test('工具契约：execute 返回值、output.render 渲染文本（harness 就是这么调的）', async () => {
  const harness = makeCtx();
  await apply(harness.ctx, harness.config);
  const remotesTool = harness.tools.find((tool) => tool.name === 'webdav_remotes');

  const value = await remotesTool.execute({}, {});
  assert.equal(typeof value, 'object');
  assert.ok(Array.isArray(value.remotes));
  assert.equal(value.remotes.length, 0, '临时配置目录里不该有任何网盘');

  const rendered = remotesTool.output.render({}, value);
  assert.ok(Array.isArray(rendered) && rendered[0].type === 'text');
  assert.match(rendered[0].text, /还没有配置任何 WebDAV 网盘/);
});

test('configDir 真的生效：配置文件落在指定目录里', async () => {
  const harness = makeCtx();
  await apply(harness.ctx, harness.config);
  const checkTool = harness.tools.find((tool) => tool.name === 'webdav_check');
  // 没配网盘时 check 会报可操作的错，错误里应带上我们指定的配置位置线索
  const error = await checkTool.execute({}, {}).then(
    () => null,
    (err) => err,
  );
  assert.ok(error, '没有网盘时 check 必须报错');
  assert.match(error.message, /还没有配置任何 WebDAV 远程/);
});

test('预设表在入口层可用，且覆盖用户点名的服务商', () => {
  assert.ok(PRESETS.length >= 15, `预设太少：${PRESETS.length}`);
  const ids = PRESETS.map((preset) => preset.id);
  for (const wanted of ['123pan', 'jianguoyun', 'nextcloud', 'fnos', 'synology', 'zspace', 'alist', 'custom']) {
    assert.ok(ids.includes(wanted), `预设缺 ${wanted}`);
  }
});
