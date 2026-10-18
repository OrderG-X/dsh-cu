#!/bin/bash
# dsh-mac-computer-use 一键安装：编译命令行引擎 dsh-cu + 光标浮层（光标是代码画的，不用素材）。
# 装完再去 DSH 的插件页把本仓库的 plugin/ 目录（或仓库地址）加进去。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${DSH_BIN_DIR:-$HOME/.dsh/bin}"
SHARE="${DSH_SHARE_DIR:-$HOME/.dsh/share}"

echo "═══ dsh-mac-computer-use 安装 ═══"
echo "  仓库: $HERE"
echo "  目标: $BIN"
echo

# ── 0. 检查环境 ─────────────────────────────────────────────────────────────
if [ "$(uname)" != "Darwin" ]; then
  echo "❌ 只支持 macOS（用到了 CGWindowList / AXUIElement / Vision）"; exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "❌ 找不到 swiftc。装一下 Xcode Command Line Tools："
  echo "     xcode-select --install"
  exit 1
fi
mkdir -p "$BIN" "$SHARE"

# ── 1. 命令行工具 ───────────────────────────────────────────────────────────
echo "① 编译 dsh-cu …"
swiftc -O -o "$BIN/dsh-cu" "$HERE/tools/dsh-cu.swift" \
  -framework AppKit -framework ApplicationServices -framework Vision
echo "   ✅ $BIN/dsh-cu"

# ── 2. 光标浮层 ─────────────────────────────────────────────────────────────
echo "② 编译光标浮层 …"
swiftc -O -o "$BIN/dsh-cursor-overlay" "$HERE/cursor/cursor-overlay.swift" \
  -framework AppKit -framework QuartzCore
echo "   ✅ $BIN/dsh-cursor-overlay"

# ── 3. PATH ─────────────────────────────────────────────────────────────────
if ! echo "$PATH" | grep -q "$BIN"; then
  echo
  echo "⚠️  $BIN 不在 PATH 里。加到 shell 配置："
  echo "     echo 'export PATH=\"\$HOME/.dsh/bin:\$PATH\"' >> ~/.zshrc"
fi

cat <<EOF

═══ 装完了 ═══

命令行自测：
  $BIN/dsh-cu winlist          # 列窗口
  $BIN/dsh-cu observe <pid>    # 截图标出可点元素
  $HERE/tools/selftest.sh      # 全链路自检

DSH 插件：去「插件」页，把下面任一个加进去
  • 本仓库地址（推荐，能自动更新）
  • 或本地路径 $HERE/plugin

装完重启 DSH。
EOF
