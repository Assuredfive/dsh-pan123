# dsh-webdav

**通用 WebDAV 网盘** 的 DeepSeek Harness 插件：把网盘变成 **原生 Agent 工具 + 内置技能 + DSH 界面（侧栏多网盘浏览器 + 设置页）**。

不是「123云盘专用」——任何遵循 RFC 4918 的 WebDAV 服务端都能用，而且可以**同时挂多个网盘**，在侧栏下拉切换。

- **零依赖**：只用 Node 标准库（`fetch` + `node:fs`/`node:stream`），**不需要 Python**，不 import 任何 `@deepseek-ai/*` 或第三方包。
- **零构建**：host 半边是普通 ESM，client 半边是手写的 lazy-CJS bundle（和官方 `dsh-notification/client.js` 同形），没有编译步骤。
- **凭据不入库**：凭据只写本机 `~/.config/dsh-webdav/credentials.json`，代码可分享、密钥不分享。

```bash
npm i -g dsh-webdav        # 或装进 DSH profile（见下文「安装」）
```

---

## 支持的网盘

选一个预设、填地址与密码即可；预设还会告诉你**去哪儿拿「应用密码」**、以及那一家**实测踩过的坑**。

| 预设 | 地址形态 | 密码用什么 |
|---|---|---|
| 123云盘 | `https://webdav.123pan.cn/webdav` | 手机号 + 「工具中心 → 第三方挂载」的应用密码（会员权益） |
| 坚果云 | `https://dav.jianguoyun.com/dav/` | 注册邮箱 + 「安全选项 → 添加应用密码」 |
| Nextcloud / ownCloud | `https://<主机>/remote.php/dav/files/<用户名>/` | 建议用「安全 → 生成应用密码」 |
| 飞牛 fnOS | `http://<NAS地址>:5005/` | 控制中心 → 文件服务 → WebDAV（默认 HTTP 5005 / HTTPS 5006） |
| 群晖 Synology DSM | `http://<NAS地址>:5005/` | 需先装 WebDAV Server 套件（默认 5005 / 5006） |
| 极空间 ZOS | `http://<NAS地址>:5005/` | 系统设置 → 网络服务 → 文件访问 → WebDAV |
| Alist / OpenList | `http://<主机>:5244/dav/` | Alist 登录账号密码（地址必须带 `/dav`） |
| Seafile | `https://<主机>/seafdav` | 「设置 → 其他 → 生成 WebDAV 密码」 |
| InfiniCLOUD / TeraCLOUD | `https://webdav.teracloud.jp/dav/` | 网页「アプリ連携 → WebDAV」的专用密码 |
| Koofr | `https://app.koofr.net/dav/Koofr/` | Preferences → App passwords |
| Yandex Disk | `https://webdav.yandex.com/` | Yandex ID 的应用专用密码 |
| Mail.ru Cloud | `https://webdav.cloud.mail.ru/` | 账号安全设置里的应用密码 |
| OpenDrive | `https://webdav.opendrive.com/` | 注册邮箱（WebDAV 需付费方案） |
| Box | `https://dav.box.com/dav` | 仅企业版提供，需管理员开启 |
| 自定义 / 其它 | 手填完整地址 | Apache mod_dav、其它 NAS、WebDAV 网关都选这项 |

> 自建 NAS 基本都在**局域网**里：跨设备取件前先确认 DSH 所在机器能连通那个地址。

---

## 功能

### 1. Agent 工具（11 个，全部支持 `remote` 参数）

| 工具 | 用途 |
|---|---|
| `webdav_remotes` | 列出已配置的网盘（id / 名称 / 地址 / 打码账号 / 默认），**多网盘时先跑这个** |
| `webdav_check [remote]` | 连通性自检：HTTP 状态、DAV 等级、根目录条目数、凭据来源 |
| `webdav_ls [remote] [路径]` | 列目录，默认根 `/`，目录在前 |
| `webdav_stat [remote] <路径>` | 查类型/大小/时间；不存在时返回 `exists=false` 而不报错 |
| `webdav_get [remote] <远端> [本地]` | 下载到本机（流式） |
| `webdav_put [remote] <本地> [远端目录]` | 上传（流式；远端目录缺失时自动补建） |
| `webdav_mkdir [remote] <路径>` | 新建目录（只建一级） |
| `webdav_mv [remote] <源> <目标>` | 移动 / 重命名（目标撞名会自动处理覆盖） |
| `webdav_rm [remote] <路径> [recursive]` | 删除；**目录必须显式 `recursive: true`** |
| `webdav_read [remote] <路径> [maxBytes]` | 直接读远端小文本文件进上下文（默认 ≤256KB） |
| `webdav_url [remote] <路径>` | 打印 WebDAV 直连地址（不是分享链接） |

