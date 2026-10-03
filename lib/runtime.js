/**
 * 运行期配置：把「插件 config 行里的静态配置」+「设置页保存的本地设置」合成一份随时可变的配置。
 *
 * 工具与 HTTP API 都通过 runtime.config 取值（每次调用时读），
 * 所以在设置页保存后**立即生效**，不需要重启 DSH。
 */

import { normalizeConfig } from './operations.js';
import { readCredentialsFile, readSettings, settingsPaths, writeCredentialsFile, writeSettings } from './settings-store.js';
import { resolveCredentials } from './webdav.js';

export class Pan123Runtime {
  /**
   * @param {object} rawConfig 插件 config（cordis patch 行里的 config），**传原始值不要先 normalize**：
   *   只有"未显式指定"的键才会回落到设置页保存的偏好。
   * @param {{settingsFile?:string, credentialsFile?:string}} [paths]
   */
  constructor(rawConfig = {}, paths = {}) {
    this.paths = { ...settingsPaths(), ...paths };
    this.rawConfig = { ...rawConfig };
    this.settings = readSettings(this.paths.settingsFile);
    this.recompute();
  }

  recompute() {
    this.resolved = normalizeConfig({ ...this.rawConfig, settings: this.settings });
    return this.resolved;
  }

  /** 每次取值都反映最新设置。 */
  get config() {
    return this.resolved;
  }

  /**
   * 设置页当前展示需要的一切（永不含密码原文）。
   * config 里给的是**有效值**（已经把凭据优先级算进去），sources 说明每个字段最终来自哪一层，
   * 这样用户在设置页能看到"环境变量盖过了我填的值"这类情况。
   */
  async describe(env = process.env) {
    const credentials = readCredentialsFile(this.paths.credentialsFile);
    const preferences = { ...this.settings };
    for (const key of ['url', 'user', 'password']) delete preferences[key];

    let sources = {};
    let effectiveUrl = this.resolved.url || '';
    let effectiveUser = '';
    try {
      const resolved = await resolveCredentials(this.resolved, env);
      sources = resolved.sources;
      effectiveUrl = resolved.url;
      effectiveUser = resolved.user;
    } catch {
      /* 凭据缺失时仍然给出设置页骨架 */
    }

    return {
      config: {
        url: effectiveUrl,
        user: effectiveUser,
        envFile: this.resolved.envFile,
        defaultUploadDir: this.resolved.defaultUploadDir,
        timeoutMs: this.resolved.timeoutMs,
        readMaxBytes: this.resolved.readMaxBytes,
        maxListEntries: this.resolved.maxListEntries,
        bigFileWarnBytes: this.resolved.bigFileWarnBytes,
        uiEnabled: this.resolved.uiEnabled !== false,
      },
      stored: {
        credentialsFile: this.paths.credentialsFile,
        settingsFile: this.paths.settingsFile,
        hasPassword: Boolean(credentials.WEBDAV_PASSWORD),
        hasFileUser: Boolean(credentials.WEBDAV_USER),
        hasFileUrl: Boolean(credentials.WEBDAV_URL),
        preferences,
      },
      sources,
      /** 哪些字段被环境变量盖住了（设置页据此提示）。 */
      envOverrides: Object.entries(sources)
        .filter(([, source]) => source === 'env')
        .map(([field]) => field),
    };
  }

  /**
   * 保存设置页的改动：凭据（url/user/password）只写 webdav.env，偏好写 settings.json。
   * 传空字符串表示清除该字段。
   */
  async save(patch = {}, env = process.env) {
    const credentialsPatch = {};
    for (const [key, field] of [
      ['url', 'WEBDAV_URL'],
      ['user', 'WEBDAV_USER'],
      ['password', 'WEBDAV_PASSWORD'],
    ]) {
      if (patch[key] !== undefined) credentialsPatch[field] = patch[key];
    }

    const preferencePatch = {};
    for (const key of ['defaultUploadDir', 'timeoutMs', 'readMaxBytes', 'maxListEntries', 'bigFileWarnBytes']) {
      if (patch[key] !== undefined) preferencePatch[key] = patch[key];
    }

    if (Object.keys(credentialsPatch).length > 0) {
      writeCredentialsFile(credentialsPatch, this.paths.credentialsFile);
    }
    if (Object.keys(preferencePatch).length > 0) {
      this.settings = writeSettings(preferencePatch, this.paths.settingsFile);
    }
    this.recompute();
    return this.describe(env);
  }

  /** 用一组临时凭据做连通性测试（不落盘）。overrides 优先级最高，盖过插件 config。 */
  async test(overrides = {}) {
    const { check } = await import('./operations.js');
    const config = normalizeConfig({
      ...this.rawConfig,
      url: overrides.url || this.rawConfig.url,
      user: overrides.user || this.rawConfig.user,
      password: overrides.password || this.rawConfig.password,
      settings: this.settings,
    });
    return check(config);
  }
}
