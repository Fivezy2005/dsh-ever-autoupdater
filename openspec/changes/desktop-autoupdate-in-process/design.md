# Design

## Context

见 proposal.md - Why。

本设计依赖三条从宿主源码中读出的硬事实（`D:\Apps\DSH Next\resources\app.asar` 内的 `@deepseek-ai/dsh-plugin-manager` 与 profile 内的 `dshmarket 1.66.44`）：

1. **桌面宿主进程内存在活跃的 `pluginManager` 服务**（方法：`installBundle` / `removeBundle` / `setBundleEnabled` / `waitForInstall` / `cancelInstall` / `listBundles`）。官方市场的桌面安装按钮走的正是它（`dshmarket/lib/official-desktop.js` 的 `createOfficialDesktopRuntime` → `installOrReinstall`）。
2. **`installBundle` 在热重载存在时，会在 pnpm 启动之前拒绝覆盖已存在的依赖**：`if (this.ownerContext.get("hmr") !== void 0 && known !== void 0 && Object.hasOwn(before, known)) throw new ManagementFailure("already-installed")`（`lib/index.js:1992`）。因此更新必须先卸载。
3. **`installBundle` 默认会启用被装的 bundle**：`if (options?.enabled !== false) await this.selectBundle(name, true)`（`lib/index.js:2092`）。因此必须显式传入原启用状态。

另有若干约束：`removeBundle` 对不可移除的 bundle 抛 `not-removable`；`change()` 把失败折进返回值（`result.application = 'failed'` + `result.error = { code, diagnostic? }`）而不外抛；`change()` 在热重载存在时走 `hmr.runExclusive(apply)`（`lib/index.js:2330-2335`），外层再包一层会自锁；`checkUpdates` 每次问 registry 的当前最新版本（无累积状态）。

## Goals / Non-Goals

**Goals:**

- 桌面端的检测与更新**全部**在宿主进程内完成，不依赖任何 CLI 子进程。
- 更新动作与官方市场的桌面安装语义等价（remove→add 序列、版本写死、失败还原）。
- 定时能力内置于插件，支持每日固定时刻 + 时区 + 抖动，且不受夏令时与长时间运行影响。
- 所有跳过、推迟、失败、回滚都带明确原因写入报告。

**Non-Goals:**

- 不做 DSH 本体（`app.asar`）的自动升级——它不在插件管辖范围。
- 不更新市场插件自身（官方 `SELF_NAMES` 明文拦截，返回 `market-self-update`）。
- 不做跨 profile 的更新（只处理当前 profile）。
- 不引入第三方 updater（已评估并否决，见 `docs/调研结论.md` §3）。
- 不使用 PATH 上的系统 pnpm 操作真实 profile（宿主自带 pnpm 11.8.0，系统的是 12.14.0，会破坏 lockfile）。
- 本次不实现"用宿主定时服务推送通知"——其投递效果未实测，属独立议题。

## Decisions

### D1: 更新走宿主 `pluginManager` 服务，不走 CLI 子进程

**理由**：桌面宿主进程内就有该服务，且官方市场桌面安装按钮用的是同一通道——复用它等于复用官方实现，语义、锁、回滚、热重载全部一致。CLI 通道（`app.asar/lib/plugin-cli.js`）虽然能跑，但对 `desktop` profile 已被官方明确拒绝（"managed exclusively by the Electron application"），且其 `runPluginCommand` 不做 bundle 记账的完整回收。

**备选方案**：
- *CLI 子进程*：曾作为主路径，但它无法更新 `desktop` profile，且不触发宿主侧的 bundle 选择与热重载。→ 降级为"宿主无管理服务时"的兜底。
- *市场 HTTP API*：桌面端 browser-access 栅栏对外部请求一律 403（实测 `curl /dsh-market/api/v1/updates` → 403 `Browser access is disabled`）。→ 排除。
- *市场进程内路由*：市场把更新逻辑封在 `mountMarketRoutes` 的闭包里，没有可被外部调用的"更新 API"。→ 排除。

### D2: 更新序列 = 停用 → 卸载 → 安装 → 校验 →（失败）回滚

**理由**：由 D1 的事实 2 推出——`installBundle` 拒绝覆盖已存在的依赖，所以必须先卸载。官方市场桌面分支的 `installOrReinstall` 同样是 `install → already-installed → remove → install`，语义等价。

"先停用"是为了让 `removeBundle` 的 `bundle-in-use` 检查（loader 中仍有该 bundle 的活 fiber）有更小的命中概率：先 `setBundleEnabled(name, false)` 让它退出组合，再卸载。

**备选方案**：
- *只调 `installBundle`，靠它抛 `already-installed` 再补卸载*：逻辑上可行，但会多一次必然失败的 pnpm 前置检查，且失败信息容易被误读为真错误。→ 改为显式先卸载。
- *直接调 `pnpm add`（绕过宿主）*：失去锁、bundle 记账、兼容性闸门与失败还原。→ 排除。

### D3: 安装时显式传入原启用状态

**理由**：由事实 3 推出。本机 `@linxin666/dsh-client-ui-task-board` 当前是 **disabled** 状态，现有代码写死 `enabled: true` 会在更新后把它意外打开——这是会改变用户可见行为的事故。

**做法**：更新前从宿主读取该 bundle 的 `enabled`；`installBundle` 时传 `{ enabled: 原状态, saveExact: npm源时为 true }`；更新后再次读取比对，不一致则记为失败。

### D4: git 源的更新目标保留原 spec，靠 remove→add 触发重新解析

