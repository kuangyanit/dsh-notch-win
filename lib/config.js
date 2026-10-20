/**
 * @module @dsh-external/dsh-notch-win/config
 *
 * 配置的**唯一权威**。
 *
 * 旧实现同时往三个地方写配置（宿主 settingsScope、跳转桥的兜底副本、
 * 渲染进程的 localStorage），三路互相删键 —— 这是它最难排查的一类缺陷。
 * 这里只有一条路：宿主持有的那一份配置。
 *
 * ## DSH 0.1.x vs 0.2.x 的 settings（这里不再静态 import dsh-settings）
 *
 * 0.1.x：`dsh-settings` 导出 `settingsNamespace` 与 `SettingsProvider.register`，
 * 插件在 `ctx.inject(["settings"], ...)` 里注册命名空间（`settings.yaml` 的
 * `dsh-notch-win:` 分节）。
 *
 * 0.2.x：`dsh-settings` 只导出 `SettingsForms`，**没有** `settingsNamespace`，
 * 也**没有** `register`；页面表单由 DSH 直接读取插件导出的 `Config` 自动生成。
 * 一旦静态 `import { settingsNamespace } ...`，ESM 在链接阶段就抛
 * `does not provide an export named 'settingsNamespace'`，整个宿主半边都不会加载
 * —— 岛 app 自然也不会被拉起。见 `lib/index.js` 里的版本分支。
 *
 * 所以：命名空间退化成插件 id 字符串（0.1.x 的 brand 只是类型层面的标记，
 * 运行时就是一个字符串），配置值优先由 cordis 通过 `apply(ctx, config)` 交进来。
 */
import z from '@deepseek-ai/schemastery';

import { PLUGIN_ID } from './protocol.js';

/** 0.1.x 的 settings 命名空间；0.2.x 的配置节由 profile 条目自己的 id 决定。 */
export const NS = PLUGIN_ID;

export const ConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('灵动岛总开关。关闭后岛不显示，也不再拉起岛 app'),
  hideWhenIdle: z
    .boolean()
    .default(false)
    .description('所有会话都不在执行中时隐藏岛'),
  jumpEnabled: z
    .boolean()
    .default(true)
    .description('允许点击岛上的会话，让 DSH 切换到该会话'),
  expandOnHover: z
    .boolean()
    .default(true)
    .description('鼠标悬停时自动展开 HUD 详情'),
  glowEffect: z
    .boolean()
    .default(true)
    .description('状态色内发光 / 外发光与呼吸动效'),
  scale: z
    .number()
    .min(0.8)
    .max(1.4)
    .default(1)
    .description('岛的整体缩放倍率 (0.8 ~ 1.4)'),
  autoLaunchApp: z
    .boolean()
    .default(true)
    .description('DSH 启动时自动拉起岛 app（已运行的实例会被单实例锁挡住，重复拉起无害）'),
  appPath: z
    .string()
    .default('')
    .description(
      '岛 app 可执行文件的完整路径。留空则按 顺序 探测：%LOCALAPPDATA%\\dsh-notch-win\\DSHNotch.exe → <插件目录>\\app\\dist\\win-unpacked\\DSHNotch.exe → <插件目录>\\app\\dist\\DSHNotch.exe',
    ),
});

/**
 * 默认值。**与上面的 `.default()` 同源** —— 直接对空对象求值，而不是手抄一遍，
 * 所以两者不可能漂移。
 */
export const DEFAULTS = Object.freeze(ConfigSchema({}));

const KEYS = Object.freeze(Object.keys(DEFAULTS));

/**
 * 只保留已知键，并丢掉显式的 `undefined`。
 *
 * 必要性：schemastery 对未知键是放行的（实测 `S({junk:1})` 会原样保留），
 * 而用户可能手改 settings.yaml。把脏键投影掉，`rev` 才不会因为无关内容抖动。
 */
export function project(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (source[key] === undefined) continue;
    out[key] = source[key];
  }
  return out;
}

/**
 * 用默认值补齐并校验。**非法值会抛出**（schemastery 的 ValidationError），
 * 这是 `/v1/config` 返回 `config-rejected` 的依据。
 */
export function resolveConfig(source) {
  return ConfigSchema({ ...DEFAULTS, ...project(source) });
}

/**
 * 配置仓库。三种状态：
 * - `settings`：已挂到 DSH settings，写入会落 `settings.yaml`（正常路径）
 * - `memory`：settings 服务缺席，值只活在内存里（设置页会显示"不可持久化"）
 * - `defaults`：还没挂载完成
 */
export function createConfigStore({ log } = {}) {
  let scope = null;
  let current = { ...DEFAULTS };
  let source = 'defaults';
  const listeners = new Set();

  function emit() {
    for (const fn of [...listeners]) {
      try {
        fn(current, source);
      } catch (error) {
        log?.warn?.('config 监听器抛出：', error);
      }
    }
  }

  function commit(next, nextSource) {
    current = next;
    source = nextSource;
    emit();
  }

  function readScope(fallback) {
    try {
      return resolveConfig(scope.get());
    } catch (error) {
      log?.warn?.('settings 分节未通过 schema，退回上一次的值：', error);
      return fallback;
    }
  }

  return {
    get config() {
      return current;
    },
    get available() {
      return scope !== null;
    },
    get source() {
      return source;
    },
    /** 订阅配置变化；返回退订函数。宿主用它来触发状态重算。 */
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * 用宿主交进来的配置播种。
     *
     * DSH 0.2.x 不再让插件自己 `register`：配置由 profile 条目持久化，cordis
     * 在 `apply(ctx, config)` 时把已校验的值作为第二参数传进来。空对象视为
     * “没有用户配置”，保持 `defaults`，免得把“插件被加载”误报成“配置来自 settings”。
     *
     * @returns `true` 表示确实有配置被采纳。
     */
    seed(value) {
      const clean = project(value);
      if (Object.keys(clean).length === 0) return false;
      commit(resolveConfig(clean), 'settings');
      return true;
    },

    /**
     * 迟到的 settings 服务。由 `ctx.inject(["settings"], cb)` 调用。
     * 返回 settingsScope.watch 的退订函数（挂到子 fiber 上由宿主负责）。
     */
    attach(nextScope) {
      scope = nextScope;
      commit(readScope(current), 'settings');
      return scope.watch(() => {
        commit(readScope(current), 'settings');
      });
    },

    /**
     * 写入一个 patch。
     *
     * @returns `{ persisted, config }`。`persisted === false` 表示 settings 服务
     *          缺席，值只在内存里 —— 设置页据此提示用户。
     */
    async set(patch) {
      const clean = project(patch);
      const candidate = resolveConfig({ ...current, ...clean }); // 先校验，失败即抛
      if (scope === null) {
        commit(candidate, 'memory');
        return { persisted: false, config: current };
      }
      await scope.update(clean);
      // watch 通常已经把新值同步进来了；这里再对一次账，防止"写入成功但没等到观察者"。
      const after = readScope(current);
      if (JSON.stringify(after) !== JSON.stringify(current)) commit(after, 'settings');
      return { persisted: true, config: current };
    },
  };
}
