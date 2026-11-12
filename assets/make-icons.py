#!/usr/bin/env python3
"""Значок приложения «АвтоБаза».

Рисует SVG-исходник (светящаяся «стеклянная» фура на тёмно-синей плитке —
в стиле присланного логотипа) и растеризует его в ресурсы Android
через rsvg-convert.

Запуск:  python3 assets/make-icons.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
PUBLIC = os.path.join(ROOT, "public")

# Тёмно-синяя гамма логотипа
NIGHT = "#030a14"
NAVY = "#0b2540"
NAVY_LIGHT = "#16456b"
CYAN = "#8fe6ff"
ICE = "#eafcff"

# Геометрия фуры в системе координат 1024×1024
BOX = dict(x=150, y=292, w=444, h=288, r=38)
BAR = dict(x=150, y=580, w=726, h=76, r=38)
CAB = (
    "M 594 656 L 594 404 Q 594 366 632 362 L 776 348 Q 808 344 820 374 "
    "L 862 500 L 868 520 L 868 656 Z"
)
WIND = "M 650 470 L 770 454 L 800 534 L 650 534 Z"
WHEEL_A = (330, 694)
WHEEL_B = (716, 694)
WHEEL_R = 60

TRUCK_CENTER = (513, 523)

DEFS = f"""
  <defs>
    <linearGradient id="tile" x1="0.06" y1="0" x2="0.92" y2="1">
      <stop offset="0" stop-color="{NAVY_LIGHT}"/>
      <stop offset="0.46" stop-color="{NAVY}"/>
      <stop offset="1" stop-color="#04101e"/>
    </linearGradient>

    <radialGradient id="tileShine" cx="0.32" cy="0.1" r="0.85">
      <stop offset="0" stop-color="#c7f2ff" stop-opacity="0.26"/>
      <stop offset="1" stop-color="#c7f2ff" stop-opacity="0"/>
    </radialGradient>

    <linearGradient id="sheen" x1="0" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.03"/>
    </linearGradient>

    <linearGradient id="rim" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="0.5" stop-color="#bfefff" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.35"/>
    </linearGradient>

    <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.66"/>
      <stop offset="0.52" stop-color="#e2f8ff" stop-opacity="0.36"/>
      <stop offset="1" stop-color="#9ddefd" stop-opacity="0.24"/>
    </linearGradient>

    <linearGradient id="glassCab" x1="0.1" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.78"/>
      <stop offset="0.6" stop-color="#e6faff" stop-opacity="0.44"/>
      <stop offset="1" stop-color="#8fd6fa" stop-opacity="0.3"/>
    </linearGradient>

    <linearGradient id="wind" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.92"/>
      <stop offset="1" stop-color="#3f9ec9" stop-opacity="0.42"/>
    </linearGradient>

    <radialGradient id="ground" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#01060d" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#01060d" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="night" cx="0.5" cy="0.46" r="0.72">
      <stop offset="0" stop-color="#123454"/>
      <stop offset="0.55" stop-color="#08192c"/>
      <stop offset="1" stop-color="{NIGHT}"/>
    </radialGradient>

    <filter id="soft" x="-45%" y="-45%" width="190%" height="190%">
      <feGaussianBlur stdDeviation="26"/>
    </filter>

    <filter id="softer" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="52"/>
    </filter>

    <clipPath id="squareClip"><rect width="1024" height="1024" rx="236"/></clipPath>
    <clipPath id="circleClip"><circle cx="512" cy="512" r="512"/></clipPath>
    <clipPath id="boxClip">
      <rect x="{BOX['x']}" y="{BOX['y']}" width="{BOX['w']}" height="{BOX['h']}" rx="{BOX['r']}"/>
    </clipPath>
  </defs>
"""


def halo() -> str:
    """Мягкое свечение вокруг фуры — без него значки не «светятся»."""
    return f"""
    <g fill="{CYAN}" opacity="0.7" filter="url(#soft)">
      <rect x="{BOX['x']}" y="{BOX['y']}" width="{BOX['w']}" height="{BOX['h']}" rx="{BOX['r']}"/>
      <rect x="{BAR['x']}" y="{BAR['y']}" width="{BAR['w']}" height="{BAR['h']}" rx="{BAR['r']}"/>
      <path d="{CAB}"/>
      <circle cx="{WHEEL_A[0]}" cy="{WHEEL_A[1]}" r="{WHEEL_R}"/>
      <circle cx="{WHEEL_B[0]}" cy="{WHEEL_B[1]}" r="{WHEEL_R}"/>
    </g>
"""


def wheel(cx: int, cy: int) -> str:
    return f"""
      <circle cx="{cx}" cy="{cy}" r="{WHEEL_R}" fill="url(#glass)" stroke="{ICE}" stroke-opacity="0.9" stroke-width="7"/>
      <circle cx="{cx}" cy="{cy}" r="27" fill="#061422"/>
      <circle cx="{cx}" cy="{cy}" r="27" fill="none" stroke="{ICE}" stroke-opacity="0.55" stroke-width="5"/>
