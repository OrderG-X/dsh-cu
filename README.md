<div align="center">

<img src="assets/hero.svg" alt="dsh-mac-computer-use — 让 DSH 看着屏幕操作你的 Mac" width="760" />

<p>
  <a href="https://github.com/OrderG-X/dsh-mac-computer-use/releases"><img src="https://img.shields.io/github/v/release/OrderG-X/dsh-mac-computer-use?label=release&color=4D6BFE" alt="release" /></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" />
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://img.shields.io/badge/DSH-plugin-4D6BFE" alt="DSH plugin" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white" alt="macOS" />
</p>

</div>

**给 DSH 的 Mac 桌面操作能力（computer use）。视觉优先，不依赖无障碍树。**

> **一句话**：DeepSeek Harness（DSH）插件，让模型看着屏幕操作你的 Mac：列窗口、截图、OCR 找字、点击、打字、按键、滚动、拖拽、打开应用。
>
> **什么时候用**：「看看我屏幕上有什么」「帮我在这个 App 里点一下」，以及没有命令行、只能用鼠标操作的 Mac 软件。
>
> **安装**：`git clone` 本仓库后跑 `./install.sh` 编译引擎（需要 Xcode Command Line Tools），再 `dsh plugin add https://github.com/OrderG-X/dsh-mac-computer-use/releases/latest/download/dsh-mac-computer-use.tgz`，重启 DSH。仅 macOS。
>
> **English:** a DeepSeek Harness (DSH) plugin for computer use on macOS. The model sees the screen and controls the Mac through 11 `desktop_*` tools: window list, screenshots, OCR text search, click, type, keys, scroll, drag and app launch. Install: clone this repo, run `./install.sh` (needs Xcode Command Line Tools), then `dsh plugin add` the release tarball above and restart DSH.

