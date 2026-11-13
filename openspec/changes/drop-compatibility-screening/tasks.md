# 任务：取消宿主适配筛选

## 1. 代码：目标版本一律取最新版

- [x] 1.1 `plugin/dsh-ever-autoupdater/lib/index.js` 的 `buildPlan()`：预取循环只对 npm 候选调用 `fetchNpmManifest()`，不再调用 `fetchGitManifest()`；`deps.compat` 注入点保留，注释改为"宿主版本号的来源"
  - 验证：`node --check plugin/dsh-ever-autoupdater/lib/index.js`
- [x] 1.2 删除 `fetchGitManifest()` 与其专用 `githubParts()`：git 源不再读目标提交的 `package.json`
  - 验证：`grep -n "fetchGitManifest\|githubParts" plugin/dsh-ever-autoupdater/lib/index.js` 无输出
- [x] 1.3 删除 `verdictOf()`；`resolveNpm()` 去掉 `compat` 参数、`verdictOf` 判定与 `findCompatibleVersion()` 回落，只保留"该版本在 registry 上不存在 / registry 不可达"两条跳过，成功后返回 `{ version }`（不再带 `compat` / `note`）
  - 验证：`grep -n "verdictOf\|findCompatibleVersion\|deriveHostCompatibility" plugin/dsh-ever-autoupdater/lib/index.js` 无输出
- [x] 1.4 删除 `resolveGit()`：git 候选在 `buildPlan()` 里直接得到 `{ entry: {} }`，不再有"目标提交不适配则跳过"
  - 验证：`grep -n "resolveGit" plugin/dsh-ever-autoupdater/lib/index.js` 无输出
- [x] 1.5 `loadCompat()` 精简为只 import `dshmarket/lib/dsh-install.js` 取 `dshHostInfo().version`，返回 `{ available, hostVersion }`；不再 import `discovery-compatibility.js` 与 `check.js`，删 `hostPackages` 与三个判定函数的透传
  - 验证：`grep -n "hostPackages\|manifestFacts" plugin/dsh-ever-autoupdater/lib/index.js` 无输出
- [x] 1.6 改写文件头注释：说明目标是市场报告的最新版，宿主拒绝安装时失败会回滚并进失败记忆
  - 验证：读回该段，与 proposal/design 表述一致

## 2. 报告与文档

- [x] 2.1 报告条目不再写 `compat` 字段（`buildPlan` 返回的 `plan` 与 `writeReport` 无需改结构，确认无残留引用即可）
  - 验证：`grep -n "compat" plugin/dsh-ever-autoupdater/lib/index.js` 仅剩 `deps.compat` 注入点与注释
- [x] 2.2 `README.md` 删掉「适配优先」条目，改为「更新目标为最新版」并说明装不上时进失败区
  - 验证：读回该节
- [x] 2.3 `AGENTS.md` 代码结构表与硬约束里与"适配筛选"相关的表述同步（若无则不改）
  - 验证：`grep -n "适配" AGENTS.md README.md`

## 3. 测试

- [x] 3.1 `test/autoupdater.test.mjs`：`fakeCompat()` 简化为只含 `hostVersion` / `available`
  - 验证：`node --test test/autoupdater.test.mjs`
- [x] 3.2 把 npm 适配用例替换为「最新版声明需要更高宿主时仍进计划、无回落、无 `note`」
  - 验证：新用例名含 "incompatible declaration is ignored"
- [x] 3.3 把 git 适配用例替换为「目标提交声明不兼容仍进计划」「读不到清单不再触发额外请求」
  - 验证：新用例断言 git 候选不产生 `raw.githubusercontent.com` 请求
- [x] 3.4 保留并调整「先取 registry 数据、再导入市场模块」的顺序用例（改为只断言 npm 预取先于 `loadCompat`）
  - 验证：该用例通过
- [x] 3.5 `test/panel.test.mjs`：`fakeCompat()` 同步简化（只留 `hostVersion` / `available`）
  - 验证：`node --test test/`

## 4. 回归

- [x] 4.1 `node --check` 四个 lib 文件
  - 验证：命令无输出
- [x] 4.2 `node --test test/`：原 58 项，删减后仍全绿
  - 验证：输出 `# fail 0`
- [x] 4.3 `openspec validate --all --strict`
  - 验证：5 个变更/规范全部通过

## 5. 真实环境验证（需用户另行授权）

- [ ] 5.1 把新版装进真实 `desktop`（先卸旧再装新，`plugin_manager` 通道），重启 DSH 后确认设置页「插件更新」正常
  - 需用户授权；验证：宿主日志无本插件报错、栏目可见
- [ ] 5.2 用 `dsh-better-sidebar` 0.32.0→0.32.1 或 `@linxin666/dsh-ssh` 0.4.16→0.4.18 验证"声明需要 `rc.2`、宿主为 `rc.1` 的包"现在会真的安装；若宿主拒绝，确认报告记录了真实错误且包被还原
  - 需用户授权；验证：`<home>/autoupdater/last-run.json` 的 `applied` 或 `failed` 有对应条目
- [ ] 5.3（follow-up）若 5.2 出现"装上了但加载被拒"，记录宿主错误文本，另开变更评估是否需要在安装前做最低限度预检

## 6. 收尾

- [ ] 6.1 `openspec archive drop-compatibility-screening -y` 并手补主规范 Purpose
  - 验证：`openspec validate --all --strict`
- [ ] 6.2 git 提交（短说明，一条一件事）
  - 需用户授权；验证：`git status` 干净
