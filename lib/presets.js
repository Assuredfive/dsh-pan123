/**
 * WebDAV 服务商预设：把「地址长什么样、密码该用哪个、有哪些坑」做成选一次就好的清单。
 *
 * 设计约定：
 *   - urlTemplate 里的 `<...>` 是让用户替换的主机占位符（设置页选中预设后会自动选中这段，
 *     用户直接输 IP 就能覆盖，不用手工删）。
 *   - tips 是「怎么拿到应用密码 / 去哪儿开通」的操作路径；quirks 是实测踩过的坑。
 *   - 预设只是**填表助手**：不做任何服务商专属分支，能力差异一律靠运行时自愈（见 lib/webdav.js）。
 */

/** @typedef {{id:string,label:string,urlTemplate:string,selfHosted?:boolean,auth?:string,helpUrl?:string,tips?:string[],quirks?:string[]}} Preset */

/** @type {Preset[]} */
export const PRESETS = [
  {
    id: '123pan',
    label: '123云盘',
    urlTemplate: 'https://webdav.123pan.cn/webdav',
    auth: 'app-password',
    helpUrl: 'https://www.123pan.com/',
    tips: [
      '账号填**手机号**，密码填 123云盘「工具中心 → 第三方挂载」里创建应用时给的应用密码',
      'WebDAV 是会员权益，非会员会连不上',
    ],
    quirks: [
      '目录的 DELETE 是递归删除且无二次确认',
      '不返回 ETag；修改时间(O)是真实的',
      'MOVE 到已存在的同名目标会返回 500（Overwrite 头无效），插件已自动改为「先删目标再移动」',
      '删除后有约 10 秒的最终一致性窗口，别马上复查',
      '下载走签名 CDN：**刚覆盖写入的文件，立刻读回可能还是旧内容**（等几秒再看）',
    ],
  },
  {
    id: 'jianguoyun',
    label: '坚果云',
    urlTemplate: 'https://dav.jianguoyun.com/dav/',
    auth: 'app-password',
    helpUrl: 'https://help.jianguoyun.com/?p=1331',
    tips: [
      '网页版「账户信息 → 安全选项 → 添加应用密码」，**密码填应用密码，不是登录密码**',
      '账号填注册邮箱',
    ],
    quirks: ['有流量/请求次数限制，被限流时表现为 503/429'],
  },
  {
    id: 'nextcloud',
    label: 'Nextcloud / ownCloud',
    urlTemplate: 'https://<主机>/remote.php/dav/files/<用户名>/',
    selfHosted: true,
    auth: 'app-password',
    tips: [
      '地址里的 `<用户名>` 就是登录名，必须替换掉',
      '密码建议在「个人设置 → 安全 → 生成应用密码」里生成，避免用主密码',
    ],
    quirks: ['删除的文件会进回收站（服务端配置决定），不一定是真删除'],
  },
  {
    id: 'fnos',
    label: '飞牛 fnOS',
    urlTemplate: 'http://<NAS地址>:5005/',
    selfHosted: true,
    auth: 'account-password',
    helpUrl: 'https://club.fnnas.com/',
    tips: [
      '在 fnOS「控制中心 → 文件服务 → WebDAV 服务」启用，默认 **HTTP 5005 / HTTPS 5006**',
      '账号密码 = fnOS 登录账号密码；还要在同一个页面设置「可见文件夹范围」',
    ],
    quirks: [
      '**共享文件夹名含中文或特殊符号时，WebDAV 可能列不出文件**——改成纯英文/数字最稳',
      '局域网地址一般是 http://192.168.x.x:5005（外网访问需要自己配端口映射或内网穿透）',
    ],
  },
  {
    id: 'synology',
    label: '群晖 Synology DSM',
    urlTemplate: 'http://<NAS地址>:5005/',
    selfHosted: true,
    auth: 'account-password',
    tips: [
      '「控制面板 → 文件服务 → WebDAV」启用，默认 **HTTP 5005 / HTTPS 5006**',
      '建议开 HTTPS 用 5006；账号 = DSM 账号',
    ],
    quirks: ['需要先在套件中心安装 WebDAV Server 套件'],
  },
  {
    id: 'zspace',
    label: '极空间 ZOS',
    urlTemplate: 'http://<NAS地址>:5005/',
    selfHosted: true,
    auth: 'account-password',
    tips: ['「系统设置 → 网络服务 → 文件访问 → WebDAV 服务」启用，端口以实际设置为准（默认常见 5005）'],
    quirks: ['开启 SSL 后端口不同，地址要用 https 且端口跟着改'],
  },
  {
    id: 'alist',
    label: 'Alist / OpenList',
    urlTemplate: 'http://<主机>:5244/dav/',
    selfHosted: true,
    auth: 'account-password',
    tips: [
      'Alist 默认端口 5244，WebDAV 挂在 `/dav` 路径下',
      '账号密码 = Alist 的登录账号密码；挂公开分享用 `/dav/<挂载路径>`',
    ],
    quirks: ['地址必须带 `/dav`；漏了会返回 404 或重定向到网页登录页'],
  },
  {
    id: 'seafile',
    label: 'Seafile',
    urlTemplate: 'https://<主机>/seafdav',
    selfHosted: true,
    auth: 'app-password',
    tips: ['密码在 Seafile「设置 → 其他 → 生成 WebDAV 密码」里单独生成'],
  },
  {
    id: 'teracloud',
    label: 'InfiniCLOUD / TeraCLOUD',
    urlTemplate: 'https://webdav.teracloud.jp/dav/',
    auth: 'app-password',
    tips: ['登录网页后在「アプリ連携 / Apps → WebDAV」里开通并取得专用密码'],
  },
  {
    id: 'koofr',
    label: 'Koofr',
    urlTemplate: 'https://app.koofr.net/dav/Koofr/',
    auth: 'app-password',
    tips: ['在「Preferences → App passwords」里生成应用密码'],
  },
  {
    id: 'yandex',
    label: 'Yandex Disk',
    urlTemplate: 'https://webdav.yandex.com/',
    auth: 'app-password',
    tips: ['要在 Yandex ID 里生成「应用专用密码」，登录密码不适用于 WebDAV'],
  },
  {
    id: 'mailru',
    label: 'Mail.ru Cloud',
    urlTemplate: 'https://webdav.cloud.mail.ru/',
    auth: 'app-password',
    tips: ['在 Mail.ru 账号安全设置里创建「应用密码」'],
  },
  {
    id: 'opendrive',
    label: 'OpenDrive',
    urlTemplate: 'https://webdav.opendrive.com/',
    auth: 'account-password',
    tips: ['账号填注册邮箱；WebDAV 需要付费方案'],
  },
  {
    id: 'box',
    label: 'Box',
    urlTemplate: 'https://dav.box.com/dav',
    auth: 'app-password',
    tips: ['WebDAV 只在 Box 企业版提供，且要管理员在后台开启'],
  },
  {
    id: 'custom',
    label: '自定义 / 其它 WebDAV',
    urlTemplate: '',
    tips: [
      '直接填完整的 WebDAV 地址，例：`https://example.com/remote.php/dav/files/me/`',
      'Apache mod_dav、WebDAV 网关、其它 NAS 都选这一项',
    ],
    quirks: ['地址必须精确到 WebDAV 端点；少一段路径会出现「返回的不是 WebDAV 响应」这类错误'],
  },
];

