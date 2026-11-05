"""Generates the VisionGuard logo (SVG + PNG) from code so it can be regenerated and tweaked.

Style: angular, wide, chamfered letterforms and a faceted shield mark that echo the Smart Way
identity (brand purple #5E4B9F, amber accent). Requires: pip install shapely pillow
Usage: python tools/brand/build_logo.py   (writes into server/public/brand/)
"""
import os
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

PURPLE, PURPLE_DARK, AMBER, INK = '#5E4B9F', '#3D2F73', '#FFB300', '#0F1B2D'
S = 20  # stroke weight
H = 100  # cap height
CLIP = box(-50, 0, 3000, H)

# glyph: (advance width, [polylines (open) | closed rings])
G = {
    'V': (88, [[(8, -30), (44, 96), (80, -30)]]),
    'I': (20, [[(10, -10), (10, 110)]]),
    'S': (96, [[(86, 10), (26, 10), (10, 26), (10, 34), (26, 50), (70, 50), (86, 66), (86, 74), (70, 90), (10, 90)]]),
    'O': (96, [[(28, 10), (68, 10), (86, 28), (86, 72), (68, 90), (28, 90), (10, 72), (10, 28), (28, 10)]]),
    'N': (88, [[(10, -10), (10, 110)], [(10, 0), (78, 100)], [(78, -10), (78, 110)]]),
    'G': (96, [[(86, 28), (68, 10), (28, 10), (10, 28), (10, 72), (28, 90), (68, 90), (86, 72), (86, 52), (52, 52)]]),
    'U': (88, [[(10, -10), (10, 72), (28, 90), (60, 90), (78, 72), (78, -10)]]),
    'A': (100, [[(4, 120), (50, -14), (96, 120)], [(26, 72), (74, 72)]]),
    'R': (92, [[(10, -10), (10, 110)], [(10, 10), (62, 10), (80, 28), (80, 40), (62, 56), (10, 56)], [(44, 56), (84, 118)]]),
    'D': (96, [[(10, 10), (56, 10), (86, 36), (86, 64), (56, 90), (10, 90), (10, 10)]]),
}
GAP = 16


def shapes_for(text, x0=0):
    parts, x = [], x0
    for ch in text:
        w, lines = G[ch]
        for ln in lines:
            pts = [(px + x, py) for px, py in ln]
            parts.append(LineString(pts).buffer(S / 2, cap_style=2, join_style=2, mitre_limit=4))
        x += w + GAP
    return unary_union(parts).intersection(CLIP), x - GAP


def path_d(geom):
    polys = [geom] if geom.geom_type == 'Polygon' else [g for g in geom.geoms if g.geom_type == 'Polygon']
    d = []
    for p in polys:
        for ring in [p.exterior, *p.interiors]:
            c = list(ring.coords)
            d.append('M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in c[:-1]) + ' Z')
    return ' '.join(d)


# ---- the mark: faceted shield, white V, amber lens ----
MARK_W, MARK_H = 100, 112
SHIELD = [(0, 14), (16, 0), (84, 0), (100, 14), (100, 64), (50, 112), (0, 64)]
V_POLY = [(15, 18), (38, 18), (50, 58), (62, 18), (85, 18), (61, 86), (39, 86)]


def mark_svg(fill=PURPLE, v='#FFFFFF', lens=AMBER, size=None):
    sh = ' '.join(f'{x},{y}' for x, y in SHIELD)
    vv = ' '.join(f'{x},{y}' for x, y in V_POLY)
    attrs = f'width="{size}" height="{size * MARK_H / MARK_W:.0f}"' if size else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {MARK_W} {MARK_H}" {attrs}>'
            f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{fill}"/><stop offset="1" stop-color="{PURPLE_DARK}"/></linearGradient></defs>'
            f'<polygon points="{sh}" fill="url(#g)"/><polygon points="{vv}" fill="{v}"/>'
            f'<circle cx="50" cy="30" r="6" fill="{lens}"/></svg>')


def inner_mark(ox, oy, scale, fill, v, lens):
    sh = ' '.join(f'{ox + x * scale:.1f},{oy + y * scale:.1f}' for x, y in SHIELD)
    vv = ' '.join(f'{ox + x * scale:.1f},{oy + y * scale:.1f}' for x, y in V_POLY)
    return (f'<polygon points="{sh}" fill="{fill}"/><polygon points="{vv}" fill="{v}"/>'
            f'<circle cx="{ox + 50 * scale:.1f}" cy="{oy + 30 * scale:.1f}" r="{6 * scale:.1f}" fill="{lens}"/>')


def lockup(word_fill, mark_fill, v, sub_fill, sub=True):
    wm, wlen = shapes_for('VISIONGUARD')
    scale = 1.18
    mw = MARK_W * scale * 0.72
    pad = 34
    tx = mw + pad
    height = 112 * 0.72 * scale
    # vertically centre the wordmark on the mark
    ty = (height - H * 0.78) / 2 - 4
    width = tx + wlen * 0.78 + 4
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} {height + (14 if sub else 0):.0f}" role="img" aria-label="VisionGuard">',
           inner_mark(0, 0, 0.72 * scale, mark_fill, v, AMBER),
           f'<g transform="translate({tx:.1f} {ty:.1f}) scale(0.78)"><path d="{path_d(wm)}" fill="{word_fill}" fill-rule="evenodd"/></g>']
    if sub:
        svg.append(f'<text x="{tx:.1f}" y="{height + 10:.0f}" font-family="Helvetica,Arial,sans-serif" font-size="9.5" letter-spacing="3.2" fill="{sub_fill}">POWERED BY SMART WAY</text>')
    svg.append('</svg>')
    return ''.join(svg)


def main():
    out = os.path.join(os.path.dirname(__file__), '..', '..', 'server', 'public', 'brand')
    os.makedirs(out, exist_ok=True)
    files = {
        'visionguard-mark.svg': mark_svg(),
        'visionguard-logo.svg': lockup(PURPLE, PURPLE, '#FFFFFF', '#62738C', sub=False),
        'visionguard-logo-dark.svg': lockup('#FFFFFF', '#7B63C9', '#FFFFFF', '#8A9BB5', sub=False),
        'visionguard-logo-powered.svg': lockup(PURPLE, PURPLE, '#FFFFFF', '#62738C', sub=True),
        'visionguard-logo-powered-dark.svg': lockup('#FFFFFF', '#7B63C9', '#FFFFFF', '#8A9BB5', sub=True),
    }
    for name, svg in files.items():
        with open(os.path.join(out, name), 'w') as f:
            f.write(svg)
    print('wrote', ', '.join(files))


if __name__ == '__main__':
    main()
