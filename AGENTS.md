# DSH 插件自动更新

DSH Desktop（`desktop` profile）的插件自动更新器：宿主内定时自检 → 调用宿主进程内的 `pluginManager` 安装更新。

> 单条事实来源。`README.md` 面向使用者，本文件面向 AI 编码代理与维护者。改这里，不要改别处。

## 仓库边界（最重要）

本仓库 **只包含自动更新器自身**。宿主、市场、其他插件都在本仓库之外，装进 `desktop` profile 的东西一律不归这里管。

| 东西 | 位置 | 归属 |
|---|---|---|
| 宿主（DSH Next App + asar 内的 plugin-manager） | `D:\Apps\DSH Next\resources\app.asar\` | **宿主**，本仓库不碰 |
| 市场（`dshmarket`） | `<profile>/node_modules/dshmarket` | **市场**，本仓库不碰 |
| 真实 `desktop` profile | `C:\Users\fivez\.dsh\profiles\desktop` | **用户数据**，除授权任务外全程只读 |
| 插件源码 | `D:\Workspace\dsh自动更新\plugin\dsh-autoupdater` | 本仓库 |
| 独立只读检测脚本 | `D:\Workspace\dsh自动更新\tools\dsh-autoupdate.mjs` | 本仓库 |
| 行为规范 | `D:\Workspace\dsh自动更新\openspec\` | 本仓库 |

**改本仓库时不要去改 asar 源码、profile 清单或市场代码。** 宿主契约会变——变了就改本仓库的适配层并更新 `docs/调研结论.md` 的行号证据。

`docs/调研结论.md` 里的每条结论都带 asar 源码路径与行号。宿主升级后**必须重新核对行号**，行号失效等于结论失效。

## 常用命令

```powershell
openspec list                                            # 现有变更与能力清单
openspec status --change desktop-autoupdate-in-process    # 看哪些工件还没写
openspec validate desktop-autoupdate-in-process --strict  # 写完必须过校验
openspec instructions apply --change desktop-autoupdate-in-process --json  # 实施时的任务说明

node --check plugin/dsh-autoupdater/lib/index.js           # 插件语法检查
node tools/dsh-autoupdate.mjs --profile desktop            # 只读检测（不改任何东西）
```

打包插件（`dist/` 已被 `.gitignore` 排除）：

```powershell
cd plugin/dsh-autoupdater
Compress-Archive -Path cordis.patch.yml,package.json,lib -DestinationPath ..\..\dist\dsh-autoupdater-0.1.0.zip
```

## 行为契约在 OpenSpec 里

规范不写在本文件，写在 `openspec/specs/`（已归档变更沉淀而来）与 `openspec/changes/<change>/specs/`（进行中的 delta）：

| 能力 | 覆盖范围 |
|---|---|
| `plugin-update-detection` | 市场一致的检测、确切版本校验、不可更新项的排除、风险排序与数量上限 |
| `plugin-update-application` | 通过宿主管理服务应用、执行序列、保持启用状态、结果校验、失败回滚、运行中熔断 |
| `plugin-update-scheduling` | 启动检查、周期触发、每日固定时刻、重新武装、抖动、重入保护、无补跑语义 |

**改更新器行为前先读对应 spec。** 行为变更要走 OpenSpec 变更流程（见下），不要直接改代码了事。

当前进行中的变更：`openspec/changes/desktop-autoupdate-in-process/`（proposal / design / 3 份 delta spec / tasks）。

## OpenSpec 工作流

本仓库用 spec-driven schema：`proposal → specs → design → tasks → apply → archive`。

```bash
openspec new change <name> --description "一句话说明"     # 1 建变更
openspec instructions <artifact> --change <name> --json   # 2 查该工件的模板与硬性要求
openspec status --change <name>                          # 3 看哪些工件还没写
openspec validate <name> --strict                        # 4 写完必须过校验
openspec instructions apply --change <name>               # 5 实施时照着 tasks 走
openspec archive <name> -y                                # 6 完成后归档，主规范自动生成
```

**工件依赖**：`specs` 与 `design` 依赖 `proposal`；`tasks` 依赖 `specs` + `design`。顺序不能颠倒。

**写规范时的硬性约束**（违反会被 `validate --strict` 拒）：

- 场景标题必须是 **4 个 `#`**（`#### Scenario:`），用 3 个会静默失败。
- 每条 `### Requirement:` 至少配一个场景。
- Requirement 正文（标题到第一个场景之间）**不超过 500 字符**。
- 新能力 spec 的首节是 `## Purpose`（50+ 字符），归档时会被搬进主规范；缺了主规范里会留 `TBD` 占位。
- 规范正文用 **SHALL / MUST** 表述规范条款；结构化标题与 SHALL/MUST 保持英文，叙述部分用中文。
- 描述**外部可观察行为**，不写类名、不写实现步骤——那些属于 `design.md` / `tasks.md`。

