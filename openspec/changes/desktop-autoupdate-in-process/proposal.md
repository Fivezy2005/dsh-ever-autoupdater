# Proposal

## Why

DSH Desktop 的 `desktop` profile 现在**只能"查"更新、不能"装"更新**：市场 UI 要手点按钮，官方 `dsh plugin --profile desktop` 被明确拒绝（"managed exclusively by the Electron application"），而本项目自研的 `dsh-autoupdater` 插件在宿主内的应用链从未打通（headless 兜底退出码 1，错误文本还被自身的 `stderr ?? stdout` 取值写法吞掉）。

本轮查证推翻了旧结论：桌面宿主进程内**存在活跃的 `pluginManager` 服务**，而官方市场的桌面安装按钮走的是**同一条底层通道**（`dshmarket/lib/official-desktop.js` 的 `installOrReinstall` = install → `already-installed` → `removeBundle` → install）。因此自动更新不需要发明新机制，只需严格复刻官方调用序列。

## What Changes

- **打通插件的应用链**：改用宿主进程内的 `pluginManager` 服务（`installBundle` / `removeBundle` / `setBundleEnabled`），headless 子进程降级为 CLI 宿主的兜底路径，不再是桌面场景的关键路径。
- **修复 5 处已定位缺陷**：
  1. headless 错误回显（空字符串 `stderr` 优先于有内容的 `stdout`，真实错误被吞成 `exit code 1`）；
  2. `installBundle` 的 `options.enabled` 写死为 `true`，会把原本被禁用的 bundle 意外启用；
  3. 更新序列缺少「先停用」与「失败装回原版本」两步；
  4. 直接采用市场报出的 `latest` 字符串，未做 registry 存在性/pin 校验（市场 #496）；
  5. 更新后未校验版本确实升级（可能静默降级）。
- **新增插件内定时能力**：`scheduleMode`（`interval` / `daily` / `startup-only`）、`dailyTime`、`timeZone`、`jitterMinutes`，用"一次触发 + 重新武装"取代 `setInterval`（避免 DST 漂移与 24.8 天 `setTimeout` 上限）。
- **新增决策层过滤**：排除市场自身（`dshmarket`）、插件自身、宿主保护包（`removable === false`）、prerelease；按 patch→minor→major 排序；单次更新数上限。
- **新增适配优先**：确定更新目标前先判定候选版本是否适配当前宿主（复用市场的判定函数）。明确不适配的版本不装；npm 源改选最新的适配版；未声明适配范围的照常装（宿主装时自会拒绝真不兼容的，失败回滚）。失败过的「包@版本」被记住，不重复重试。
- **覆盖 npm 与 GitHub 两类来源**：不论插件是否发布到 npm，都纳入更新。
- **报告增强**：`last-run.json` 增补每包的 from/to/action/error/耗时、跳过原因、回滚标记。
- **BREAKING**：`tools/dsh-autoupdate.mjs --apply` 对 `desktop` profile 不再是可用路径（官方禁止 CLI 改 desktop）；该脚本降级为「只读检测 + 留档」工具。

## Capabilities

### New Capabilities

- `plugin-update-detection`: 判定 profile 中哪些插件存在可用更新，输出与市场 UI 一致的更新列表（npm 精确版本 + git 源提交），并按安全规则过滤与排序。
- `plugin-update-application`: 通过宿主 `pluginManager` 服务把更新安全地应用到 profile——含「先停用 → 卸载 → 安装 → 校验 → 失败回滚」序列、原启用状态保持、运行中 agent 熔断。
- `plugin-update-scheduling`: 插件内的定时触发能力（启动后延迟一次 + 周期/每日固定时刻），含时区与抖动处理。

### Modified Capabilities

（无 —— 本项目此前没有建立 OpenSpec 主规格，本次全部为新能力。）

## Impact

- **代码**：`plugin/dsh-autoupdater/lib/index.js`（检测/决策/应用/调度四层）、`plugin/dsh-autoupdater/cordis.patch.yml`（新增配置键）、`tools/dsh-autoupdate.mjs`（降级为只读）、`docs/调研结论.md`（补宿主 in-process 通道的事实）。
- **运行时**：DSH Desktop 的 `desktop` profile（`C:\Users\fivez\.dsh\profiles\desktop`）——更新时会改写其 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`。
- **依赖**：仅使用宿主已有的 `dshmarket`（检测）与 `pluginManager`（应用），不新增第三方依赖。
- **宿主契约依赖**：`installBundle` 在 HMR 存在时对已存在的依赖抛 `already-installed`（`@deepseek-ai/dsh-plugin-manager/lib/index.js:2733`）；`removeBundle` 对不可移除的 bundle 抛 `not-removable`；`installBundle` 默认会启用 bundle（同文件 2859 行）。这些是设计前提，宿主升级后需重新核对。
- **风险面**：自动替换宿主代码 = 自我提权面（标准预设默认禁用 `tool-plugin-manager` 正是此意），必须由用户显式知情授权后才安装进 `desktop` profile。
