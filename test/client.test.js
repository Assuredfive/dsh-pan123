import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

/**
 * client 半边是给浏览器用的 lazy-CJS bundle（顶层调用 window.__ModuleLoader__.load）。
 * 这里用最小沙箱跑一遍：id 正确、只 require 基线 react、apply 会注册
 * ① better-sidebar 标签页 ② 设置项 settings.section，两者都指向 /webdav 页面。
 */
function loadBundle() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const registrations = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' });
  return registrations;
}

const fakeReact = () => ({ createElement: (type, props) => ({ type, props }) });

function makeCtx() {
  const tabs = [];
  const slotRegistrations = [];
  const slotInjects = [];
  const warnings = [];
  return {
    tabs,
    slotRegistrations,
    slotInjects,
    warnings,
    ctx: {
      get: (key) =>
        key === 'betterSidebar'
          ? {
              registerTab: (descriptor) => {
                tabs.push(descriptor);
                return () => {};
              },
            }
          : undefined,
      slots: {
        inject: (name, callback) => {
          slotInjects.push(name);
          return callback();
        },
        register: (options, component) => {
          slotRegistrations.push({ options, component });
          return () => {};
        },
      },
      effect: (factory) => factory(),
      logger: { warn: (message) => warnings.push(message) },
    },
  };
}

test('client bundle 以正确的 id 注册，且只 require 基线模块', () => {
  const registrations = loadBundle();
  assert.equal(registrations.length, 1, '顶层必须且只能调用一次 __ModuleLoader__.load');
  const registration = registrations[0];
  assert.equal(registration.id, 'dsh-webdav', 'id 必须等于 package.json 的 name');
  assert.equal(typeof registration.factory, 'function');

  const requested = [];
  const exportsObject = registration.factory((specifier) => {
    requested.push(specifier);
    if (specifier === 'react') return fakeReact();
    throw new Error(`client bundle 只应 require 平台基线模块，却请求了 ${specifier}`);
  });
  assert.deepEqual(requested, ['react']);
  assert.equal(typeof exportsObject.apply, 'function');
  assert.deepEqual([...exportsObject.inject], ['slots', 'betterSidebar']);
});

test('apply 同时注册侧栏标签页与设置项，组件都渲染 /webdav 的 iframe', () => {
  const [registration] = loadBundle();
  const exportsObject = registration.factory(() => fakeReact());
  const { ctx, tabs, slotRegistrations, slotInjects } = makeCtx();

  exportsObject.apply(ctx);

  // ① 侧栏标签页
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, 'webdav');
  assert.equal(tabs[0].title, '网盘');
  assert.equal(tabs[0].single, true);
  assert.match(tabs[0].description, /WebDAV/);
  const tabElement = tabs[0].component({});
  assert.equal(tabElement.type, 'iframe');
  assert.equal(tabElement.props.src, '/webdav');
  assert.equal(tabElement.props.style.width, '100%');

  // ② 设置 → WebDAV 网盘
  assert.deepEqual(slotInjects, ['settings.section']);
  assert.equal(slotRegistrations.length, 1);
  const { options, component } = slotRegistrations[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'webdav-settings');
  assert.equal(options.label(), 'WebDAV 网盘');
  const settingsElement = component({});
  assert.equal(settingsElement.type, 'iframe');
  assert.equal(settingsElement.props.src, '/webdav?view=settings');
});

test('没有 better-sidebar 时只跳过标签页，设置项仍然注册', () => {
  const [registration] = loadBundle();
  const exportsObject = registration.factory(() => fakeReact());
  const { ctx, warnings, slotRegistrations } = makeCtx();
  ctx.get = () => undefined;

  assert.doesNotThrow(() => exportsObject.apply(ctx));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /better-sidebar/);
  assert.equal(slotRegistrations.length, 1, '设置项不依赖 better-sidebar');
  assert.equal(slotRegistrations[0].options.name, 'settings.section');
});

test('bundle 里不再残留旧的路由 / id / 请求头', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  // 注意：描述里点名「123云盘」是**支持的网盘之一**，属于有意保留，不算残留
  for (const stale of ['/pan123', 'pan123-settings', "'dsh-pan123'", 'X-Pan123-Token', "id: 'pan123'"]) {
    assert.ok(!source.includes(stale), `client bundle 不该再出现 ${stale}`);
  }
});
