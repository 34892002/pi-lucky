# 交接状态（最近一次验证：2026-11-13）

> 给下一个会话 / 下一个人：这份文件是**当前事实**，`docs/development.md` 是**怎么调试**。
> 两者冲突时以这份为准并顺手更新它。

## 1. 一句话状态

pi-lucky 已能跑完整应用：Neutralino 窗口（2.4MB 壳）+ Bun sidecar（业务逻辑）+ pi-gui 原样 UI。
`bun run build` 产出 `dist/pi-lucky/` 可双击运行，`dist/pi-lucky` 桌面版已人工确认能开窗、能拖动。

界面**中英双语已收口**：渲染进程与壳的文案全部走 `apps/desktop/src/i18n`，跟随系统语言或在设置里手选；
sidecar 的文案仍是英文（见 §5 缺口 5）。

## 2. 体积（同口径对比，别再比错）

| 口径 | pi-gui 1.0.1 portable | pi-lucky |
|---|---|---|
| 分发体积 | 116MB（electron-builder 的 7z 自解压 exe） | 109MB 未压缩目录；**zip 后 41.5MB** |
| 安装后磁盘 | ~250MB | **109MB** |
| 壳 | Electron 运行时 ~180MB | **2.4MB**（复用 WebView2） |
| sidecar | — | 101MB（含 ~95MB Bun 运行时，这是体积下限） |

结论：约 **2.5 倍**收益，不是数量级。**UPX 压缩 sidecar 尚未尝试**（有 Defender 误报 / 原生模块加载风险），要试就在副本上先验证启动 + node-pty。

## 3. 已验证的回归门（改完必跑）

```bash
bun run typecheck          # renderer + host，exit 0
bun run i18n:verify        # 文案门：目录/占位符/复数/回落 + 已翻译面（122 文件）无英文硬编码
bun run i18n:check         # 报告：哪个 catalog 还有键没翻（不失败）
bun run smoke:sidecar      # sidecar RPC/WS
bun run smoke:terminal     # 编译版 sidecar 里 node-pty 可用（**本机需先 git init，见 §5**）
bun run smoke:shell        # 真窗口 + CDP：piApp / React / 状态往返（需 dev 模式渲染构建）
bun run smoke:shortcuts    # Ctrl+O / Ctrl+V 归属（真窗口 + CDP）
bun run apps/desktop/scripts/audit-parity.ts   # 132 个 bridge 方法 vs host 实现，gaps 必须为空
```

最近一次结果：全部 PASS（`audit-parity` 的 `gaps: []`，`i18n:verify` 的 `failures: []`）。

> 踩过的坑：`smoke:shell` / `smoke:terminal` 以前拿 `repoRoot` 当工作区，而 sidecar 会因
> **「该会话已在另一个 pi 实例打开」**（本机常开着 pi-gui）静默拒绝，报 `no workspace available`；
> 而且仓库目录名 `pi-lucky` 会撞上界面文案，让「工作区已渲染」的断言假通过。现在两个脚本都
> 用 `mkdtemp` 建临时工作区（`smoke-shell.ts` / `smoke-terminal.ts`），与环境无关。

## 4. 这一轮做了什么（中英双语收口）

目标：不做「重新设计 i18n」，而是把 pi-gui 自带的 `apps/desktop/src/i18n`（与上游逐字节相同）真正用满。

- **保留 partial + 英文回落**：`en.ts` 派生 `MessageKey`，`zh-CN.ts` 是 `Partial<Messages>`；
  没翻的键自动英文，不需要完整双语对照表。现在 905 个英文键 / 879 个中文键（差的 26 个是 CLDR 复数变体，
  中文只有 `other` 一类，按设计不写）。
- **渲染进程清零**：`app/**`、`features/**` 全部走 `t()`（约 800 处替换），文案按面分组：
  `settings.*`、`threads.*`、`workbench.*`、`composer.*`、`extensions.*`、`scheduledTasks.*`、`palette.*`、`time.*`…
- **纯函数/表驱动模块不好用 hook**（`buildPaletteActions`、`groupLabel`、`formatRelativeTime`、
  `restoreWorkbenchView`、`describeProvider`、`formatScheduledTaskRowMeta` …）：一律加 `t: Translate = translate`
  参数，由组件传入 `useTranslation()` 的 `t`；`useCallback`/`useMemo` 的依赖数组补 `t`，否则切语言不重算。