"""


def truck(glow: bool = True) -> str:
    """Фура: прицеп слева, кабина справа — всё из «стекла» с подсветкой."""
    return f"""
  <g>
{halo() if glow else ''}
    <ellipse cx="512" cy="782" rx="356" ry="30" fill="url(#ground)"/>

    <!-- Колёса (верх прячется за рамой) -->
{wheel(*WHEEL_A)}
{wheel(*WHEEL_B)}

    <!-- Рама -->
    <rect x="{BAR['x']}" y="{BAR['y']}" width="{BAR['w']}" height="{BAR['h']}" rx="{BAR['r']}"
          fill="url(#glass)" stroke="{ICE}" stroke-opacity="0.85" stroke-width="8"/>

    <!-- Прицеп -->
    <rect x="{BOX['x']}" y="{BOX['y']}" width="{BOX['w']}" height="{BOX['h']}" rx="{BOX['r']}"
          fill="url(#glass)" stroke="{ICE}" stroke-opacity="0.9" stroke-width="9"/>
    <g clip-path="url(#boxClip)">
      <polygon points="320,292 470,292 244,580 96,580" fill="url(#sheen)"/>
      <rect x="430" y="316" width="6" height="240" fill="#ffffff" fill-opacity="0.22"/>
    </g>

    <!-- Кабина -->
    <path d="{CAB}" fill="url(#glassCab)" stroke="{ICE}" stroke-opacity="0.9"
          stroke-width="9" stroke-linejoin="round"/>
    <path d="{WIND}" fill="url(#wind)" stroke="{ICE}" stroke-opacity="0.6"
          stroke-width="5" stroke-linejoin="round"/>
  </g>
"""


def tile() -> str:
    """Стеклянная плитка: фон значка для квадратной версии."""
    return f"""
  <g clip-path="url(#squareClip)">
    <rect width="1024" height="1024" fill="url(#tile)"/>
    <rect width="1024" height="1024" fill="url(#tileShine)"/>
    <polygon points="1024,0 1024,560 560,0" fill="#ffffff" fill-opacity="0.05"/>
    <polygon points="1024,0 1024,214 268,1024 0,1024 0,806" fill="url(#sheen)" fill-opacity="0.45"/>
    <rect x="6" y="6" width="1012" height="1012" rx="232" fill="none"
          stroke="url(#rim)" stroke-width="12"/>
  </g>
"""


def svg_square() -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
        + DEFS
        + f"""
  <g>
    <rect width="1024" height="1024" fill="url(#night)"/>
    <rect x="152" y="152" width="720" height="720" rx="176" fill="{CYAN}"
          opacity="0.55" filter="url(#softer)"/>
"""
        + tile()
        + truck()
        + """
  </g>
</svg>
"""
    )


def svg_round() -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
        + DEFS
        + f"""
  <g clip-path="url(#circleClip)">
    <rect width="1024" height="1024" fill="url(#night)"/>
    <rect width="1024" height="1024" fill="url(#tileShine)"/>
"""
        + truck()
        + """
  </g>
</svg>
"""
    )


def svg_foreground(scale: float = 0.070, size: int = 432) -> str:
    """Передний слой адаптивного значка: фура в безопасной зоне (108×108)."""
    cx, cy = TRUCK_CENTER
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 108 108">'
        + DEFS
        + f"""
  <g transform="translate(54 54) scale({scale}) translate({-cx} {-cy})">
"""
        + truck()
        + """
  </g>
</svg>
"""
    )


def svg_splash_icon(scale: float = 0.40) -> str:
    """Логотип для системной заставки Android 12+ (круглая обрезка)."""
    cx, cy = TRUCK_CENTER
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">'
        + DEFS
        + f"""
  <g transform="translate(256 256) scale({scale}) translate({-cx} {-cy})">
"""
        + truck()
        + """
  </g>
</svg>
"""
    )


def render(svg: str, svg_path: str, png_path: str, size: int) -> None:
    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    with open(svg_path, "w", encoding="utf-8") as fh:
        fh.write(svg)
    subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size), svg_path, "-o", png_path],
        check=True,
    )


def render_to(svg_text: str, tmp_name: str, png_path: str, size: int) -> None:
    tmp = os.path.join(ASSETS, tmp_name)
    render(svg_text, tmp, png_path, size)


def main() -> int:
    if not shutil.which("rsvg-convert"):
        print("Нужен rsvg-convert (librsvg2-bin)", file=sys.stderr)
        return 1

    os.makedirs(ASSETS, exist_ok=True)

    square = svg_square()
    circle = svg_round()
    fg = svg_foreground()
    splash_icon = svg_splash_icon()

    # Исходники остаются в репозитории — их удобно править
    for name, text in [
        ("icon.svg", square),
        ("icon-round.svg", circle),
        ("icon-foreground.svg", fg),
        ("splash-icon.svg", splash_icon),
    ]:
        with open(os.path.join(ASSETS, name), "w", encoding="utf-8") as fh:
            fh.write(text)

    # Квадратный и круглый значок для старых версий Android
    for density, size in [
        ("mdpi", 48),
        ("hdpi", 72),
        ("xhdpi", 96),
        ("xxhdpi", 144),
        ("xxxhdpi", 192),
    ]:
        render_to(square, "icon.svg", os.path.join(RES, f"mipmap-{density}", "ic_launcher.png"), size)
        render_to(circle, "icon-round.svg", os.path.join(RES, f"mipmap-{density}", "ic_launcher_round.png"), size)

    # Передний слой адаптивного значка
    for density, size in [
        ("mdpi", 108),
        ("hdpi", 162),
        ("xhdpi", 216),
        ("xxhdpi", 324),
        ("xxxhdpi", 432),
    ]:
        render_to(fg, "icon-foreground.svg", os.path.join(RES, f"mipmap-{density}", "ic_launcher_foreground.png"), size)

    # Логотип заставки
    render_to(splash_icon, "splash-icon.svg", os.path.join(RES, "drawable", "splash_icon.png"), 512)

    # Значок для браузера
    os.makedirs(PUBLIC, exist_ok=True)
    with open(os.path.join(PUBLIC, "icon.svg"), "w", encoding="utf-8") as fh:
        fh.write(square)
    render_to(square, "icon.svg", os.path.join(PUBLIC, "icon.png"), 192)

    print("Значки обновлены")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
