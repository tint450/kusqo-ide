#!/usr/bin/env python3
"""Generates the KUSQO IDE brand assets (icons, installer images) from the same
hexagon mark used on kusqo.com (KusqoMark in apps/web/src/app/page.tsx).

Run from the vscodium directory:  python kusqo-branding/make_assets.py
Requires Pillow. Outputs are committed; this script is the source of truth.
"""
import io
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
RES = os.path.join(ROOT, 'src', 'stable', 'resources')

BG = (11, 11, 20)  # #0b0b14 — the panel colour on kusqo.com
BG_DEEP = (6, 6, 12)  # #06060c — the page colour
STOPS = [(0.0, (129, 140, 248)), (0.55, (192, 132, 252)), (1.0, (244, 114, 182))]  # #818cf8 → #c084fc → #f472b6

HEX_OUTER = [(24, 4), (41, 14), (41, 34), (24, 44), (7, 34), (7, 14)]
HEX_INNER = [(24, 11), (34, 17.5), (34, 30.5), (24, 37), (14, 30.5), (14, 17.5)]
K_STROKES = [((18, 15), (18, 33)), ((18, 24), (28, 15)), ((18, 24), (28, 33))]


def gradient(size):
    """Diagonal brand gradient, top-left to bottom-right."""
    g = Image.new('RGB', (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
                if t0 <= t <= t1:
                    f = (t - t0) / (t1 - t0)
                    px[x, y] = tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))
                    break
    return g


def mark(size, ss=4):
    """The KUSQO mark as an RGBA image with a transparent background."""
    big = size * ss
    k = big / 48
    pts = lambda poly: [(x * k, y * k) for x, y in poly]
    stroke = Image.new('L', (big, big), 0)
    d = ImageDraw.Draw(stroke)
    outer = pts(HEX_OUTER)
    d.line(outer + [outer[0]], fill=255, width=round(2.5 * k), joint='curve')
    for p in outer:
        r = 2.5 * k / 2
        d.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=255)
    for a, b in K_STROKES:
        a, b = (a[0] * k, a[1] * k), (b[0] * k, b[1] * k)
        d.line([a, b], fill=255, width=round(3 * k))
        r = 3 * k / 2
        for p in (a, b):
            d.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=255)
    fill = Image.new('L', (big, big), 0)
    ImageDraw.Draw(fill).polygon(pts(HEX_INNER), fill=round(255 * 0.15))
    mask = Image.composite(Image.new('L', (big, big), 255), fill, stroke)
    out = gradient(big).convert('RGBA')
    out.putalpha(mask)
    return out.resize((size, size), Image.LANCZOS)


def app_icon(size, pad=0.17, radius=0.22):
    """Dark rounded square with the mark and a faint brand glow — the app icon."""
    ss = 3
    big = size * ss
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    plate = Image.new('RGBA', (big, big), BG + (255,))
    glow = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((big * 0.1, big * -0.2, big * 0.9, big * 0.5), fill=(99, 102, 241, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(big * 0.12))
    plate = Image.alpha_composite(plate, glow)
    m = Image.new('L', (big, big), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, big - 1, big - 1), radius=round(big * radius), fill=255)
    img.paste(plate, (0, 0), m)
    inner = round(big * (1 - 2 * pad))
    glyph = mark(inner)
    img.alpha_composite(glyph, (round(big * pad), round(big * pad)))
    return img.resize((size, size), Image.LANCZOS)


