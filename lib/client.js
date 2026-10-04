/* dsh-webdav —— client half (browser bundle)。
 *
 * 手写的 lazy-CJS 包：DSH 把本文件当普通 <script> 执行，顶层的
 * window.__ModuleLoader__.load({id, factory}) 只是登记一个工厂，所有副作用都在工厂里。
 * 所以这里**不能**用顶层 import/export，也**不需要**任何构建步骤
 * （与官方插件 dsh-notification/client.js 的产物形状一致）。
 *
 * 挂两个界面入口，本体都是 host 半边提供的同一个零依赖页面：
 *   1. better-sidebar 标签页「网盘」 → /webdav                  （多网盘浏览/上传/下载/切换）
 *   2. 设置项 settings.section「WebDAV 网盘」 → /webdav?view=settings（增删网盘、凭据、偏好、测试连接）
 * 用 iframe 而不是重写一份 React UI：页面自带 token，同源可直接调 /webdav/api/*，
 * 且不必引入任何前端依赖或构建链。
 */
window.__ModuleLoader__.load({
  id: 'dsh-webdav',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react'); // 平台内置基线模块，无需写进 dsh.client.external

    var FRAME_STYLE = {
      width: '100%',
      height: '100%',
      minHeight: '360px',
      border: '0',
      display: 'block',
      background: 'transparent',
    };

    function frame(src, title) {
      return React.createElement('iframe', { src: src, title: title, style: FRAME_STYLE });
    }

    function WebdavPanel() {
      return frame('/webdav', '网盘文件浏览器');
    }

    function WebdavSettings() {
      return frame('/webdav?view=settings', 'WebDAV 网盘设置');
    }

    function warn(ctx, message) {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message);
    }

    function apply(ctx) {
      // 1) 侧栏标签页
      try {
        var sidebar = ctx.get('betterSidebar');
        if (sidebar && typeof sidebar.registerTab === 'function') {
          ctx.effect(function () {
            return sidebar.registerTab({
              id: 'webdav',
              title: '网盘',
              description: '浏览/上传/下载 123云盘、坚果云、Nextcloud、群晖、飞牛 NAS 等 WebDAV 网盘',
              order: 120,
              single: true,
              component: WebdavPanel,
            });
          }, 'dsh-webdav: sidebar tab');
        } else {
          warn(ctx, 'dsh-webdav: 未检测到 dsh-better-sidebar，侧栏标签页未注册（/webdav 页面仍可访问）');
        }
      } catch (error) {
        warn(ctx, 'dsh-webdav: 侧栏标签页注册失败 - ' + String(error && error.message ? error.message : error));
      }

      // 2) 设置 → WebDAV 网盘
      try {
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          ctx.effect(function () {
            return ctx.slots.inject('settings.section', function () {
              return ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'webdav-settings',
                  order: 120,
                  label: function () {
                    return 'WebDAV 网盘';
                  },
                },
                WebdavSettings,
              );
            });
          }, 'dsh-webdav: settings section');
        } else {
          warn(ctx, 'dsh-webdav: 未检测到 ui-renderer 的 slots 服务，设置分区未注册（/webdav?view=settings 仍可访问）');
        }
      } catch (error) {
        warn(ctx, 'dsh-webdav: 设置分区注册失败 - ' + String(error && error.message ? error.message : error));
      }
    }

    var inject = ['slots', 'betterSidebar'];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
