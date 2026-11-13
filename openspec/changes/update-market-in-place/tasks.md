# Tasks

## 1. 检测放开市场

- [ ] 1.1 `plugin/dsh-ever-autoupdater/lib/index.js` 的 `buildPlan` 去掉对 `MARKET` 的无条件排除；`skipPackages` 含市场时给出"用户列入不更新名单"的原因。验证：`node --test test/` 新增固定输入用例——市场行有更新且不在名单 → 进入计划；在名单 → `skipped` 原因含 `skipPackages`。
- [ ] 1.2 不可移除检查对市场豁免（市场 `removable=false` 仍进入计划）。验证：单测——`removable:false` 的市场行进入计划，`removable:false` 的 `@deepseek-ai/dsh-base` 仍被跳过。

## 2. 原地更新通道

- [ ] 2.1 在 `applyUpdate` 入口按 `entry.name === MARKET` 分流到新函数 `applyMarketInPlace`：读 `profileContext.packageManager` 与 profile 目录，逐字段校验（缺任一字段即整体判定"宿主没提供"），用 `spawn` 执行 `pnpm add dshmarket@<精确版本>`（不用 shell 拼接，不加 `--config.minimum-release-age=0`，不用系统 pnpm）。验证：单测用假 spawn 断言 `args` 恰为 `['add','dshmarket@<版本>']`，无 shell、无 minimum-release-age。
- [ ] 2.2 执行成功后读磁盘 `node_modules/dshmarket/package.json` 的版本，等于目标才返回 `{ok:true, action:'in-place', restartRequired:true}`。验证：单测三种磁盘版本——等于目标 → 成功；仍为旧版本 → 失败且报告含实际与期望版本；既非旧也非目标 → 失败并带手动修复命令，且不再次执行 pnpm。
- [ ] 2.3 失败分类：文件被占用（`EBUSY`/`EPERM`/`being used by another process` 等关键字）、发布冷却（`minimum-release-age`/`too recent`）、其他；各自带原始错误与建议。发布冷却不写入失败版本记忆，其余写入。验证：单测用三段固定错误文本断言分类、建议文本与 `blameTarget`。
- [ ] 2.4 `run()` 内把市场排到本轮应用顺序的最后。验证：单测——计划含市场与两个普通插件，调用顺序断言市场最后。

## 3. 设置页与文案

- [ ] 3.1 `lib/client.js` 中市场相关文案：成功后提示"重启 DSH 后生效"；去掉"市场不能自更新"类文案。验证：`test/client.test.mjs` 新增断言（假数据含 `restartRequired` 的市场项 → 渲染出重启提示文本）；`node --check` 通过。
- [ ] 3.2 报告字段兼容：`action:'in-place'` 在设置页历史里正常显示。验证：单测。

## 4. 文档与约束

- [ ] 4.1 `AGENTS.md` 硬约束两条改写（见 design 风险一节）；`README.md`、`docs/调研结论.md` 补充市场原地更新通道与行号证据（`official-desktop.js:149,234-290,325-339`、`host.js:241,283`、`dshmarket/lib/index.js:91`）。验证：读回 diff。
- [ ] 4.2 `node --test test/` 全部通过；`openspec validate update-market-in-place --strict` 与 `openspec validate --all --strict` 通过。

## 5. 真实环境验证（需用户授权，会改真实 desktop profile，需重启生效）

- [ ] 5.1 只读确认：宿主进程内是否发布了 `profileContext.packageManager`（装入新版后看启动日志/报告，不改任何东西）。需用户授权。
- [ ] 5.2 用户关闭会话、授权后，在真实 desktop 试更新市场 1.70.2→1.73.17：观察报告 `applied`/`failed`、磁盘版本、重启后市场正常、已装插件无缺失；若文件被占用，按报告里的手动命令处理。需用户授权。
- [ ] 5.3 把新版插件装进真实 desktop（先卸旧装新）。需用户授权。

## Workflow follow-up（归档等后续工作）

- [ ] 6.1 5.x 验证通过后 `openspec archive update-market-in-place -y`，主规范同步。
- [ ] 6.2 git 提交（短说明，一条一件事）并推送；若市场投稿已提 PR，说明文案同步市场自更新能力。需用户授权。
