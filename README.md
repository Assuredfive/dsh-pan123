# dsh-pan123

123 云盘（123pan / 123网盘）WebDAV 的 DeepSeek Harness 插件。把原来那个 `pan123-webdav` 技能变成：
**原生 Agent 工具 + 内置技能 + DSH 界面（侧栏文件浏览器 + 设置页）**。

- **零依赖**：只用 Node 标准库（`fetch` + `node:fs`/`node:stream`），**不需要 Python**，不 import 任何 `@deepseek-ai/*` 或第三方包。
- **零构建**：host 半边是普通 ESM，client 半边是手写的 lazy-CJS bundle（和官方 `dsh-notification/client.js` 同形），没有编译步骤。
- **凭据不入库**：凭据只写本机 `~/.config/123pan/webdav.env`，代码可分享、密钥不分享。

---

## 功能

### 1. Agent 工具（10 个）

| 工具 | 用途 |
|---|---|
| `pan123_check` | 连通性自检（先跑这个），回显 HTTP 状态与凭据来源 |
| `pan123_ls [路径]` | 列目录，默认根 `/`，目录在前 |
| `pan123_stat <路径>` | 查类型/大小/时间；不存在时返回 `exists=false` 而不报错 |
| `pan123_get <远端> [本地]` | 下载到本机（流式） |
| `pan123_put <本地> [远端目录]` | 上传（流式，PUT 自动创建缺失目录） |
| `pan123_mkdir <路径>` | 新建目录（只建一级） |
| `pan123_mv <源> <目标>` | 移动 / 重命名 |
| `pan123_rm <路径> [recursive]` | 删除；**目录必须显式 `recursive: true`** |
| `pan123_read <路径> [maxBytes]` | 直接读远端小文本文件进上下文（默认 ≤256KB） |
| `pan123_url <路径>` | 打印 WebDAV 直连地址（不是分享链接） |

远端路径以 `/` 开头或不以 `/` 开头都行；中文名自动 URL 编码，不要手工编码。

### 2. 设置页：`设置 → 123云盘`

plugin 在 DSH 设置里注册一个 **「123云盘」** 分区，用来做初始化与日常维护：

- **连接状态**：实时自检（HTTP 状态、账号、根目录条目数），一键「测试连接」
- **凭据**：填 WebDAV 地址 / 账号 / 应用密码 → 保存后写本机 `webdav.env`
- **偏好**：默认上传目录（影响 `pan123_put` 省略远端目录时的落点）、列目录条数上限、
  `pan123_read` 上限、请求超时
- **保存后立即生效**，不需要重启 DSH
- 若本机设了 `WEBDAV_*` 环境变量盖住了本页保存的值，页面会明确提示

### 3. 侧栏标签页「123网盘」

装了 `dsh-better-sidebar` 时，侧栏会多出一个 **「123网盘」标签页**，点开即完整文件浏览器：

- 面包屑导航、进入目录、下载、预览
- **搜索 / 排序 / 筛选**：按 `/` 聚焦搜索框即时按名称过滤，「仅文件夹」开关；
  可按名称 / 修改时间 / 大小 / 类型排序（点击切换升倒序，**目录永远在前**，名称按数字序）
- **多选与批量操作**：行首复选框 + 表头全选，可批量下载 / 移动 / 删除（删除需手输 `DELETE` 确认）
- **右键菜单**：打开、预览、下载、复制下载链接、复制路径、重命名 / 移动、删除
- 上传（按钮 + 拖拽，带进度）
- 新建文件夹、重命名 / 移动
- 删除：目录必须手动输入 `DELETE` 确认（123云盘对目录是递归删除、无回收站）
- **Markdown 预览**：`.md` 默认渲染（标题/列表/表格/代码块/引用/行内样式），可切「原文」对照

页面也可以单独访问：`http://127.0.0.1:19387/pan123`（设置页 `?view=settings`）。

### 4. 同源 JSON API

页面用的接口，也可以自己脚本调（都要带页面里内嵌的 token）：