**理由**：`add` 一个与清单中完全相同的浮动 spec 会被 pnpm 判成 "Already up to date"（市场 issue #786）；而卸载后清单里已无该条目，`add` 会重新解析到远程 HEAD。官方市场桌面分支走的正是 remove→add。

**做法**：
- 浮动 spec（无 40 位 SHA）：目标 = 原 spec 去掉 SHA；先卸载再安装。
- 固定 SHA：目标 = `包名@<sha>`。

**未验证项**：remove 之后 `add` 浮动 spec 是否确实解析到新 HEAD，需实机验证（见 tasks 阶段 4）。

### D5: npm 源在应用前做一次 registry 存在性校验

**理由**：市场 issue #496 记录过——不先解析出精确版本就交给 pnpm，pnpm 11 的 fresh-release hold 会静默装旧版并写进清单。现有代码直接采用市场报的 `latest` 字符串，缺这一步。

**做法**：应用前查 `https://registry.npmjs.org/<包名>`，确认 `versions[<latest>]` 存在；不存在则跳过并记录原因。

### D6: 定时用「一次触发 + 重新武装」，不用固定重复定时器

**理由**：
- `setInterval(24h)` 在夏令时切换后会漂移 1 小时。
- `setTimeout` 的最长延迟约 24.8 天，日调度必然超限。
- 固定间隔无法表达"每天 09:30"这种日历语义。

**做法**：统一为一个 `nextRun(cfg, now)` 函数（`daily` / `interval` / `startup-only` 三种模式），算出下一时刻 → `setTimeout` → 到点执行 → 重新调用 `nextRun` 再次武装。`daily` 模式用 `Intl.DateTimeFormat` 在目标时区枚举 0~23 点的 UTC offset 反推真实时刻，并做"格式化回去仍等于配置时刻"的校验以处理 DST 跳变。

**备选方案**：
- *宿主定时服务*：契约是 `create(sessionId, request)`，投递的是 prompt 且必须绑定会话——更新是确定性的包管理调用，不能交给 LLM 自由发挥；且只覆盖 DSH 运行期间。→ 不作为执行器。
- *Windows 计划任务*：对 `desktop` profile 只能"查"不能"装"（官方拒绝 CLI 改 desktop），与插件内定时覆盖范围重合。→ 只作为可选的"DSH 未运行时的只读检测"留档手段，不纳入本次实现。

### D7: 跳过/推迟/失败一律带原因写进报告

**理由**：现有实现在 headless 兜底失败时把真实错误吞成 `exit code 1`（`result.stderr ?? result.stdout`，空字符串优先），导致"为什么没更新"无法排查。

**做法**：报告结构扩为 `updates`（计划）、`applied`、`deferred`（带原因）、`failed`（带错误原文）、`skipped`（带原因）、`rolledBack`；错误取值改为"两路都试，取非空的那一路"。

### D8: 不使用 PATH 上的系统 pnpm

**理由**：系统 pnpm 12.14.0 与宿主自带 pnpm 11.8.0 版本不同，曾在一次性 profile 上用系统 pnpm 改坏过 lockfile。真实 `desktop` profile 只走宿主自带的 pnpm。

## Risks / Trade-offs

- **自动替换宿主代码 = 自我提权面** → 插件默认 `autoApply` 可关闭；安装进 `desktop` profile 必须由用户显式授权；`skipPackages` 硬编码插件自身。
- **宿主契约会随版本变化**（`already-installed` 守卫、`enabled` 默认值、失败返回形状）→ 把这三条写进 `docs/调研结论.md`，并在 tasks 里安排"宿主升级后重新核对"的检查项。
- **更新中的包被运行中的 agent 使用** → 双保险：应用前检查运行中的 agent 整轮降级为只报告；宿主侧 `removeBundle` 的 `bundle-in-use` 再兜一层。
- **浮动 git 源的 remove→add 行为未实测** → 单独安排一个阶段验证，失败则该源退回"只报告"。
- **每日时刻落在 DST 不存在的时刻** → 反解后做"格式化回去"校验，不匹配则顺延到下一候选日并记录。
- **更新可能需要重启 DSH 才生效** → 报告中标明 `restartRequired`，不假装已生效。
- **一次装多个包会连续触发多次 pnpm 树重放** → 单轮数量上限（默认 3）控制爆炸半径。

## Migration Plan

1. 修插件既有缺陷（错误回显、启用状态、执行序列、版本校验）——只改 `plugin/dsh-autoupdater/`，不碰任何 profile。
2. 加定时能力（`scheduleMode` / `dailyTime` / `timeZone` / `jitterMinutes`）+ 重新武装改造。
3. 重建一次性 profile 做无头通道验证（CLI 宿主下挂载、检测、错误可见）。
4. **需用户授权**：把插件解压到纯 ASCII 路径并装进 `desktop` profile。
5. 空跑（`autoApply: false`）确认检测列表正确。
6. 放行一个低风险补丁版本更新，重点验证"启用状态未被改变"。
7. 验证浮动 git 源。
8. 全量开启 + 可选的只读检测计划任务。

**回滚策略**：所有更新动作由宿主服务执行，宿主本身在安装失败时还原 `package.json` 与 `pnpm-lock.yaml`；插件层再叠加"装回原版本"。插件整体可通过宿主卸载（但它会自我保护，需先把它从 `skipPackages` 之外的手段处理——实际做法是先停用再卸载）。

## Open Questions

- 宿主定时服务（`schedule`）把 prompt 投进会话后的实际呈现效果未实测。若之后要加"更新完成提醒"，需先在真实会话上验证一次；这不影响本设计的任何规格。
- 插件是否需要导出 `Config` schema（让配置有校验与 UI 提示）——独立议题，不阻塞本次实现。
