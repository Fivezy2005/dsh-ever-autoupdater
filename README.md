# DSH 插件自动更新

让 DSH Desktop（`desktop` profile）**自动检查并安装插件更新**，不依赖市场 UI 手点，也不依赖任何第三方更新插件。

本项目采用 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 的 spec-driven 工作流：每一项行为变更先写成一份带可验证场景的规格，再实现、验证、归档。

## 目录结构

```
D:\Workspace\dsh-ever-autoupdater\        # 独立 git 仓库（分支 main）
├── openspec\
│   ├── config.yaml                 # OpenSpec 配置（schema: spec-driven）
│   ├── specs\                      # 主规格（已归档变更沉淀而来）
│   └── changes\
│       └── desktop-autoupdate-in-process\   # 当前进行中的变更
│           ├── proposal.md         # 为什么做 / 做什么 / 影响面
│           ├── design.md           # 技术决策与取舍
│           ├── tasks.md            # 可勾选的实施清单
│           └── specs\              # 三份 delta spec（能力级需求）
├── plugin\dsh-ever-autoupdater\        # DSH 插件：宿主内定时自检并调用官方管理接口
├── test\autoupdater.test.mjs      # 插件单元测试（node --test test/）
├── tools\dsh-autoupdate.mjs       # 独立只读检测脚本
├── docs\调研结论.md               # 路线对比与底层机制证据（每条都带文件路径/行号）
├── dist\                          # 打包产物（已 gitignore）
├── .dsh\skills\                   # OpenSpec 技能（进版本控制）
├── AGENTS.md                      # 面向 AI 编码代理与维护者的单条事实来源
├── .gitignore
├── 项目进度.md
└── README.md
```

> `README.md` 面向使用者；`AGENTS.md` 面向 AI 编码代理与维护者（仓库边界、硬约束、验证要求）。

## 交付物

| 路径 | 说明 | 状态 |
| --- | --- | --- |
| [`openspec/changes/desktop-autoupdate-in-process/`](openspec/changes/desktop-autoupdate-in-process/) | 当前变更的完整规划（proposal / design / specs / tasks） | ✅ 4/4 产物完成，`validate --strict` 通过 |
| [`AGENTS.md`](AGENTS.md) | 仓库边界、硬约束、验证要求（面向编码代理） | ✅ |
| [`plugin/dsh-ever-autoupdater/`](plugin/dsh-ever-autoupdater/) | DSH 插件：宿主内定时自检并调用官方管理接口 | ✅ 代码完成（tasks 第 1–4 组），29 项单测通过；真实 `desktop` 内验证待授权（第 5、6 组） |
| [`test/autoupdater.test.mjs`](test/autoupdater.test.mjs) | 插件单元测试（`node --test test/`） | ✅ 29/29 |
| [`tools/dsh-autoupdate.mjs`](tools/dsh-autoupdate.mjs) | 独立脚本：只读检测 | ✅ 已降级为只读，`--apply` 对 `desktop` 拒绝执行 |
| [`项目进度.md`](项目进度.md) | 进度、已验证项、待办、风险、决策记录 | — |
| [`docs/调研结论.md`](docs/调研结论.md) | 路线对比与底层机制证据（每条都带文件路径/行号） | — |
| [`dist/`](dist/) | 打包产物（插件 zip，已 gitignore） | — |

## 核心思路

不用第三方插件，用**本机已有的两个官方能力**拼成自动更新：

```
检测  dshmarket 的 checkUpdates(profile, true, profileDir)
      → 与市场 UI 显示的更新列表完全一致

应用  宿主进程内的 pluginManager 服务
      → 官方市场桌面安装按钮走的正是这一条
      → 停用 → 卸载 → 安装 → 校验，带锁、带兼容闸门、带失败还原
```

不打开市场的 HTTP API（外部访问一律 403），不启用被禁用的 `tool-plugin-manager` / `tool-plugin-market` 工具导出（它们是只读列表 + `already-installed` 限制，见调研结论）。

## 工作流

```bash
# 看当前有哪些变更、各自处于什么阶段
openspec list
openspec status --change desktop-autoupdate-in-process

# 复核一份变更的规划产物是否自洽
openspec validate desktop-autoupdate-in-process --strict

# 按 tasks.md 逐项实施（建议配合 /openspec-apply-change）
openspec instructions apply --change desktop-autoupdate-in-process --json
```

每个任务条目都自带验证方式，实施时逐条勾选。

## 快速开始（当前实现）

### 插件（宿主内自检）

