## 1. 设置与跳过版本存储

- [x] 1.1 新增 `lib/store.js`：设置白名单校验（7 个键）、读写 `settings.json`、读写 `skipped-versions.json`、原子写文件。验证：`test/panel.test.mjs` 的 settings 用例
- [x] 1.2 `lib/index.js` 增加 `effectiveConfig(state)`（出厂默认 ← patch 配置 ← settings.json）与 `armScheduler(state, log)`（重新武装、不重排启动检查）。验证：effectiveConfig / armScheduler 用例
- [x] 1.3 `buildPlan` 排除用户跳过的目标版本、较新版本照常出现。验证：skip 用例

## 2. 手动运行

- [x] 2.1 `run()` 增加 `deps.manual`：只检查 / 更新选中 / 无视 autoApply 与数量上限。验证：manual check / manual update 用例
- [x] 2.2 会话在跑且未确认 → 返回 `needsConfirmation` 且不改任何东西；确认后执行。验证：agents running 两个用例
- [x] 2.3 自动运行行为不变。验证：scheduled run 用例 + 原 29 项单测

## 3. 本机接口

- [x] 3.1 新增 `lib/api.js`：overview / settings / action 三个处理函数。验证：overview、settings request、action 用例
- [x] 3.2 路由：仅本机、方法检查、JSON 校验、64KB 上限（413）、未启动完成答 503。验证：routes 用例
- [x] 3.3 `apply()` 同时注入 `loader` 与 `webServer`，路由随宿主层销毁注销。验证：apply 用例（假宿主）

## 4. 设置页栏目

- [x] 4.1 新增 `lib/client.js`：状态、待更新（每行更新/跳过）、检查/全部更新、设置表单、上一轮历史、失败/跳过记录清除。验证：`node --check`
- [x] 4.2 `package.json` 增加 `exports["./client"]`、`files`、`dsh.client`。验证：JSON 解析
- [x] 4.3 装配契约：factory 返回 exports、`inject` 为 `['slots']`、登记 `settings.section`、可注销、不拼 HTML、只调三个本机路由。验证：`test/client.test.mjs`

## 5. 隔离验证（不碰真实 desktop）

- [x] 5.1 在临时 `DSH_HOME`（D:\Workspace\dsh-scratch-home，profile scratchtest）的无头宿主里确认：新版插件（含 api.js/store.js/client.js）能装入并加载，启动检查正常写出 `last-run.json`（reason: startup），输出无报错。无头宿主没有 `webServer`，所以"路由实际可访问"没有验到，留给 6.2
- [x] 5.2 无头宿主不提供 webServer，curl 无从做起；路由逻辑（含 403/405/400/413/503）由 `test/panel.test.mjs` 的假服务器覆盖，真实可访问性并入 6.2

## 6. 真实环境（需用户另行授权）

- [x] 6.1 已重新打包并卸旧装新到 `desktop`（plugin_manager remove_bundle + install_bundle 均返回 applied；依赖仍 33 个；旧安装副本备份为 C:\Users\fivez\.dsh\plugins\dsh-autoupdater.bak-20261110；安装副本 autoApply 保持 false）。宿主日志 desktop-next.log 显示新版已加载、重新武装（mode interval，下次 3 小时后）、4 项更新因有会话在跑而推迟，无报错
- [ ] 6.2（受阻） `curl http://127.0.0.1:<端口>/api/dsh-autoupdater/overview` 返回与 `last-run.json` 一致。实测：桌面端对 curl 这类外部请求一律 403 "Browser access is disabled"（dsh-hook 与不存在的路径同样），无法用 curl 验接口；接口通不通改由 6.3 在设置页里点开确认
- [ ] 6.3 用户重启 DSH 后在设置页看到「插件更新」栏目；点"立即检查"后上次检查时间刷新
- [ ] 6.4 手动更新一个插件，在会话运行中验证确认弹窗

## 7. 收尾

- [x] 7.1 更新 `README.md`（设置页使用说明）、`AGENTS.md`（代码结构表增 store/api/client）、`项目进度.md`
- [x] 7.2 `openspec validate autoupdater-settings-panel --strict` 通过
- [ ] 7.3 全部完成后 `openspec archive autoupdater-settings-panel -y`
