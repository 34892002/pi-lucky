# pi-lucky 开发与调试指南

写给后续接手的人 / AI。这里只记录**这套架构特有的事实**和**已经踩过的坑**，
通用 React / Bun / Neutralino 教程请查官方文档。

---

## 1. 心智模型

三个进程/层，各管一段，改代码前先确认自己站在哪一层：

| 层 | 产物 | 职责 | 源码 |
|---|---|---|---|
| shell | `pi-lucky-win_x64.exe` (2.4MB) | 开窗、菜单/加速键之外的原生能力（拖动、剪贴板、通知、文件夹对话框） | `apps/desktop/src/host/` |
| renderer | `resources/`（打进 `resources.neu`） | React UI（**pi-gui 原样复用**） | `apps/desktop/src/` |
| sidecar | `binaries/pi-lucky-sidecar.exe` (101MB, Bun 单文件) | pi SDK、会话、终端、扩展、状态存储 | `apps/desktop/host/sidecar/` + `apps/desktop/host/` 其余部分 |

通信：

```
renderer  ──local────────────────────►  shell (Neutralino JS API)
renderer  ──HTTP /rpc/:channel───────►  sidecar   (bearer token)
renderer  ◄─WS /events───────────────   sidecar   (推送)
sidecar   ──"renderer-request"───────►  renderer  (要原生对话框时反向请求)
```

- `window.piApp` = pi-gui preload 的移植（132 个方法，见 `src/host/generated/bridge-map.ts`）。
  它把三类东西合在一起：**local**（shell 自己实现）、**server**（转发给 sidecar）、
  **push**（WS 订阅；少数几个由 shell 本地广播）。
- **单窗口假设**：`primaryWindow()` 取代 `BrowserWindow.fromWebContents(sender)`。
- 每条通道名仍叫 `pi-gui:*`，与上游一一对应，方便回移补丁。

---

## 2. 常用命令

```bash
bun run dev            # 包构建 + vite --watch(development) + neu run(--window-enable-inspector)
bun run build          # packages → renderer(production) → sidecar → neu build → dist/<name>/
bun run build:renderer # 只重建 renderer（会先清 resources/assets + index.html）
bun run build:sidecar  # 只重编 sidecar（bun build --compile，约 1-2 分钟）
bun run build:shell    # neu build + 组装 dist/（需要 sidecar 已存在）
bun run typecheck      # renderer(tsconfig.json) + host(tsconfig.host.json)
bun run i18n:verify    # 文案门：目录/占位符/复数/回落 + 已翻译面不能有英文硬编码
bun run i18n:check     # 报告：哪个 catalog 还有键没翻（不失败）
bun run i18n:new <tag> "<名称>"   # 新语言脚手架（写 messages/<tag>.ts + 注册 catalog）
bun run smoke:sidecar  # sidecar RPC/WS 冒烟（不需要窗口）
bun run smoke:terminal # 编译版 sidecar 里 node-pty 是否可用
bun run smoke:shell    # 真窗口 + CDP，断言 piApp/React/状态（**需 dev 模式渲染构建**）
```

体积约束（默认只出本平台二进制，`PI_LUCKY_ALL_PLATFORMS=1` 全出）：

```bash
PI_LUCKY_ALL_PLATFORMS=1 bun run build
```

### 2.1 数据目录与环境变量

数据目录默认是**便携的**：`<程序目录>/data`（打包后是 exe 同级；`bun run dev` 时是仓库根的
`data/`，已在 `.gitignore` 里）。只有 `<程序目录>` 不可写（装进 `Program Files`、只读挂载）时才回落到
`%APPDATA%\pi-lucky`，启动日志里的 `userDataDirSource` 会说明用的是哪一个：

```json
{"userDataDir":"D:\\...\\data","userDataDirSource":"portable"}
```

解析顺序：`PI_LUCKY_USER_DATA_DIR` → `<程序目录>/data`（可写时）→ `%APPDATA%\pi-lucky`。
“是否打包版”不开环境变量，直接看 `process.execPath`：跑在 `bun`/`node` 下就是源码，否则就是编译后的
sidecar（`isPackaged()`）。

