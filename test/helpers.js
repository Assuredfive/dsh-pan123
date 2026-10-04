/**
 * 测试公用工具：把「一组远程配置」拼成 operations 层吃的 config 形状。
 *
 * config 形状（运行期由 lib/runtime.js 生产）：
 *   {
 *     remotes:     [{ id, label, preset, url, defaultUploadDir, enabled }],   // 非机密，来自 config.json
 *     default:     '<remote id>',
 *     credentials: { '<remote id>': { user, password } },                     // 机密，来自 credentials.json
 *     prefs:       { timeoutMs, readMaxBytes, maxListEntries, bigFileWarnBytes },
 *     capabilities:{ get(id,url), set(id,url,caps) }                          // 可选的能力缓存
 *   }
 */

import * as ops from '../lib/operations.js';

export const TEST_USER = '13800000000';
export const TEST_PASSWORD = 'app-password';

/** 用一台假 WebDAV 服务端拼一份单远程配置。 */
export function makeConfig(server, options = {}) {
  const id = options.id ?? 'test';
  const remotes =
    options.remotes ??
    [
      {
        id,
        label: options.label ?? '测试网盘',
        preset: options.preset ?? 'custom',
        url: server?.url ?? options.url,
        defaultUploadDir: options.defaultUploadDir ?? '',
        enabled: true,
      },
    ];
  const credentials = options.credentials ?? { [id]: { user: options.user ?? TEST_USER, password: options.password ?? TEST_PASSWORD } };
  return {
    remotes,
    default: options.default ?? id,
    credentials,
    prefs: options.prefs ?? {},
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  };
}

/** 内存版能力缓存，行为与 lib/remotes.js 的 CapabilityStore 一致（但不落盘）。 */
export function memoryCapabilities() {
  const memo = {};
  return {
    memo,
    get(id, url) {
      const entry = memo[id];
      return entry && entry.url === url ? { ...entry.caps } : {};
    },
    set(id, url, caps) {
      const merged = { ...(memo[id]?.url === url ? memo[id].caps : {}), ...caps };
      memo[id] = { url, caps: merged };
    },
  };
}

/** 取「应该抛错」的那次调用的错误对象；没抛错就断言失败。 */
export async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('预期这次调用会失败，但它成功了');
}

export { ops };
