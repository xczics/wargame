# -*- coding: utf-8 -*-
# The starter trade routes' tables from their chapters (chapters.py: land, prizes, key places' orders), the layout
# (layout.py: about a hundred places a chapter, each chapter its own) and the stories written for them.
#
#   python3 scripts/trade-routes/gen.py skeleton   each chapter's places for the writers: skeleton/<route>-<chapter>.json
#   python3 scripts/trade-routes/gen.py            the tables (starter-trade-routes/data): routes, nodes, edges, features,
#                                                  i18n-routes, from the skeletons and stories/<route>-<chapter>.json
#
# A story file: { "title": [zh, en], "<node id>": { "name": [zh, en], "before": [zh, en], "after": [zh, en],
# "first": [zh, en], "pass": [zh, en] (supply points), "portrait": "<id>" (optional) }, ... }: the story before the
# fight and how it ends after (user 2026-11-20: "剧情有两部分：打之前给看一部分……打完之后，再补全剩下的部分").
# Then pnpm check; TRIES=2 pnpm sim test/sim/trade-routes.sim.ts to see who wins where.
import csv, importlib.util, json, pathlib, random, re, sys
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
from layout import chapter as lay_chapter, assign  # noqa: E402
from chapters import CHAPTERS, COUNT  # noqa: E402
OUT = HERE.parent.parent / 'src/plugins/starter-trade-routes/data'
SKEL = HERE / 'skeleton'
STORIES = HERE / 'stories'
P = 'starter-trade-routes.'


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


# The routes: id, order, their start (name and story: the old files), the difficulty of chapter 1.
ROUTES = [('silk', 1, load('silk').SILK, 0.0), ('tea', 2, load('tea').TEA, 1.5), ('sea', 3, load('sea').SEA, 3.0)]
START_PORTRAIT = {'tea': 'tax-clerk', 'sea': 'harbour-official'}
FAMILIES = ['infantry', 'archer', 'cavalry']

# A column's men by difficulty (user 2026-11-18, "前段指数、后段线性"). Up to the top tier (6, difficulty 4) a stage of
# the player's growth a difficulty: the anchors are about nine tenths of the men a team of that stage (heroes Lv 20 / 30
# / 45 / 60 / 75 / 90 leading tier 2-6, nothing worn, no research) beats a boss with half the time, so a boss takes the
# whole team and some luck and the camps before it are easy. 6: past a bare Lv 90 team (gear, research, rebirth). Then
# a tenth and a half of that more each difficulty, so a route can go on for many chapters without a wall.
ANCHORS = [2050, 2970, 4100, 8000, 18500, 23100, 36000]
SLOPE = 0.15
def men_at(d):
    d = max(0, d)
    top = len(ANCHORS) - 1
    if d >= top: return ANCHORS[top] * (1 + SLOPE * (d - top))
    i = int(d); f = d - i
    return ANCHORS[i] * (ANCHORS[i + 1] / ANCHORS[i]) ** f
# Who leads each enemy column (user 2026-11-18): an NPC hero "<venue>/<venue level>/<level>". The player's hero level by
# difficulty, +3 a difficulty past the last. 暂按: leaderless below difficulty 1, then a hero of a tavern at level
# 2 + difficulty raised to six tenths of that level; a boss's or an elite camp's best column a tavern two levels
# better, at 85% of it.
STAGE_LEVELS = [20, 30, 45, 60, 75, 90, 90]
def stage_level(d):
    d = max(0, d)
    top = len(STAGE_LEVELS) - 1
    if d >= top: return STAGE_LEVELS[top] + 3 * (d - top)
    i = int(d); f = d - i
    return STAGE_LEVELS[i] + (STAGE_LEVELS[i + 1] - STAGE_LEVELS[i]) * f
