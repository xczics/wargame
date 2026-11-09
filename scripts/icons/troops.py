# Generates web/plugins/starter-icons/sprites-32.ts: the 32 x 32 sprites of the troops (a sprite per tier of each
# family: user 2026-11-04 "每级士兵的图标都要不一样") and of the NPC camps (fortresses and outposts by level: "要塞和据点
# 用不同的图标，根据等级还有细微的区别。高等级的要一看就'高级'"). Each is drawn from shapes in colours that name a part
# (helmet, armour, shield...), outlined, then given its tier's colours and pieces (plumes, capes, banners, gold).
# Run: python3 scripts/icons/troops.py [--preview <dir>]   (the preview needs Pillow)
import sys
from pathlib import Path

W = H = 32
O = '#2a1d18'


class Canvas:
    def __init__(self):
        self.px = [[None] * W for _ in range(H)]

    def set(self, x, y, c):
        if 0 <= x < W and 0 <= y < H and c is not None:
            self.px[y][x] = c

    def get(self, x, y):
        return self.px[y][x] if 0 <= x < W and 0 <= y < H else None

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, c)

    def ellipse(self, cx, cy, rx, ry, c):
        for y in range(H):
            for x in range(W):
                if ((x - cx) / (rx + 0.5)) ** 2 + ((y - cy) / (ry + 0.5)) ** 2 <= 1:
                    self.set(x, y, c)

    def line(self, x0, y0, x1, y1, c, width=1):
        n = max(abs(x1 - x0), abs(y1 - y0), 1)
        for i in range(n + 1):
            x = round(x0 + (x1 - x0) * i / n)
            y = round(y0 + (y1 - y0) * i / n)
            for dx in range(width):
                self.set(x + dx, y, c)

    def poly(self, pts, c):
        ys = [p[1] for p in pts]
        for y in range(min(ys), max(ys) + 1):
            xs = []
            for i in range(len(pts)):
                (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % len(pts)]
                if y0 == y1:
                    continue
                if min(y0, y1) <= y + 0.5 < max(y0, y1):
                    xs.append(x0 + (y + 0.5 - y0) * (x1 - x0) / (y1 - y0))
            xs.sort()
            for a, b in zip(xs[::2], xs[1::2]):
                for x in range(round(a), round(b)):
                    self.set(x, y, c)

    def pixels(self, pts, c):
        for x, y in pts:
            self.set(x, y, c)

    def outline(self, c='o'):
        add = []
        for y in range(H):
            for x in range(W):
                if self.px[y][x] is None and any(
                    self.get(x + dx, y + dy) not in (None, c) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                ):
                    add.append((x, y))
        for x, y in add:
            self.px[y][x] = c

    def rows(self):
        return [''.join(ch or '.' for ch in row) for row in self.px]