- **模块作用域的表不能调 hook**：`FILE_MARKDOWN_COMPONENTS` 这类改成 `(t) => ({...})` 工厂函数。
- **不拼接语序**：组合型 aria-label 用「基础键 + 带上下文键」成对定义
  （`threads.pinThread`/`threads.pinThreadIn`、`composer.mention.enableNamed`、`workbench.file.closeNamed`…）。
- **日期/时间走 `Intl`**：`formatRelativeTime` 用 `time.*` + 插值，面板时间用 `toLocaleString(locale)`，
  周锚点用 `Date.UTC(2024,0,7)` + `timeZone: "UTC"`。
- **跨进程文案传原因码，不传英文**：剪贴板解码失败改成 `code: "decode-failed"`，渲染进程 `t()` 出文案。
- **壳的文案也翻了**：`src/host/shell-locale.ts` 的 `shellTranslator()` 复用同一份 catalog，
  读同一个 localStorage 偏好（壳和渲染进程同源同 bundle）；用于原生对话框默认标题与启动失败面板。
- **守卫升级**：`apps/desktop/scripts/check-i18n.ts`（纯 Bun，无测试运行器）
  校验 locale 注册表、占位符、复数回落、语言解析、以及 `TRANSLATED_SURFACES`（递归目录，`.ts`+`.tsx`，122 文件）
  里不能再出现英文字面量；`scripts/new-locale.mjs --check` 报告未翻键（`SAME_COPY_BY_DESIGN` 放品牌名/占位符）。
- 顺手统一品牌：文案里 `pi-gui` → `pi-lucky`，窗口标题 `pi` → `pi-lucky`（`neutralino.config.json` + `index.html`，
  `smoke-shell.ts` 的 CDP 页面标题断言同步改）。

上一轮的快捷键补全仍有效：pi-gui 在 Windows **没有原生菜单**，快捷键来自 `before-input-event`，
且共享映射表在渲染进程里已有一份（`src/app/use-desktop-commands.ts`），所以 `src/host/accelerators.ts`
只实现 main 独有的 `Ctrl+O` 和非编辑区 `Ctrl+V`；粘贴以 paste 事件为主，原生 `readClipboardImage` 只兜底；
`LOCAL_PUSH_CHANNELS` + `emitLocalPush()` 让三个本地推送不再是死订阅。

## 5. 已知缺口（相对 pi-gui）

1. **拖拽文件进窗口**：Neutralino 没有 `getPathForFile`，现在返回 `""`。粘贴图片、选择文件正常。
   （思路：读 `File` 字节走后端上传，绕过路径。）
2. **全局快捷键**（Electron `globalShortcut`）无对应物。
3. **单窗口**：sidecar 与 `primaryWindow()` 都按单窗口写，`Ctrl+Shift+N` 新窗口未接。
4. Windows 上本来就没有的（不算缺口，加之前先想清楚）：关窗/重载/缩放/DevTools 快捷键。
5. **sidecar 的文案仍是英文**（`apps/desktop/host/`，约 330 条）。而且它们大多不是「界面文案」而是
   **写入会话存储的数据**（转录里的活动项、通知、错误），在写入时翻译会把语言固化进用户数据，
   要做得改成「存键、读时译」。渲染进程唯一还能见到英文的地方就是这些 sidecar 回传的字符串
   （终端面板标题 `Terminal 1`、活动项、toast 等）。原生对话框标题已经改走 `contracts/shell-copy.ts` 的键集合。

未做真实端到端验证的路径：**真实 API key 的完整对话流**、扩展视图、通知、更新检查、
review/checkpoint 工作台。

## 6. 关键决策

- **Bun sidecar 是强制的**：Neutralino 没有 JS 后端。
- **传输层 = 本地 HTTP + WS**（随机端口 + 每次启动的 bearer token，只经 stdout 传，不落盘）。
- **`ipc-compat.ts` 是唯一接缝**：给 `register-desktop-ipc.ts` 提供三个 Electron 名字。
- **原生对话框反转**：sidecar → `pi-gui:renderer-request` → 渲染进程弹原生框。
- **数据目录默认便携**：`<程序目录>/data`（dev 是仓库根 `data/`，已 gitignore；目录不可写才回落
  `%APPDATA%\pi-lucky`）。`PI_LUCKY_USER_DATA_DIR` 可覆盖（旧名 `PI_APP_USER_DATA_DIR` 仍认），
  通过 `pi-lucky.json` 所有权标记拒绝外来 profile；`%APPDATA%\pi` 属于 pi-gui，绝不可共用。
  环境变量只在 `env.ts` 里读，见 `docs/development.md` §2.1。