def general(d, elite=False):
    # Raised a little short of the stage (2026-11-20 simulation: at full level, with counters x3 and their aim, the late
    # bosses were past the stage they belong to: the Mirage's 0% for a Lv 90 team).
    if elite: return f'tavern/{max(1, round(4 + d))}/{max(1, round(0.85 * stage_level(d)))}'
    if d < 1: return ''
    return f'tavern/{max(1, round(2 + d))}/{max(1, round(0.6 * stage_level(d)))}'
def column(d, i, scale=1.0, tier_up=0):
    men = round(men_at(d) * scale / 10) * 10
    tier = min(6, 2 + int(max(0, d)) + tier_up)
    return f'{FAMILIES[i % 3]}-{tier}:{men}'

# By kind: the columns (men's share, tier up), the generals, the width, experience and loot over a plain camp's.
# Experience and loot are a little each place (a hundred of them a chapter: several times the old chapter's in all;
# user: "章内由浅入深……经验和掉落按节点数摊薄，整章总量多几倍"). An elite camp guards a dead end, a lair is fought
# again every time out.
# Bosses a little easier than their chapter's difficulty where the full sim (2026-11-20, all stories in) found them past
# the stage they belong to: the Silk Road's first (Lv 20 won 1 in 4), the Tea-Horse Road's first two (Lv 30 / 45, 1 in 4).
BOSS_EASE = {('tea', 1): 0.15, ('tea', 2): 0.3}
# The Silk Road's first is at the floor of difficulty already: fewer men instead.
BOSS_MEN = {('silk', 1): 0.8}


def guards(kind, d, k, wide):
    if kind == 'boss':
        # A third fewer than at first (2026-11-20: with generals and counters the bosses were a stage past their own).
        cols = [(0.6, 0), (1.5, 1), (0.6, 0), (0.5, 0), (0.5, 0)]; elite = 1; width = 3
    elif kind in ('elite', 'lair'):
        cols = [(0.9, 0), (1.1, 1 if kind == 'elite' else 0), (0.8, 0)]; elite = 1; width = 2 if kind == 'lair' else 3
    elif kind == 'merchant':
        cols = [(0.8, 0)]; elite = None; width = 1
    elif kind == 'supply':
        cols = [(0.7, 0)]; elite = None; width = 1
    elif wide:
        cols = [(0.8, 0), (0.8, 0), (0.6, 0)]; elite = None; width = 2
    else:
        cols = [(1.0, 0)]; elite = None; width = 1
    enemies = ' | '.join(column(d, k + i, s, up) for i, (s, up) in enumerate(cols))
    gens = ' | '.join(general(d, i == elite) for i in range(len(cols)))
    return enemies, (gens if gens.strip(' |') else ''), width
EXP = {'enemy': 0.3, 'wide': 0.4, 'story': 0.25, 'key': 0.3, 'merchant': 0.25, 'supply': 0.2, 'elite': 0.8, 'lair': 0.4, 'boss': 4}
LOOT = {'enemy': 0.45, 'wide': 0.6, 'story': 0.4, 'key': 0.45, 'merchant': 0.4, 'supply': 0.35, 'elite': 1.1, 'lair': 0.55, 'boss': 3}


def terrain_of(p, feats):
    """Where a place stands, for the writers: inside an area, or by the line nearest it."""
    from layout import _inside, _dist_seg
    words = {'desert': 'in the desert', 'forest': 'in the forest', 'marsh': 'in the marsh', 'land': 'on an island'}
    for k, pts in feats:
        if k in words and _inside(p, pts): return words[k]
    best = None
    for k, pts in feats:
        if k in ('river', 'range', 'wall', 'road', 'sea', 'lake'):
            dd = min(_dist_seg(p, pts[i], pts[i + 1]) for i in range(len(pts) - 1))
            if best is None or dd < best[0]: best = (dd, k)
    if best and best[0] < 90:
        return {'river': 'by the river', 'range': 'at the foot of the mountains', 'wall': 'by the old wall', 'road': 'on the old road',
                'sea': 'on the coast', 'lake': 'by the lake'}[best[1]]
    return 'in open country'