# ---------- tiers: colours and pieces ----------
SKIN = {'s': '#e8b88a', 'S': '#c48a5e', 'e': '#2a1d18'}
TIERS = {
    # cloth / leather / iron / heavy iron / bright steel with red / gold "明光铠"
    1: dict(a='#8a6a4a', A='#5e4630', h='#c9b48a', H='#9c8660', c='#6d5a44', C='#4a3c2c', t='#8a6a4a', k='#a8743c', K='#7a4a22', x='#c9a26a', m='#9aa3ab', M='#6d7782', w='#8a5a34'),
    2: dict(a='#9c6a3c', A='#6e4524', h='#7a4a22', H='#55321a', c='#5f6d44', C='#404b2c', t='#c9a26a', k='#a8743c', K='#7a4a22', x='#9aa3ab', m='#a9b3bc', M='#6d7782', w='#8a5a34'),
    3: dict(a='#8d969e', A='#5e666e', h='#8d969e', H='#5e666e', c='#7a3a30', C='#55261f', t='#c9372b', k='#c9372b', K='#8f2219', x='#e2b241', m='#c8d0d6', M='#7c8690', w='#7a4a22'),
    4: dict(a='#6d7782', A='#454d56', h='#6d7782', H='#454d56', c='#3e4a5c', C='#2a3442', t='#a9b3bc', k='#55606c', K='#363e48', x='#c8d0d6', m='#dfe5ea', M='#8d969e', w='#55321a'),
    5: dict(a='#c8d0d6', A='#8d969e', h='#c8d0d6', H='#8d969e', c='#8f2219', C='#5e1610', t='#c9372b', k='#8f2219', K='#5e1610', x='#e2b241', m='#eef2f5', M='#9aa3ab', w='#55321a'),
    6: dict(a='#f0d77a', A='#c09a35', h='#f0d77a', H='#c09a35', c='#2e3a6e', C='#1e2648', t='#fff1b8', k='#c9372b', K='#8f2219', x='#ffe066', m='#fff8e0', M='#c8b070', w='#8f2219'),
}
EXTRA = {'p': '#e04a3a', 'P': '#a82a1e', 'f': '#c9372b', 'F': '#8f2219', 'g': '#ffe066', 'G': '#c09a35', 'r': '#e8edf1', 'n': '#8a5a34', 'N': '#5e3b20', 'q': '#d9cfc0', 'Q': '#a39684', 'y': '#e2b241', 'Y': '#a97b22', 'b': '#3a2a20', 'B': '#22170f'}


def figure(cv, tier, x0=0):
    """A soldier standing, facing us: legs, body, arms, head with its tier's helmet."""
    X = lambda x: x + x0
    # legs and boots
    cv.rect(X(13), 23, X(15), 28, 'c')
    cv.rect(X(17), 23, X(19), 28, 'c')
    cv.rect(X(15), 23, X(15), 28, 'C')
    cv.rect(X(19), 23, X(19), 28, 'C')
    cv.rect(X(12), 29, X(15), 30, 'b')
    cv.rect(X(17), 29, X(20), 30, 'b')
    # body: armour (tier 1: a tunic), a belt
    cv.poly([(X(12), 13), (X(21), 13), (X(21), 23), (X(12), 23)], 'a')
    cv.rect(X(19), 13, X(20), 22, 'A')
    cv.rect(X(12), 21, X(20), 21, 't' if tier >= 2 else 'A')
    if tier >= 3:  # lamellae
        for y in (15, 17, 19):
            for x in range(12, 20, 2):
                cv.set(X(x), y, 'A')
    if tier >= 4:  # shoulder guards
        cv.rect(X(10), 13, X(12), 15, 'h')
        cv.rect(X(20), 13, X(22), 15, 'h')
        cv.rect(X(10), 15, X(12), 15, 'H')
        cv.rect(X(20), 15, X(22), 15, 'H')
    if tier == 6:  # the bright mirrors of 明光铠
        cv.ellipse(X(14), 16, 1, 1, 'r')
        cv.ellipse(X(18), 16, 1, 1, 'r')
        cv.pixels([(X(14), 16), (X(18), 16)], 'g')
    if tier >= 5:  # trims
        cv.rect(X(12), 13, X(20), 13, 't')
        cv.rect(X(12), 22, X(20), 22, 't')
    # arms
    cv.rect(X(21), 15, X(22), 20, 'c')
    cv.rect(X(21), 21, X(22), 22, 's')
    cv.rect(X(10), 15, X(11), 20, 'c')
    cv.rect(X(10), 21, X(11), 22, 's')
    # neck and head
    cv.rect(X(15), 11, X(17), 12, 'S')
    cv.ellipse(X(16), 8, 3, 3, 's')
    cv.rect(X(14), 10, X(18), 10, 'S')
    cv.pixels([(X(15), 8), (X(17), 8)], 'e')
    helmet(cv, tier, X)


