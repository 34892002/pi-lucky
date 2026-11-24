# pi-lucky

[pi](https://github.com/badlogic/pi) 的 Windows 桌面客户端。

pi 是一个跑在终端里的编程助手：读你的代码、改文件、跑命令、按你的指示干活。pi-lucky 给它配上
一个完整的桌面界面——侧边栏里管理会话，中间看对话和工具调用，右侧打开文件、差异和终端——
界面来自 [pi-gui](https://github.com/minghinmatthewlam/pi-gui)，底层把 Electron 换成了
**Neutralino + Bun**，因此不需要自带的 Chromium/Node 运行时：

| | pi-gui（Electron） | pi-lucky |
| --- | --- | --- |
| 窗口外壳 | ~180 MB Chromium | **2.4 MB**（复用系统 WebView2） |
| 安装后占用 | ~250 MB | **~109 MB** |
| 分发体积 | 116 MB | **41.5 MB**（zip） |

## 能做什么

- **会话**：按工作区（文件夹）组织会话，多窗口并排看对话、子线程树、历史搜索、归档。
- **对话**：选择模型；流式输出；工具调用卡片、改动汇总、长对话里的图片与附件；
  斜杠命令、`@` 引用文件、排队发送下一条消息。
- **文件工作台**：内置文件树、编辑器、差异面板和终端，不用切到别的窗口。
- **扩展与技能**：浏览、安装、配置扩展和技能，扩展可以自己出 UI 面板。
- **定时任务**：让 pi 按周期或指定时间自动跑一段提示词。
- **中英双语**：跟随系统语言，也可以在「设置 → Language」里手动切换。
- **快捷键**：沿用 pi-gui 的一套，`Ctrl+K` 命令面板、`Ctrl+O` 打开文件夹等。

## 开始使用

**直接运行打包好的版本**

解压 `dist/pi-lucky-release.zip` 到**任何可写目录**（整个文件夹就是全部，移动即搬家），
双击 `pi-lucky-win_x64.exe`。

推送到 GitHub 后，**Actions → Build Windows** 会自动构建 Windows x64 版本。
在成功的运行记录底部下载 `pi-lucky-windows-x64` 产物，解压整个 ZIP 后双击
`pi-lucky-win_x64.exe`。也可以从工作流页面手动运行构建。

**从源码构建**

需要 [Bun](https://bun.sh)：

```
bun install        # 顺带给 Bun 打 node-pty 补丁
bun run neu update # 首次检出后下载 Neutralino 运行时
bun run build      # 产物在 dist/pi-lucky/
```

第一次启动时，在设置里登录或填入你的服务商 API key（和 pi、pi-gui 一样）；配置好之后
新建会话、选个工作区文件夹就能开始。

## 数据放在哪

pi-lucky 是**便携**的：所有会话、附件、界面状态都在**程序目录下的 `data/`**（第一次启动时创建），
不往用户目录里写东西。整个文件夹拷走就等于带着全部数据搬家；备份也只是拷 `data/`。

两种情况例外：

- 程序目录**不可写**（比如解压进 `Program Files`）时，数据回落到 `%APPDATA%\pi-lucky`，
  启动日志里的 `userDataDirSource` 会写明用的是哪个。
- 想自己指定位置，就设 `PI_LUCKY_USER_DATA_DIR` 环境变量（旧名 `PI_APP_USER_DATA_DIR` 也认）。

pi-gui 用的是 `%APPDATA%\pi`，**不要和它共用一个目录**——两边格式相同，指到一起会互相覆盖
`ui-state.json`、`catalogs.json` 和附件。pi-lucky 发现是别的程序的 profile 时会拒绝启动。

另外，登录凭据、模型配置和会话文件是 pi 自己在管，默认在 `%USERPROFILE%\.pi\agent`
（和终端里的 pi 共用）；想让它们也进便携目录，设 `PI_CODING_AGENT_DIR` 指过去即可。

## 已知限制

- 目前只支持 **Windows**。
- 往窗口里**拖拽文件**还不支持（粘贴图片、点按钮选文件都正常）。
- 系统级全局快捷键没有对应实现；单窗口应用，`Ctrl+Shift+N` 开新窗口未接线。
- 少数由后台进程生成的文字（终端面板标题、部分提示条、通知）仍是英文。

## 关于

- 界面、交互和业务逻辑来自 pi-gui，MIT 许可，版权归上游作者 Matthew Lam。
- 本项目采用 MIT 许可，见 [LICENSE](LICENSE)。
- 当前实现状态、已验证的路径和缺口：[docs/status.md](docs/status.md)。
- 想改代码或调试：[docs/development.md](docs/development.md)；与 pi-gui 上游基线的对应关系：
  [docs/upstream-base.md](docs/upstream-base.md)。
