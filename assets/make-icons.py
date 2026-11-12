#!/usr/bin/env python3
"""Значок приложения «АвтоБаза» по присланному логотипу.

Исходник — растровый логотип `assets/logo-source.png`: тёмная плитка
со светящейся «стеклянной» фурой (тот рисунок, что прислал пользователь).
Скрипт вырезает из него нужные области и собирает ресурсы Android
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

# Исходник лежит рядом со скриптом — на него ссылаются SVG-файлы
SOURCE = "logo-source.png"
SRC_W, SRC_H = 1024, 572

# Плитка с фурой внутри исходника (границы измерены по яркости пикселей)
TILE_X, TILE_Y, TILE_SIZE = 293.0, 68.0, 437.0
CENTER_X = TILE_X + TILE_SIZE / 2
CENTER_Y = TILE_Y + TILE_SIZE / 2

# Квадратный значок: плитка и небольшое поле вокруг неё
ICON_MARGIN = 24.0
ICON_SIDE = TILE_SIZE + ICON_MARGIN * 2

PNG_DENSITIES = [
    ("mdpi", 48),
    ("hdpi", 72),
    ("xhdpi", 96),
    ("xxhdpi", 144),
    ("xxxhdpi", 192),
]

FG_DENSITIES = [
    ("mdpi", 108),
    ("hdpi", 162),
    ("xhdpi", 216),
    ("xxhdpi", 324),
    ("xxxhdpi", 432),
]


def image_tag() -> str:
    return f'<image x="0" y="0" width="{SRC_W}" height="{SRC_H}" xlink:href="{SOURCE}"/>'


def svg_doc(view: tuple[float, float, float, float], size: int, prefix: str = "", suffix: str = "") -> str:
    """SVG-обёртка: показывает вырезанную из исходника область."""
    x, y, w, h = view
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{size}" height="{size}" viewBox="{x} {y} {w} {h}">' + prefix + image_tag() + suffix + "</svg>"
    )


def square_view() -> tuple[float, float, float, float]:
    return (CENTER_X - ICON_SIDE / 2, CENTER_Y - ICON_SIDE / 2, ICON_SIDE, ICON_SIDE)


def full_view() -> tuple[float, float, float, float]:
    """Максимальный квадрат исходника — для переднего слоя адаптивного значка."""
    side = float(SRC_H)
    return (CENTER_X - side / 2, CENTER_Y - side / 2, side, side)


def round_clip() -> tuple[str, str]:
    radius = ICON_SIDE / 2
    return (
        '<defs><clipPath id="round">'
        f'<circle cx="{CENTER_X}" cy="{CENTER_Y}" r="{radius}"/>'
        "</clipPath></defs>"
        '<g clip-path="url(#round)">',
        "</g>",
    )


def render(svg_text: str, svg_name: str, png_path: str, size: int) -> None:
    svg_path = os.path.join(ASSETS, svg_name)
    with open(svg_path, "w", encoding="utf-8") as fh:
        fh.write(svg_text)
    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size), svg_path, "-o", png_path],
        check=True,
        cwd=ASSETS,
    )


def main() -> int:
    if not shutil.which("rsvg-convert"):
        print("Нужен rsvg-convert (librsvg2-bin)", file=sys.stderr)
        return 1

    if not os.path.exists(os.path.join(ASSETS, SOURCE)):
        print(f"Нет исходника {SOURCE} в папке assets", file=sys.stderr)
        return 1

    prefix, suffix = round_clip()
    square = svg_doc(square_view(), 1024)
    circle = svg_doc(square_view(), 1024, prefix, suffix)
    foreground = svg_doc(full_view(), 108)

    # Исходники остаются в репозитории — по ним видно, откуда взялся значок
    for name, text in [
        ("icon.svg", square),
        ("icon-round.svg", circle),
        ("icon-foreground.svg", foreground),
        ("splash-icon.svg", circle),
    ]:
        with open(os.path.join(ASSETS, name), "w", encoding="utf-8") as fh:
            fh.write(text)

    # Квадратный и круглый значок для старых версий Android
    for density, size in PNG_DENSITIES:
        render(square, "icon.svg", os.path.join(RES, f"mipmap-{density}", "ic_launcher.png"), size)
        render(circle, "icon-round.svg", os.path.join(RES, f"mipmap-{density}", "ic_launcher_round.png"), size)

    # Передний слой адаптивного значка (108×108 дип)
    for density, size in FG_DENSITIES:
        render(
            foreground,
            "icon-foreground.svg",
            os.path.join(RES, f"mipmap-{density}", "ic_launcher_foreground.png"),
            size,
        )

    # Логотип системной заставки
    render(circle, "splash-icon.svg", os.path.join(RES, "drawable", "splash_icon.png"), 512)

    # Значок для браузера (вкладка и «на главный экран»)
    os.makedirs(PUBLIC, exist_ok=True)
    render(square, "icon.svg", os.path.join(PUBLIC, "icon.png"), 192)

    print("Значки обновлены по логотипу", SOURCE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