def helmet(cv, tier, X):
    if tier == 1:  # a cloth headband
        cv.rect(X(13), 6, X(19), 6, 'h')
        cv.rect(X(13), 5, X(19), 5, 'b')
        cv.pixels([(X(20), 6), (X(21), 7)], 'h')
    elif tier == 2:  # a leather cap
        cv.ellipse(X(16), 5, 3, 2, 'h')
        cv.rect(X(13), 6, X(19), 6, 'H')
    else:  # iron helmets, taller with the tier
        cv.ellipse(X(16), 5, 4, 2, 'h')
        cv.rect(X(12), 6, X(20), 6, 'H')
        cv.rect(X(16), 2 if tier >= 4 else 3, X(16), 3, 'h')
        if tier >= 4:  # cheek guards
            cv.rect(X(12), 7, X(12), 10, 'H')
            cv.rect(X(20), 7, X(20), 10, 'H')
        if tier >= 5:  # a plume
            cv.pixels([(X(16), 1), (X(17), 0), (X(15), 1), (X(17), 1), (X(18), 0)], 'p')
            cv.set(X(16), 0, 'P')
        if tier == 6:  # gold crest
            cv.pixels([(X(14), 4), (X(18), 4), (X(16), 4)], 'g')


def infantry(tier):
    cv = Canvas()
    if tier == 6:  # a banner on its back
        cv.line(10, 0, 10, 12, 'n')
        cv.rect(3, 1, 9, 6, 'f')
        cv.rect(3, 6, 9, 6, 'F')
        cv.pixels([(5, 3), (6, 3), (7, 3), (6, 2), (6, 4)], 'g')
    figure(cv, tier)
    # the weapon: a spear (a halberd from tier 5), held in the right hand
    cv.line(24, 2, 24, 30, 'w')
    cv.poly([(24, 0), (26, 4), (22, 4)], 'm')
    cv.set(23, 3, 'M')
    if tier >= 5:
        cv.poly([(25, 5), (29, 4), (29, 9), (25, 8)], 'm')
        cv.rect(25, 8, 28, 8, 'M')
    if tier >= 3:
        cv.rect(23, 5, 25, 5, 't')
    cv.rect(23, 20, 24, 21, 's')
    # the shield: round of wood, then a square board, then a tall one with its pattern
    if tier <= 2:
        cv.ellipse(8, 18, 5, 5, 'k')
        cv.ellipse(8, 18, 3, 3, 'K')
        cv.ellipse(8, 18, 1, 1, 'x')
    elif tier == 3:
        cv.rect(3, 13, 12, 24, 'k')
        cv.rect(3, 23, 12, 24, 'K')
        cv.rect(7, 16, 8, 21, 'x')
        cv.rect(5, 18, 10, 19, 'x')
    else:
        cv.poly([(3, 12), (13, 12), (13, 24), (8, 28), (3, 24)], 'k')
        cv.poly([(3, 22), (13, 22), (13, 24), (8, 28), (3, 24)], 'K')
        cv.rect(3, 12, 13, 12, 't')
        cv.ellipse(8, 18, 2, 2, 'x')
        if tier >= 5:  # a sun of gold on it, rays at the corners
            cv.ellipse(8, 18, 2, 2, 'g' if tier == 6 else 'x')
            cv.set(8, 18, 'G')
            cv.pixels([(5, 15), (11, 15), (5, 21), (11, 21), (8, 14), (8, 22), (4, 18), (12, 18)], 'g' if tier == 6 else 'x')
    cv.outline()
    return cv