def chapter_plan(rid, c, d0):
    """A chapter laid out and its places given their kinds, ids, numbers and the writers' hints."""
    ch = CHAPTERS[(rid, c)]
    lay = lay_chapter(f'{rid}-{c}', ch['recipe'], COUNT)
    rng = random.Random(f'{rid}-{c}-kinds')
    kind, prize_at, chains = assign(rng, lay, ch['prizes'])
    n = len(lay['points'])
    # Ids by how far in, then west to east: "<route>-<chapter>-<n>", the boss "<route>-<chapter>-b".
    order = sorted(range(n), key=lambda i: (lay['progress'][i], lay['points'][i][0]))
    ids = {}
    k = 1
    for i in order:
        if i == 1: ids[i] = f'{rid}-{c}-b'
        else: ids[i] = f'{rid}-{c}-{k}'; k += 1
    d = d0 + c - 1
    chain_of = {}
    for ci, chain in enumerate(chains):
        for step, i in enumerate(chain): chain_of[i] = (ci + 1, step + 1, len(chain))
    # Threads (user 2026-11-20: "每章一个主线，是并行好多支线一起收束得到的。并行的支线在网状地图上展开"): the places
    # split by where they lie into a few parts of the map (k-means on their positions, the way in and the boss left out),
    # each a story of its own, its steps by how far in; all of them close on the boss.
    THREADS = 5
    pts = lay['points']
    others = [i for i in range(n) if i not in (0, 1)]
    krng = random.Random(f'{rid}-{c}-threads')
    centres = [pts[i] for i in krng.sample(others, THREADS)]
    for _ in range(25):
        groups = [[] for _ in centres]
        for i in others:
            k_ = min(range(len(centres)), key=lambda g: (pts[i][0] - centres[g][0]) ** 2 + (pts[i][1] - centres[g][1]) ** 2)
            groups[k_].append(i)
        centres = [(sum(pts[i][0] for i in g) / len(g), sum(pts[i][1] for i in g) / len(g)) if g else centres[j] for j, g in enumerate(groups)]
    # Numbered west to east (the first met first).
    order_g = sorted(range(len(groups)), key=lambda g: centres[g][0])
    thread_of = {}
    for t, g in enumerate(order_g):
        members = sorted(groups[g], key=lambda i: (lay['progress'][i], pts[i][0]))
        for step, i in enumerate(members):
            thread_of[i] = {'id': t + 1, 'step': step + 1, 'of': len(members)}
    keys = iter(ch['keys'])
    nodes = []
    for i in order:
        kd = kind[i]
        wide = kd == 'enemy' and rng.random() < 0.25
        nd = d - BOSS_EASE.get((rid, c), 0) if kd == 'boss' else d - 0.2 + 0.8 * lay['progress'][i]
        enemies, gens, width = guards(kd, nd, i, wide)
        if kd == 'boss' and (rid, c) in BOSS_MEN:
            enemies = ' | '.join(
                ':'.join([u, str(int(round(int(n) * BOSS_MEN[(rid, c)], -1)))]) if u else ''
                for u, _, n in (part.strip().partition(':') for part in enemies.split('|'))
            )
        role = 'wide' if wide else kd
        node = {
            'id': ids[i], 'kind': kd, 'progress': round(lay['progress'][i], 2), 'x': lay['points'][i][0], 'y': lay['points'][i][1],
            'neighbours': [ids[j] for j in lay['adj'][i]], 'where': terrain_of(lay['points'][i], lay['features']),
            'main': i in lay['main'], 'deadEnd': len(lay['adj'][i]) == 1, 'difficulty': round(nd, 2),
            'enemies': enemies, 'generals': gens, 'width': width,
            'exp': round(3000 * 1.35 ** max(0, nd) * EXP[role] / 10) * 10,
            'loot': round((1 + 0.3 * max(0, nd)) * LOOT[role], 2),
        }
        if i == 0: node['gate'] = True
        if i in prize_at: node['prize'] = prize_at[i]
        if i in chain_of: node['chain'] = dict(zip(('id', 'step', 'of'), chain_of[i]))
        if i in thread_of: node['thread'] = thread_of[i]
        if kd == 'key': node['unlock'] = next(keys)
        if kd == 'boss': node['unlock'] = f'loss:{20 + 10 * c}'
        nodes.append(node)
    edges = [(ids[i], ids[j]) for i, j in lay['edges']]
    feats = [{'kind': k, 'points': [[round(x), round(y)] for x, y in pts]} for k, pts in lay['features']]
    return {'route': rid, 'chapter': c, 'difficulty': d, 'entry': ids[0], 'boss': ids[1], 'nodes': nodes, 'edges': edges, 'features': feats}