const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

/** @returns {Preset} */
export function findPreset(id) {
  return BY_ID.get(String(id ?? '')) ?? BY_ID.get('custom');
}

export function presetIds() {
  return PRESETS.map((preset) => preset.id);
}

/**
 * 从地址反推预设（只用于「用户已经填过地址」的场景，比如旧配置迁移）。
 *
 * 用**有序的特征匹配**而不是遍历预设模板：
 * 自建 NAS 的地址模板长得很像（都是 http://<NAS地址>:5005/），拿模板去比会把
 * Nextcloud 的 `/remote.php/dav/` 误判成坚果云的 `/dav/`。所以这里先认主机名，
 * 再认有辨识度的路径；实在认不出就返回 custom —— 认错比认不出更糟。
 */
const URL_SIGNATURES = [
  { id: '123pan', host: 'webdav.123pan.cn' },
  { id: 'jianguoyun', host: 'jianguoyun.com' },
  { id: 'teracloud', host: 'teracloud.jp' },
  { id: 'koofr', host: 'koofr.net' },
  { id: 'opendrive', host: 'opendrive.com' },
  { id: 'mailru', host: 'cloud.mail.ru' },
  { id: 'yandex', host: 'webdav.yandex.com' },
  { id: 'box', host: 'dav.box.com' },
  { id: 'nextcloud', path: '/remote.php/dav' },
  { id: 'seafile', path: '/seafdav' },
  { id: 'alist', path: '/dav/' },
];

export function presetForUrl(url) {
  const text = String(url ?? '').trim().toLowerCase();
  if (!text) return findPreset('custom');
  let host = '';
  let pathname = '';
  try {
    const parsed = new URL(text);
    host = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    host = text.replace(/^[a-z]+:\/\//, '').split('/')[0];
  }
  for (const signature of URL_SIGNATURES) {
    if (signature.host && host.endsWith(signature.host)) return findPreset(signature.id);
    if (signature.path && pathname.includes(signature.path)) return findPreset(signature.id);
  }
  // 群晖 / 飞牛 / 极空间的地址形状完全一样（http://<NAS地址>:5005/），无法从 URL 区分，
  // 猜错会给出错误的排错提示，所以老实返回 custom。
  return findPreset('custom');
}

/** 预设的「主机占位符」在模板里的位置，设置页用它来选中那段让用户直接改。 */
export function hostPlaceholderRange(template) {
  const match = /<[^>]+>/.exec(String(template ?? ''));
  if (!match) return null;
  return { start: match.index, end: match.index + match[0].length, text: match[0] };
}
