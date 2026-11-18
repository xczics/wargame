# -*- coding: utf-8 -*-
# Writes starter-trade-routes' routes.csv / nodes.csv / edges.csv and its story texts (i18n-routes.csv) from the routes'
# texts (silk.py, tea.py, sea.py: a dict per route, chapters keyed 1, 2, ...; a chapter added there is a chapter more on
# the route, nine places closing on its boss) and the difficulty curve below.
# Run: python3 scripts/trade-routes/gen.py   (then pnpm check; TRIES=2 pnpm sim test/sim/trade-routes.sim.ts to see
# who wins where)
import csv, importlib.util, pathlib
HERE = pathlib.Path(__file__).parent
OUT = HERE.parent.parent / 'src/plugins/starter-trade-routes/data'
P = 'starter-trade-routes.'
def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
ROUTES = []  # (id, order, data, difficulty of chapter 1)
for rid, order, mod, var, d0 in [('silk', 1, 'silk', 'SILK', 0.0), ('tea', 2, 'tea', 'TEA', 1.5), ('sea', 3, 'sea', 'SEA', 3.0)]:
    if (HERE / f'{mod}.py').exists(): ROUTES.append((rid, order, getattr(load(mod), var), d0))
FAMILIES = ['infantry', 'archer', 'cavalry']
# Who the story shows at a place (web/plugins/starter-trade-routes/portraits.ts), by (route, chapter, node); 0: the start.
PORTRAIT = {
 ('silk', 1, 'n2'): 'postmaster', ('silk', 1, 'b'): 'hawk', ('silk', 2, 'n6'): 'shen-du', ('silk', 2, 'b'): 'bandit-king',
 ('silk', 3, 'b'): 'gold-mask', ('silk', 4, 'n2'): 'bookkeeper', ('silk', 4, 'n7'): 'gold-mask', ('silk', 4, 'b'): 'oasis-king',
 ('tea', 0, 'start'): 'tax-clerk', ('tea', 1, 'b'): 'fog-master', ('tea', 2, 'n2'): 'gu-woman', ('tea', 2, 'b'): 'gu-king',
 ('tea', 3, 'n8'): 'lu-jiu', ('tea', 3, 'b'): 'lu-jiu', ('tea', 4, 'b'): 'mountain-god',
 ('sea', 0, 'start'): 'harbour-official', ('sea', 1, 'b'): 'dragon-king', ('sea', 2, 'b'): 'admiral',
 ('sea', 3, 'n5'): 'harbour-official', ('sea', 3, 'n8'): 'shen-du', ('sea', 4, 'n8'): 'shen-du', ('sea', 4, 'b'): 'ruins-lord',
}
# Each chapter's unlocks at its key node (n5), and the boss's points off the loss.
UNLOCK = {
 'silk': {1: 'order:stone>wood:10000', 2: 'order:wood>food:15000; loss:40', 3: 'order:food>stone:15000; loss:40', 4: 'order:metal>gold:6000; order:stone>metal:8000; loss:60'},
 'tea': {1: 'order:food>wood:20000; loss:30', 2: 'order:wood>stone:20000; loss:50', 3: 'order:gold>metal:8000; loss:50', 4: 'order:stone>gold:10000; order:food>metal:12000; loss:80'},
 'sea': {1: 'order:metal>food:15000; loss:50', 2: 'order:gold>wood:12000; order:stone>food:25000; loss:60', 3: 'order:wood>metal:15000; loss:80', 4: 'order:food>gold:15000; order:wood>gold:15000; loss:120'},
}
# A column's men by difficulty (user 2026-11-18, "前段指数、后段线性"). Up to the top tier (6, difficulty 4) a stage of
# the player's growth a difficulty: the anchors are about nine tenths of the men a team of that stage (heroes Lv 20 / 30
# / 45 / 60 / 75 / 90 leading tier 2-6, nothing worn, no research) beats a boss with half the time, so a boss takes the
# whole team and some luck and the camps before it are easy. 6: past a bare Lv 90 team (gear, research, rebirth). Then
# a tenth and a half of that more each difficulty: what the heroes grow by then is the slow part (gear, research,
# rebirth), not the steep part (tiers), so a route can go on for many chapters without a wall.
ANCHORS = [2050, 2970, 4100, 8000, 18500, 23100, 36000]
SLOPE = 0.15
def men_at(d):
    top = len(ANCHORS) - 1
    if d >= top: return ANCHORS[top] * (1 + SLOPE * (d - top))
    i = int(d); f = d - i
    return ANCHORS[i] * (ANCHORS[i + 1] / ANCHORS[i]) ** f