def skeleton():
    SKEL.mkdir(exist_ok=True)
    for rid, order, R, d0 in ROUTES:
        for c in range(1, 5):
            plan = chapter_plan(rid, c, d0)
            plan['title'] = list(R[c]['title'])
            (SKEL / f'{rid}-{c}.json').write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding='utf8')
            print(rid, c, len(plan['nodes']), 'places')


def tables():
    routes_rows, node_rows, edge_rows, feat_rows, texts = [], [], [], [], []
    missing = []
    for rid, order, R, d0 in ROUTES:
        chapters = [f'{P}chapter:{rid}-{c}' for c in range(1, 5)]
        routes_rows.append([rid, f'{P}route:{rid}', str(order), '; '.join(chapters), str(d0 + 1)])
        texts.append((f'route:{rid}', R['name'][1], R['name'][0]))
        start = f'{rid}-0'
        prev = start
        for c in range(1, 5):
            plan = json.loads((SKEL / f'{rid}-{c}.json').read_text(encoding='utf8'))
            # The chapter's stories: one file, or its parts (written a part at a time).
            sf = STORIES / f'{rid}-{c}.json'
            story = json.loads(sf.read_text(encoding='utf8')) if sf.exists() else {}
            for part in sorted(STORIES.glob(f'{rid}-{c}.part*.json')):
                story.update(json.loads(part.read_text(encoding='utf8')))
            # The game's CSVs hold a cell on one line: paragraphs run on (Chinese joined, English with a space).
            def one_line(v):
                if isinstance(v, str): return v
                if isinstance(v, list) and len(v) == 2 and all(isinstance(x, str) for x in v):
                    return [re.sub(r'\s*\n+\s*', '', v[0]), re.sub(r'\s*\n+\s*', ' ', v[1])]
                return v
            story = {k: ({f: one_line(x) for f, x in v.items()} if isinstance(v, dict) else v) for k, v in story.items()}
            title = story.get('title') or plan['title']
            texts.append((f'chapter:{rid}-{c}', title[1], title[0]))
            if c == 1:
                entry = next(nd for nd in plan['nodes'] if nd['id'] == plan['entry'])
                node_rows.append([rid, start, '1', 'start', str(max(20, entry['x'] - 70)), str(entry['y']), '1'] + [''] * 4 +
                                 [f'{P}node:{start}', f'{P}story:{start}', START_PORTRAIT.get(rid, ''), '', '', '', '', '', '', ''])
                texts.append((f'node:{start}', R['start'][1], R['start'][0]))
                texts.append((f'story:{start}', R['start'][3], R['start'][2]))
            edge_rows.append([rid, prev, plan['entry']])
            for f in plan['features']:
                feat_rows.append([rid, str(c), f['kind'], '; '.join(f'{x} {y}' for x, y in f['points'])])
            for nd in plan['nodes']:
                nid = nd['id']; s = story.get(nid)
                if not s:
                    missing.append(nid); s = {'name': [nid, nid], 'before': ['……', '...']}
                kind = {'elite': 'enemy'}.get(nd['kind'], nd['kind'])
                texts.append((f'node:{nid}', s['name'][1], s['name'][0]))
                texts.append((f'story:{nid}', s['before'][1], s['before'][0]))
                after = first = pass_ = ''
                if s.get('after'):
                    after = f'{P}after:{nid}'; texts.append((f'after:{nid}', s['after'][1], s['after'][0]))
                if nd['kind'] == 'supply':
                    fz, fe = s.get('first') or ['你们查抄了路霸的存货。', 'You take the bullies\' stores.']
                    pz, pe = s.get('pass') or ['当地百姓为你们备好了补给。', 'The people here have supplies ready for you.']
                    first, pass_ = f'{P}first:{nid}', f'{P}pass:{nid}'
                    texts.append((f'first:{nid}', fe, fz)); texts.append((f'pass:{nid}', pe, pz))
                goods = ('merchant-rebirth' if c >= 4 else 'merchant') if nd['kind'] == 'merchant' else ''
                node_rows.append([rid, nid, str(c), kind, str(nd['x']), str(nd['y']), str(nd['width']), nd['enemies'], f'{P}{rid}-{c}',
                                  str(nd['loot']), str(nd['exp']), f'{P}node:{nid}', f'{P}story:{nid}', s.get('portrait', ''),
                                  nd.get('unlock', ''), nd['generals'], goods, first, pass_, after, nd.get('prize', '')])
            for a, b in plan['edges']:
                edge_rows.append([rid, a, b])
            prev = plan['boss']
    if missing:
        print(f'{len(missing)} places with no story yet (e.g. {missing[:3]}): placeholders written', file=sys.stderr)

    def write(name, header, rows, note):
        with open(OUT / name, 'w', encoding='utf8', newline='') as f:
            f.write(note)
            w = csv.writer(f, lineterminator='\n'); w.writerow(header); w.writerows(rows)
    write('routes.csv', ['id', 'name', 'order', 'chapters', 'stage'], routes_rows,
          '# The starter trade routes (docs/design/gameplay.md §17.2): the Silk Road, the Tea-Horse Road, the Sea Route.\n'
          '# Written by scripts/trade-routes/gen.py. stage: chapter 1\'s difficulty for the drops (drops.csv; +1 a chapter).\n')
    write('nodes.csv', ['route', 'id', 'chapter', 'kind', 'x', 'y', 'width', 'enemies', 'pool', 'loot', 'exp', 'name', 'text',
                        'portrait', 'unlock', 'generals', 'goods', 'first', 'pass', 'after', 'prize'], node_rows,
          '# About a hundred places a chapter, each chapter its own land (user 2026-11-20); every place guarded until won.\n'
          '# Written by scripts/trade-routes/gen.py (change it there: layout.py, chapters.py, stories/). Enemies: a column\'s men by\n'
          '# difficulty, steep up to the top tier then +15% a difficulty; tier 2 + difficulty, 6 at most; within a chapter from its\n'
          '# difficulty - 0.2 at the way in to + 0.6 at the far end (the boss at the chapter\'s). Difficulty: the Silk Road 0-3, the\n'
          '# Tea-Horse Road 1.5-4.5, the Sea Route 3-6, +1 a chapter. prize: what the place gives the first time it is won (the\n'
          '# first of a thing new to the routes: starter-trade-routes; drops and merchants have it only after).\n')
    write('edges.csv', ['route', 'a', 'b'], edge_rows, '# Paths between the places (both ways).\n')
    write('features.csv', ['route', 'chapter', 'kind', 'points'], feat_rows,
          '# The land each chapter is drawn on (rivers, ranges, seas, lakes, islands, deserts, forests, marshes, walls, roads).\n')
    with open(OUT / 'i18n-routes.csv', 'w', encoding='utf8', newline='') as f:
        f.write('# The starter trade routes\' names, chapters and stories (sent as "starter-trade-routes.<key>").\n')
        w = csv.writer(f, lineterminator='\n'); w.writerow(['key', 'en', 'zh-CN']); w.writerows([[k, en, zh] for k, en, zh in texts])
    print(len(node_rows), 'places', len(edge_rows), 'paths', len(feat_rows), 'features', len(texts), 'texts')


if __name__ == '__main__':
    skeleton() if sys.argv[1:] == ['skeleton'] else tables()
