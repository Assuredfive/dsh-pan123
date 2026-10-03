/**
 * Agent 工具：pan123_*
 *
 * 刻意**不 import 任何 @deepseek-ai/* 包**：那类包在 profile 里是运行时内置的，
 * 从插件真实路径解析不到（实测 "Cannot find package '@deepseek-ai/dsh-tools'"）。
 * 这里自带参数编译（和 dsh-email 的做法一致），把工具定义直接交给 ctx.tools.register。
 *
 * 工具本身只做参数校验 + 文本渲染，实际语义全部在 lib/operations.js。
 */

import * as ops from './operations.js';

const QUERY_TIMEOUT_MS = 120_000;
const TRANSFER_TIMEOUT_MS = 300_000;

const text = (value) => [{ type: 'text', text: value }];

function signalOf(exec) {
  const signal = exec && typeof exec === 'object' ? exec.signal : undefined;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** { key: { type, required?, description? } } -> JSON Schema（与 dsh-email 的 compileParameters 同形）。 */
export function compileParameters(spec = {}) {
  const properties = {};
  const required = [];
  for (const [key, prop] of Object.entries(spec)) {
    if (prop?.required === true) required.push(key);
    const node = {};
    if (typeof prop?.type === 'string') node.type = prop.type;
    if (typeof prop?.description === 'string') node.description = prop.description;
    properties[key] = node;
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

/** 组装一个 ToolDefinition，并统一做必填参数检查。 */
function tool(definition) {
  const parameters = compileParameters(definition.parameters);
  const requiredKeys = parameters.required ?? [];
  return {
    name: definition.name,
    description: definition.description,
    parameters,
    timeoutMs: definition.timeoutMs,
    output: definition.output,
    async execute(args, exec) {
      const values = args ?? {};
      const missing = requiredKeys.filter(
        (key) => values[key] === undefined || values[key] === null || values[key] === '',
      );
      if (missing.length > 0) {
        throw new Error(`${definition.name}: 缺少必填参数 ${missing.join(', ')}`);
      }
      return definition.execute(values, signalOf(exec));
    },
  };
}

const PATH_DESC = '远端路径，如 /学习/2026；以 / 开头或不以 / 开头都行，中文名不要手工 URL 编码。';
const CRED_HINT = '凭据来自环境变量或 ~/.config/123pan/webdav.env；凭据不要写进记忆或聊天正文。';

/* ------------------------------------------------------------------- 渲染 */

const entrySchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    name: { type: 'string' },
    path: { type: 'string' },
    isDir: { type: 'boolean' },
    // size 只在能拿到数字时出现（目录没有长度），所以不进 required
    size: { type: 'integer' },
    sizeText: { type: 'string' },
    mtime: { type: 'string' },
  },
};

const listSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    path: { type: 'string' },
    total: { type: 'integer' },
    truncated: { type: 'boolean' },
    entries: { type: 'array', items: entrySchema },
  },
};

function renderList(value) {
  const header = `${value.path} — ${value.total} 项${value.truncated ? `（只显示前 ${value.entries.length} 项）` : ''}`;
  if (value.entries.length === 0) return text(`${header}\n(空目录)`);
  const lines = value.entries.map(
    (entry) =>
      `${entry.isDir ? 'DIR ' : 'FILE'}  ${String(entry.sizeText).padStart(9)}  ${String(entry.mtime || '')
        .slice(0, 19)
        .padEnd(19)}  ${entry.name}`,
  );
  return text([header, ...lines].join('\n'));
}