> 以前叫 `dsh-cu`，2026-10-18 改名。旧地址会自动跳到这里；底层的命令行引擎仍叫 `dsh-cu`。
> 和别人家的 [dsh-computer-use](https://github.com/988hj7tczd-oss/dsh-computer-use) 不是一个东西：那个靠无障碍树（cua-driver），这个靠截图。

![光标动效](assets/cursor-demo.gif)

*桌面光标：实心蓝箭头 + 带显示器图标的「DSH」名牌，干活时名牌写上正在做什么。跟 [dsh-chrome-bridge](https://github.com/OrderG-X/dsh-chrome-bridge) 的浏览器光标是同一套样式，那边是半透明的、名牌带地球图标。*

11 个 `desktop_*` 工具 + 一个自包含的 Swift 命令行 + 一个看得见的桌面光标。

```
desktop_windows    desktop_observe    desktop_screenshot   desktop_find_text
desktop_click      desktop_type       desktop_key          desktop_apps
desktop_launch     desktop_scroll     desktop_drag
```

---

## 为什么又造一个

DSH 上已有的 computer use 插件（`dsh-computer-use`、`dsh-mac-cua` 等）大多依赖 **macOS 无障碍树（AX）**。
我们实测过：**锁屏时 AX 对所有应用都返回 0 个 AXWindow**，解锁后立刻恢复正常 —— 这是 macOS 的行为，
不是驱动的 bug（[详细记录](docs/locked-session-and-ax.md)）。另外第三方二进制在某些环境下拿不到 AXWindow。

**Codex 那种 computer use 走的是视觉路线**：截图 → 模型看 → 按坐标操作。这条路不碰 AX，
所以在 AX 不灵的环境下照样能用。这个仓库就是那条路，外加：

| | |
|---|---|
| **OCR 找文字** | 用 macOS 自带的 Vision 框架，本地跑。`desktop_click(text="登录")` 直接按文字点 |
| **元素编号** | `desktop_observe` 把可点元素在截图上编号，模型说"点第 7 个"就行 |
| **看得见的光标** | 屏幕上有个蓝色光标跟着操作走，名牌写着「点击 发送」这类动作；跟浏览器插件的光标一套样式 |
| **空闲自退** | 光标浮层 60 秒没动静自己走，不留常驻进程 |
| **单文件 Swift** | 零依赖，好审计 |

---

## 安装

```bash
git clone https://github.com/OrderG-X/dsh-mac-computer-use.git
cd dsh-mac-computer-use
./install.sh
```

需要 macOS + Xcode Command Line Tools（`xcode-select --install`）。光标是代码画的，不用另装素材。

装完去 DSH 的**插件页**添加插件，地址填 `https://github.com/OrderG-X/dsh-mac-computer-use/releases/latest/download/dsh-mac-computer-use.tgz`（或者命令行 `dsh plugin add` 这个地址），然后**重启 DSH**。

装好后插件页里叫「**Mac 桌面操作**」。点进去是设置页：能不能用、看得到几个窗口，命令行引擎、屏幕录制权限、辅助功能权限、光标浮层逐项打勾，缺哪个就给哪个的按钮（复制安装命令 / 打开系统设置）；还有「屏幕上显示操作光标」开关。

---

## 用起来是什么样

```
你：帮我看看屏幕上有什么
→ desktop_windows      拿到窗口列表和坐标
→ desktop_screenshot   模型看到图

你：点那个「登录」按钮
→ desktop_click(text="登录")   OCR 找到它 → 发事件过去（不动你的鼠标）

你：把计算器的 7+8 算一下
→ desktop_observe      截图 + 元素编号
→ desktop_click(index=5) 点第 5 个（"7"）
→ desktop_screenshot   再截一次确认
```

**推荐工作流是 `observe → click(index)`** —— 模型看图上的编号，比算坐标可靠得多。

---

## 底层

```
DSH 工具 (desktop_*)
      ↓ spawn
dsh-cu (Swift 单文件)
      ├── winlist   CGWindowListCopyWindowInfo   ← 窗口坐标，零权限
      ├── observe   AX 枚举可点元素 + 截图标注编号
      ├── shot      screencapture -l 窗口号       ← 截窗口本身，被挡住也行
      ├── find      Vision 框架 OCR              ← 找文字 → 可点坐标
      ├── clickat   CGEvent postToPid            ← 不移动真实鼠标、不抢前台
      ├── type/key  CGEvent                      ← 支持中文
      ├── scroll/drag  CGEvent
      └── launch    NSWorkspace（后台启动，不抢前台）
```

后台点击能落进窗口，靠的是两处细节：鼠标事件里填上目标窗口号和窗口内坐标（不填的话 AppKit 和 Electron 都会把事件丢掉）；目标是后台的 Chromium / Electron 窗口（比如 DSH 自己）时，按下那一下带上 ⌘，页面才肯接，松开和 click 本身不带，页面看到的就是普通点击。

截某个应用的窗口时，按窗口号截它本身（`screencapture -l`）：被别的窗口挡住、在后台都截得到，看到的就是要点的那个窗口；截不到再退回按屏幕区域截。截图、给元素编号、按文字找都是这样（感谢 [@Golden-Pigeon](https://github.com/Golden-Pigeon) 的 PR）。

后台打字同理：先用辅助功能把目标窗口设成它自己的主窗口（不激活应用、不抢前台），按键才有去处；Chromium / Electron 在后台一个按键只收一个字，所以对它们逐字发。后台应用收不到全选、复制、粘贴这类走菜单的 ⌘ 快捷键。

命令行也能单独用：

```bash
dsh-cu winlist                    # 列窗口
dsh-cu tree <pid>                 # AX 树（解锁状态下可用）
dsh-cu observe <pid>              # 截图 + 编号
dsh-cu find "登录"                 # OCR 找文字 → 坐标
dsh-cu clickat <pid> <x> <y>      # 点（默认不动真实鼠标）
dsh-cu type <pid> "你好"           # 输入
dsh-cu selftest                   # 全链路自检（见 tools/selftest.sh）
```

---

## 光标

`cursor/cursor-overlay.swift` 是桌面光标浮层（装到 `~/.dsh/bin/dsh-cursor-overlay`）：NSPanel，不抢前台、点击穿透、永远置顶，闲 60 秒自己退出。

跟 [dsh-chrome-bridge](https://github.com/OrderG-X/dsh-chrome-bridge) 的浏览器光标是**一套样式**，一眼分得清是在哪边干活：

| | 桌面（这个仓库） | 浏览器（dsh-chrome-bridge） |
|---|---|---|
| 箭头 | 同一个形状，实心蓝 | 同一个形状，半透明淡蓝 |
| 名牌 | 显示器图标 + DSH | 地球图标 + DSH |
| 干活时 | 名牌展开成「DSH · 点击 发送」 | 名牌展开成「DSH · 点击 登录」 |

**动效**走克制路线，两边一样：

- 同一个弹簧、同一套算法：沿轻微的弧线滑过去，顺着速度方向轻轻拉长（最多 7%）、略侧倾，名牌晚半拍跟上；到了冲过头最多两三像素再落回
- 点击时以箭头尖端为支点缩一下再弹回（瞄准点纹丝不动），一圈淡波纹
- 拖拽时按住（缩一点 + 尖端一圈光晕）跟着走；滚动时右上角亮一下方向
- 闲 6 秒变淡、名牌收起，不挡视线；系统开了「减少动态效果」就不做动画

浮层指令（往 `$(getconf DARWIN_USER_TEMP_DIR)dsh-cursor.fifo` 写一行，每个账号各自一个）：`show x y` / `move x y` / `click [n]` / `down` / `up` / `scroll ±1` / `label 文字` / `hide` / `ping`。

---

## 已知限制

- **锁屏时**：截图只有壁纸、窗口不渲染、AX 读不到窗口 —— 这是 macOS 的行为，不是工具的问题
- **最小化的窗口、在别的桌面空间（Space）里的窗口**：看不到也操作不了，先把它放回当前桌面
- `desktop_click` 默认投递给目标进程（`postToPid`）。个别应用不响应投递事件，加 `global: true` 走系统事件兜底（会移动真实鼠标）
- **桌面点击驱动不了 Chrome** —— Chrome 不理会投递的合成事件。操作浏览器请用 CDP 类工具（比如 [dsh-chrome-bridge](https://github.com/OrderG-X/dsh-chrome-bridge)）
- 需要**屏幕录制**权限（`screencapture` 用）和**辅助功能**权限（点击、输入、按键、滚动、拖拽用；没开时系统会静默丢掉这些事件，所以工具会直接报错，不会假装成功）

---

## Field notes

[docs/locked-session-and-ax.md](docs/locked-session-and-ax.md) —— 锁屏会让 AX 全废这件事，
以及为什么它看起来跟驱动 bug 一模一样。这个坑花了一整天才确认。

---

## License

MIT。`tools/dsh-cu.swift` 是自包含单文件，想改直接改。

---

## 关于光标形状

光标是**代码画的**（`cursor/cursor-overlay.swift` 里的 `arrowPath`），圆角经典箭头 + 蓝色渐变，跟浏览器那边用同一条路径 —— 不包含任何第三方素材文件。
