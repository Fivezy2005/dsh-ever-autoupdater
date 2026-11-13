# Proposal

## Why

更新器现在对插件市场（`dshmarket`）一刀切地跳过（`plugin/dsh-ever-autoupdater/lib/index.js:482-483`），用户只能关 DSH 后手动更新，或在市场界面里点。但市场自己是能给自己更新的：它不走"卸载再安装"，而是调宿主自带的 pnpm 原地覆盖（`dshmarket/lib/official-desktop.js:234-290`）。我们的更新器完全可以复用同一条路，让市场也被自动纳入"每次启动/定时检查"，不再有一个永远落后的例外。

## What Changes

- 市场自身不再被排除；检测到更新时走"原地覆盖"通道（宿主 pnpm 把新版本直接装到 profile 目录），**不经过**停用/卸载/安装序列。
- 覆盖后读磁盘上的版本号，确认等于目标版本才算成功；成功后在报告里标记"需要重启生效"。
- 保留全部既有保护：有 agent 在跑就推迟、手动更新遇会话运行需确认、适配优先选版本、失败版本记忆、`skipPackages` 仍可手动排除市场。
- 宿主没有提供 pnpm 调用信息、文件被占用、版本核对失败时，如实报告失败并给出手动更新命令，不退回系统 pnpm。
- 同步修改 `AGENTS.md` 里"不碰市场自身""不在 profile 目录里跑 pnpm"两条硬约束的表述，并更新 README 与设置页里"市场不能自更新"的文案。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `plugin-update-detection`: "不可更新项的识别与排除"不再把市场自身列为排除项。
- `plugin-update-application`: "更新的执行序列"为市场自身增加例外；新增"市场自身的原地更新"需求，规定通道、校验、失败与重启提示。

## Non-Goals

- 不升级 DSH 本体，不改 asar 源码，不改市场代码，不改 profile 清单（本仓库一律不碰；只是调用宿主已暴露的 pnpm）。
- 不调用市场的公开更新接口（`UPDATE-API-V1.md`）：它要求浏览器登录态，插件后台线程用不了。
- 不装第三方 updater，不使用系统 pnpm，不加 `--config.minimum-release-age=0` 绕过发布冷却（与市场 #944 一致）。
- 不自动重启 DSH；重启仍由用户决定。
- 不改变"插件不更新自身"的约束。

## Impact

- 代码：`plugin/dsh-ever-autoupdater/lib/index.js`（`buildPlan` 市场排除、`applyUpdate` 新分支、报告字段）、`lib/client.js`（"需重启"提示文案）、`test/`。
- 依赖的宿主行为及其失效点：宿主向进程内发布的 `profileContext.packageManager`（`app.asar/lib/host.js:241,283`）与市场的版本核对做法（`official-desktop.js:234-290`）。宿主升级后任一处改名即失效，需重新核对行号，失效时更新器退化为"只报告"。
- 真实 `desktop` profile：实际更新市场（1.70.2→1.73.17）会改 `node_modules/dshmarket` 并要求重启，属于需用户授权的第 6 组验证。
