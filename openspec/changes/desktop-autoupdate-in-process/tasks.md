# Tasks

> 所有任务默认只改本仓库（`D:\Workspace\dsh自动更新\`）。凡涉及**真实 `desktop` profile** 的任务都标注了「需用户授权」，未授权前不得执行。

## 1. 修复插件既有缺陷（不触碰任何 profile）

- [ ] 1.1 修 headless 错误回显：把 `result.stderr ?? result.stdout` 改为"两路都取、非空者优先"，并在两路皆空时回落到退出码；验证：构造一个 stdout 有内容、stderr 为空的失败子进程，报告中的 `failed[].error` 含有 stdout 原文而不是 `exit code 1`
- [ ] 1.2 修启用状态：应用更新前读取目标 bundle 的 `enabled`，安装时把该状态原样传入；验证：单元级断言"原 disabled 的包，更新后仍为 disabled"
- [ ] 1.3 重写更新序列为「停用 → 卸载 → 安装 → 校验」；验证：代码路径不再出现"先 install 再等 `already-installed`"的分支，且卸载失败时不再继续安装
- [ ] 1.4 加 npm 源的 registry 存在性校验：应用前确认 `versions[<latest>]` 存在，否则跳过并记录原因；验证：给定一个 registry 上不存在的版本号，该项进入 `skipped` 且不产生安装动作
- [ ] 1.5 加更新后版本校验（生效版本必须 ≥ 更新前版本），低于则判失败并触发回滚；验证：模拟安装后版本未升的情形，该项进入 `failed` 且 `rolledBack` 为 true
- [ ] 1.6 扩展报告结构（`updates` / `applied` / `deferred` / `failed` / `skipped` / `rolledBack`，每项带 from/to/reason/error）；验证：一次失败运行后 `last-run.json` 中每个未更新项都有非空原因

## 2. 插件内定时能力

- [ ] 2.1 新增配置键 `scheduleMode`（`interval`/`daily`/`startup-only`）、`dailyTime`、`timeZone`、`jitterMinutes`，并在 `cordis.patch.yml` 的 config 块补默认值；验证：`--dump-config` 能看到新键且默认值正确
- [ ] 2.2 实现 `nextRun(cfg, now)`：三种模式分别返回下一触发时刻，`daily` 模式按 `timeZone` 解释 `dailyTime`；验证：给定固定 `now` 与配置时刻，返回值落在目标时区的该时刻上
- [ ] 2.3 用「一次触发 + 重新武装」替换现有 `setInterval`（`plugin/dsh-autoupdater/lib/index.js:88-96`），两种模式共用一条代码路径；验证：代码中不再有直接的 `setInterval`，且触发后能重新排定下一次
- [ ] 2.4 实现 `daily` 的时区反解与 DST 校验（用 `Intl.DateTimeFormat` 枚举目标时区各小时 offset，反解后格式化回去必须仍等于配置时刻）；验证：跨 DST 切换的一组固定输入下，返回时刻仍落在配置时区的配置时刻
- [ ] 2.5 实现抖动（0~`jitterMinutes` 随机延迟）与 `intervalHours = 0` 时关闭周期触发；验证：抖动上限为 0 时实际延迟为 0，上限大于 0 时延迟落在区间内
- [ ] 2.6 保留并强化重入保护：上一轮未结束时跳过本轮，且不影响下一次排定；验证：并发触发两次时第二次被跳过且下一次触发时刻不变

## 3. 决策层过滤与排序

- [ ] 3.1 实现跳过名单与原因：市场自身、插件自身、宿主不可移除包、普通依赖、预发布版本；验证：每类各构造一例，报告中均有对应原因
- [ ] 3.2 实现风险排序（补丁 → 次版本 → 主版本）与单轮数量上限；验证：混合三种跳变类型的输入，输出顺序符合预期，超限项进入 `deferred`

## 4. 无头通道回归验证（一次性 profile，不碰 `desktop`）

- [ ] 4.1 重建一次性 profile（如 `scratchtest`）用于验证；验证：该 profile 出现在 `C:\Users\fivez\.dsh\profiles\` 下且不与 `desktop` 混淆
- [ ] 4.2 在无头 CLI 宿主中挂载插件，确认检测可用、报告落盘、失败项带真实错误文本；验证：`<DSH_HOME>/autoupdater/last-run.json` 存在且字段完整
- [ ] 4.3 验证幂等：连续两次运行后第二次报告"无可用更新"；验证：两次运行后第二次的 `updates` 为空

## 5. 装入真实 `desktop` profile（需用户授权）

- [ ] 5.1 把 `dist/dsh-autoupdater-0.1.0.zip` 解压到纯 ASCII 路径 `C:\Users\fivez\.dsh\plugins\dsh-autoupdater`（OneDrive 中文路径不可用）；验证：目标目录存在且含 `package.json` / `lib/index.js` / `cordis.patch.yml`
- [ ] 5.2 用宿主的 `plugin_manager` 工具把插件装进 `desktop` profile（`install_bundle`，目标为该目录的绝对路径），不手写 profile 的 `package.json` / `cordis.patch.yml`，不在 profile 目录里跑 pnpm；验证：安装结果为 applied，且 bundle 列表中出现 `dsh-autoupdater`
- [ ] 5.3 空跑（`autoApply: false`）验证检测列表正确；验证：报告中列出本机当前的两个真实更新项（`@linxin666/dsh-client-ui-task-board` 0.4.6→0.4.8 与 `dsh-our-free-model` 的新提交），且 `applied` 为空

## 6. 真实更新验证（需用户授权）

- [ ] 6.1 放行一个低风险补丁版本更新（`maxUpdatesPerRun: 1`），重点验证启用状态未被改变；验证：更新后 `@linxin666/dsh-client-ui-task-board` 仍为 disabled，版本变为 0.4.8，lockfile 与清单一致
- [ ] 6.2 验证浮动 git 源：先卸载再安装后，来源提交应变为市场报告的新提交；验证：`dsh-our-free-model` 的来源提交变化；若未变化则该源退回"只报告"并在文档中说明
- [ ] 6.3 验证失败回滚路径：制造一次安装失败，确认包被装回原版本且启用状态不变；验证：报告的 `rolledBack` 为 true 且包版本与更新前一致

## 7. 文档与收尾

- [ ] 7.1 更新 `docs/调研结论.md`：补入宿主 `pluginManager` 的三条硬事实（`already-installed` 守卫、`enabled` 默认启用、失败折进返回值）与"市场桌面安装走同一通道"的结论；验证：文档中的每条事实都能在 asar 源码中定位到行号
- [ ] 7.2 更新 `README.md` 与 `项目进度.md`：反映新目录结构、OpenSpec 工作流、已完成与待验证项；验证：文档中的进度与 tasks.md 的勾选状态一致
- [ ] 7.3 把 `tools/dsh-autoupdate.mjs` 降级为只读检测工具（移除或禁用其 `--apply` 对 `desktop` 的作用），并在帮助文本中说明原因；验证：`--apply` 对 `desktop` 不再执行安装，脚本帮助中写明原因
- [ ] 7.4 重新打包 `dist/` 产物并核对包内文件；验证：解压后的插件目录含三个文件且能通过语法检查
- [ ] 7.5 清理旧的 `自动更新/` 目录（`C:\Users\fivez\OneDrive\Onedrive文档\deepseek-harness\default-workspace\自动更新`），确认新目录已完整承接全部内容；验证：新目录含 `README.md`、`项目进度.md`、`docs/`、`plugin/`、`tools/`、`dist/` 与 `openspec/`，旧目录已不存在

## Workflow follow-up

- 变更实现完成后运行 `openspec validate desktop-autoupdate-in-process --strict` 复核。
- 经项目评审要求满足后归档该变更（`/openspec-archive-change`），归档后核对主规格 `openspec/specs/` 下三个能力已生成。