环境变量只在 `apps/desktop/host/env.ts` 里读写，别的地方不要再写 `process.env.PI_*` 字面量。
**canonical 名是 `PI_LUCKY_*`**；从 pi-gui 继承来的 `PI_APP_*` 仍然可用，但会经 `readWithLegacy()`
读一次并 warn，避免 pi-gui 的覆盖量悄悄作用到 pi-lucky 上。

| 变量 | 旧名（pi-gui，仍可用） | 作用 |
| --- | --- | --- |
| `PI_LUCKY_USER_DATA_DIR` | `PI_APP_USER_DATA_DIR` | profile 目录（store、附件、worktree、checkpoint） |
| `PI_LUCKY_INITIAL_WORKSPACES` | `PI_APP_INITIAL_WORKSPACES` | 启动时打开的工作区，多个用 `path.delimiter` 分隔 |
| `PI_LUCKY_NODE_PTY_DIR` | — | 打包时放在 exe 旁的 `node-pty` 目录 |
| `PI_LUCKY_VERSION` | — | 覆盖 sidecar 上报的版本号（默认 `0.1.0`，与 `neutralino.config.json` 一致） |
| `PI_LUCKY_TEST_MODE` | `PI_APP_TEST_MODE` | 静音系统通知，只写通知日志 |
| `PI_LUCKY_NOTIFICATION_LOG_PATH` | `PI_APP_NOTIFICATION_LOG_PATH` | 通知 JSONL 输出路径 |
| `PI_LUCKY_ORCHESTRATION_SUPERVISION_INTERVAL_MS` | `PI_APP_ORCHESTRATION_SUPERVISION_INTERVAL_MS` | 子线程巡检间隔，下限 250ms |

构建/冒烟脚本自己的开关留在脚本里（不是运行时配置）：`PI_LUCKY_ALL_PLATFORMS`、
`PI_LUCKY_TARGET`、`PI_LUCKY_DEV`、`PI_LUCKY_DEBUG_PORT`、`PI_LUCKY_SHELL_BIN`。

**pi 自己的变量不要改名、也不要塞进 `env.ts`**：`PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`，
装 auth/models/settings/sessions）、`PI_CODING_AGENT_SESSION_DIR`、`PI_OFFLINE`、`PI_TELEMETRY` …
这些是 pi SDK 的契约，改了 pi 就不认。

---

## 3. 调试

### 3.1 窗口内 DevTools（最省事）

`bun run dev` 已经带上 `--window-enable-inspector`（配置里 `enableInspector: true`），
窗口起来后自带 DevTools 窗口，`console.log` 直接看。

**sidecar 的 stdout/stderr 会被渲染进程转发成 `[sidecar] ...` 打到 DevTools 控制台**，
后端崩溃/抛错的堆栈就在这里，不用另开终端。

### 3.2 外部 CDP

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" bun run dev
# 然后
curl http://127.0.0.1:9222/json/list
# 连 target.webSocketDebuggerUrl（Node 22 自带全局 WebSocket，无需 puppeteer）
```

必须知道的三个坑：

1. **CDP 响应里第一个 `type: "page"` 往往是 DevTools 自己**（`devtools://devtools/...`）。
   过滤掉 `url.startsWith("devtools://")`，否则你拿到的是空白 DevTools 页面
   （`window.piApp === undefined`，`location.href` 是 `devtools://...`）。
2. **调试端口按浏览器进程固定**：上一个实例残留时，同一端口会返回**旧页面**。
   测试脚本必须动态取空闲端口（`createServer().listen(0)`）并且先
   `taskkill /F /IM neutralino-win_x64.exe`。
3. **不要用 `Bun.spawn` 拉起打包版再连 CDP**：会偶发命中 Neutralino 官网欢迎页
   （`https://neutralino.js.org/`）。用 `node` 的 `child_process.spawn`，或者手动双击。
   `tmp/shortcutcheck.cjs` 是可用的参考实现（node + 全局 WebSocket + 明确 `process.exit`）。