`remote` 是网盘 id，省略就用默认网盘。远端路径以 `/` 开头或不以 `/` 开头都行；中文名自动 URL 编码，不要手工编码。

### 2. 设置页：`设置 → WebDAV 网盘`

- **网盘列表**：每张卡片显示名称 / 预设 / 地址 / 打码账号 / 是否默认 / 是否缺密码，
  可**测试连接、编辑、设为默认、删除**；被环境变量盖住的字段会明确标出
- **添加 / 编辑网盘**：选预设自动填地址（并**自动选中 `<主机>` 占位符**，直接打 IP 就能覆盖），
  就地显示该预设的「怎么拿密码」与「已知坑」
- **偏好**：请求超时、`webdav_read` 上限、列目录条数上限、大文件警告阈值
- **保存后立即生效**，不需要重启 DSH

### 3. 侧栏标签页「网盘」

装了 `dsh-better-sidebar` 时，侧栏会多出一个 **「网盘」标签页**，点开即完整文件浏览器：

- **多网盘切换**：工具栏下拉切换网盘（只配一个时自动隐藏）；**每个网盘各自记住上次所在目录**
- 面包屑导航、进入目录、下载、预览
- **搜索 / 排序 / 筛选**：按 `/` 聚焦搜索框即时按名称过滤，「仅文件夹」开关；
  可按名称 / 修改时间 / 大小 / 类型排序（点表头或工具栏按钮切换升倒序，**目录永远在前**，名称按数字序）
- **多选与批量操作**：行首复选框 + 表头全选，可批量下载 / 移动 / 删除；
  批量任务显示进度条，**随时可点「停止」**；上传失败不再中断整批，最后汇总失败清单
- **重命名**：行内编辑（`F2` 或右键/`⋯` 菜单），只改名字，`Enter` 提交、`Esc` 取消
- **移动到…**：**可视化目录选择器**（逐级点进去选目标，还能就地新建文件夹），不用手打路径；
  文件夹移入自身会被自动跳过，移动后可一键「打开目标目录」
- **右键菜单 / `⋯` 按钮**：打开、预览、下载、复制下载链接、复制路径、重命名、移动到…、删除
- **键盘操作**：`Ctrl+A` 全选、`F2` 重命名、`Delete` 删除、`↑`/`↓` 移动光标行、`空格` 勾选、`Enter` 打开或预览
- 上传（按钮 + 拖拽，带进度）、新建文件夹；删除**目录**需手输 `DELETE` 确认
- **窄栏适配**：侧栏窄的时候自动收起大小 / 修改时间列，名字不被挤没
- **Markdown 预览**：`.md` 默认渲染（标题/列表/表格/代码块/引用/行内样式），可切「原文」对照

页面也可以单独访问：`http://127.0.0.1:19387/webdav`（设置页 `?view=settings`）。

### 4. 同源 JSON API

页面用的接口，也可以自己脚本调（都要带页面里内嵌的 token，请求头 `X-Webdav-Token`）。
**所有内容接口都接受 `remote=<id>`**，省略则用默认网盘。

```
GET  /webdav                                文件浏览器页面（token 内嵌）
GET  /webdav?view=settings                  设置页
GET  /webdav/api/config                     网盘清单 + 全局偏好 + 预设表（永不含密码）
POST /webdav/api/config                     {prefs?} / {remote?} / {select?} / {remove?}
GET  /webdav/api/status?remote=<id>         凭据来源 + 连通性
POST /webdav/api/test                       用临时凭据测连通性，不落盘
GET  /webdav/api/list?remote=&path=/        列目录
GET  /webdav/api/stat?remote=&path=/x       单个条目
GET  /webdav/api/content?remote=&path=/x    读小文本文件（JSON）
GET  /webdav/api/download?remote=&path=/x   下载（浏览器另存为）
PUT  /webdav/api/upload?remote=&dir=&name=  请求体即文件字节，流式 PUT 到远端
POST /webdav/api/mkdir                      {remote?,path}
POST /webdav/api/move                       {remote?,from,to}
POST /webdav/api/delete                     {remote?,path,recursive}
```

