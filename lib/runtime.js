/**
 * 运行期配置：把「config.json 里的远程清单」+「credentials.json 里的凭据」+「运行时学到的服务端能力」
 * 合成一份随时可变的配置。工具与 HTTP API 都通过 runtime.config 取值（每次调用时读），
 * 所以在设置页保存后**立即生效**，不需要重启 DSH。
 *
 * 多远程是这里的主线：每个远程（123云盘 / 坚果云 / 公司 Nextcloud / 家里的飞牛 NAS…）
 * 各自有地址、凭据、默认上传目录和能力缓存，操作时用 `remote` 参数或默认远程来选。
 */

import { CapabilityStore, migrateLegacy, readConfig, readCredentials, settingsPaths, writeConfig, writeCredentials, removeCredentials, makeRemoteId, normalizeRemote } from './remotes.js';
import { PRESETS, findPreset, presetForUrl } from './presets.js';
import { credentialStatus, normalizePrefs, testCredentials } from './operations.js';

export class WebdavRuntime {
  /**
   * @param {object} rawConfig 插件 config（cordis patch 行里的 config）。
   *   **注意**：网盘清单与偏好只来自配置文件（config.json / configDir），
   *   在插件 config 行里写 `remotes:` 或 `prefs:` 是**无效**的——这里只有 `env` 与 `uiEnabled`
   *   等开关会被用到。把清单放配置文件里，是为了让密码不进 DSH 的 profile 与备份；
   *   既然只有一处真源，就不该再留第二处能改它的地方（否则两边不一致时更难排查）。
   * @param {{configFile?:string,credentialsFile?:string,capabilitiesFile?:string,legacyEnvFile?:string|null,legacySettingsFile?:string|null}} [paths]
   */
  constructor(rawConfig = {}, paths = {}) {
    this.rawConfig = { ...rawConfig };
    this.paths = { ...settingsPaths(), ...paths };
    this.capabilities = new CapabilityStore(this.paths.capabilitiesFile);
    // 老版本 dsh-pan123 的凭据会被自动接管，用户不需要重输一遍
    try {
      migrateLegacy({
        configFile: this.paths.configFile,
        credentialsFile: this.paths.credentialsFile,
        legacyEnvFile: this.paths.legacyEnvFile,
        legacySettingsFile: this.paths.legacySettingsFile,
        env: this.rawConfig.env,
      });
    } catch {
      /* 迁移失败不应挡住插件加载，用户仍可在设置页手工填 */
    }
    this.reload();
  }

  reload() {
    this.stored = readConfig(this.paths.configFile);
    this.credentials = readCredentials(this.paths.credentialsFile);
    return this.stored;
  }

  /** 每次取值都反映最新设置。 */
  get config() {
    return {
      remotes: this.stored.remotes,
      default: this.stored.default,
      credentials: this.credentials,
      prefs: this.stored.prefs,
      capabilities: this.capabilities,
    };
  }

  /**
   * 设置页当前展示需要的一切（永不含密码）。
   * config 里给的是**有效值**（已经把凭据优先级算进去），sources 说明每个字段最终来自哪一层。
   */
  async describe(env = process.env) {
    const status = credentialStatus(this.config, { env });
    const byId = new Map(status.remotes.map((item) => [item.id, item]));
    return {
      default: status.default,
      remotes: (this.stored.remotes ?? []).map((remote) => {
        const effective = byId.get(remote.id) ?? {};
        return {
          id: remote.id,
          label: remote.label,
          preset: remote.preset,
          presetLabel: findPreset(remote.preset).label,
          url: effective.url ?? remote.url,
          user: effective.user ?? '',
          hasPassword: effective.hasPassword === true,
          defaultUploadDir: remote.defaultUploadDir,
          enabled: remote.enabled !== false,
          isDefault: remote.id === status.default,
          sources: effective.sources ?? {},
        };
      }),
      prefs: normalizePrefs(this.stored.prefs),
      paths: {
        configFile: this.paths.configFile,
        credentialsFile: this.paths.credentialsFile,
        capabilitiesFile: this.paths.capabilitiesFile,
      },
      presets: PRESETS,
      envOverrides: [
        ...new Set(
          status.remotes.flatMap((item) =>
            Object.entries(item.sources ?? {})
              .filter(([, source]) => source === 'env')
              .map(([field]) => `${item.id}.${field}`),
          ),
        ),
      ],
    };
  }

  /**
   * 保存设置页的改动。
   * @param {{prefs?:object, select?:string, remove?:string, remote?:object}} patch
   */
  async save(patch = {}, env = process.env) {
    let stored = this.stored;
    let credentials = this.credentials;

    if (patch.prefs && typeof patch.prefs === 'object') {
      stored = writeConfig({ ...stored, prefs: { ...stored.prefs, ...patch.prefs } }, this.paths.configFile);
    }

    if (patch.remove) {
      const id = String(patch.remove);
      const remotes = stored.remotes.filter((remote) => remote.id !== id);
      const nextDefault = stored.default === id ? remotes[0]?.id ?? '' : stored.default;
      stored = writeConfig({ ...stored, remotes, default: nextDefault }, this.paths.configFile);
      credentials = removeCredentials(id, this.paths.credentialsFile);
    }

    if (patch.remote && typeof patch.remote === 'object') {
      const incoming = patch.remote;
      const preset = findPreset(incoming.preset).id;
      const existingId = typeof incoming.id === 'string' && incoming.id ? incoming.id : '';
      const known = stored.remotes.find((remote) => remote.id === existingId);
      const label = String(incoming.label ?? known?.label ?? findPreset(preset).label).trim() || findPreset(preset).label;
      const id = known
        ? known.id
        : makeRemoteId(
            incoming.id && !known ? incoming.id : label,
            stored.remotes.map((remote) => remote.id),
          );

      const url = String(incoming.url ?? known?.url ?? '').trim() || findPreset(preset).urlTemplate;
      const entry = normalizeRemote({
        id,
        label,
        preset,
        url,
        defaultUploadDir: incoming.defaultUploadDir ?? known?.defaultUploadDir ?? '',
        enabled: incoming.enabled ?? known?.enabled ?? true,
      });

      const remotes = known
        ? stored.remotes.map((remote) => (remote.id === id ? entry : remote))
        : [...stored.remotes, entry];
      const isFirst = remotes.length === 1;
      stored = writeConfig({ ...stored, remotes, default: isFirst ? id : stored.default }, this.paths.configFile);

      // 凭据：只有显式给了字段才动它（undefined = 不改，'' = 清除）
      const credentialPatch = {};
      if (incoming.user !== undefined) credentialPatch.user = incoming.user;
      if (incoming.password !== undefined) credentialPatch.password = incoming.password;
      if (Object.keys(credentialPatch).length > 0) {
        credentials = writeCredentials(id, credentialPatch, this.paths.credentialsFile);
      }
    }

    if (patch.select) {
      const id = String(patch.select);
      if (stored.remotes.some((remote) => remote.id === id)) {
        stored = writeConfig({ ...stored, default: id }, this.paths.configFile);
      }
    }

    this.reload();
    return this.describe(env);
  }

  /** 用一组临时凭据做连通性测试（不落盘）。overrides 优先级最高。 */
  async test(overrides = {}) {
    return testCredentials(this.config, overrides);
  }

  /** 地址 → 预设（设置页在用户手填地址时用来提示「看着像群晖」）。 */
  guessPreset(url) {
    return presetForUrl(url).id;
  }
}

export { PRESETS };