# Who leads each enemy column (user 2026-11-18: "普通小兵，一开始群龙无首，到后面相当于3-5级酒馆招募得到的英雄属性，越往后面
# 敌方英雄也越牛逼"; "像不同阶段的玩家能养出来的英雄"): an NPC hero "<venue>/<venue level>/<level>" (the npc-heroes plugin
# draws it the way the tavern does and spends its free points as a player would). The player's hero level by difficulty
# (the stages the anchors are fitted to), +3 a difficulty past the last. 暂按: a column leaderless below difficulty 1,
# then a hero of a tavern at level 2 + difficulty raised to seven tenths of that level; a boss's elite column (the middle
# one) from the first chapter on, a tavern two levels better, at the full level.
STAGE_LEVELS = [20, 30, 45, 60, 75, 90, 90]
def stage_level(d):
    top = len(STAGE_LEVELS) - 1
    if d >= top: return STAGE_LEVELS[top] + 3 * (d - top)
    i = int(d); f = d - i
    return STAGE_LEVELS[i] + (STAGE_LEVELS[i + 1] - STAGE_LEVELS[i]) * f
def general(d, elite=False):
    if elite: return f'tavern/{max(1, round(4 + d))}/{max(1, round(stage_level(d)))}'
    if d < 1: return ''
    return f'tavern/{max(1, round(2 + d))}/{max(1, round(0.7 * stage_level(d)))}'
def generals(kind, d):
    if kind == 'enemy': return general(d)
    if kind == 'enemy2': return ' | '.join([general(d)] * 3)
    if kind == 'supply': return general(d)
    if kind == 'boss': return ' | '.join([general(d), general(d, True), general(d), general(d), general(d)])
    return ''
def column(d, i, scale=1.0, tier_up=0):
    men = round(men_at(d) * scale / 10) * 10
    tier = min(6, 2 + int(d) + tier_up)
    return f'{FAMILIES[i % 3]}-{tier}:{men}'
def enemies(kind, d, k):
    if kind == 'enemy': return column(d, k)
    if kind == 'enemy2': return ' | '.join([column(d, k, 0.8), column(d, k + 1, 0.8), column(d, k + 2, 0.6)])
    if kind == 'supply': return column(d, k + 1, 0.7)
    if kind == 'boss': return ' | '.join([column(d, k, 0.9), column(d, k + 1, 2.2, 1), column(d, k + 2, 0.9), column(d, k, 0.7), column(d, k + 2, 0.7)])
    return ''
