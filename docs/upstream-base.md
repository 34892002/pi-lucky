# 上游基线（pi-gui）

pi-lucky 的渲染进程、`contracts/`、`packages/` 和移植后的 `host/` 都来自 pi-gui。
这份文件只记录**一个事实**：本地这份快照对应上游哪个 git 提交。以后判断「上游改了什么」
就靠它做 `git diff` 的起点。

## 基线

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/minghinmatthewlam/pi-gui （本地克隆：`../pi-gui`） |
| 基线提交 | `c65474ba862923315b3c15f0f8aa0b78a8232c8f` |
| 基线描述 | `v1.0.1-67-gc65474ba`（package.json version `1.0.1`） |
| 基线日期 | 2026-10-27 10:48:58 -0400 |
| 本次快照日期 | 2026-11-13 |
| 记录时的上游 main | `faf8edd6`（2026-10-28，#318）——只改了 `.agents/skills/verify-pi-gui/*.md`，被移植的源码零变化，所以基线取它的父提交 |

## 目录对应

| pi-gui | pi-lucky |
|---|---|
| `apps/desktop/src/` | `apps/desktop/src/` |
| `apps/desktop/contracts/` | `apps/desktop/contracts/` |
| `apps/desktop/electron/` | `apps/desktop/host/`（同结构，改名） |
| `apps/desktop/electron/main.ts`、`preload.ts` | `apps/desktop/reference/`（只读参考，preload 还用于生成 `bridge-map.ts`） |
| `packages/` | `packages/` |
| `apps/desktop/electron/windows/{window-chrome,window-owner}.ts` | 未移植（Neutralino 侧由 `src/host/window-*.ts` 承担） |

`tests/`、`electron-builder.yml`、`electron.vite.config.mjs`、根 `package.json` 的 pnpm 脚本不跟随。

## 上游更新后怎么查

```bash
cd ../pi-gui
git fetch origin
git diff --name-status c65474ba origin/main -- \
  apps/desktop/src apps/desktop/contracts apps/desktop/electron packages
```

- 输出里 `electron/…` 的文件对应本地 `apps/desktop/host/…`，别直接照搬路径。
- **不能整文件覆盖**：本地已有 93 个文件相对基线改过（渲染进程几乎全被 i18n 化，electron 侧是
  IPC/窗口/通知的移植改动），另有 29 个本地独有文件。改过的文件按 3 路合并处理，
  `apps/desktop/src/i18n/messages/zh-CN.ts`、`contracts/shell-copy.ts`、`host/transport/*` 是本地独有，别被上游覆盖。
- `packages/*/package.json` 里 `@earendil-works/*` 被钉成精确版本（上游用 `^`），合并时保留本地写法。
- 同步后在 `docs/status.md` §6 补一句，并把上表的基线提交换成新提交。