def archer(tier):
    cv = Canvas()
    if tier == 6:  # a cape
        cv.poly([(11, 13), (21, 13), (24, 27), (8, 27)], 'f')
        cv.poly([(19, 13), (21, 13), (24, 27), (20, 27)], 'F')
    # a quiver on its back, arrows in it
    n = 1 if tier == 1 else 2 if tier <= 3 else 3
    cv.rect(21, 7, 23, 14, 'n')
    cv.rect(21, 7, 23, 7, 'N')
    for i in range(n):
        cv.set(21 + i, 5, 'q')
        cv.set(21 + i, 6, 'Q')
    figure(cv, tier)
    if tier == 1:  # a fur cap instead of the headband
        cv.ellipse(16, 5, 4, 2, 'n')
        cv.rect(12, 6, 20, 6, 'N')
    if tier == 3:  # a crossbow at the chest
        cv.rect(6, 16, 24, 17, 'w')
        cv.rect(6, 15, 7, 18, 'm')
        cv.line(6, 12, 6, 21, 'M')
        cv.rect(23, 16, 26, 18, 'w')
    else:  # a bow held up on our left, bigger and finer with the tier
        top, bottom = (6, 26) if tier <= 2 else (4, 28)
        mid = (top + bottom) // 2
        for y in range(top, bottom + 1):
            d = abs(y - mid) / (mid - top)
            x = round(4 + 3 * d * d)
            cv.set(x, y, 'w')
            cv.set(x + 1, y, 'w' if tier < 5 else 'g' if y in (top + 2, bottom - 2, mid) else 'w')
        cv.line(7, top, 7, bottom, 'q')
        cv.rect(8, mid - 1, 10, mid, 's')
        cv.line(3, mid, 12, mid, 'n')  # the arrow
        cv.poly([(1, mid), (3, mid - 2), (3, mid + 2)], 'm')
        if tier >= 5:
            cv.pixels([(5, top), (5, bottom)], 'g')
    cv.outline()
    return cv


HORSE = {
    1: dict(u='#8a5a34', U='#5e3b20', v='#3a2a20'),
    2: dict(u='#a8743c', U='#7a4a22', v='#2a1d18'),
    3: dict(u='#9aa3ab', U='#6d7782', v='#454d56'),
    4: dict(u='#4a3c2c', U='#2a1d18', v='#1c1410'),
    5: dict(u='#7a3a30', U='#4a2018', v='#2a1d18'),
    6: dict(u='#ece6da', U='#bdb4a4', v='#c09a35'),
}


def cavalry(tier):
    cv = Canvas()
    # the horse, side on, heading right
    cv.ellipse(15, 19, 9, 4, 'u')
    cv.poly([(20, 17), (24, 9), (28, 9), (29, 12), (25, 15), (24, 20)], 'u')
    cv.rect(27, 10, 29, 12, 'u')
    cv.set(26, 10, 'e')
    cv.poly([(23, 9), (25, 6), (25, 9)], 'U')  # ear
    cv.poly([(21, 11), (24, 8), (25, 9), (22, 13)], 'v')  # mane
    cv.poly([(6, 17), (3, 20), (2, 26), (5, 22), (7, 19)], 'v')  # tail
    for x in (8, 11, 18, 21):
        cv.rect(x, 22, x + 1, 29, 'U' if x in (11, 21) else 'u')
        cv.rect(x, 30, x + 1, 30, 'v')
    if tier >= 4:  # barding
        cv.poly([(9, 16), (21, 16), (22, 22), (8, 22)], 'k')
        cv.rect(8, 22, 22, 22, 't')
        cv.rect(23, 9, 27, 10, 'h')
        if tier >= 5:
            for x in range(10, 21, 3):
                cv.set(x, 19, 'x')
    else:
        cv.rect(12, 16, 18, 18, 'k')  # a saddle cloth
        cv.rect(12, 18, 18, 18, 'K')
    # the rider
    cv.rect(13, 14, 15, 18, 'c')
    cv.rect(16, 15, 17, 18, 'C')
    cv.poly([(12, 7), (18, 7), (18, 15), (12, 15)], 'a')
    cv.rect(17, 7, 18, 15, 'A')
    cv.rect(12, 13, 18, 13, 't' if tier >= 2 else 'A')
    if tier >= 3:
        for y in (9, 11):
            for x in range(12, 17, 2):
                cv.set(x, y, 'A')
    if tier == 6:
        cv.ellipse(14, 10, 1, 1, 'r')
        cv.set(14, 10, 'g')
    cv.rect(15, 5, 16, 6, 'S')
    cv.ellipse(15, 3, 2, 2, 's')
    cv.set(16, 3, 'e')
    X = lambda x: x - 1
    if tier == 1:
        cv.rect(13, 1, 17, 1, 'h')
    elif tier == 2:
        cv.ellipse(15, 1, 2, 1, 'h')
    else:
        cv.ellipse(15, 1, 3, 1, 'h')
        cv.rect(12, 2, 18, 2, 'H')
        if tier >= 5:
            cv.pixels([(13, 0), (12, 0), (11, 1)], 'p')
        if tier == 6:
            cv.set(15, 0, 'g')
    # the lance, held forward from the hand (its butt behind the rider)
    cv.line(19, 10, 29, 6, 'w')
    cv.poly([(29, 5), (31, 5), (29, 8)], 'm')
    cv.line(9, 13, 11, 12, 'w')
    if tier >= 4:  # a pennant
        cv.poly([(25, 7), (28, 7), (25, 10)], 'f')
    cv.rect(18, 10, 19, 11, 's')
    cv.outline()
    return cv


