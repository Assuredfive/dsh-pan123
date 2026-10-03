/**
 * dsh-pan123 —— 123云盘(123pan) WebDAV 插件（host 半边）。
 *
 * 四件事：
 *   1. 注册 Agent 工具 pan123_*（check/ls/stat/get/put/mkdir/mv/rm/read/url）；
 *   2. 注册内置技能 pan123-webdav，把用法与硬限制随插件分发；
 *   3. 暴露 /pan123 文件浏览器页面 + 设置页面 + 同源 JSON API
 *      （侧栏「123网盘」标签页 = 浏览器；设置 → 123云盘 = 初始化/凭据/偏好）；
 *   4. 设置页保存的改动立即生效（runtime.config 每次调用时读取），不需要重启 DSH。
 *
 * 纯 Node 标准库实现：**不 import 任何 @deepseek-ai/* 或第三方包**。
 * 实测：运行时包在 profile 里解析不到（"Cannot find package '@deepseek-ai/dsh-tools'"），
 * 所以参数 Schema 由 lib/tools.js 自己编译，配置也不依赖 schemastery。
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerApi } from './api.js';
import { normalizeConfig } from './operations.js';
import { Pan123Runtime } from './runtime.js';
import { skillRegistration } from './skill.js';
import { registerTools } from './tools.js';
import { DEFAULT_BIG_FILE_WARN, DEFAULT_ENV_FILE, DEFAULT_READ_MAX_BYTES, DEFAULT_TIMEOUT_MS } from './webdav.js';

export const name = 'dsh-pan123';

/**
 * tools 必需；skills 提供内置技能；webServer 提供界面路由。
 * 三者都在 web / desktop 组合里处于 active。
 */
export const inject = ['tools', 'skills', 'webServer'];

/**
 * 插件 config 行的默认值。url/user/password 留空表示「未显式指定」，
 * 让凭据解析按 设置页保存值 > 环境变量 > webdav.env 的顺序取值。
 */
export const defaultConfig = {
  url: '',
  user: '',
  password: '',
  envFile: DEFAULT_ENV_FILE,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  defaultUploadDir: '',
  bigFileWarnBytes: DEFAULT_BIG_FILE_WARN,
  readMaxBytes: DEFAULT_READ_MAX_BYTES,
  maxListEntries: 1000,
  uiEnabled: true,
};

export async function apply(ctx, config) {
  const merged = { ...defaultConfig, ...(config && typeof config === 'object' ? config : {}) };
  // 传原始 config：未显式指定的键要能回落到设置页保存的偏好
  const runtime = new Pan123Runtime(merged);
  const resolved = normalizeConfig(merged);

  for (const [stage, run] of [
    ['registerTools', () => registerTools(ctx, () => runtime.config)],
    ['registerSkill', () => ctx.skills.register(skillRegistration())],
    ['registerApi', () => resolved.uiEnabled !== false && registerApi(ctx.webServer, runtime, ctx.logger)],
  ]) {
    try {
      run();
    } catch (error) {
      reportFailure(ctx, stage, error);
      throw error;
    }
  }

  if (typeof ctx.logger?.info === 'function') {
    ctx.logger.info('dsh-pan123 已加载：工具 pan123_*，界面 /pan123（设置页 /pan123?view=settings，侧栏「123网盘」标签页）');
  }
}

/**
 * 失败诊断：总是记进 host 日志；设 DSH_PAN123_DEBUG=1 时额外在插件目录写 .apply-report.json，
 * 方便在看不到 host 日志的环境里定位加载失败。
 */
function reportFailure(ctx, stage, error) {
  if (typeof ctx.logger?.error === 'function') ctx.logger.error(`dsh-pan123: ${stage} 失败`, error);
  if (process.env.DSH_PAN123_DEBUG !== '1') return;
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