```
GET  /pan123                                文件浏览器页面（token 内嵌）
GET  /pan123?view=settings                  设置页
GET  /pan123/api/status                     凭据 + 连通性
GET  /pan123/api/config                     当前有效配置 + 凭据来源（永不含密码）
POST /pan123/api/config                     保存设置（凭据 → webdav.env；偏好 → settings.json）
POST /pan123/api/test                       用（临时）凭据测试连通性，不落盘
GET  /pan123/api/list?path=/                列目录
GET  /pan123/api/stat?path=/x               单个条目
GET  /pan123/api/content?path=/x            读小文本文件（JSON）
GET  /pan123/api/download?path=/x&token=    下载（浏览器另存为）
PUT  /pan123/api/upload?dir=/&name=a.bin    请求体即文件字节，直接流式 PUT
POST /pan123/api/mkdir | move | delete      {path} / {from,to} / {path,recursive}
```

除页面本身外都要求 `X-Pan123-Token` 头或 `?token=`，避免本机别的程序顺手驱动网盘。

### 5. 内置技能 `pan123-webdav`

把自己注册成同名技能（`source: runtime`，优先于磁盘上的同名技能），把「远端 `/dsh` 是文档区」
「同机交付不必绕道网盘」「大文件别用 WebDAV」这些踩过坑的约定随插件一起分发。

---

## 安装

插件包带 `cordis.patch.yml`（插入行 `id: pan123-webdav, name: dsh-pan123`），
**推荐注册成 profile bundle**——这样它会出现在「设置 → 插件」里，可停用/移除。

### A. 作为 profile bundle（推荐）

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add dsh-pan123                  # 从 npm 安装；本地开发用： pnpm add link:D:\path\to\dsh-pan123
```

然后在 `profiles\desktop\package.json` 的 `dsh.profile.bundles` 数组里加上 `"dsh-pan123"`，重启 DSH。

`dsh.profile.bundles` 是「设置 → 插件」列表的数据源：不在这个数组里的包即使能跑，也不会出现在设置里。

### B. 热挂载（不改 package.json，适合临时试）

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-pan123" `
  -Target "D:\path\to\dsh-pan123"
```

再往 `~\.dsh\profiles\desktop\cordis.patch.yml` 追加：

```yaml
- insert:
    - id: pan123-webdav
      name: dsh-pan123
```

**注意**：host 插件是新插件，第一次挂载后要重启一次 DSH Desktop；且这种方式**不会**出现在设置 → 插件列表里。

### 卸载

从 `dsh.profile.bundles` 移除 `"dsh-pan123"`（或在设置 → 插件里停用），再 `pnpm remove dsh-pan123`，重启即可。
插件不改动 profile 里其它任何行。

---

## 配置

### 凭据（设置页填，或手写文件）

优先级（高 → 低）：**插件 config → 环境变量 → `webdav.env`**。

- 环境变量：`WEBDAV_URL` / `WEBDAV_USER` / `WEBDAV_PASSWORD`
- 凭据文件：`C:\Users\<你>\.config\123pan\webdav.env`
- 设置页保存时写的就是这个凭据文件（并尽力用 icacls 收紧到仅当前用户）

```ini
WEBDAV_URL=https://webdav.123pan.cn/webdav
WEBDAV_USER=<手机号>
WEBDAV_PASSWORD=<应用密码>
```

**凭据不要写进记忆、聊天正文、仓库或任何会同步的位置。** 泄露就去 123云盘「工具中心-第三方挂载」删掉该应用、重发密码。

### 偏好

设置页保存到 `~/.config/123pan/settings.json`（只放偏好，不放密码）；
也可以写进 patch 行的 `config:`（优先级更高）：

```yaml
- id: pan123-webdav
  config:
    defaultUploadDir: dsh
    maxListEntries: 2000
