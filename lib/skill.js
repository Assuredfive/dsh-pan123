/**
 * 内置技能：把「踩过才知道」的约定随插件一起分发，
 * 这样即使技能目录没被加载，模型也能拿到正确用法与硬限制。
 *
 * 注册两个：
 *   - `webdav`：主技能，通用 WebDAV + 各家服务商的坑。
 *   - `pan123-webdav`：**影子技能**，名字与磁盘上那个旧技能（只会调 scripts/pan123.py）相同。
 *     runtime 层优先于 user 层，所以这个影子会顶掉旧技能——否则模型会重新看到「去跑 Python 脚本」的旧指引。
 */

export const SKILL_NAME = 'webdav';
export const LEGACY_SKILL_NAME = 'pan123-webdav';

export const SKILL_DESCRIPTION =
  '通过 WebDAV 读写用户的网盘文件（上传/下载/列目录/建目录/移动/删除），并在 DSH 界面里打开网盘文件浏览器。' +
  '支持多个网盘并存：123云盘/123网盘、坚果云、Nextcloud/ownCloud、群晖 Synology、飞牛 fnOS、极空间、' +
  'Alist/OpenList、Seafile、InfiniCLOUD、Koofr、Box、Yandex Disk 等。' +
  '当用户提到网盘、云盘、WebDAV、上传下载到网盘、把文件传到网盘、从网盘拉文件、123pan、坚果云、群晖、飞牛、' +
  'fnOS、极空间、Nextcloud、Alist 时使用。';

export const SKILL_WHEN_TO_USE =
  '需要访问用户网盘上的文件，或需要在跨设备之间取件时使用（同机交付不需要绕道网盘）。';