function renderStat(value) {
  if (!value.exists) return text(`${value.path} 不存在（HTTP ${value.status ?? 404}）`);
  const entry = value.entry;
  return text(
    [
      `${value.path}`,
      `类型    ${entry.isDir ? '目录' : '文件'}`,
      `大小    ${entry.sizeText}${entry.size == null ? '' : ` (${entry.size} 字节)`}`,
      `修改    ${entry.mtime || '-'}`,
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------- 工具集 */

export function buildTools(getConfig) {
  const run = (fn) => (args, signal) => fn(getConfig(), { ...args, signal });
  const toolset = [];

  toolset.push(
    tool({
      name: 'pan123_check',
      description: `123云盘 WebDAV 连通性自检：返回服务地址、HTTP 状态与根目录条目数，并回显凭据来源。凭据异常时先跑这个。${CRED_HINT}`,
      parameters: {},
      timeoutMs: QUERY_TIMEOUT_MS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) =>
          text(
            [
              `WebDAV   ${value.url}`,
              `HTTP     ${value.status} (207 正常)`,
              `根目录   ${value.rootCount} 个条目`,
              `账号     ${value.user || '(未解析)'}`,
              `凭据来源 ${JSON.stringify(value.sources)}`,
            ].join('\n'),
          ),
      },
      execute: run(ops.check),
    }),
  );

  toolset.push(
    tool({
      name: 'pan123_ls',
      description:
        '列出 123云盘 WebDAV 的某个目录（默认根目录 /）。只返回该目录的直接子项，目录在前。根目录条目多时较慢，尽量在子目录里操作。',
      parameters: { path: { type: 'string', description: PATH_DESC } },
      timeoutMs: QUERY_TIMEOUT_MS,
      output: { schema: listSchema, render: (_args, value) => renderList(value) },
      execute: run(ops.list),
    }),
  );

  toolset.push(
    tool({
      name: 'pan123_stat',
      description:
        '查询 123云盘单个条目的类型/大小/修改时间。目标不存在时返回 exists=false 而不是报错——这是判断“某路径是否存在”的可靠手段。',
      parameters: { path: { type: 'string', required: true, description: PATH_DESC } },
      timeoutMs: QUERY_TIMEOUT_MS,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => renderStat(value) },
      execute: run(ops.stat),
    }),
  );

  toolset.push(
    tool({
      name: 'pan123_get',
      description:
        '从 123云盘下载一个文件到本机。AI 与用户通常在同一台机器上，同机交付优先用本地路径，不必为了“交换文件”绕道网盘。',
      parameters: {
        remote: { type: 'string', required: true, description: '远端文件路径，如 /学习/x.pdf' },
        local: { type: 'string', description: '本地保存路径（含文件名）；省略时存到当前工作目录的同名文件。' },
      },
      timeoutMs: TRANSFER_TIMEOUT_MS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(`已下载 ${value.remote} -> ${value.local} (${value.size})`),
      },
      execute: run(ops.download),
    }),
  );

  toolset.push(
    tool({
      name: 'pan123_put',
      description:
        '把本机文件上传到 123云盘。远端目录不存在时会自动创建（与 mkdir 不同，PUT 会自动建目录）。文件名取自本地文件，可用 remoteName 覆盖。',
      parameters: {
        local: { type: 'string', required: true, description: '本地文件路径（绝对路径最稳）。' },
        remoteDir: {
          type: 'string',
          description: '远端目录（默认根目录 /，可用插件配置 defaultUploadDir 改成 dsh）。用户说“传到 dsh”时传 dsh。',
        },
        remoteName: { type: 'string', description: '远端文件名，省略时用本地文件名。' },
      },
      timeoutMs: TRANSFER_TIMEOUT_MS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) =>
          text(
            [
              `已上传 ${value.local} -> ${value.remote} (${value.size})`,
              ...(value.warnings ?? []).map((warning) => `[!] ${warning}`),
            ].join('\n'),
          ),
      },
      execute: run(ops.upload),
    }),
  );

  toolset.push(
    tool({
      name: 'pan123_mkdir',
      description: '在 123云盘新建目录（只建一级；父目录不存在会返回 409，需要逐级创建）。',
      parameters: { path: { type: 'string', required: true, description: PATH_DESC } },
      timeoutMs: QUERY_TIMEOUT_MS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(`已创建目录 ${value.path}`),
      },
      execute: run(ops.mkdir),
    }),
  );

  toolset.push(
    tool({
      name: 'pan123_mv',
      description: '在 123云盘移动或重命名条目（目标同名会被覆盖）。',
      parameters: {
        from: { type: 'string', required: true, description: '源路径。' },
        to: { type: 'string', required: true, description: '目标路径（完整新路径，不是目标目录）。' },
      },
      timeoutMs: QUERY_TIMEOUT_MS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(`已移动 ${value.from} -> ${value.to}`),
      },
      execute: run(ops.move),
    }),
  );

  toolset.push(
    tool({
      name: 'pan123_rm',
      description:
        '删除 123云盘上的文件或目录。注意：123云盘对目录是**递归删除**（子项一并删除且无确认），所以删除目录时必须显式传 recursive=true；先用 pan123_ls 看清内容再删。删除后有短暂的最终一致性窗口，不要立刻复查。',
      parameters: {
        path: { type: 'string', required: true, description: PATH_DESC },
        recursive: {
          type: 'boolean',
          description: '确认递归删除目录：目标被判定为目录时必须传 true，否则本工具会拒绝执行。',
        },
      },
      timeoutMs: QUERY_TIMEOUT_MS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) =>
          value.removed
            ? text(`已删除 ${value.path}${value.wasDir ? '（目录，递归删除）' : ''}\n${value.note}`)
            : text(`${value.path} 不存在，无需删除。`),
      },
      execute: run(ops.remove),
    }),
  );

  toolset.push(
    tool({
      name: 'pan123_read',
      description:
        '直接把 123云盘上的小文本文件读进上下文（默认最多 256KB，超出会标记 truncated）。比先下载再读取更省事，大文件请用 pan123_get。',
      parameters: {
        path: { type: 'string', required: true, description: '远端文件路径。' },
        maxBytes: { type: 'integer', description: '最多读取的字节数，默认 262144。' },
      },
      timeoutMs: QUERY_TIMEOUT_MS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) =>
          text([`${value.path} (${value.bytes} 字节)${value.truncated ? ' [已截断]' : ''}`, value.content].join('\n')),
      },
      execute: run(ops.readText),
    }),
  );

  toolset.push(
    tool({
      name: 'pan123_url',
      description: '打印某个远端路径的 WebDAV 直连地址（需要凭据，不是公开分享链接）。',
      parameters: { path: { type: 'string', description: PATH_DESC } },
      timeoutMs: QUERY_TIMEOUT_MS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(`${value.url}\n${value.note}`),
      },
      execute: run(ops.url),
    }),
  );

  return toolset;
}

/** 注册全部工具，返回统一 disposer。getConfig() 每次执行时取最新配置，设置页改动立即生效。 */
export function registerTools(ctx, getConfig) {
  const disposers = buildTools(getConfig).map((def) => ctx.tools.register(def));
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
