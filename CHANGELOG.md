# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-03

首个版本。由本地技能 `pan123-webdav`（Python 脚本）改写为原生 DSH 插件。

### Added

- **10 个 Agent 工具**：`pan123_check` / `ls` / `stat` / `get` / `put` / `mkdir` / `mv` / `rm` / `read` / `url`。
- **文件浏览器页面** `/pan123`：面包屑导航、进目录、下载、上传（按钮 + 拖拽 + 进度）、新建文件夹、
  重命名/移动、预览、删除（目录需手输 `DELETE` 确认）。
- **Markdown 预览**：`.md` 默认渲染标题/列表/表格/代码块/引用/行内样式，可切「原文」对照。
- **侧栏标签页「123网盘」**（`dsh-better-sidebar`）：内嵌同一个页面。
- **设置分区「123云盘」**（设置页）：连接状态与实时自检、凭据（地址/账号/应用密码）、
  偏好（默认上传目录、列目录上限、读取上限、超时），保存后立即生效。
- **同源 JSON API** `/pan123/api/*`（token 保护）：status / config / test / list / stat / content /
  download / upload / mkdir / move / delete。
- **内置技能 `pan123-webdav`**：把用法、约定与「踩过才知道」的硬限制随插件分发。
- **凭据与偏好分离存储**：凭据只写 `~/.config/123pan/webdav.env`（尽力收紧 ACL），
  偏好写 `~/.config/123pan/settings.json`，都不进插件配置、不进仓库。

### Notes

- 纯 Node 标准库实现：**不需要 Python，没有任何运行时依赖，没有构建步骤**。
- `pan123_rm` 对目录强制 `recursive: true`：123 云盘对目录是递归删除且无回收站确认。
- 发布前用 `npm pack --dry-run` 核对过内容（14 个文件，约 42 kB，不含测试与凭据）。