---

## 服务端差异：这个插件替你消化掉的部分

各家的 WebDAV 实现差别很大。下面这张表是**真机实测**出来的（123云盘 + 若干知名服务端），
插件用「先乐观尝试 → 失败后自愈 → 记住结论」的方式让同一段代码在谁家都能用：

| 行为 | 123云盘 实测 | 标准/多数服务端 | 插件的处理 |
|---|---|---|---|
| `PUT` 到不存在的父目录 | 自动逐级建目录 | `409 Conflict` | 409/404 → 逐级 `MKCOL` → 重试一次 |
| `MOVE` 到**已存在**的目标 | **一律 `500`**（`Overwrite` 头无效） | 正常覆盖 | 先确认源存在 → 删目标 → 重试，并标记 `replaced` |
| `MOVE` 源不存在 | `500` | `404` | 先查源；**源不存在就绝不碰目标**（防静默数据丢失） |
| `MOVE` 目标父目录不存在 | `500` | `409` | 二次诊断后提示「目标目录不存在」 |
| `COPY` | Allow 里声明支持，实测 `500` | 可用 | 识别为「不支持」并给出替代方案 |
| `MKCOL` 已存在的目录 | `201`（当成功） | `405` | 都当成功，但错误提示按服务端语义走 |
| `PROPFIND` 不带 body | 可用 | 部分 NAS 要求显式 `<prop>` | 先带显式 body，被拒就自动退回 allprop 并记住 |
| `getetag` | 空 | 有 | 有就用，没有不报错 |
| `getcontentlength` | 目录无 | 目录无 | 拿不到就是 `null`，**不会当成 0** |
| `resourcetype` / `displayname` | 有 | 多数有 | 两种命名空间前缀（`d:` / 无前缀）都能解析 |
| 不支持的属性 | 回 404 propstat 里放**同名空元素** | — | **只在 2xx propstat 里取值**，避免读到空值 |
| `Allow` 头 | **不可信**（列了 COPY 却不工作） | — | 能力靠实测，不读 `Allow` |
| 被反代到登录页 | — | 返回 `200` + HTML | 识别为「不是 WebDAV 响应」并报错，**绝不静默当成空目录或把登录页存成文件** |

123云盘还有一条**内容层面**的最终一致性：下载走签名 CDN，**刚覆盖写入的文件立刻读回可能仍是旧内容**
（实测 `PUT` 新内容后 `GET` 仍返回上一版，几秒后正常）。这不是写入失败。

学到的能力缓存在 `~/.config/dsh-webdav/capabilities.json`，按「网盘 id + 地址」存；地址一改就自动作废。

---

## 安装

### 方式一：DSH profile（推荐）

在 profile 的 `package.json` 里加依赖，并把包名加进 `dsh.profile.bundles`：

```jsonc
{
  "dependencies": { "dsh-webdav": "link:D:/agent/dsh-webdav" },   // 或版本号
  "dsh": { "profile": { "bundles": [ /* ... */ "dsh-webdav" ] } }
}
```

包内的 `cordis.patch.yml` 会插入 `id: dsh-webdav` 这一行，因此在「设置 → 插件」里可见、可停用。

> 改 `package.json` 与 host 代码后需要重启 DSH；改 `lib/ui.html` 只要刷新页面（按 mtime 缓存）。

### 方式二：从 npm 安装

```bash
npm i -g dsh-webdav
```

---

## 凭据与配置文件

刻意把**密码**和**能进备份的配置**分开存，三份文件都在 `~/.config/dsh-webdav/`：