const SKILL_SUMMARY = `# WebDAV 网盘通道（dsh-webdav 插件）

用户的网盘通过标准 WebDAV 接入，**纯 Node 实现**，不依赖 Python，也不需要任何旧的 \`scripts/pan123.py\`。
可以同时挂多个网盘（123云盘、坚果云、公司 Nextcloud、家里的群晖/飞牛 NAS…）。

## 怎么用

优先直接用插件提供的原生工具（不必起子进程）：

| 工具 | 用途 | 备注 |
|---|---|---|
| \`webdav_remotes\` | 列出已配置的网盘 | **配了多个网盘时先跑这个**，确认 remote id |
| \`webdav_check [remote]\` | 连通性自检 | 回显 HTTP 状态、DAV 等级与凭据来源 |
| \`webdav_ls [remote] [路径]\` | 列目录，默认根 \`/\` | 根目录条目多时慢，尽量进子目录 |
| \`webdav_stat [remote] <路径>\` | 查类型/大小/时间 | 不存在时返回 \`exists=false\`，不报错 |
| \`webdav_get [remote] <远端> [本地]\` | 下载到本机 | 本地缺省 = 当前工作目录同名文件 |
| \`webdav_put [remote] <本地> [远端目录]\` | 上传 | 远端目录缺省 = 该网盘的默认上传目录 |
| \`webdav_mkdir [remote] <路径>\` | 新建目录（只建一级） | 父目录不存在返回 409 |
| \`webdav_mv [remote] <源> <目标>\` | 移动/重命名 | 目标是完整新路径，不是目录 |
| \`webdav_rm [remote] <路径> [recursive]\` | 删除 | 目录必须显式 \`recursive: true\`，见下 |
| \`webdav_read [remote] <路径>\` | 读远端小文本文件（默认 ≤256KB） | 大文件用 \`webdav_get\` |
| \`webdav_url [remote] <路径>\` | 打印 WebDAV 直连地址 | **不是分享链接** |

\`remote\` 是网盘 id，省略就用默认网盘。远端路径写 \`路径\` 或 \`/路径\` 都行；
中文名由插件自动 URL 编码，**不要手工编码**。

**界面方式**：需要用户自己点着看/传文件时，让用户打开侧栏「网盘」标签页，
或直接访问 \`http://127.0.0.1:19387/webdav\`。界面顶部可切换网盘，支持列目录、进目录、下载、上传、
新建文件夹、行内重命名、移动到…（可视化选目录）、多选批量操作、右键菜单、快捷键与搜索排序。

## 凭据

在 DSH「设置 → WebDAV 网盘」里按网盘分别配置（地址 + 账号 + **应用密码**）。
落盘位置（密码与配置分开存）：

- \`~/.config/dsh-webdav/config.json\` — 网盘清单与偏好（非机密）
- \`~/.config/dsh-webdav/credentials.json\` — 账号与密码（0600 + ACL 收紧）
- \`~/.config/dsh-webdav/capabilities.json\` — 运行时学到的服务端能力

也可以用环境变量 \`WEBDAV_URL / WEBDAV_USER / WEBDAV_PASSWORD\`（多网盘时用 \`WEBDAV_REMOTE\` 指定给哪个网盘）
临时顶替。老版本的 \`~/.config/123pan/webdav.env\` 已被自动接管，无需重填。

**凭据禁止写入记忆、聊天正文、仓库或任何会同步的位置。**
多数服务商要求用「应用密码」而不是登录密码。

## 各家服务商的坑（实测/公认）

- **123云盘**：WebDAV 是会员权益；目录 \`DELETE\` 是递归删除且无确认；**不返回 ETag**；
  删除后有约 10 秒最终一致性窗口（立刻复查可能读到陈旧结果，以随后的 404 为准）；
  \`MOVE\` 到已存在的同名目标会返回 500（Overwrite 头无效）——插件已自动改成「先删目标再移动」；
  **下载走签名 CDN，刚覆盖写入的文件立刻读回可能仍是旧内容**（实测 PUT 新内容后 GET 仍返回上一版，
  等几秒或换文件名即正常）——这不是插件的问题，别据此判断写入失败。
- **飞牛 fnOS**：控制中心 → 文件服务 → WebDAV 服务，默认 HTTP 5005 / HTTPS 5006；
  **共享文件夹名含中文或特殊符号时可能列不出文件**，改成纯英文/数字最稳。
- **群晖 Synology**：需先装 WebDAV Server 套件，默认 5005 / 5006。开 HTTPS 要用 5006。
- **坚果云**：有流量/请求次数限制，被限流时表现为 429/503。
- **Alist/OpenList**：地址必须带 \`/dav\`（默认端口 5244）。
- 自建 NAS 基本都在**局域网**里：跨设备取件前先确认 DSH 所在机器能连通那个地址。

## 硬限制与安全约定

1. **目录删除 = 递归删除**：RFC 4918 规定对集合的 \`DELETE\` 就是递归的，任何服务端都不会再确认一次。
   → 插件强制：\`webdav_rm\` 判定目标是目录时必须显式 \`recursive: true\`，否则拒绝执行。动手前先 \`webdav_ls\`。
2. **\`webdav_mkdir\` 只建一级**：父目录不存在返回 \`409\`。
   但 \`webdav_put\` 会自动创建缺失的远端目录（有的服务端 PUT 自己会建，不会的由插件补 MKCOL），两者行为不对称。
3. **\`webdav_mv\` 撞名会覆盖**：插件会删掉已存在的目标再移动；如果你不想覆盖，先确认目标不存在。
4. **AI 与用户在同一台机器上**：同机交付文件走本地路径 + \`present\` 工具即可，
   **不要为了"交换"绕道网盘**。网盘只在跨设备（手机 / 另一台电脑）取件时才需要。
5. 对**真正不存在**的路径，查询返回 \`HTTP 404\`——这是判断"某路径是否存在"的可靠手段。
6. 大文件（默认 >200MB）会打印警告：WebDAV 没有秒传/断点续传，各家都容易失败，必要时改用官方客户端。
`;

