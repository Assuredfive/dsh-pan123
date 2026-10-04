/**
 * dsh-webdav —— 通用 WebDAV 网盘插件（host 半边）。
 *
 * 四件事：
 *   1. 注册 Agent 工具 webdav_*（remotes/check/ls/stat/get/put/mkdir/mv/rm/read/url）；
 *   2. 注册内置技能 webdav（+ 一个 pan123-webdav 影子技能，顶掉磁盘上那个只会用 Python 脚本的旧技能）；
 *   3. 暴露 /webdav 文件浏览器页面 + 设置页面 + 同源 JSON API
 *      （侧栏「网盘」标签页 = 浏览器；设置 → WebDAV 网盘 = 多网盘/凭据/偏好）；
 *   4. 设置页保存的改动立即生效（runtime.config 每次调用时读取），不需要重启 DSH。
 *
 * 多网盘：123云盘、坚果云、Nextcloud、群晖、飞牛 fnOS、极空间、Alist…都能同时挂上，
 * 各自有地址/凭据/默认上传目录，用 remote id 区分。
 *
 * 纯 Node 标准库实现：**不 import 任何 @deepseek-ai/* 或第三方包**。
 * 实测：运行时包在 profile 里解析不到（"Cannot find package '@deepseek-ai/dsh-tools'"），
 * 所以参数 Schema 由 lib/tools.js 自己编译，配置也不依赖 schemastery。
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerApi } from './api.js';
import { pathsForDir } from './remotes.js';
import { WebdavRuntime } from './runtime.js';
import { skillRegistrations } from './skill.js';
import { registerTools } from './tools.js';

export const name = 'dsh-webdav';

/**
 * tools 必需；skills 提供内置技能；webServer 提供界面路由。
 * 三者都在 web / desktop 组合里处于 active。
 */
export const inject = ['tools', 'skills', 'webServer'];

/**
 * 插件 config 行的默认值。
 * 网盘清单与凭据**不在这里**：它们在配置目录下由设置页管理
 * （config.json / credentials.json），这样密码不会进 DSH 的 profile 配置与备份。
 *
 * `configDir` 留空表示用默认的 `~/.config/dsh-webdav`；填了就把三份配置文件都放到那里
 * （便携安装、一台机器跑多套配置、以及测试隔离都用它）。
 */
export const defaultConfig = {
  uiEnabled: true,
  configDir: '',
};

export async function apply(ctx, config) {
  const merged = { ...defaultConfig, ...(config && typeof config === 'object' ? config : {}) };
  const runtime = new WebdavRuntime(merged, merged.configDir ? pathsForDir(merged.configDir) : {});

  for (const [stage, run] of [
    ['registerTools', () => registerTools(ctx, () => runtime.config)],
    ['registerSkill', () => ctx.skills.register(skillRegistrations().primary)],
    ['registerLegacySkill', () => ctx.skills.register(skillRegistrations().legacy)],
    ['registerApi', () => merged.uiEnabled !== false && registerApi(ctx.webServer, runtime, ctx.logger)],
  ]) {
    try {
      run();
    } catch (error) {
      reportFailure(ctx, stage, error);
      throw error;
    }
  }

  if (typeof ctx.logger?.info === 'function') {
    const count = runtime.stored.remotes.length;
    ctx.logger.info(
      `dsh-webdav 已加载：工具 webdav_*，界面 /webdav（设置页 /webdav?view=settings，侧栏「网盘」标签页），` +
        `当前配置了 ${count} 个网盘`,
    );
  }
}

/**
 * 失败诊断：总是记进 host 日志；设 DSH_WEBDAV_DEBUG=1 时额外在插件目录写 .apply-report.json，
 * 方便在看不到 host 日志的环境里定位加载失败。
 */
function reportFailure(ctx, stage, error) {
  if (typeof ctx.logger?.error === 'function') ctx.logger.error(`dsh-webdav: ${stage} 失败`, error);
  if (process.env.DSH_WEBDAV_DEBUG !== '1') return;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    writeFileSync(
      join(here, '..', '.apply-report.json'),
      JSON.stringify({ stage, message: String(error?.message ?? error), stack: String(error?.stack ?? '') }, null, 2),
      'utf8',
    );
  } catch {
    /* 诊断本身失败就算了 */
  }
}
