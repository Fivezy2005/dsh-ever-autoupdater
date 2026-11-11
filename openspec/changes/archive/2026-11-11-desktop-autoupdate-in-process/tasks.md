# Tasks

> 所有任务默认只改本仓库（`D:\Workspace\dsh-ever-autoupdater\`）。凡涉及**真实 `desktop` profile** 的任务都标注了「需用户授权」，未授权前不得执行。

## 1. 修复插件既有缺陷（不触碰任何 profile）

- [x] 1.1 修 headless 错误回显：把 `result.stderr ?? result.stdout` 改为"两路都取、非空者优先"，并在两路皆空时回落到退出码；验证：构造一个 stdout 有内容、stderr 为空的失败子进程，报告中的 `failed[].error` 含有 stdout 原文而不是 `exit code 1`
- [x] 1.2 修启用状态：应用更新前读取目标 bundle 的 `enabled`，安装时把该状态原样传入；验证：单元级断言"原 disabled 的包，更新后仍为 disabled"
- [x] 1.3 重写更新序列为「停用 → 卸载 → 安装 → 校验」；验证：代码路径不再出现"先 install 再等 `already-installed`"的分支，且卸载失败时不再继续安装
- [x] 1.4 加 npm 源的 registry 存在性校验：应用前确认 `versions[<latest>]` 存在，否则跳过并记录原因；验证：给定一个 registry 上不存在的版本号，该项进入 `skipped` 且不产生安装动作
- [x] 1.5 加更新后版本校验（生效版本必须 ≥ 更新前版本），低于则判失败并触发回滚；验证：模拟安装后版本未升的情形，该项进入 `failed` 且 `rolledBack` 为 true
- [x] 1.6 扩展报告结构（`updates` / `applied` / `deferred` / `failed` / `skipped` / `rolledBack`，每项带 from/to/reason/error）；验证：一次失败运行后 `last-run.json` 中每个未更新项都有非空原因

## 2. 插件内定时能力

- [x] 2.1 新增配置键 `scheduleMode`（`interval`/`daily`/`startup-only`）、`dailyTime`、`timeZone`、`jitterMinutes`，并在 `cordis.patch.yml` 的 config 块补默认值（默认 `interval`、`intervalHours: 3`、`jitterMinutes: 5`，无发布冷却）；验证：单元测试断言 `resolveConfig({})` 默认值与 `cordis.patch.yml` 一致（`--dump-config` 未实现，以单测代替）
- [x] 2.2 实现 `nextRun(cfg, now)`：三种模式分别返回下一触发时刻，`daily` 模式按 `timeZone` 解释 `dailyTime`；验证：给定固定 `now` 与配置时刻，返回值落在目标时区的该时刻上
- [x] 2.3 用「一次触发 + 重新武装」替换现有 `setInterval`（`plugin/dsh-ever-autoupdater/lib/index.js:88-96`），两种模式共用一条代码路径；验证：代码中不再有直接的 `setInterval`，且触发后能重新排定下一次
- [x] 2.4 实现 `daily` 的时区反解与 DST 校验（用 `Intl.DateTimeFormat` 枚举目标时区各小时 offset，反解后格式化回去必须仍等于配置时刻）；验证：跨 DST 切换的一组固定输入下，返回时刻仍落在配置时区的配置时刻
- [x] 2.5 实现抖动（0~`jitterMinutes` 随机延迟）与 `intervalHours = 0` 时关闭周期触发；验证：抖动上限为 0 时实际延迟为 0，上限大于 0 时延迟落在区间内
- [x] 2.6 保留并强化重入保护：上一轮未结束时跳过本轮，且不影响下一次排定；验证：并发触发两次时第二次被跳过且下一次触发时刻不变

## 3. 决策层过滤与排序

- [x] 3.1 实现跳过名单与原因：市场自身、插件自身、宿主不可移除包、普通依赖、预发布版本；验证：每类各构造一例，报告中均有对应原因
- [x] 3.2 实现风险排序（补丁 → 次版本 → 主版本）与单轮数量上限；验证：混合三种跳变类型的输入，输出顺序符合预期，超限项进入 `deferred`

- [x] 3.3 实现适配优先（npm）：取宿主版本（`dshHostInfo()`），先用原生 `fetch` 取完 registry 数据，再调用 `manifestFacts` / `deriveHostCompatibility`；`incompatible` 时用 `findCompatibleVersion` 改选最新适配版，无则跳过并记原因；验证：用固定的 registry 样本数据构造「最新版适配 / 未声明 / 不适配有较新适配版 / 不适配无适配版」四例，结果分别为 装最新 / 装最新 / 装适配版 / 跳过
- [x] 3.4 实现适配优先（git 源）：读目标提交 `package.json` 做同一判定；读不到按 `unknown` 处理并注明；不回溯历史提交；验证：构造「声明不适配」「声明适配」「读取失败」三例，结果分别为 跳过 / 更新 / 更新且报告注明未能读取
- [x] 3.5 实现失败版本黑名单（`<DSH_HOME>/autoupdater/failed-versions.json`）；验证：同一失败版本第二轮被跳过并注明"此前失败"，出现更新版本后重新进入流程
- [x] 3.6 取数顺序防护：插件先取完 registry/清单数据再调用市场判定函数；验证：测试断言调用顺序，（单纯导入已于普通 Node 实测不会使 `fetch` 失效；调用后再发 `fetch` 的宿主内回归留第 6 组实测）

## 4. 无头通道回归验证（一次性 profile，不碰 `desktop`）

- [x] 4.1 用隔离的 `DSH_HOME`（`D:\Workspace\dsh-scratch-home`，不是真实 `~/.dsh`）建一次性 profile `scratchtest`；验证：真实 `desktop` profile 未被触碰（实测 `profiles\` 下仍只有 desktop/node_modules/web）
- [x] 4.2 在无头 CLI 宿主中挂载插件，确认检测可用、报告落盘、失败项带真实错误文本；验证：`<DSH_HOME>/autoupdater/last-run.json` 存在且字段完整
- [x] 4.3 验证幂等：连续两次运行后第二次报告"无可用更新"；验证：两次运行后第二次的 `updates` 为空

## 5. 装入真实 `desktop` profile（需用户授权）

- [ ] 5.1 把 `dist/dsh-autoupdater-0.1.0.zip` 解压到纯 ASCII 路径 `C:\Users\fivez\.dsh\plugins\dsh-autoupdater`（OneDrive 中文路径不可用）；验证：目标目录存在且含 `package.json` / `lib/index.js` / `cordis.patch.yml`
- [ ] 5.2 用宿主的 `plugin_manager` 工具把插件装进 `desktop` profile（`install_bundle`，目标为该目录的绝对路径），不手写 profile 的 `package.json` / `cordis.patch.yml`，不在 profile 目录里跑 pnpm；验证：安装结果为 applied，且 bundle 列表中出现 `dsh-autoupdater`
- [ ] 5.3 空跑（`autoApply: false`）验证检测列表正确；验证：报告中列出当时市场界面显示的全部可更新项（2026-11-10 实测 npm 侧为 `dsh-client-auto-continue` 0.17.4→0.18.0、`dsh-context` 0.83.0→0.83.1、`dsh-model-think-level` 2.4.0→2.6.0、`dsh-skill-mcp-panel` 2.3.7→2.3.11，另有 GitHub 源待核），与市场界面逐项一致，且 `applied` 为空

## 6. 真实更新验证（需用户授权）

- [ ] 6.1 放行一个低风险补丁版本更新（`maxUpdatesPerRun: 1`），重点验证启用状态未被改变；验证：更新后 `@linxin666/dsh-client-ui-task-board` 仍为 disabled，版本变为 0.4.8，lockfile 与清单一致
- [ ] 6.2 验证浮动 git 源：先卸载再安装后，来源提交应变为市场报告的新提交；验证：`dsh-our-free-model` 的来源提交变化；若未变化则该源退回"只报告"并在文档中说明
- [ ] 6.3 验证失败回滚路径：制造一次安装失败，确认包被装回原版本且启用状态不变；验证：报告的 `rolledBack` 为 true 且包版本与更新前一致

## 7. 文档与收尾

- [x] 7.1 更新 `docs/调研结论.md`：补入宿主 `pluginManager` 的三条硬事实（`already-installed` 守卫、`enabled` 默认启用、失败折进返回值）与"市场桌面安装走同一通道"的结论；验证：文档中的每条事实都能在 asar 源码中定位到行号
- [x] 7.2 更新 `README.md` 与 `项目进度.md`：反映新目录结构、OpenSpec 工作流、已完成与待验证项；验证：文档中的进度与 tasks.md 的勾选状态一致
- [x] 7.3 把 `tools/dsh-autoupdate.mjs` 降级为只读检测工具（移除或禁用其 `--apply` 对 `desktop` 的作用），并在帮助文本中说明原因；验证：`--apply` 对 `desktop` 不再执行安装，脚本帮助中写明原因
- [x] 7.4 重新打包 `dist/` 产物并核对包内文件；验证：解压后的插件目录含三个文件且能通过语法检查
- [x] 7.5 清理旧的 `自动更新/` 目录（`C:\Users\fivez\OneDrive\Onedrive文档\deepseek-harness\default-workspace\自动更新`），确认新目录已完整承接全部内容；验证：新目录含 `README.md`、`项目进度.md`、`docs/`、`plugin/`、`tools/`、`dist/` 与 `openspec/`，旧目录已不存在

## Workflow follow-up

- 变更实现完成后运行 `openspec validate desktop-autoupdate-in-process --strict` 复核。
- 经项目评审要求满足后归档该变更（`/openspec-archive-change`），归档后核对主规格 `openspec/specs/` 下三个能力已生成。