LAYOUT = {'n1': (60, 200), 'n2': (60, 500), 'n3': (60, 800), 'n4': (125, 250), 'n5': (125, 500), 'n6': (125, 750), 'n7': (190, 350), 'n8': (190, 650), 'b': (245, 500)}
LINKS = [('in', 'n1'), ('in', 'n2'), ('in', 'n3'), ('n1', 'n4'), ('n2', 'n4'), ('n2', 'n5'), ('n3', 'n5'), ('n3', 'n6'), ('n4', 'n7'), ('n5', 'n7'), ('n5', 'n8'), ('n6', 'n8'), ('n7', 'b'), ('n8', 'b')]
routes_rows, node_rows, edge_rows, texts = [], [], [], []
q = lambda s: '"' + s.replace('"', '""') + '"'
for rid, order, R, d0 in ROUTES:
    count = max(k for k in R if isinstance(k, int))
    chapters = [f'{P}chapter:{rid}-{c}' for c in range(1, count + 1)]
    routes_rows.append([rid, f'{P}route:{rid}', str(order), '; '.join(chapters), str(d0 + 1)])
    texts.append((f'route:{rid}', R['name'][1], R['name'][0]))
    sname, sen, szh, sstory_en = R['start'][1], R['start'][1], R['start'][0], R['start'][3]
    start = f'{rid}-0'
    node_rows.append([rid, start, '1', 'start', '10', '500', '1', '', '', '', '', f'{P}node:{start}', f'{P}story:{start}', PORTRAIT.get((rid, 0, 'start'), ''), '', ''])
    texts.append((f'node:{start}', R['start'][1], R['start'][0]))
    texts.append((f'story:{start}', R['start'][3], R['start'][2]))
    entry = start
    for c in range(1, count + 1):
        ch = R[c]; d = d0 + c - 1
        texts.append((f'chapter:{rid}-{c}', ch['title'][1], ch['title'][0]))
        x0 = (c - 1) * 250 + 10
        for k, key in enumerate(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'b']):
            zh_name, en_name, kind, zh, en = ch[key]
            nid = f'{rid}-{c}-{key}'
            real = {'enemy2': 'enemy'}.get(kind, kind)
            width = 3 if kind == 'boss' else 2 if kind == 'enemy2' else 1
            guarded = kind in ('enemy', 'enemy2', 'supply', 'boss')
            ex = 3000 * 1.35 ** d * {'enemy': 1, 'enemy2': 1.3, 'supply': 0.7, 'boss': 4}.get(kind, 0)
            loot = round((1 + 0.3 * d) * (3 if kind == 'boss' else 1), 2)
            pool = f'{P}{rid}-{c}' if guarded else ('merchant-rebirth' if c >= 4 else 'merchant') if kind == 'merchant' else ''
            unlock = UNLOCK[rid].get(c, '') if key == 'n5' else (f'loss:{20 + 10 * c}' if kind == 'boss' else '')
            x, y = LAYOUT[key]
            node_rows.append([rid, nid, str(c), real, str(x0 + x), str(y), str(width), enemies(kind, d, k), pool, str(loot) if guarded else '', str(round(ex / 10) * 10) if ex else '', f'{P}node:{nid}', f'{P}story:{nid}', PORTRAIT.get((rid, c, key), ''), unlock, generals(kind, d)])
            texts.append((f'node:{nid}', en_name, zh_name))
            texts.append((f'story:{nid}', en, zh))
        for a, b in LINKS:
            edge_rows.append([rid, entry if a == 'in' else f'{rid}-{c}-{a}', f'{rid}-{c}-{b}'])
        entry = f'{rid}-{c}-b'
def write(name, header, rows, note):
    with open(OUT / name, 'w', encoding='utf8', newline='') as f:
        f.write(note)
        w = csv.writer(f, lineterminator='\n'); w.writerow(header); w.writerows(rows)
write('routes.csv', ['id', 'name', 'order', 'chapters', 'stage'], routes_rows, '# The starter trade routes (docs/design/gameplay.md §17.2): the Silk Road, the Tea-Horse Road, the Sea Route.\n# stage: chapter 1\'s difficulty for the drops (drops.csv; +1 a chapter).\n')
write('nodes.csv', ['route', 'id', 'chapter', 'kind', 'x', 'y', 'width', 'enemies', 'pool', 'loot', 'exp', 'name', 'text', 'portrait', 'unlock', 'generals'], node_rows,
      '# Each chapter a net of nine nodes closing on its boss, the next chapter\'s way in (user 2026-11-16: "每章的boss同时对应\'网\'的收束节点").\n'
      '# Written by scripts/trade-routes/gen.py (change it there). Enemies: a column\'s men by difficulty, steep up to the top tier\n'
      '# then +15% a difficulty (the curve: gen.py); tier 2 + difficulty, 6 at most. Difficulty: the Silk Road 0-3, the Tea-Horse\n'
      '# Road 1.5-4.5, the Sea Route 3-6 (user: each opens about at the middle of the one before), +1 a chapter.\n'
      '# Exp a hero: 3,000 x 1.35^difficulty (x4 a boss). generals: each column\'s NPC hero (<venue>/<venue level>/<level>; gen.py).\n')
write('edges.csv', ['route', 'a', 'b'], edge_rows, '# Paths between the nodes (both ways).\n')
with open(OUT / 'i18n-routes.csv', 'w', encoding='utf8', newline='') as f:
    f.write('# The starter trade routes\' names, chapters and stories (sent as "starter-trade-routes.<key>").\n')
    w = csv.writer(f, lineterminator='\n'); w.writerow(['key', 'en', 'zh-CN']); w.writerows([[k, en, zh] for k, en, zh in texts])
print(len(node_rows), 'nodes', len(edge_rows), 'edges', len(texts), 'texts')