**归档不是可选步骤**：只写变更不归档，`openspec/specs/` 永远是空的，规范等于没写。

## 代码结构

| 文件 | 职责 |
|---|---|
| `plugin/dsh-autoupdater/lib/index.js` | 插件全部逻辑：配置合并、检测（市场优先 / 内置兜底）、决策过滤、排序、应用序列、定时触发、报告落盘 |
| `plugin/dsh-autoupdater/cordis.patch.yml` | 宿主 bundle patch：在 `dsh.profile.bundles` 插入本插件行 + 默认配置块 |
| `plugin/dsh-autoupdater/package.json` | 插件包元数据（`dsh.engines.dsh`、`dsh.bundle.patch`、peerDependencies） |
| `tools/dsh-autoupdate.mjs` | 独立只读检测脚本（退出码 2 = 有更新）。**不得**对 `desktop` 执行安装 |
| `docs/调研结论.md` | 路线对比与底层机制证据（每条带 asar 路径 + 行号） |
| `项目进度.md` | 进度、已验证项、阻塞点、风险、决策记录 |

## 硬约束

- **不自我更新**：`skipPackages` 恒含 `dsh-autoupdater`——卸载自己等于卸载执行更新的代码。
- **不碰市场自身**：`dshmarket` 在宿主里 `removable=false`，决策层显式排除并记原因。
- **不装宿主保护包**：`removable=false` 的 bundle（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）一律跳过。
- **有 agent 在跑就整轮只报告**：`hostCtx.get('agents')` → `status === 'running'`，与市场 `runningAgentIds` 同一判定。
- **只装精确版本**：npm 源安装市场报告的那个精确版本（`saveExact`），不是 `latest` 漂移值；应用前还要做 registry 存在性校验。
- **不用系统 pnpm**：真实 profile 只走宿主自带的 pnpm 11.8.0（`resources/runtime/x64/primary-runtime`）。系统 pnpm 12.14.0 会破坏 lockfile。
- **不手写 profile 清单**：装插件只能用宿主的 `plugin_manager` 工具，不手改 `package.json` / `cordis.patch.yml`，不在 profile 目录里跑 pnpm。
- **插件源码必须装在纯 ASCII 路径**（如 `C:\Users\fivez\.dsh\plugins\dsh-autoupdater`）——中文/空格路径不适合做 `file:` spec。
- **不装第三方 updater**、不装 `dsh-purge`、不走市场 HTTP API（桌面端对外部请求一律 403）、不启用被禁用的 `tool-plugin-manager` / `tool-plugin-market`。

## 验证要求

改动必须实跑验证，不能只靠"代码写完了"：

- **纯逻辑**（定时计算、版本比较、过滤排序）必须有可复现的固定输入输出对照——不能靠肉眼读代码判断对错。
- **报告结构**：一次失败运行后 `<DSH_HOME>/autoupdater/last-run.json` 里每个未更新项都要有非空原因；失败项的 `error` 必须含真实错误文本，而不是 `exit code 1`。
- **启用状态**：原为 disabled 的包，更新后必须仍是 disabled。
- **回滚**：制造一次安装失败，确认包被装回原版本且启用状态不变（`rolledBack: true`）。
- **幂等**：连续两次运行，第二次 `updates` 为空。
- **触碰 `desktop` profile 的任务（第 5、6 组）必须先取得用户明确授权**，未授权前只做只读扫描。

改动宿主契约相关的代码时，还要核对 `docs/调研结论.md` 里的行号证据是否仍然成立。
