# -*- coding: utf-8 -*-
# One chapter of a trade route laid out (user 2026-11-20: "每个章节的节点数要要大大增加（100个？）"; "你这个节点，画的自相
# 似性太高了，一点诚意都没有"): its land first (rivers, ranges, coasts, lakes, deserts, forests, marshes, walls, roads, by
# its recipe, each chapter its own seed), then about a hundred places scattered over the dry land, joined into a net the
# way a land allows (a river crossed at a few fords, a range at a few passes, never over water), with forks, loops and
# dead ends; the way in on the west, the boss on the east, the only way on. Pure: gen.py calls it.
import math
import random

W, H = 1700, 1050


def _noise_line(rng, a, b, step=70, wobble=55):
    """Points from a to b, wandering sideways."""
    (ax, ay), (bx, by) = a, b
    n = max(2, int(math.hypot(bx - ax, by - ay) / step))
    nx, ny = -(by - ay), bx - ax
    ln = math.hypot(nx, ny) or 1
    nx, ny = nx / ln, ny / ln
    out, off = [], 0.0
    for i in range(n + 1):
        t = i / n
        if 0 < i < n:
            off = off * 0.6 + rng.uniform(-wobble, wobble)
        else:
            off = 0
        out.append((ax + (bx - ax) * t + nx * off, ay + (by - ay) * t + ny * off))
    return out


def _blob(rng, cx, cy, rx, ry, k=14):
    pts = []
    for i in range(k):
        a = 2 * math.pi * i / k
        r = rng.uniform(0.75, 1.15)
        pts.append((cx + math.cos(a) * rx * r, cy + math.sin(a) * ry * r))
    return pts


def _edge_point(rng, side):
    if side == 'n': return (rng.uniform(150, W - 150), -20)
    if side == 's': return (rng.uniform(150, W - 150), H + 20)
    if side == 'w': return (-20, rng.uniform(150, H - 150))
    return (W + 20, rng.uniform(150, H - 150))


def _sea(rng, side, depth):
    """A sea along one side of the map: its coast wanders."""
    if side == 's':
        coast = _noise_line(rng, (-30, H - depth), (W + 30, H - depth * rng.uniform(0.6, 1.4)), 90, 60)
        return coast + [(W + 30, H + 40), (-30, H + 40)]
    if side == 'n':
        coast = _noise_line(rng, (-30, depth), (W + 30, depth * rng.uniform(0.6, 1.4)), 90, 60)
        return coast + [(W + 30, -40), (-30, -40)]
    if side == 'e':
        coast = _noise_line(rng, (W - depth, -30), (W - depth * rng.uniform(0.7, 1.3), H + 30), 90, 60)
        return coast + [(W + 40, H + 30), (W + 40, -30)]
    coast = _noise_line(rng, (depth, -30), (depth * rng.uniform(0.7, 1.3), H + 30), 90, 60)
    return coast + [(-40, H + 30), (-40, -30)]


def terrain(rng, recipe):
    """The land of a chapter from its recipe: [(kind, where), ...] (gen's chapters.py)."""
    feats = []
    for kind, where in recipe:
        if kind == 'river':
            a, b = where  # sides it runs between, e.g. ('n', 's')
            feats.append(('river', _noise_line(rng, _edge_point(rng, a), _edge_point(rng, b), 60, 45)))
        elif kind == 'road':
            a, b = where
            feats.append(('road', _noise_line(rng, _edge_point(rng, a), _edge_point(rng, b), 90, 30)))
        elif kind == 'range':
            (x1, y1), (x2, y2) = where  # fractions of the map
            feats.append(('range', _noise_line(rng, (x1 * W, y1 * H), (x2 * W, y2 * H), 80, 30)))
        elif kind == 'wall':
            (x1, y1), (x2, y2) = where
            feats.append(('wall', _noise_line(rng, (x1 * W, y1 * H), (x2 * W, y2 * H), 100, 12)))
        elif kind == 'sea':
            side, depth = where
            feats.append(('sea', _sea(rng, side, depth * H if side in 'ns' else depth * W)))
        elif kind in ('lake', 'desert', 'forest', 'marsh', 'land'):
            (x, y), (rx, ry) = where
            feats.append((kind, _blob(rng, x * W, y * H, rx * W, ry * H)))
        else:
            raise ValueError(f'no terrain kind {kind}')
    return feats


def _inside(p, poly):
    x, y = p
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi:
            inside = not inside
        j = i
    return inside