```bash
# 0) 把插件解压到一个纯 ASCII 路径（file: spec 对中文/空格路径不友好）
#    dist/dsh-ever-autoupdater-0.1.0.zip 里是 cordis.patch.yml / package.json / lib/
#    例：解压到 C:\Users\fivez\.dsh\plugins\dsh-ever-autoupdater

# 1) 装进 desktop profile：只能走宿主的 plugin_manager 工具（install_bundle），
#    不手改 package.json / cordis.patch.yml，不在 profile 目录里跑 pnpm。
#    这一步会改真实 desktop profile，需要用户明确授权（tasks.md 第 5 组）。

# 2) 重启 DSH Desktop，插件在启动后 45s 首次自检；先用 autoApply: false 空跑，
#    核对 <DSH_HOME>/autoupdater/last-run.json 与市场界面一致，再放开自动安装。
```

### 脚本（只读检测）

```bash
# 只看有哪些可更新（退出码 2 = 有更新，便于脚本判断）
node tools/dsh-autoupdate.mjs --profile desktop
```

### 插件配置

写在 `plugin/dsh-ever-autoupdater/cordis.patch.yml` 的 row config 里：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `checkOnStart` | `true` | 启动后是否自检 |
| `startupDelayMs` | `45000` | 启动后延迟（等宿主热身） |
| `scheduleMode` | `interval` | `interval`（每隔 N 小时）/ `daily`（每天固定时刻）/ `startup-only`（只在启动时） |
| `intervalHours` | `3` | `interval` 模式的间隔，0 = 关闭周期触发 |
| `dailyTime` | `03:30` | `daily` 模式的每日时刻（按 `timeZone` 解释） |
| `timeZone` | `""` | IANA 时区名，空 = 本机时区；填错会回落为空 |
| `jitterMinutes` | `5` | 每次触发再随机延迟 0~N 分钟，0 = 不抖动 |
| `allowPrerelease` | `false` | 是否更新到预发布版本 |
| `autoApply` | `true` | 是否直接安装（false = 只报告） |
| `maxUpdatesPerRun` | `3` | 单轮最多更新几个 |
| `skipPackages` | `['dsh-ever-autoupdater']` | 永不动的包（保护自己） |
| `marketModule` | `''` | 指定 dshmarket 的 `lib/updates.js` 路径 |
| `registry` | `https://registry.npmjs.org` | 内置兜底检测用的 registry |

定时语义见当前变更的 `specs/plugin-update-scheduling/spec.md`。没有发布冷却：新版发布后，下一轮检查就会更新。

### 设置页「插件更新」栏目

装好并重启后，在 DSH 的 设置 里会多一个「插件更新」栏目（变更 `autoupdater-settings-panel`）：

- **状态**：宿主版本、上次检查时间、下次检查时间、当前有没有会话在跑。
- **待更新列表**：每行显示 现版本 → 目标版本，可「立即更新」或「跳过此版本」（出现更新的版本会重新提示）。
- **操作**：「立即检查」只检查不安装；「全部更新」会先弹确认，有会话在跑时再弹一次确认。
- **设置**：自动安装开关、检查方式与间隔、单轮上限、是否含预发布、永不更新的包。保存到 `<DSH_HOME>/autoupdater/settings.json`，下一轮检查起生效，覆盖 `cordis.patch.yml` 的出厂默认。
- **历史**：本轮已更新 / 失败（带原因）/ 已回滚 / 已跳过；失败版本黑名单可清除。

接口只认本机（`/api/dsh-ever-autoupdater/overview｜settings｜action`），非本机访问返回 403；`registry`、`marketModule` 不在界面里开放。

## 安全约束（已实现）

- **不自我更新**：`skipPackages` 含 `dsh-ever-autoupdater`。
- **有 agent 在跑就不动**：检测 `ctx.get('agents')` → `status === 'running'`（与市场 `runningAgentIds` 同一套判定）。
- **版本写死**：npm 包安装的是市场报告的那个精确版本，不是 `latest` 漂移值。
- **只跑自己知道来源的包**：检测源是市场自己的 `checkUpdates()`，不是任意 registry 扫描。
- **更新目标为最新版**：市场报告哪个版本就装哪个，不因插件声明"需要更新的 DSH"而回退旧版或跳过。宿主拒绝安装时，真实错误写进报告、包被还原，该版本记入失败记忆，下一轮不再撞同一版本。
- **失败版本不重试**：某版本整轮失败后记入 `<DSH_HOME>/autoupdater/failed-versions.json`，同版本或更旧的不再尝试，出现更新版本才重新进入流程。
- **保持启用状态**：更新前停用的包，更新后仍是停用；更新失败会装回旧版并恢复原状态。
- **不碰系统 pnpm**：真实 profile 只走宿主自带的 pnpm 11.8.0。

## 风险提示

自动装插件 = 自我提权面（标准预设默认禁掉 `tool-plugin-manager` 正是此意）。详见 [`项目进度.md`](项目进度.md) 的「风险与边界」与当前变更的 `design.md`。