> 自测脚本退不出的经典原因：CDP 的 `WebSocket` 没关，node 事件循环挂着。
> 收尾时 `socket.close()` + `taskkill` + `process.exit(code)`，别只设 `process.exitCode`。

### 3.3 直接打 sidecar 的 HTTP 接口

每次启动都会写 `<数据目录>\runtime.json`（默认 `<程序目录>/data`，可用 `PI_LUCKY_USER_DATA_DIR` 改）：

```json
{ "pid": 1234, "port": 51234, "version": "0.1.0" }
```

注意里面**没有 bearer token**：token 只经 stdout 的 `PI_LUCKY_READY` 行传给壳，不落盘。

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/health
curl -X POST -H "Authorization: Bearer <token>" -H "content-type: application/json" \
     -d '{"args":[]}' http://127.0.0.1:<port>/rpc/pi-gui:state-request
```

RPC 调用约定：body 是 `{"args":[...]}`（可变参数），响应直接是被调用方法的返回值。

### 3.4 dev 版 vs 打包版（别混着测）

| | dev (`neu run`) | 打包版 |
|---|---|---|
| 渲染资源 | `resources/` 目录（`--load-dir-res`） | `resources.neu` 内嵌 |
| sidecar | 从 TypeScript 源码起 `bun` | `binaries/pi-lucky-sidecar.exe` |
| 缺失资源时 | 报错 | **静默加载 `https://neutralino.js.org/` 欢迎页** |

- **`resources.neu` 必须和 exe 同目录**，否则就是欢迎页。看到「CDP 里是 Neutralino 官网」= 资源没找到。
- 应用**正在运行时** `neu build --release` 会 `EPERM: unlink ...pi-lucky-win_x64.exe`：先关掉实例。
- `smoke:shell` 依赖 **development 模式**的渲染构建（`__PI_SIDECAR_DEV__`）。
  跑过 `bun run build`（production）之后再跑 `smoke:shell` 会报
  `Cannot read properties of undefined (reading 'addWorkspacePath')` —— 重新
  `vite build --mode development` 即可。
- `vite.config.ts` 用 `emptyOutDir: false`（因为 `resources/js/neutralino.js` 不能被清掉），
  所以 `scripts/build-renderer.ts` **构建前手动删** `resources/assets` 和 `resources/index.html`。
  不删的话历史 bundle + `.map` 会累积（曾经涨到 17MB）。

---

## 4. 已踩过的坑（按症状查）