CAMP = {
    'o': O, 'w': '#a8743c', 'W': '#7a4a22', 'd': '#55321a', 's': '#a09a90', 'S': '#6e6861', 'l': '#d3cdc2',
    'r': '#c9372b', 'R': '#8f2219', 'g': '#ffe066', 'G': '#c09a35', 't': '#d9cfc0', 'T': '#a39684',
    'k': '#2a1d18', 'y': '#e2b241', 'Y': '#a97b22', 'b': '#5f8f45', 'B': '#3e6a2e', 'n': '#3e4a5c', 'N': '#2a3442',
    'q': '#e8c88e',
}


def banner(cv, x, y, h=5, c='r', C='R'):
    cv.line(x, y, x, y + h + 3, 'd')
    cv.rect(x + 1, y, x + 4, y + 2, c)
    cv.rect(x + 1, y + 2, x + 4, y + 2, C)


def roof(cv, x0, x1, y, c='R', C='r', eaves=1):
    """A sloped Chinese roof over x0..x1 at row y, its eaves turned up."""
    cv.poly([(x0 - eaves, y + 3), (x0 + 1, y), (x1, y), (x1 + 1 + eaves, y + 3)], c)
    cv.rect(x0 - eaves, y + 2, x1 + eaves, y + 2, C)
    cv.pixels([(x0 - eaves - 1, y + 1), (x1 + eaves + 1, y + 1)], c)


def palisade(cv, x0, x1, y0, y1):
    for x in range(x0, x1 + 1, 2):
        cv.rect(x, y0, x, y1, 'w')
        cv.rect(x + 1, y0 + 1, x + 1, y1, 'W')
        cv.set(x, y0 - 1, 'w')