- **node-pty 必须 external + 随二进制分发 + 打补丁**（Bun 下 `net.Socket({fd})` 会立即关闭）。
- **打包体积取舍**：默认只出本平台二进制（`PI_LUCKY_ALL_PLATFORMS=1` 全出）、生产不带 sourcemap、
  不复制 `.pdb`、构建前清 `resources/assets`。
- **`../pi-gui` 保留**（36MB，带 `.git`）作为上游基线，**不要删**。
- **与上游的关系变了（重要）**：以前渲染进程相对 pi-gui 只改了 3 个文件，现在**渲染进程的形状与上游明显不同**——
  中英双语收口改了 `app/**` 与 `features/**` 几乎每一个组件（只是加 `t()`、加 `Translate` 参数，
  外加 `i18n/messages/zh-CN.ts`）。回移上游补丁时要预期冲突；反过来，上游回移时
  **不应把中文改动带回去**（`en.ts` 是共享源，`zh-CN.ts` 是 pi-lucky 独有的一部分）。
  结构上仍是新增目录为主：`src/host/`、`host/transport/`、`host/sidecar/`、`host/windows/host-window-owner.ts`、`host/platform/*`。
- **i18n 不重新设计、不引框架**：`apps/desktop/src/i18n` 与上游逐字节相同（只多了 `messages/zh-CN.ts` 与校验脚本），
  英文是源、其他语言是 `Partial<Messages>`，缺键自动回落英文。

## 7. 建议的下一步（按价值排序）

1. **sidecar 文案的 locale 通道**（i18n 最后一块）：先加一个 `pi-gui:set-locale` 通道把偏好传给 sidecar，
   再把「读时译」做起来：转录活动项存 `{ key, params }` 而不是英文句子，渲染进程用 `t()` 出文；
   原生对话框标题（目前 sidecar 写死 `"Open a workspace folder"` / `"Attach files"`）先改走这个通道。
2. 真实会话冒烟：新建 thread → 发 prompt → 断言流式转录（需 API key 或假 provider）。
3. 拖拽文件：用 `File` 字节上传补上缺口 1。
4. 扩展视图 / 通知 / 更新检查各跑一次真实场景。
5. 可选：UPX 实验（只会省下载体积，磁盘占用不变）。
6. 发行：打包成单文件 portable exe（7z SFX，预计 42–45MB）、签名。

## 8. 恢复开发的最短路径

```bash
bun install          # 会跑 postinstall：neu update + patch-node-pty
bun run dev          # 渲染进程 watch + 窗口（自带 DevTools）
bun run build        # 全量产物 → dist/pi-lucky/
```

分层与文件地图：

| 想改什么 | 去哪 |
|---|---|
| UI / 交互（pi-gui 原有） | `apps/desktop/src/features/**`（文案一律 `t("area.key")`，见下两行） |
| 文案（英文源 / 中文） | `apps/desktop/src/i18n/messages/{en,zh-CN}.ts`，改完跑 `bun run i18n:verify` |
| i18n 机制 / 加语言 | `apps/desktop/src/i18n/`（`AGENTS.md` 在里面）+ `bun run i18n:new <tag> <名称>` |
| 渲染进程与 shell/sidecar 的接缝 | `apps/desktop/src/host/{bridge,transport,neutralino}` |
| 快捷键 / 拖动 / 窗口 | `apps/desktop/src/host/{accelerators,window-drag,window-state}.ts` |
| 业务逻辑、IPC 处理 | `apps/desktop/host/ipc/register-desktop-ipc.ts`（约 100 个处理程序） |
| 环境变量 / 数据目录 | `apps/desktop/host/env.ts` |
| 传输层（HTTP/WS/RPC） | `apps/desktop/host/transport/*` |
| sidecar 引导 | `apps/desktop/host/sidecar/main.ts` |
| 构建脚本 | `scripts/{build-packages,build-renderer,build-sidecar,build-shell,dev}.ts` |