```

| 键 | 默认 | 说明 |
|---|---|---|
| `url` / `user` / `password` | 空 | 留空则按上面的优先级回落 |
| `envFile` | `~/.config/123pan/webdav.env` | 凭据文件路径 |
| `timeoutMs` | `120000` | 单次请求超时 |
| `defaultUploadDir` | 空（=根目录） | `pan123_put` 默认远端目录；设 `dsh` 后上传默认落到 `/dsh` |
| `bigFileWarnBytes` | `209715200` | 超过则提示别用 WebDAV 搬大文件 |
| `readMaxBytes` | `262144` | `pan123_read` 默认上限 |
| `maxListEntries` | `1000` | 单次列目录最多返回条目数 |
| `uiEnabled` | `true` | 是否注册 `/pan123` 页面 |

---

## 硬限制（踩过才知道）

1. **WebDAV 是会员功能**；凭据失效先确认会员是否到期。
2. **官方不推荐用 WebDAV 搬大文件**：无秒传、无断点续传，>200MB 会提示；真搬大文件用 123云盘客户端。
3. 免费用户直连挂载每月 10GB 流量，超限表现为下载无反应。
4. 授权目录是「我的文件」根，**根目录条目多时列目录慢**，尽量在子目录操作。
5. **删除目录是递归删除且无确认**（2026-09-22 实测）：本插件因此强制 `recursive: true`；界面里要求输入 `DELETE`。
6. **`mkdir` 只建一级**（父目录缺失 → 409），但 **`PUT` 会自动建缺失目录**——两者行为不对称。
7. **删除后有短暂最终一致性窗口**：删完立刻查询可能读到陈旧结果，以随后的 404 为准。
8. 不存在的路径查询返回 `HTTP 404`——这是判断「是否存在」的可靠手段。

## 排错

- `HTTP 401` → 应用密码错/被重置，或该应用授权被删除
- `HTTP 404` → 路径不存在（注意大小写与全角半角），或超出授权目录
- `HTTP 409` → 父目录不存在（MKCOL 只建一级）
- `HTTP 423` → 文件被占用（网盘端在处理）
- 工具报错会带人类可读的 `hint`；设置页的「测试连接」会直接给出原因
- 插件加载失败但看不到 host 日志时：设 `DSH_PAN123_DEBUG=1` 再重启，会把失败栈写到插件目录的 `.apply-report.json`
- 设置 → 插件里停用/启用即可重载；client 半边（标签页/设置页）改动会被 host 每 500ms 轮询到并热替换

---

## 开发

```powershell
cd D:\agent\dsh-pan123
node --test          # 56 个用例
```

覆盖：纯函数、**进程内假 WebDAV 服务端**端到端（`test/fake-webdav.js`，复刻 123云盘的
dir 404 / MKCOL 409·405 / PUT 自动建目录 / 目录 DELETE 递归 / `D:` 命名空间 207 / Basic 认证）、
HTTP API、设置存储与优先级、client bundle 契约、以及从 `ui.html` 抽出来跑的 Markdown 渲染器。

结构：

```
lib/webdav.js         纯 Node WebDAV 客户端（PROPFIND/GET/PUT/MKCOL/DELETE/MOVE + 凭据解析 + 207 解析）
lib/operations.js     操作层：工具与 HTTP API 共用的同一套语义
lib/settings-store.js 本机凭据文件（webdav.env）与偏好文件（settings.json）的读写
lib/runtime.js        运行期配置：设置页改动立即生效，无需重启
lib/tools.js          pan123_* 工具定义（自带参数 -> JSON Schema 编译，不依赖 dsh-tools）
lib/skill.js          内置技能正文
lib/api.js            /pan123 页面 + 同源 JSON API（token 保护）
lib/ui.html           零依赖文件浏览器 + 设置页 + Markdown 渲染器
lib/client.js         client 半边：侧栏标签页 + 设置分区（都是 /pan123 的 iframe）
lib/index.js          插件入口（tools + skills + webServer）
```

### 三个已知的工程约束

- **不要 `import` `@deepseek-ai/*`**：这些运行时包在 profile 里是内置的，从插件真实路径解析不到
  （实测 `Cannot find package '@deepseek-ai/dsh-tools'`），会让整个插件 fiber 加载失败。
  参数 Schema 由 `lib/tools.js` 自己编译；配置不用 schemastery。
- **工具输出会被 harness 校验**：`output.schema` 里声明 `integer` 的字段不能返回 `null`
  （目录没有 size），所以 `size` 只在拿到数字时才出现。
- **`webserver.register` 对重复 path 直接抛错**：热重载残留实例会占住 `/pan123`。
  插件对 `duplicate prefix route` 做了容错（告警 + 沿用既有路由）。

## License

MIT