def _dist_seg(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / ((dx * dx + dy * dy) or 1)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def _cross(a, b, c, d):
    def o(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return (o(a, b, c) > 0) != (o(a, b, d) > 0) and (o(c, d, a) > 0) != (o(c, d, b) > 0)


def _crosses_line(a, b, line):
    return any(_cross(a, b, line[i], line[i + 1]) for i in range(len(line) - 1))


def chapter(seed, recipe, count=100, branches=10):
    """Land, places (x, y), paths (i, j), the way in and the boss, each place's progress (0 at the way in, 1 at the boss)."""
    rng = random.Random(seed)
    feats = terrain(rng, recipe)
    water = [pts for k, pts in feats if k in ('sea', 'lake')]
    islands = [pts for k, pts in feats if k == 'land']
    lines = [(k, pts) for k, pts in feats if k in ('river', 'range')]

    def dry(p):
        x, y = p
        if not (50 <= x <= W - 50 and 60 <= y <= H - 50): return False
        if any(_inside(p, w) for w in water) and not any(_inside(p, s) for s in islands): return False
        for k, pts in lines:
            if any(_dist_seg(p, pts[i], pts[i + 1]) < (30 if k == 'river' else 40) for i in range(len(pts) - 1)): return False
        return True

    # Places: scattered over the dry land (Poisson-disc by darts), the way in and the boss pinned west and east.
    entry = next(p for p in ((70, H / 2 + rng.uniform(-120, 120)) for _ in range(200)) if dry(p))
    # The boss as far east as dry land goes (an island, if the sea takes the east).
    boss = next(p for x in range(W - 80, 0, -20) for p in ((x, rng.uniform(120, H - 120)) for _ in range(30)) if dry(p))
    pts = [entry, boss]
    # Spaced as for 1500 x 950: the rest of the map is room for the branches to grow into.
    r = math.sqrt(1500 * 950 * 0.55 / count)
    tries = 0
    while len(pts) < count + 1 and tries < 60000:
        tries += 1
        p = (rng.uniform(60, W - 60), rng.uniform(70, H - 60))
        if dry(p) and all(math.hypot(p[0] - q[0], p[1] - q[1]) > r for q in pts):
            pts.append(p)
        if tries % 15000 == 0: r *= 0.9
    n = len(pts)

    # Paths: the relative neighbourhood graph (a sparse, natural-looking net), a few more for loops; none over water,
    # at most a few over each river (fords) and range (passes).
    d = lambda i, j: math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])
    cand = []
    for i in range(n):
        for j in range(i + 1, n):
            dij = d(i, j)
            if dij > r * 2.6: continue
            if not any(max(d(i, k), d(j, k)) < dij for k in range(n) if k not in (i, j)):
                cand.append((dij, i, j, 'rng'))
            elif rng.random() < 0.06 and dij < r * 1.9:
                cand.append((dij, i, j, 'loop'))
    cand.sort()
    crossings = {id(pts_): 0 for _, pts_ in lines}
    budget = {id(pts_): (3 if k == 'river' else 2) for k, pts_ in lines}
    edges = []
    for dij, i, j, why in cand:
        a, b = pts[i], pts[j]
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        if any(_inside(mid, w) for w in water) and not any(_inside(mid, s) for s in islands): continue
        crossed = [pts_ for _, pts_ in lines if _crosses_line(a, b, pts_)]
        if any(crossings[id(c)] >= budget[id(c)] for c in crossed): continue
        for c in crossed: crossings[id(c)] += 1
        edges.append((i, j))
    # Some dead ends (leaves) the net would not make: trim a few edges off nodes with three or more.
    adj = {i: set() for i in range(n)}
    for i, j in edges: adj[i].add(j); adj[j].add(i)
    # Connected: join every piece to the nearest place of the main one.
    def comps():
        seen, out = set(), []
        for s in range(n):
            if s in seen: continue
            stack, comp = [s], set()
            while stack:
                u = stack.pop()
                if u in comp: continue
                comp.add(u); stack.extend(adj[u] - comp)
            seen |= comp; out.append(comp)
        return out
    while True:
        cs = comps()
        if len(cs) == 1: break
        main = max(cs, key=len)
        best = None
        for c in cs:
            if c is main: continue
            for i in c:
                for j in main:
                    if best is None or d(i, j) < best[0]: best = (d(i, j), i, j)
        _, i, j = best
        edges.append((i, j)); adj[i].add(j); adj[j].add(i)
    # The boss closes the chapter: one or two ways into it, from the west.
    nb = sorted(adj[1], key=lambda k: -pts[k][0])
    for k in nb[2:]:
        # Keep the net whole without it.
        adj[1].discard(k); adj[k].discard(1)
        if len(comps()) > 1:
            adj[1].add(k); adj[k].add(1)
    # Branches of their own (dead ends a few places long: lairs, prizes, side stories), grown out of the net into the
    # land left empty (user 2026-11-20: "不要裁剪，只往上加"): from a place, step by step away from everything, as long as
    # there is dry land and room; joined to the net only where they leave it.
    want = branches
    for _ in range(want * 30):
        if want <= 0: break
        root = rng.randrange(2, len(pts))
        if pts[root][0] < 150: continue
        walk, cur = [], pts[root]
        for _step in range(rng.randint(2, 4)):
            best = None
            for _try in range(24):
                a = rng.uniform(0, 2 * math.pi)
                p = (cur[0] + math.cos(a) * r * 1.05, cur[1] + math.sin(a) * r * 1.05)
                if not dry(p): continue
                room = min(math.hypot(p[0] - q[0], p[1] - q[1]) for q in pts + walk)
                if room < r * 0.85: continue
                if best is None or room > best[0]: best = (room, p)
            if not best: break
            walk.append(best[1]); cur = best[1]
        if len(walk) < 2: continue
        ids = list(range(len(pts), len(pts) + len(walk)))
        pts.extend(walk)
        for k in ids: adj[k] = set()
        chain = [root] + ids
        for a_, b_ in zip(chain, chain[1:]):
            adj[a_].add(b_); adj[b_].add(a_)
        want -= 1
    n = len(pts)
    edges = sorted({(min(i, j), max(i, j)) for i in adj for j in adj[i]})
    # Progress: hops from the way in, over the farthest.
    hops = {0: 0}
    queue = [0]
    while queue:
        u = queue.pop(0)
        for v in adj[u]:
            if v not in hops:
                hops[v] = hops[u] + 1; queue.append(v)
    far = max(hops.values()) or 1
    progress = [hops[i] / far for i in range(n)]
    progress[1] = 1.0
    # The main way: the shortest path from the way in to the boss.
    prev = {0: None}
    queue = [0]
    while queue:
        u = queue.pop(0)
        for v in sorted(adj[u]):
            if v not in prev:
                prev[v] = u; queue.append(v)
    main, u = [], 1
    while u is not None:
        main.append(u); u = prev[u]
    main.reverse()
    return {
        'features': feats,
        'points': [(round(x), round(y)) for x, y in pts],
        'edges': edges,
        'adj': {i: sorted(v) for i, v in adj.items()},
        'progress': progress,
        'main': main,
    }