| 文件 | 内容 |
|---|---|
| `config.json` | 非机密：网盘清单（id / 名称 / 预设 / 地址 / 默认上传目录）+ 全局偏好 |
| `credentials.json` | 机密：每个网盘的账号与应用密码（`0600`，Windows 下用 `icacls` 收紧到仅当前用户） |
| `capabilities.json` | 运行时学到的服务端能力（上面那张表的结论） |

也可以用环境变量临时顶替：

```bash
WEBDAV_URL=https://dav.example.com/dav/
WEBDAV_USER=me@example.com
WEBDAV_PASSWORD=<应用密码>
WEBDAV_REMOTE=nas          # 可选：指定这些变量作用于哪个网盘（省略则作用于默认网盘）
```

**凭据禁止写入记忆、聊天正文、仓库或任何会同步的位置。** 多数服务商要求用「应用密码」而不是登录密码。

想换配置目录（便携安装 / 一台机器跑多套配置），在插件 config 里设置 `configDir`：

```yaml
- id: dsh-webdav
  config: { configDir: 'D:/portable/dsh-webdav' }
```

自定义目录是**完全自包含**的：三份文件都在里面，且不会去读 `~/.config/123pan/` 的老配置
（迁移只针对默认位置，免得「换个目录」把真实老凭据意外带进来）。

---

## 从 `dsh-pan123` 升级

老版本（≤0.3.0）的凭据会被**自动接管**，不需要重新输一次：

- `~/.config/123pan/webdav.env` → 解析成一个新的网盘条目写进 `config.json` / `credentials.json`
- `~/.config/123pan/settings.json` 里的偏好转进 `config.json`
- 迁移是幂等的：只要 `config.json` 已存在就不会再动它
- 老的 `pan123-*` 工具名、`/pan123` 路由、`pan123-webdav` 技能**不再提供**；
  内置的 `pan123-webdav` 影子技能会把模型指到新的 `webdav` 技能，避免它再去跑 `scripts/pan123.py`

老的 `~/.config/123pan/` 目录会保留不动，确认新配置工作正常后可以自行删除。

---

## 开发

```bash
node --test                       # 全部测试（154 个）
node --test test/interop.test.js  # 只跑「多服务端行为档位」互操作矩阵
npm pack --dry-run                # 看发布产物
```

测试里最值得一提的是两层：

- **`test/fake-webdav.js`**：可编排的假 WebDAV 服务端，用 `profile` 复刻真实服务端行为——
  `standard`（RFC 标准）、`123pan`（自动建目录 / MOVE 撞名 500 / COPY 500 / 404 propstat 空元素）、
  `minimal`（必须带显式 `<prop>` / 不支持 MOVE、COPY）、`login-redirect`（200 + HTML 登录页）；
  还能开 `noPrefix` 用默认命名空间。**真机比假服务器更弱**这件事就是靠它对出来的。
- **`test/interop.test.js`**：同一套操作跑遍所有 profile，断言最终结果一致——
  这是「通用」这个说法唯一的证据。

真机验证脚本（不进仓库，需要真实凭据）：覆盖连通性、多级目录上传、中文名、撞名 MOVE、
源不存在时的安全护栏、递归删除护栏、能力缓存回写。

---

## 边界与已知限制

- **协议本身**：WebDAV 没有服务端搜索（界面里的搜索只作用于**已加载的当前目录**）、没有分享链接、
  多数服务端没有回收站（`DELETE` 就是真删）。
- **目录删除是递归的**：按 RFC 4918，对集合的 `DELETE` 就是递归删除，任何服务端都不会再确认一次。
  插件强制要求显式 `recursive: true`，但这只是护栏，不是「能撤销」。
- **认证**：目前只支持 HTTP Basic（探测到的服务端基本都是它）。Digest / OAuth 未实现。
- **大文件**：WebDAV 没有秒传/断点续传，超过阈值会警告；超大文件建议用官方客户端。
- **部分服务端的最终一致性**：123云盘删除后约 10 秒内 `stat` 可能仍报「存在」；
  下载走 CDN，**覆盖写入后立刻读回可能拿到旧内容**。这类现象不是写入失败。
- **能力探测是惰性的**：插件不会一上来就在你的网盘里建临时文件去试探，
  而是在真实操作失败时才学习并记住结论。所以**第一次**撞名移动会比之后多花一次往返。

## License

MIT
