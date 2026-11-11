## Context

更新器已能在宿主内定时检查并更新（见 `desktop-autoupdate-in-process`）。用户无编程背景，需要在设置页里看状态、手动更新、改设置。样板是已装插件 `dsh-hook`：后端用 `ctx.webServer.register` 开本机接口，浏览器端用 `client.js` 经 `slots` 登记一个 `settings.section`。

## Goals / Non-Goals

**Goals**
- 设置页一个栏目覆盖：状态、待更新、手动检查/更新、设置、历史。
- 设置落在 `<DSH_HOME>/autoupdater/settings.json`，不改 profile 清单，下一轮立即生效。
- 手动更新遇到会话在跑时先问用户。

**Non-Goals**
- 不让界面改 `registry`、`marketModule`（这两项能把检测指向任意地址/文件，不暴露）。
- 不做更新器自更新；不做更新日志/变更说明展示。
- 不改自动更新的检测、适配、应用、回滚逻辑。

## Decisions

**D1 代码分层**：`lib/store.js`（设置/跳过版本的读写与校验）、`lib/api.js`（三个路由的处理函数，纯函数，可脱离服务器测试）、`lib/client.js`（浏览器端）、`lib/index.js`（接线）。理由：`index.js` 已 900+ 行，路由和存储单独成文件便于单测。

**D2 一个插件注入两个服务**：`apply()` 里分别 `ctx.inject(['loader'], …)`（保持原样，取 pluginManager）与 `ctx.inject(['webServer'], …)`（注册路由）。两边通过 `holder.state` 共享；`loader` 侧启动完成前，路由答 503 而不是崩溃。备选：把两个服务写进同一个 `inject` 数组——但 `loader` 在宿主层、`webServer` 在 profile 层，层级不同，合并会让其中一个永远取不到。本条在宿主内是否成立**待第 6 组实测**（隔离环境的无头宿主没有 webServer）。

**D3 设置覆盖顺序**：出厂默认（`DEFAULTS`）← `cordis.patch.yml` 的 config ← `settings.json`。每轮 `run` 和每次保存都重读 `settings.json`；保存后重新武装定时器，但**不**重排启动检查，避免改设置时多触发一次检查。`skipPackages` 恒含 `dsh-autoupdater`（`resolveConfig` 已保证）。

**D4 白名单校验**：`store.js` 只接受 7 个键（`autoApply`、`allowPrerelease`、`scheduleMode`、`intervalHours`、`dailyTime`、`maxUpdatesPerRun`、`skipPackages`），每个键有范围校验；未知键或无效值整个请求拒绝（400），不部分写入。读取时同样丢弃无效项，手改坏的文件不会把更新器带崩。

**D5 手动运行复用 `run()`**：给 `run()` 加 `deps.manual`（`{}` = 只检查；`{apply:true, names?, confirmed?}` = 更新）。手动更新无视 `autoApply` 与 `maxUpdatesPerRun`，因为这是用户亲自下的命令；有会话在跑且未带 `confirmed` 时返回 `needsConfirmation`，不做任何改动。其余检测、适配、排序、回滚、黑名单完全复用。备选：另写一条手动路径——会复制整套应用序列，拒绝。

**D6 确认走两次请求**：服务端无状态，第一次请求被拒并带回会话列表，用户确认后客户端带 `confirmed:true` 再发。理由：不需要在服务端保存"待确认"状态。

**D7 跳过版本**：`<DSH_HOME>/autoupdater/skipped-versions.json`，`{包名: 版本}`；`buildPlan` 里目标版本等于被跳过版本才排除，更新的版本照常出现。git 源以目标提交 sha 作版本。

**D8 本机限制**：每个路由先判 `req.socket.remoteAddress`（127.0.0.1 / ::1 / ::ffff:127.0.0.1），再判方法，再解析 JSON（上限 64KB，超限 413）。POST 才有副作用，GET 只读。

**D9 浏览器端只写文本**：全部用 `textContent` 构造 DOM，不拼 HTML，网络返回的包名/错误原文不会被当成标记执行。轮询 15 秒，仅栏目打开时；用户正在编辑设置表单时不重绘。

## Risks / Trade-offs

- **[宿主内同时注入两个服务未实测]** → 路由注册失败只记警告，不影响更新器主功能；第 6 组实测。
- **[浏览器端能否出现栏目未实测]** → 样板同款写法；需用户重启后看页面，我无法替用户看到界面。
- **[手动更新会重启插件]** → 更新自己除外的插件时，被更新插件可能卸载重装，界面请求期间连接可能抖动；超时设 15 分钟，失败只显示错误。
- **[重新装进 desktop]** → 要先卸旧装新，是改真实环境的动作，代码阶段不做，需单独授权。
