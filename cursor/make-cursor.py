#!/usr/bin/env python3
"""
生成光标素材 —— 不需要任何第三方版权资源，纯程序绘制。

产出（都在 ~/.dsh/share/）：
  dsh-cursor-solid.png    实心蓝，桌面浮层用
  dsh-cursor-fog.png      半透明蓝，网页页内用
  cursor-frames/f00..f23  24 帧流动渐变，"活着"的感觉
  lens/                   45 帧旋转球（"工作中"指示器）

形状是经典 macOS 箭头几何（尖端在左上），配色是蓝色渐变。
想换成别的颜色改 BLUE / STOPS 就行。
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFilter
import numpy as np

OUT = os.environ.get("DSH_SHARE_DIR") or os.path.expanduser("~/.dsh/share")
W, H = 300, 300            # 箭头画布（正方形，尖端在左上角）

# 经典 macOS 箭头（x, y），坐标系原点在左上
ARROW = [(0, 0), (0, 16.6), (4.4, 12.0), (7.9, 19.8), (11.0, 18.2), (7.6, 10.6), (12.8, 10.6)]

# 蓝色渐变带：暗 → 亮（阴影 → 主蓝 → 高光）
STOPS = np.array([
    [26, 70, 200],
    [46, 110, 255],
    [120, 170, 255],
    [235, 243, 255],
], np.float32)
POS = np.array([0.0, 0.45, 0.78, 1.0], np.float32)


def arrow_mask(size=W):
    """画箭头，返回 alpha 蒙版（0-255）"""
    S = size / 21.0                      # 箭头高约 20 个单位
    img = Image.new("L", (size, size), 0)
    ImageDraw.Draw(img).polygon([(x * S + size * 0.02, y * S + size * 0.02) for x, y in ARROW], fill=255)
    return img


def shade(mask):
    """把蒙版做成"有体积感"的蓝色渐变：用距离变换当明暗骨架"""
    m = np.array(mask).astype(np.float32) / 255.0
    # 用高斯模糊当"离边缘的距离"，越靠中心越亮 —— 制造圆润的体积感
    blur = np.array(mask.filter(ImageFilter.GaussianBlur(28))).astype(np.float32) / 255.0
    lum = np.clip(blur * 1.25, 0, 1)
    rgb = np.zeros((mask.height, mask.width, 3), np.float32)
    for c in range(3):
        rgb[:, :, c] = np.interp(lum, POS, STOPS[:, c])
    return rgb, m


def make(mask, alpha_scale=1.0):
    rgb, m = shade(mask)
    out = np.dstack([rgb, m * 255 * alpha_scale]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def main():
    os.makedirs(OUT, exist_ok=True)
    mask = arrow_mask()

    solid = make(mask, 1.0)
    solid.save(os.path.join(OUT, "dsh-cursor-solid.png"))
    make(mask, 0.72).save(os.path.join(OUT, "dsh-cursor-fog.png"))
    print("✅ dsh-cursor-solid.png / dsh-cursor-fog.png")

    # 流动渐变帧：色带沿"尖端→尾部"方向缓慢平移
    frames_dir = os.path.join(OUT, "cursor-frames")
    os.makedirs(frames_dir, exist_ok=True)
    for f in os.listdir(frames_dir):
        if f.endswith(".png"):
            os.remove(os.path.join(frames_dir, f))

    m = np.array(mask).astype(np.float32) / 255.0
    blur = np.array(mask.filter(ImageFilter.GaussianBlur(28))).astype(np.float32) / 255.0
    yy, xx = np.mgrid[0:W, 0:H]
    axis = (xx / W * 0.55 + yy / H * 0.45)
    sel = m > 0.1
    axis = (axis - axis[sel].min()) / max(axis[sel].max() - axis[sel].min(), 1e-6)

    N = 24
    for i in range(N):
        t = (axis * 0.75 + np.clip(blur * 1.25, 0, 1) * 0.25 + i / N) % 1.0
        rgb = np.zeros((W, H, 3), np.float32)
        for c in range(3):
            rgb[:, :, c] = np.interp(t, POS, STOPS[:, c])
        Image.fromarray(np.dstack([rgb, m * 255]).astype(np.uint8), "RGBA").save(
            os.path.join(frames_dir, f"f{i:02d}.png"))
    print(f"✅ cursor-frames/  {N} 帧")


if __name__ == "__main__":
    try:
        import PIL  # noqa
    except ImportError:
        sys.exit("需要 Pillow：python3 -m pip install pillow numpy")
    main()