def assign(rng, lay, prizes):
    """Kinds: the boss (1), three key places along the way, a prize place at a dead end for each thing new to the routes
    here, three lairs on branches of their own, supply points and merchants spread out, elite camps, stories; camps for
    the rest. Returns kind by index and
    the side chains (dead-end branches told as one small story)."""
    n = len(lay['points']); adj = lay['adj']; prog = lay['progress']; pts = lay['points']
    kind = ['enemy'] * n
    kind[0] = 'enemy'  # the way in: a camp at the chapter's gate
    kind[1] = 'boss'
    free = set(range(2, n))
    main = lay['main']
    # Key places: on the main way at about a quarter, a half and three quarters.
    for t in (0.25, 0.5, 0.75):
        k = min((i for i in main if i in free), key=lambda i: abs(prog[i] - t))
        kind[k] = 'key'; free.discard(k)
    def spread(count, pool, min_prog=0.05):
        chosen = []
        pool = [i for i in pool if prog[i] >= min_prog]
        for _ in range(count):
            if not pool: break
            if not chosen:
                k = min(pool, key=lambda i: prog[i])
            else:
                k = max(pool, key=lambda i: min(math.hypot(pts[i][0] - pts[c][0], pts[i][1] - pts[c][1]) for c in chosen))
            chosen.append(k); pool.remove(k)
        return chosen
    leaves = [i for i in free if len(adj[i]) == 1]
    # Prize places (the first of a thing new to the routes): dead ends past a third of the way.
    # In the list's order, the first the nearest (the plainer thing turns up first).
    prize_at = {}
    for item in prizes:
        cands = sorted((i for i in leaves if i in free and prog[i] > 0.3), key=lambda i: prog[i]) or sorted(free, key=lambda i: prog[i])
        k = cands[min(len(cands) - 1, len(cands) // 4)]
        kind[k] = 'story'; prize_at[k] = item; free.discard(k)
    # Lairs, fought again every time out (user 2026-11-20: "相关节点要是独立分支，不要占据必经之路"): dead ends off the main
    # way, early, midway and late.
    for t in (0.2, 0.5, 0.8):
        cands = [i for i in leaves if i in free and i not in main]
        if not cands: break
        k = min(cands, key=lambda i: abs(prog[i] - t))
        kind[k] = 'lair'; free.discard(k)
    for k in spread(8, [i for i in free if len(adj[i]) >= 2], 0.08):
        kind[k] = 'supply'; free.discard(k)
    for k in spread(4, list(free), 0.12):
        kind[k] = 'merchant'; free.discard(k)
    # Elite camps: the remaining dead ends first (guards of something), then a few choke points.
    elites = [i for i in leaves if i in free][:6] + [i for i in free if len(adj[i]) == 2 and rng.random() < 0.04]
    for k in elites[:9]:
        kind[k] = 'elite'; free.discard(k)
    # Stories: about a third of the rest, more along the main way.
    for i in sorted(free):
        if rng.random() < (0.55 if i in main else 0.27):
            kind[i] = 'story'; free.discard(i)
    # Side chains: dead-end branches (a leaf back to where the branch leaves the net), 3-5 places, told as one story.
    chains = []
    for leaf in [i for i in range(2, n) if len(adj[i]) == 1]:
        branch, u, prev_ = [leaf], leaf, None
        while True:
            nxt = [v for v in adj[u] if v != prev_]
            if len(nxt) != 1 or len(adj[nxt[0]]) > 2 or nxt[0] in (0, 1): break
            prev_, u = u, nxt[0]; branch.append(u)
        if len(branch) >= 3:
            chains.append(list(reversed(branch[:5])))
    return kind, prize_at, chains
