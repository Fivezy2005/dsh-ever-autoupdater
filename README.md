# DSH 插件自动更新

让 DSH Desktop（`desktop` profile）**自动检查并安装插件更新**，不依赖市场 UI 手点，也不依赖任何第三方更新插件。

本项目采用 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 的 spec-driven 工作流：每一项行为变更先写成一份带可验证场景的规格，再实现、验证、归档。

## 目录结构

```
D:\Workspace\dsh自动更新\        # 独立 git 仓库（分支 main）
├── openspec\
│   ├── config.yaml                 # OpenSpec 配置（schema: spec-driven）
│   ├── specs\                      # 主规格（已归档变更沉淀而来）
│   └── changes\
│       └── desktop-autoupdate-in-process\   # 当前进行中的变更
│           ├── proposal.md         # 为什么做 / 做什么 / 影响面
│           ├── design.md           # 技术决策与取舍
│           ├── tasks.md            # 可勾选的实施清单
│           └── specs\              # 三份 delta spec（能力级需求）
├── plugin\dsh-autoupdater\        # DSH 插件：宿主内定时自检并调用官方管理接口
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
| [`plugin/dsh-autoupdater/`](plugin/dsh-autoupdater/) | DSH 插件：宿主内定时自检并调用官方管理接口 | ⚠️ 检测已验证；应用链改造进行中 |
| [`tools/dsh-autoupdate.mjs`](tools/dsh-autoupdate.mjs) | 独立脚本：只读检测 | ⚠️ 即将降级为只读（见变更的 BREAKING 项） |
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
#    dist/dsh-autoupdater-0.1.0.zip 里是 dsh-autoupdater/ 三个文件
#    例：解压到 C:\Users\fivez\.dsh\plugins\dsh-autoupdater

# 1) 装进 profile（官方操作，会同时写入 dsh.profile.bundles）
cd "C:/Users/fivez/.dsh/profiles/desktop"
ELECTRON_RUN_AS_NODE=1 DSH_HOME=C:/Users/fivez/.dsh \
  "D:/Apps/DSH Next/DSH NEXT.exe" \
  "D:/Apps/DSH Next/resources/app.asar/lib/plugin-cli.js" \
  desktop add "file:C:/Users/fivez/.dsh/plugins/dsh-autoupdater"

# 2) 重启 DSH Desktop，插件在启动后 45s 首次自检
```

### 脚本（只读检测）

```bash
# 只看有哪些可更新（退出码 2 = 有更新，便于脚本判断）
node tools/dsh-autoupdate.mjs --profile desktop
```

### 插件配置

写在 `plugin/dsh-autoupdater/cordis.patch.yml` 的 row config 里：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `checkOnStart` | `true` | 启动后是否自检 |
| `startupDelayMs` | `45000` | 启动后延迟（等宿主热身） |
| `intervalHours` | `6` | 周期自检间隔，0 = 关闭 |
| `autoApply` | `true` | 是否直接安装（false = 只报告） |
| `maxUpdatesPerRun` | `3` | 单轮最多更新几个 |
| `skipPackages` | `['dsh-autoupdater']` | 永不动的包（保护自己） |
| `marketModule` | `''` | 指定 dshmarket 的 `lib/updates.js` 路径 |
| `registry` | `https://registry.npmjs.org` | 内置兜底检测用的 registry |

新增的定时配置键（`scheduleMode` / `dailyTime` / `timeZone` / `jitterMinutes`）见当前变更的 `specs/plugin-update-scheduling/spec.md`。

## 安全约束（已实现）

- **不自我更新**：`skipPackages` 含 `dsh-autoupdater`。
- **有 agent 在跑就不动**：检测 `ctx.get('agents')` → `status === 'running'`（与市场 `runningAgentIds` 同一套判定）。
- **版本写死**：npm 包安装的是市场报告的那个精确版本，不是 `latest` 漂移值。
- **只跑自己知道来源的包**：检测源是市场自己的 `checkUpdates()`，不是任意 registry 扫描。
- **不碰系统 pnpm**：真实 profile 只走宿主自带的 pnpm 11.8.0。

## 风险提示

自动装插件 = 自我提权面（标准预设默认禁掉 `tool-plugin-manager` 正是此意）。详见 [`项目进度.md`](项目进度.md) 的「风险与边界」与当前变更的 `design.md`。
