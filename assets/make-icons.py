#!/usr/bin/env python3
"""Значок приложения «АвтоБаза».

Рисует SVG-исходник («стеклянная» фура на бирюзовом градиенте)
и растеризует его в ресурсы Android через rsvg-convert.

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

BRAND_DEEP = "#07404e"
BRAND = "#0a6a7d"
BRAND_LIGHT = "#14a6bd"
ACCENT = "#f0b654"

DEFS = f"""
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{BRAND_LIGHT}"/>
      <stop offset="0.52" stop-color="{BRAND}"/>
      <stop offset="1" stop-color="{BRAND_DEEP}"/>
    </linearGradient>

    <radialGradient id="glow" cx="0.24" cy="0.12" r="0.72">
      <stop offset="0" stop-color="#b6f4ff" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#b6f4ff" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="groundshadow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#04202b" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#04202b" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="lampglow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="{ACCENT}" stop-opacity="0.75"/>
      <stop offset="1" stop-color="{ACCENT}" stop-opacity="0"/>
    </radialGradient>

    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.38"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.2"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.12"/>
    </linearGradient>

    <linearGradient id="bodycab" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.46"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.16"/>
    </linearGradient>

    <linearGradient id="sweep" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.02"/>
    </linearGradient>

    <linearGradient id="windscreen" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#d9fbff" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#062b36" stop-opacity="0.42"/>
    </linearGradient>

    <clipPath id="trailerClip">
      <rect x="168" y="356" width="436" height="266" rx="28"/>
    </clipPath>

    <clipPath id="squareClip"><rect width="1024" height="1024" rx="236"/></clipPath>
    <clipPath id="circleClip"><circle cx="512" cy="512" r="512"/></clipPath>
  </defs>
"""

# Фура: прицеп слева (это корма), кабина справа. Каждый узел — «стеклянная» панель.
TRUCK = f"""
  <g>
    <ellipse cx="524" cy="774" rx="368" ry="42" fill="url(#groundshadow)"/>

    <!-- Колёса -->
    <g>
      <circle cx="264" cy="682" r="54" fill="#04202a" stroke="#d8fbff" stroke-opacity="0.5" stroke-width="6"/>
      <circle cx="264" cy="682" r="23" fill="none" stroke="#d8fbff" stroke-opacity="0.32" stroke-width="5"/>
      <circle cx="386" cy="682" r="54" fill="#04202a" stroke="#d8fbff" stroke-opacity="0.5" stroke-width="6"/>
      <circle cx="386" cy="682" r="23" fill="none" stroke="#d8fbff" stroke-opacity="0.32" stroke-width="5"/>
      <circle cx="700" cy="682" r="54" fill="#04202a" stroke="#d8fbff" stroke-opacity="0.5" stroke-width="6"/>
      <circle cx="700" cy="682" r="23" fill="none" stroke="#d8fbff" stroke-opacity="0.32" stroke-width="5"/>
      <circle cx="822" cy="682" r="54" fill="#04202a" stroke="#d8fbff" stroke-opacity="0.5" stroke-width="6"/>
      <circle cx="822" cy="682" r="23" fill="none" stroke="#d8fbff" stroke-opacity="0.32" stroke-width="5"/>
    </g>

    <!-- Рама -->
    <rect x="176" y="600" width="664" height="44" rx="20" fill="#04202a" fill-opacity="0.55"/>

    <!-- Прицеп -->
    <rect x="168" y="356" width="436" height="266" rx="28"
          fill="url(#body)" stroke="#e6fdff" stroke-opacity="0.72" stroke-width="7"/>
    <g clip-path="url(#trailerClip)">
      <polygon points="248,356 372,356 186,622 62,622" fill="url(#sweep)"/>
      <rect x="308" y="372" width="5" height="236" fill="#ffffff" fill-opacity="0.16"/>
      <rect x="452" y="372" width="5" height="236" fill="#ffffff" fill-opacity="0.16"/>
    </g>

    <!-- Кабина -->
    <path d="M 616 622 L 616 450 Q 616 412 656 405 L 764 388 Q 818 381 833 421 L 860 505 L 868 505 L 868 622 Z"
          fill="url(#bodycab)" stroke="#e6fdff" stroke-opacity="0.72" stroke-width="7"
          stroke-linejoin="round"/>
    <path d="M 668 462 L 762 446 L 790 508 L 668 508 Z"
          fill="url(#windscreen)" stroke="#e6fdff" stroke-opacity="0.45" stroke-width="4"
          stroke-linejoin="round"/>

    <!-- Фара -->
    <circle cx="858" cy="562" r="46" fill="url(#lampglow)"/>
    <circle cx="858" cy="562" r="14" fill="#ffe3ab"/>

    <!-- Линии скорости -->
    <g fill="#ffffff">
      <rect x="54" y="450" width="78" height="14" rx="7" fill-opacity="0.3"/>
      <rect x="34" y="520" width="98" height="14" rx="7" fill-opacity="0.22"/>
      <rect x="62" y="590" width="64" height="14" rx="7" fill-opacity="0.16"/>
    </g>
  </g>
"""


def svg_square() -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
        + DEFS
        + """
  <g clip-path="url(#squareClip)">
    <rect width="1024" height="1024" fill="url(#bg)"/>
    <rect width="1024" height="1024" fill="url(#glow)"/>
"""
        + TRUCK
        + """
  </g>
</svg>
"""
    )


def svg_round() -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
        + DEFS
        + """
  <g clip-path="url(#circleClip)">
    <rect width="1024" height="1024" fill="url(#bg)"/>
    <rect width="1024" height="1024" fill="url(#glow)"/>
"""
        + TRUCK
        + """
  </g>
</svg>
"""
    )


def svg_foreground() -> str:
    """Передний слой адаптивного значка: 108x108, фура в безопасной зоне."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432" viewBox="0 0 108 108">'
        + DEFS
        + """
  <g transform="translate(54 54) scale(0.066) translate(-500 -548)">
"""
        + TRUCK
        + """
  </g>
</svg>
"""
    )


def svg_splash_icon() -> str:
    """Логотип для системной заставки Android 12+ (круглая обрезка)."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">'
        + DEFS
        + """
  <g transform="translate(256 256) scale(0.48) translate(-500 -548)">
"""
        + TRUCK
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
    with open(os.path.join(ASSETS, "icon.svg"), "w", encoding="utf-8") as fh:
        fh.write(square)
    with open(os.path.join(ASSETS, "icon-round.svg"), "w", encoding="utf-8") as fh:
        fh.write(circle)
    with open(os.path.join(ASSETS, "icon-foreground.svg"), "w", encoding="utf-8") as fh:
        fh.write(fg)
    with open(os.path.join(ASSETS, "splash-icon.svg"), "w", encoding="utf-8") as fh:
        fh.write(splash_icon)

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
