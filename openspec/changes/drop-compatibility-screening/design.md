# 设计：取消宿主适配筛选

## 决策 1：目标版本直接取市场报告的版本

市场报告的 `latest`（npm 为精确版本号，git 为来源引用）就是目标。`targetFor()`（`plugin/dsh-ever-autoupdater/lib/index.js:583`）不需要改，它本来就用 `row.latest`；要删的是它之后的兼容闸门。

替代方案：保留筛选但加开关（默认关）。放弃 —— 用户要的是行为改变，多一个开关只是把同样的复杂度留下，设置页还得解释一个新词。

## 决策 2：删掉 npm 的"回落适配版"与 git 的"跳过"

- npm：`resolveNpm()`（`lib/index.js:665`）删除 `verdictOf()` 判定与 `findCompatibleVersion()` 回落，只保留两条前置检查 —— registry 上该版本不存在、registry 不可达（都不是适配判断，是防止把不存在的版本交给包管理器）。
- git：`resolveGit()`（`lib/index.js:709`）不再读目标提交的 `package.json`，`fetchGitManifest()` 一并删除 —— 没有判定就没有要读的清单。

替代方案：只删"回落"、保留"跳过"。放弃 —— 跳过同样会压住更新，正是用户要取消的东西。

## 决策 3：保留宿主版本号的读取，但只用于报告

`loadCompat()`（`lib/index.js:611`）原本加载市场三个模块（`discovery-compatibility.js`、`dsh-install.js`、`check.js`）以取得判定函数。判定函数全部不用了，只保留 `dsh-install.js` 的 `dshHostInfo().version`，供报告 `host.version` 与设置页状态区显示。

替代方案：整块删掉，报告里 `host.version` 恒为 null。放弃 —— 设置页要显示"当前宿主版本"，这是用户判断"为什么插件不好用"的依据，留着成本很低（一个动态 import）。

失效点：`dshHostInfo()` 位于 `C:\Users\fivez\.dsh\profiles\desktop\node_modules\dshmarket\lib\dsh-install.js:168`（宿主 0.2.2-rc.1，2026-11-10 核对）。市场改函数名或返回结构后，`host.version` 变为 null，不影响更新。

## 决策 4：报告条目去掉 `compat` 字段

`entry.compat`（`compatible` / `unknown`）与"no host compatibility declared — installing anyway"这类 `note` 都不再有意义 —— 所有条目都按最新版装。报告里 `updates` / `skipped` / `failed` 的结构不变，界面不用改。

保留 `note` 字段的渲染能力（`lib/client.js:406` 已实现"有 note 才显示"），因为将来别的跳过原因可能用得上，删掉反而是无谓的改动。

## 决策 5：风险交给宿主与既有回滚

不做额外预检。装不上时宿主会返回失败（`application: 'failed'`，错误折进返回值，`plugin-manager/lib/index.js:2859`、`:3146-3190`），本插件把它写进 `failed` 并触发原有还原逻辑（`restore()`，`lib/index.js:813`），同时记入失败版本记忆，下一轮不再撞同一个版本。

已知风险：宿主可能"装上了但不加载"（例如加载期因 `engines.dsh` 不符被拒绝）。这种情况报告会显示 `applied` 而插件实际不工作。当前无法从插件侧区分，已在 proposal 写明；若真发生，用户在设置页看日志或加进"不更新的插件"。

## 回滚策略

代码回滚：本变更是纯删除 + 简化，`git revert` 单个提交即可回到筛选行为，无需数据迁移。已安装的插件版本不回滚（那是用户要装的新版）。

## 测试

- 删掉 `test/autoupdater.test.mjs` 里 `fakeCompat` 的判定函数与三个适配用例，替换为：npm 最新版声明"需要更高宿主"仍进计划、git 目标提交声明"不兼容"仍进计划。
- 保留 registry 存在性、预发布、用户跳过、失败记忆、排序等既有用例。
- `test/panel.test.mjs` 的 `fakeCompat` 同步简化（只留 `hostVersion` / `available`）。