/** 123云盘这个远程的用户私有约定（用户自己的目录习惯，别丢）。 */
const PRIVATE_NOTES = `
## 123云盘（用户的主网盘）的私有约定

- **远端文档目录 \`/dsh\`：用户的个人文档存放区**——用户说「把文档传到 dsh / 存到网盘」时，目标就是这里。
  把该网盘的「默认上传目录」设为 \`dsh\` 后，\`webdav_put\` 省略远端目录时也会落到这里。
- 旧的 \`/dsh-io\` 临时交换区已于 2026-09-22 删除，**不要重新创建**。
- 本地 \`D:\\Tools\\123网盘\\\` 是 **123 云盘 Windows 客户端的安装目录**，**不是文件落点**，不要往这里写文件。
- 非会员用不了 123 的 WebDAV；凭据失效时先确认会员有没有到期。
`;

const TROUBLESHOOTING = `
## 排错

- \`HTTP 401\` → 账号或应用密码错/失效；确认用的是**应用密码**而非登录密码。
- \`HTTP 403\` → 权限不足、超出授权目录，或没开通 WebDAV 权限。
- \`HTTP 404\` → 路径不存在（注意大小写与全角半角），或地址少了路径段。
- \`HTTP 409\` → 父目录不存在（MKCOL 只建一级）。
- \`HTTP 423\` → 被锁定（服务端在处理或被其它客户端占用）。
- \`HTTP 429/503\` → 被限流（坚果云常见），稍后重试。
- \`HTTP 500\` → 服务端内部错误。**有些服务端（如 123云盘）用它表示「路径不存在 / 目标已存在 / 父目录不存在」**，
  插件会对这类模糊错误做二次诊断，给出更具体的原因。
- 报错说「返回的不是 WebDAV 响应」→ 地址写错了，或被反向代理重定向到了登录页；检查地址是否精确到 WebDAV 端点。
- 想更原始地调试（把地址与凭据换成自己的）：
  \`curl.exe -sS --basic -u "<账号>:<应用密码>" -X PROPFIND -H "Depth: 1" <你的 WebDAV 地址>/\`
`;

export function skillContent() {
  return `${SKILL_SUMMARY}${PRIVATE_NOTES}${TROUBLESHOOTING}`;
}

export function legacySkillContent() {
  return `# pan123-webdav（已由 dsh-webdav 插件接管）

这个技能原本教模型去调用 \`scripts/pan123.py\` 访问 123云盘 WebDAV。
**该做法已废弃**，请改用 dsh-webdav 插件：

- 工具：\`webdav_remotes\` / \`webdav_check\` / \`webdav_ls\` / \`webdav_stat\` / \`webdav_get\` /
  \`webdav_put\` / \`webdav_mkdir\` / \`webdav_mv\` / \`webdav_rm\` / \`webdav_read\` / \`webdav_url\`
- 完整用法与各家服务商的坑：见 \`webdav\` 技能
- 界面：DSH 侧栏「网盘」标签页，或 \`http://127.0.0.1:19387/webdav\`

\`scripts/pan123.py\` 与 \`~/.config/123pan/webdav.env\` 都不再需要（旧凭据已被自动接管）。
不要再为此启动 Python 子进程。
`;
}

/** 提交给 skills 服务的注册对象。 */
export function skillRegistrations() {
  return {
    primary: {
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      whenToUse: SKILL_WHEN_TO_USE,
      content: skillContent(),
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    },
    legacy: {
      name: LEGACY_SKILL_NAME,
      description:
        '（已废弃）旧的 123云盘 WebDAV 技能：请改用 webdav 技能与 webdav_* 工具，不要调用 scripts/pan123.py。',
      whenToUse: '当提到 123网盘、pan123、pan123-webdav 时使用；它只负责把用法指到新的 webdav 技能。',
      content: legacySkillContent(),
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    },
  };
}
