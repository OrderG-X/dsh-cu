#!/bin/bash
# 解锁后跑这个 —— 把「看见 → 找到 → 操作 → 验证」整条链验一遍
#
#   ./selftest.sh              只跑不点（安全）
#   ./selftest.sh --click      额外做一次真实点击（会在计算器上按 7+8=）

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CU="$HERE/dsh-cu"
PASS=0; FAIL=0

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "═══ 0. 屏幕状态 ═══"
LOCK=$(python3 -c "import Quartz;print((Quartz.CGSessionCopyCurrentDictionary() or {}).get('CGSSessionScreenIsLocked'))" 2>/dev/null)
echo "  锁屏: $LOCK"
if [ "$LOCK" = "True" ]; then
  echo "  ⚠️  屏幕锁着 —— 下面的窗口/截图/OCR 都会失败，先解锁再跑"
fi

echo "═══ 1. 窗口枚举（CGWindowList，不需要权限）═══"
WINS=$("$CU" winlist 2>&1)
N=$(echo "$WINS" | grep -c . || true)
if [ "$N" -gt 0 ]; then ok "列出 ${N} 个窗口"; echo "$WINS" | head -4 | sed 's/^/     /'
else bad "一个窗口都没有"; fi

echo "═══ 2. 截图 ═══"
SHOT=/tmp/dsh-cu-selftest.png
"$CU" shot --out "$SHOT" >/dev/null 2>&1
if [ -f "$SHOT" ]; then
  VAR=$(python3 -c "
from PIL import Image; import numpy as np
a=np.array(Image.open('$SHOT').convert('L'))
print(round(float(a.var()),1))
" 2>/dev/null)
  ok "截到图（灰度方差 ${VAR}）"
  # 只有壁纸时方差也会很高，所以用「菜单栏是否纯色」判断有没有窗口
  MENU=$(python3 -c "
from PIL import Image
im=Image.open('$SHOT').convert('RGB'); w,h=im.size; px=im.load()
row=[px[x, int(h*0.01)] for x in range(0,w,max(1,w//40))]
print(len(set(row)))
" 2>/dev/null)
  if [ "${MENU:-0}" -gt 3 ]; then ok "顶部有内容（菜单栏/窗口在渲染）"; else bad "顶部是纯色 —— 可能还是锁屏或没窗口"; fi
else bad "截图失败"; fi

echo "═══ 3. OCR 引擎 ═══"
python3 -c "
from PIL import Image, ImageDraw, ImageFont
f=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',48)
im=Image.new('RGB',(900,120),'white'); ImageDraw.Draw(im).text((30,30),'Continue with Google',fill='black',font=f)
im.save('/tmp/dsh-cu-ocr-selftest.png')
" 2>/dev/null
OCR=$("$CU" find "Google" --file /tmp/dsh-cu-ocr-selftest.png 2>&1 | head -1)
if echo "$OCR" | grep -q "Google"; then ok "OCR 命中：$OCR"; else bad "OCR 没命中：$OCR"; fi

echo "═══ 4. 屏幕 OCR（需要有可见窗口）═══"
if [ "$LOCK" != "True" ]; then
  SCREEN=$("$CU" find "*" --all 2>&1 | head -1)
  if echo "$SCREEN" | grep -q $'\t'; then ok "屏幕上读到文字：$(echo "$SCREEN" | cut -f4 | head -c 40)"; else bad "屏幕上没读到文字"; fi
else
  echo "  ⏭  锁屏，跳过"
fi

echo "═══ 5. 虚拟光标 ═══"
if command -v cua-driver >/dev/null 2>&1; then
  CUR=$(cua-driver call get_agent_cursor_state '{}' 2>&1 | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print('enabled' if d.get('enabled') else 'disabled')
except: print('unavailable')
" 2>/dev/null)
  echo "  cua-driver 虚拟光标: $CUR"
fi

echo "═══ 6. 真实点击（计算器 7+8=15）═══"
if [ "${1:-}" = "--click" ]; then
  if [ "$LOCK" = "True" ]; then
    bad "锁屏状态下没法验证点击结果，先解锁"
  else
    "$CU" launch Calculator >/dev/null 2>&1; sleep 3
    PID=$(pgrep -x Calculator | head -1)
    # winlist 行尾是 "X,Y W×H"，坐标里有空格，所以要取最后两个字段
    RECT=$("$CU" winlist 2>/dev/null | awk -v p="$PID" '$1==p {print $(NF-1)" "$NF; exit}')
    X=$(echo "$RECT" | cut -d' ' -f1 | cut -d, -f1); Y=$(echo "$RECT" | cut -d' ' -f1 | cut -d, -f2)
    W=$(echo "$RECT" | cut -d' ' -f2 | cut -d'×' -f1); H=$(echo "$RECT" | cut -d' ' -f2 | cut -d'×' -f2)
    echo "     计算器 pid=$PID @($X,$Y) ${W}×${H}"
    # 计算器 230×408 的固定布局：AC/7/+/8/=
    click() { "$CU" clickat "$PID" "$((X + $1))" "$((Y + $2))" >/dev/null 2>&1; sleep 0.3; }
    click 90 160; click 40 213; click 190 318; click 90 213; click 190 370
    sleep 1
    "$CU" shot --out /tmp/dsh-cu-calc.png >/dev/null 2>&1
    ANS=$("$CU" find "15" --file /tmp/dsh-cu-calc.png 2>&1 | head -1)
    if echo "$ANS" | grep -q "15"; then ok "计算器显示 15 —— 点击链路通了"; else echo "  ⚠️  截图里没 OCR 到 15，人工看一眼 /tmp/dsh-cu-calc.png（结果：${ANS}）"; fi
    pkill -x Calculator 2>/dev/null
  fi
else
  echo "  ⏭  加 --click 才会做真实点击"
fi

echo
echo "═══ 结果：$PASS 通过 / $FAIL 失败 ═══"
[ "$FAIL" -eq 0 ] && echo "全绿。" || echo "有失败项，看上面。"
