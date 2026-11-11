## Why

自动更新器目前只能靠改配置文件调参、靠读 `last-run.json` 看结果，用户（无编程背景）看不到状态，也不能手动触发更新或改设置。需要在 DSH 设置页里给它一个可视化栏目。

## What Changes

- 设置页新增一级栏目「插件更新」：状态、待更新列表、操作按钮、设置、历史。
- 插件新增 3 个只认本机访问的接口：总览（GET）、保存设置（POST）、操作（POST：立即检查 / 更新选中 / 全部更新 / 跳过此版本 / 清除失败记录）。
- 用户在界面改的设置存到 `<DSH_HOME>/autoupdater/settings.json`，每轮检查与调度重新武装时读取，覆盖 `cordis.patch.yml` 的出厂默认；不改 profile 清单。
- 手动更新与自动更新对「有会话在运行」的处理不同：自动更新仍一律推迟；手动更新先返回确认请求，用户确认后才执行。
- 新增「跳过此版本」：被跳过的目标版本不再提示，出现更新的版本时重新提示。
- 插件新增浏览器端模块（`client.js`），通过 `dsh.client` 声明装配。

## Capabilities

### New Capabilities
- `plugin-update-panel`: 设置页栏目、本机接口、用户设置的持久化与覆盖、手动更新的确认语义、跳过版本。

### Modified Capabilities
（无。自动更新的检测、应用、调度行为不变，仅在其上增加手动入口。）

## Impact

- 代码：`plugin/dsh-ever-autoupdater/lib/index.js`（设置层、手动运行、路由）、新增 `lib/client.js`、`package.json`（`exports["./client"]`、`dsh.client`、`files`）。
- 测试：`test/` 新增设置层、手动运行、路由的单测。
- 真实 `desktop` profile：本变更的代码阶段不触碰；重新装入需单独授权。
- 风险：同一插件同时需要 `loader` 与 `webServer` 服务、浏览器端页面能否装配，需在隔离环境实测。