def save(img, *path, **kw):
    target = os.path.join(RES, *path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    img.save(target, **kw)
    print('wrote', os.path.relpath(target, ROOT))


def font(size):
    for name in ('segoeuib.ttf', 'arialbd.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def installer_big(w, h):
    img = Image.new('RGB', (w, h), BG_DEEP)
    d = ImageDraw.Draw(img)
    glow = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((-w * 0.4, -h * 0.1, w * 1.4, h * 0.45), fill=(99, 102, 241, 60))
    glow = glow.filter(ImageFilter.GaussianBlur(w * 0.2))
    img = Image.alpha_composite(img.convert('RGBA'), glow).convert('RGB')
    d = ImageDraw.Draw(img)
    s = round(w * 0.62)
    img.paste(mark(s), ((w - s) // 2, round(h * 0.16)), mark(s))
    f = font(round(w * 0.15))
    text = 'KUSQO'
    tw = d.textlength(text, font=f)
    d.text(((w - tw) / 2, round(h * 0.16) + s + round(h * 0.03)), text, font=f, fill=(228, 228, 231))
    f2 = font(round(w * 0.075))
    sub = 'build verified.'
    sw = d.textlength(sub, font=f2)
    d.text(((w - sw) / 2, h - round(h * 0.09)), sub, font=f2, fill=(129, 140, 248))
    return img


def installer_small(w, h):
    img = Image.new('RGB', (w, h), BG)
    s = round(min(w, h) * 0.8)
    m = mark(s)
    img.paste(m, ((w - s) // 2, (h - s) // 2), m)
    return img


def xpm(img, name='kusqo'):
    q = img.convert('RGB').quantize(colors=48, method=Image.MEDIANCUT)
    pal = q.getpalette()[: 48 * 3]
    syms = [chr(33 + i) for i in range(48) if chr(33 + i) not in '"\\']
    lines = ['/* XPM */', f'static char *{name}[] = {{', f'"{q.width} {q.height} {len(syms)} 1",']
    for i, s in enumerate(syms):
        r, g, b = pal[i * 3: i * 3 + 3]
        lines.append(f'"{s} c #{r:02x}{g:02x}{b:02x}",')
    px = q.load()
    for y in range(q.height):
        lines.append('"' + ''.join(syms[min(px[x, y], len(syms) - 1)] for x in range(q.width)) + '",')
    lines[-1] = lines[-1].rstrip(',')
    return '\n'.join(lines) + '\n};\n'


def svg(background):
    grad = ('<defs><linearGradient id="kq" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">'
            '<stop offset="0%" stop-color="#818cf8"/><stop offset="55%" stop-color="#c084fc"/>'
            '<stop offset="100%" stop-color="#f472b6"/></linearGradient></defs>')
    hexo = ' '.join(f'{x},{y}' for x, y in HEX_OUTER)
    hexi = ' '.join(f'{x},{y}' for x, y in HEX_INNER)
    glyph = ''.join([
      f'<polygon points="{hexo}" fill="none" stroke="url(#kq)" stroke-width="2.5" stroke-linejoin="round"/>',
      f'<polygon points="{hexi}" fill="url(#kq)" opacity="0.15"/>',
      '<path d="M18 15v18M18 24l10-9M18 24l10 9" stroke="url(#kq)" stroke-width="3" '
      'stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    ])
    if background:
        body = f'<rect width="48" height="48" rx="10.5" fill="#0b0b14"/><g transform="translate(6 6) scale(0.75)">{glyph}</g>'
    else:
        body = glyph
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 48 48" fill="none">{grad}{body}</svg>'


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    print('wrote', os.path.relpath(path, ROOT))


def main():
    icon = app_icon(1024)
    # Windows
    ico_sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    save(icon, 'win32', 'code.ico', format='ICO', sizes=[(s, s) for s in ico_sizes])
    save(app_icon(150, pad=0.12, radius=0.0), 'win32', 'code_150x150.png')
    save(app_icon(70, pad=0.12, radius=0.0), 'win32', 'code_70x70.png')
    scales = {'100': (164, 314, 55, 55), '125': (192, 386, 64, 68), '150': (246, 459, 83, 80),
              '175': (273, 556, 92, 97), '200': (328, 604, 110, 106), '225': (355, 700, 119, 123),
              '250': (410, 797, 138, 140)}
    for sc, (bw, bh, sw, sh) in scales.items():
        save(installer_big(bw, bh), 'win32', f'inno-big-{sc}.bmp')
        save(installer_small(sw, sh), 'win32', f'inno-small-{sc}.bmp')
    # Linux
    save(icon, 'linux', 'code.png')
    write_text(os.path.join(RES, 'linux', 'code.svg'), svg(True))
    write_text(os.path.join(RES, 'linux', 'rpm', 'code.xpm'), xpm(icon.resize((64, 64), Image.LANCZOS).convert('RGBA').convert('RGB')))
    # Server / web
    save(app_icon(192), 'server', 'code-192.png')
    save(app_icon(512), 'server', 'code-512.png')
    save(icon, 'server', 'favicon.ico', format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
    # macOS
    save(icon, 'darwin', 'code.icns', format='ICNS')
    # icon sources used by icons/build_icons.sh
    for q in ('stable', 'insider'):
        base = os.path.join(ROOT, 'icons', q)
        write_text(os.path.join(base, 'codium_cnl.svg'), svg(True))
        write_text(os.path.join(base, 'codium_cnl_w80_b8.svg'), svg(True))
        write_text(os.path.join(base, 'codium_clt.svg'), svg(False))
    # extension assets
    ext = os.path.abspath(os.path.join(ROOT, '..', 'ide-extension', 'media'))
    os.makedirs(ext, exist_ok=True)
    app_icon(128).save(os.path.join(ext, 'icon.png'))
    print('wrote ide-extension/media/icon.png')


if __name__ == '__main__':
    main()