def stone_wall(cv, x0, x1, y0, y1, crenels=True):
    cv.rect(x0, y0, x1, y1, 's')
    for y in range(y0 + 2, y1 + 1, 3):
        cv.rect(x0, y, x1, y, 'S')
        for x in range(x0 + (y // 3) % 2 * 2, x1, 4):
            cv.set(x, y - 1, 'S')
    if crenels:
        for x in range(x0, x1 + 1, 3):
            cv.rect(x, y0 - 2, x + 1, y0 - 1, 's')


def fortress(level):
    cv = Canvas()
    if level == 1:  # a palisade, a watchtower, one flag
        palisade(cv, 3, 28, 18, 28)
        cv.rect(13, 8, 19, 16, 'W')  # tower
        cv.rect(12, 7, 20, 8, 'w')
        cv.line(13, 16, 13, 28, 'd')
        cv.line(19, 16, 19, 28, 'd')
        cv.rect(14, 22, 18, 28, 'k')  # gate
        banner(cv, 20, 1)
    elif level == 2:  # stone walls, a gate tower with its roof, banners
        stone_wall(cv, 2, 29, 16, 29)
        cv.rect(10, 9, 21, 16, 's')
        cv.rect(12, 11, 13, 13, 'k')
        cv.rect(18, 11, 19, 13, 'k')
        roof(cv, 10, 21, 6)
        cv.poly([(13, 29), (13, 22), (16, 20), (19, 22), (19, 29)], 'k')
        banner(cv, 3, 4)
        banner(cv, 25, 4)
    else:  # a great pass: walls of stone, a two-storey gate tower roofed in gold, red banners, gold studs on the gate
        stone_wall(cv, 0, 31, 17, 30)
        cv.rect(8, 11, 23, 17, 'R')
        cv.rect(9, 12, 22, 16, 'r')
        for x in (10, 14, 17, 21):
            cv.rect(x, 12, x, 16, 'R')
        roof(cv, 8, 23, 8, 'G', 'g', 2)
        cv.rect(11, 5, 20, 8, 'R')
        cv.rect(12, 6, 19, 7, 'r')
        roof(cv, 11, 20, 2, 'G', 'g', 1)
        cv.pixels([(15, 1), (16, 1)], 'g')
        cv.poly([(12, 30), (12, 23), (16, 20), (20, 23), (20, 30)], 'R')
        cv.line(16, 21, 16, 30, 'k')
        for y in (24, 27):
            cv.pixels([(14, y), (18, y)], 'g')
        banner(cv, 1, 6, c='r')
        banner(cv, 26, 6, c='r')
        cv.pixels([(2, 7), (27, 7)], 'g')
    cv.outline()
    return cv


def outpost(level):
    cv = Canvas()
    if level == 1:  # tents, sacks and a low fence
        cv.poly([(4, 24), (10, 12), (16, 24)], 't')
        cv.poly([(10, 12), (16, 24), (12, 24)], 'T')
        cv.rect(9, 19, 11, 24, 'k')
        cv.poly([(15, 25), (22, 14), (29, 25)], 'q')
        cv.poly([(22, 14), (29, 25), (25, 25)], 'Y')
        cv.ellipse(6, 27, 2, 2, 'q')
        cv.ellipse(11, 28, 2, 1, 't')
        palisade(cv, 1, 30, 27, 30)
    elif level == 2:  # a walled manor: a storehouse with its roof, grain heaped, a gate
        cv.rect(2, 19, 29, 29, 'W')
        cv.rect(2, 19, 29, 20, 'w')
        cv.rect(6, 11, 25, 19, 'q')
        cv.rect(6, 17, 25, 19, 'Y')
        roof(cv, 6, 25, 8, 'n', 'N')
        cv.rect(14, 13, 17, 19, 'k')
        cv.ellipse(5, 25, 2, 2, 'y')
        cv.ellipse(26, 25, 2, 2, 'y')
        cv.rect(13, 24, 18, 29, 'k')
    else:  # a rich trade city: a tall hall roofed in gold over walls, gold piled at the gate
        stone_wall(cv, 0, 31, 19, 30)
        cv.rect(6, 12, 25, 19, 'q')
        cv.rect(6, 17, 25, 19, 'Y')
        for x in (8, 12, 19, 23):
            cv.rect(x, 12, x, 19, 'R')
        roof(cv, 6, 25, 9, 'G', 'g', 2)
        cv.rect(11, 5, 20, 9, 'q')
        cv.rect(14, 6, 17, 9, 'R')
        roof(cv, 11, 20, 2, 'G', 'g', 1)
        cv.poly([(12, 30), (12, 24), (16, 22), (20, 24), (20, 30)], 'k')
        cv.ellipse(5, 27, 2, 2, 'g')
        cv.ellipse(26, 27, 2, 2, 'g')
        cv.pixels([(5, 26), (26, 26)], 'G')
        banner(cv, 1, 9, c='y', C='Y')
        banner(cv, 26, 9, c='y', C='Y')
    cv.outline()
    return cv


def palette_of(tier, extra=None):
    out = {'o': O}
    out.update(SKIN)
    out.update(EXTRA)
    out.update(TIERS[tier])
    if extra:
        out.update(extra)
    return out


SPRITES = {}
for tier in range(1, 7):
    SPRITES[f'infantry-{tier}'] = (infantry(tier), palette_of(tier))
    SPRITES[f'archer-{tier}'] = (archer(tier), palette_of(tier))
    SPRITES[f'cavalry-{tier}'] = (cavalry(tier), palette_of(tier, HORSE[tier]))


for i in range(1, 4):
    SPRITES[f'fortress-{i}'] = (fortress(i), CAMP)
    SPRITES[f'outpost-{i}'] = (outpost(i), CAMP)


def ts(sprites):
    lines = [
        '// Generated by scripts/icons/troops.py: edit that and run it again (python3 scripts/icons/troops.py).',
        "// 32 x 32 sprites (more detail; drawn halved where only 16 fit): the troops' tiers and the NPC camps' levels.",
        "import type { IconArt } from './sprites';",
        '',
        'export const SPRITES_32: Record<string, IconArt> = {',
    ]
    for name, (cv, pal) in sprites.items():
        rows = cv.rows()
        used = sorted({ch for r in rows for ch in r if ch != '.'})
        lines.append(f"\t'{name}': {{")
        lines.append('\t\trows: [')
        for r in rows:
            lines.append(f"\t\t\t'{r}',")
        lines.append('\t\t],')
        lines.append('\t\tpalette: { ' + ', '.join(f"{k}: '{pal[k]}'" for k in used) + ' },')
        lines.append('\t},')
    lines.append('};')
    return '\n'.join(lines) + '\n'


def preview(sprites, out):
    from PIL import Image

    names = list(sprites)
    cols = 6
    scale = 4
    img = Image.new('RGB', (cols * (W * scale + 8) + 8, ((len(names) + cols - 1) // cols) * (H * scale + 8) + 8), (243, 238, 228))
    for i, n in enumerate(names):
        cv, pal = sprites[n]
        ox = 8 + (i % cols) * (W * scale + 8)
        oy = 8 + (i // cols) * (H * scale + 8)
        for y, row in enumerate(cv.rows()):
            for x, ch in enumerate(row):
                if ch != '.':
                    c = pal[ch]
                    rgb = tuple(int(c[k : k + 2], 16) for k in (1, 3, 5))
                    for dy in range(scale):
                        for dx in range(scale):
                            img.putpixel((ox + x * scale + dx, oy + y * scale + dy), rgb)
    img.save(out)
    # and as they show in text: halved
    small = Image.new('RGB', (cols * 24 + 8, ((len(names) + cols - 1) // cols) * 24 + 8), (243, 238, 228))
    for i, n in enumerate(names):
        cv, pal = sprites[n]
        ox = 8 + (i % cols) * 24
        oy = 8 + (i // cols) * 24
        for y, row in enumerate(cv.rows()[::2]):
            for x, ch in enumerate(row[::2]):
                if ch != '.':
                    c = pal[ch]
                    small.putpixel((ox + x, oy + y), tuple(int(c[k : k + 2], 16) for k in (1, 3, 5)))
    small.resize((small.width * 3, small.height * 3), Image.NEAREST).save(str(out).replace('.png', '-small.png'))


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    if '--preview' in sys.argv:
        out = Path(sys.argv[sys.argv.index('--preview') + 1])
        preview(SPRITES, out / 'troops.png')
    else:
        (root / 'web/plugins/starter-icons/sprites-32.ts').write_text(ts(SPRITES), encoding='utf8')