| 症状 | 原因 | 处置 |
|---|---|---|
| 无边框窗口拖不动 | WebView2 不认 `-webkit-app-region: drag` | `src/host/window-drag.ts` 用 `window.beginDrag()` 复刻；选择器 `.topbar` / `.window-titlebar` / `[data-window-drag]` |
| 拖一次却触发多次 | `MutationObserver` 对每个新节点都挂监听 | 只对 `node.matches(DRAG_SELECTOR)` 的节点挂，`WeakSet` 去重 |
| 终端起来就退出 / 无输出 | Bun 下 `net.Socket({fd, readable:false, writable:true})` 在 Windows 立即关闭 | `scripts/patch-node-pty.ts` 改成 `fs.writeSync(fd)` + `readable:true`（幂等，仅 win32） |
| 打包后 `node-pty` 找不到 | 原生模块不能进 `bun build --compile` | `--external node-pty`，把 `node-pty/{lib,package.json,prebuilds/win32-x64}` 复制到 exe 旁边；`resolveNodePty()` 依次试 `require` → `PI_LUCKY_NODE_PTY_DIR` → `dirname(execPath)/node-pty` |
| sidecar 体积 114MB→101MB | 生产构建带了 inline sourcemap | 只在 dev 加 `--sourcemap=inline`；node-pty 复制时过滤 `.pdb`（省 24MB） |
| 文本粘贴失效 | 异步化后 keydown 无条件 `preventDefault`，把原生粘贴吃掉了 | `handlePastedImages()`：**paste 事件优先**（`clipboardData` 已含图片文件），原生 `readClipboardImage` 只做「WebView2 什么都没给」的兜底 |
| `events.on(...)` 无法退订 | Neutralino 返回的是 `Promise<{success}>`，不是退订函数 | 自己保存 handler 引用并在卸载时 `events.off` |
| 快捷键触发两次 | 渲染进程 `use-desktop-commands` 与 shell 层各注册了一次 | shell 层（`src/host/accelerators.ts`）只处理 main 独有的 `Ctrl+O` / 非编辑区 `Ctrl+V`；共享表只在渲染进程注册 |
| `os.spawnProcess` 路径含空格失败 | 内部走 `cmd.exe /c` | 命令整体加引号；需要真实进程树管理时用 `Bun.spawn` |
| `neu build` 产物里没有 sidecar | `neu` 只复制 `binaries/` 里它认识的运行时 | `build-sidecar` 输出到 `build/binaries/`，`build-shell` 再搬进 `dist/<binaryName>/binaries/` |
| 资源 `.neu` 越来越大 | 历史 bundle 累积（见 3.4） | `build-renderer.ts` 先清理 |
| 编辑文件「找不到精确匹配」 | 仓库文件是 **CRLF**，`edit` 工具按原始字节匹配 | 用 `node scripts/patch-text.mjs <file> <patch.json>`（自动按文件 EOL 归一化，并要求唯一匹配） |
| `python` / `python3` 报错 | Windows Store 存根 | 用 `node -e` / `edit` / `write` |
| 探针脚本找不到 `/tmp` | bash 的 `/tmp` ≠ node 的 `/tmp`（→ `D:\tmp`） | 临时脚本一律放仓库 `tmp/`（已 gitignore） |
| `npx tsc` 装错包 | 项目里没有 `tsc` bin | `./node_modules/.bin/tsc -p ...` |
| 起不来 `vite` | 只有 `vite.exe`，没有 `vite.cmd` | `node_modules/.bin/vite.exe` |
| `bun install` 偶发 `EPERM NtSetInformationFile` | Windows 文件锁 | 重试即可 |
| `TS2345`：`t("x.count")` 不接受 | 计数键需要 en 同时有 plain + `_one` + `_other` | 三个都加；中文只写 plain（CLDR 只有 `other`）|
| `TS2353`：`_plural` 不是合法键 | 复数后缀必须是 CLDR 分类 | 用 `_one` / `_other` / `_few` / `_many`，不能用 `_plural` |
| 切语言后部分文案不变 | `useCallback` / `useMemo` 依赖数组没带 `t` | 把 `t` 加进去；纯函数用 `t: Translate = translate` 参数 |
| 组件一渲染就报 hook 错误 | 模块作用域的表（如 `FILE_MARKDOWN_COMPONENTS`）里调了 `t` | 改成 `(t) => ({...})` 工厂，在组件内构造 |
| `smoke:shell` 卡满 60 秒报「never opened a debuggable window」 | 它按页面标题找 CDP target，而标题改了（`pi` → `pi-lucky`） | 改 `smoke-shell.ts` 的 `WINDOW_TITLE`（与 `neutralino.config.json` 保持一致）|
| `smoke:terminal` / `smoke:shell` 报 `no workspace available` 或断言工作区没渲染 | 脚本以前用 `repoRoot` 当工作区：该目录被别的 pi 实例打开时会话被锁，sidecar 静默拒绝；目录名还会撞上界面文案 | 脚本已改用 `mkdtemp` 临时工作区；手工复现时也换一个空目录 |

### 4.1 改文案 / 加语言（i18n）

详细规则在 `apps/desktop/src/i18n/AGENTS.md`，这里只列高频操作：

