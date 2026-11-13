# Design

## Context

- 现状：`plugin/dsh-ever-autoupdater/lib/index.js:482-483` 在 `buildPlan` 里对 `row.name === MARKET`（`:31`）一律 `rejected('the market cannot update itself …')`；普通插件的应用序列在 `applyUpdate`（`:756`）：停用 → `removeBundle` → `installBundle` → `verifyInstalled`（`:793`），失败走 `restore`（`:813`）。
- 市场自己的做法（本机 `C:\Users\fivez\.dsh\profiles\desktop\node_modules\dshmarket\lib\official-desktop.js`）：`SELF_NAMES`（`:149`）；`installOrReinstall`（`:325` 起）在 `already-installed` 且为市场自身时走 `updateMarketInPlace`（`:234-290`，调用点 `:339`）。原因是宿主的 `removeBundle` 会先把市场从运行组合里摘掉，补装那步就执行不到了（#900）。
- `updateMarketInPlace` 需要 `context.packageManager` 与 `context.profileDirectory`，缺则返回 `market-self-update` 失败（`:236-239`）；否则 `runHostPnpm(invocation, directory, ['add', spec, --registry?])`；成功后读磁盘版本，等于目标才返回 `restart-required`（`:250-256`），不符则失败；`release-age-violation`（`:265`）与 `windows-file-locked`（`:274`）各有专门提示；**不加** `--config.minimum-release-age=0`（#944，`:232`）。
- 包管理器来源：宿主在 `app.asar/lib/host.js:241`（`bundledPnpmInvocation(runtimeDir)`）与 `:283` 把它发布进进程；市场用 `hostPackageManagerOf(profileContext)`（`dshmarket/lib/index.js:91`）读取并逐字段校验，缺任何一个字段整体丢弃。我们的 `start()`（`lib/index.js:140`）已经读 `manager?.profile ?? hostCtx.get('profileContext')`。
- 市场的公开更新接口（`dshmarket/UPDATE-API-V1.md`）要求同源与浏览器登录 cookie，后台线程用不了，故不走。

## Goals / Non-Goals

**Goals:**
- 市场自身像普通插件一样被自动/手动更新，保留所有既有保护。
- 成败以磁盘版本为准，失败原因可读、带原始错误与下一步建议。
- 宿主没提供包管理器时不乱来，退化为"如实报告失败"。

**Non-Goals:**
- 不升级宿主、不改市场代码、不改 profile 清单、不自动重启、不绕发布冷却、不用系统 pnpm、不走市场 HTTP 接口。

## Decisions

1. **复用宿主发布的 pnpm，在更新器内自己执行 `pnpm add <精确版本>`，不去调用市场的 `installOrReinstall`。** 理由：那是市场内部函数，没有稳定导出；且导入市场模块曾导致进程内全局 `fetch` 失效（调研时遇到的 `assert(dispatcher)`）。被放弃的替代方案：①导入市场函数直接调用（耦合市场内部、有 fetch 污染风险）；②走市场公开 HTTP 接口（需浏览器登录态）；③走普通"卸载再安装"（#900：卸载先摘掉市场，补装执行不到，可能把市场留在被卸载状态，风险最高）。
2. **更新对象恒为精确版本 `dshmarket@<版本>`**，沿用现有 `targetFor`/适配筛选得到的目标，不用 `latest`。理由：与普通 npm 插件同一规则，保证"适配优先"对市场同样生效。
3. **成败以磁盘版本为准**：命令退出码为 0 还不够，必须读 `node_modules/dshmarket/package.json` 的版本等于目标（对应市场 `:250-256`）。不符记失败并把该目标版本写入失败版本记忆（`blameTarget`）。
4. **失败分类沿用市场的三类**：文件被占用、发布冷却、其他；发布冷却是时间问题，不写入失败版本记忆，下一轮自然重试；文件被占用 Windows 上市场自己也提示"再点更新也换不上"，给出手动命令。
5. **报告字段**：成功项沿用 `applied`，`action: 'in-place'`、`restartRequired: true`；设置页现有"需重启"标记（`restartRequired`）直接复用，只改 `lib/client.js` 里市场相关的文案。
6. **手动与自动共用同一应用函数**：`run()`（`:296`）仍只有一处调用 `applyUpdate`，在 `applyUpdate` 入口按 `entry.name === MARKET` 分流，保持有 agent 在跑的熔断、`maxUpdatesPerRun`、手动确认逻辑一字不改。
7. **自动更新对市场放到同一轮的最后一个执行**：避免市场文件被覆盖后其余项的处理被中断。理由：市场被覆盖后需重启才加载新代码，本身不影响其余项，但把风险最高的一项放最后，前面的项不受它失败影响。

## Risks / Trade-offs

- **Windows 文件被占用（高）**：市场代码此刻正被宿主加载，覆盖时可能被拒。市场自己对此也只能提示手动。缓解：如实报告 + 给手动命令；回滚见下。是否经常发生需在真实环境实测（任务 5.2，需用户授权）。
- **半覆盖状态**：`pnpm add` 中途失败可能留下不一致的 `node_modules/dshmarket`。缓解：失败后立即读磁盘版本；若既不是旧版本也不是目标版本，报告里明确警告并给手动修复命令，**不自动再次覆盖**（避免第二次写入扩大损坏）。
- **宿主未发布包管理器**：本机运行时是否真发布了 `profileContext.packageManager` 目前只读过源码，没有运行时实测（任务 5.1 验证）。缓解：缺失时整项失败并写明原因，不退回系统 pnpm。
- **宿主升级失效点**：`host.js:241/283` 的发布点、`official-desktop.js:234-290` 的做法任一变更都要重新核对行号并更新 `docs/调研结论.md`。
- **回滚策略**：原地更新没有"先卸后装"的中间态，因此回滚简化为"不再动文件"。若覆盖后读到的仍是旧版本，则无需回滚；若读到异常版本，只报告并给手动命令，不做自动回滚（自动回滚同样要写 `node_modules/dshmarket`，在文件被占用时必然再失败）。
- **AGENTS.md 硬约束需同步**："不碰市场自身""不在 profile 目录里跑 pnpm"两条改为"不碰市场代码；只允许用宿主发布的 pnpm 对 `dshmarket` 做 `add` 原地更新"，仍禁止系统 pnpm 与手改清单。