```bash
# 1) 组件里加一句文案：只改 en.ts（中文未翻时自动回落英文）
#    en.ts:  "threads.archive": "Archive",
#    zh-CN.ts: "threads.archive": "归档",
# 2) 扫一个目录里剩下的英文硬编码
bun run i18n:verify      # 只看 TRANSLATED_SURFACES 里的目录；新目录先加进去
# 3) 新增一种语言
bun run i18n:new ja "日本語"
```

守门范围：`check-i18n.ts` 的 `TRANSLATED_SURFACES`（递归目录，`.ts`+`.tsx`）里的文件**不允许**再出现英文字面量，
新译完一块就把它加进去。侧边效应：改名/重构后一旦漏掉 `t()`，`bun run i18n:verify` 会直接报出 `文件:行`。

---

## 5. 加一个新的 IPC 通道（照这个顺序）

1. `apps/desktop/contracts/ipc.ts`：在 `desktopIpc` 加通道名，在 `PiDesktopApi` 加方法签名。
2. `apps/desktop/src/host/renderer-requests.ts`：如果通道要**反向请求渲染进程**（原生对话框等），在这里注册。
3. `apps/desktop/host/ipc/register-desktop-ipc.ts`：`ipcMain.handle(desktopIpc.xxx, ...)`（同目录 `main-frame-ipc.ts` 提供 `ipcMain` 兼容层）。
4. `apps/desktop/src/features/...`：在渲染进程调用 `window.piApp.xxx(...)`。
5. `bun run scripts/gen-bridge-map.ts`：**只有 preload 有变化时才需要重跑**（`bridge-map.ts` 由
   `apps/desktop/reference/preload.ts` 生成）。漏掉这步的表现是 `window.piApp.xxx is not a function`。
6. `bun run typecheck` + `bun run smoke:sidecar`。

推送（`ipcRenderer.on` 方向）走 `transport.subscribe`；如果它根本不该由 sidecar 产生，
就加进 `src/host/bridge.ts` 的 `LOCAL_PUSH_CHANNELS`，用 `bridge.emitLocalPush()` 广播。

---

## 6. 快捷键 / 拖动 / 菜单的归属（别重复实现）

- pi-gui 在 **Windows 上没有原生菜单**（`installApplicationMenu()` 开头就 `platform !== "darwin"` 直接 return），
  快捷键全部来自 `webContents.on("before-input-event")`。
- 其中共享表（`getDesktopCommandFromShortcut` / `getSidePanelTabCommand` /
  `isCloseFocusedSurfaceShortcut`）**在渲染进程里已经有一份**（`src/app/use-desktop-commands.ts`，
  用的是 `contracts/ipc.ts` 同一个函数），并且 pi-gui 当年就是「main 发一次 + 渲染进程再处理一次」，
  用 `createChordPairGate()` 去重。
- 因此 `src/host/accelerators.ts` **只允许**实现 main 独有、渲染进程完全没有的两件事：
  - `Ctrl+O` → 选工作区（macOS 是 `Cmd+O`）
  - `Ctrl+V` → 焦点**不在**输入框/终端时，读剪贴板图片并 `emitLocalPush("pi-gui:clipboard-image-pasted")`
- 想要新增窗口级快捷键（如 `Ctrl+W` 关窗、缩放、重载）：pi-gui 在 Windows 上**本来就没有**，
  加之前先确认是不是「补齐」还是「新增行为」。

---

## 7. 测试与已知缺口

回归门（改完必跑）：

```bash
bun run typecheck && bun run i18n:verify && bun run smoke:sidecar
bun run smoke:terminal
# 需要窗口/CDP 的（先 bun run build:renderer --mode development）：
bun run smoke:shell && bun run smoke:shortcuts
```

已知缺口（相对 pi-gui）：

1. **拖拽文件进窗口**：Neutralino 拿不到本地路径（`getPathForFile` 返回 `""`）；粘贴与「选择文件」正常。
2. **全局快捷键**（Electron `globalShortcut`）没有对应物。
3. **多窗口**：sidecar 按单窗口实现。
4. 未做真实验证的路径：扩展视图、通知、更新检查、review/checkpoint 工作台、真实 API key 的完整对话流。
