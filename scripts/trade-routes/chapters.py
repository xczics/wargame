# -*- coding: utf-8 -*-
# Each chapter of the starter routes (user 2026-11-20): its land (layout.py's recipe: each chapter its own), the things
# new to the routes that first turn up here (a prize place: user "商路特有的道具+转生丹，要设计一个首次出现节点"; drops
# and merchants have them only once it is won), and the trade orders its three key places open ("order:from>to:n";
# loss points off the trade's loss with each). Places about a hundred a chapter ("每个章节的节点数要要大大增加").
COUNT = 100

CHAPTERS = {
    # The Silk Road: out through the Jade Gate, over the sea of sand, past the Thousand Buddha caves to the oasis.
    ('silk', 1): dict(
        recipe=[('wall', ((0.02, 0.18), (0.45, 0.08))), ('range', ((0.1, 0.03), (0.95, 0.07))),
                ('desert', ((0.62, 0.6), (0.32, 0.3))), ('river', ('n', 's')), ('road', ('w', 'e'))],
        prizes=['veteran-squad', 'veteran-ten'],
        keys=['order:stone>wood:10000; loss:15', 'order:wood>food:12000; loss:15', 'order:food>stone:9000; loss:20']),
    ('silk', 2): dict(
        recipe=[('desert', ((0.5, 0.5), (0.48, 0.45))), ('lake', ((0.38, 0.42), (0.04, 0.05))),
                ('lake', ((0.78, 0.66), (0.03, 0.04))), ('range', ((0.15, 0.95), (0.85, 0.9))), ('road', ('w', 'e'))],
        prizes=['veteran-company'],
        keys=['order:wood>food:15000; loss:15', 'order:stone>wood:14000; loss:15', 'order:food>metal:6000; loss:20']),
    ('silk', 3): dict(
        recipe=[('range', ((0.05, 0.3), (0.55, 0.22))), ('range', ((0.5, 0.75), (0.98, 0.7))), ('river', ('n', 's')),
                ('forest', ((0.42, 0.55), (0.06, 0.22))), ('desert', ((0.8, 0.3), (0.18, 0.2)))],
        prizes=['rebirth-pill', 'build-order-xl'],
        keys=['order:food>stone:15000; loss:15', 'order:wood>metal:8000; loss:20', 'order:stone>gold:6000; loss:20']),
    ('silk', 4): dict(
        recipe=[('lake', ((0.55, 0.5), (0.09, 0.12))), ('forest', ((0.55, 0.5), (0.2, 0.28))),
                ('wall', ((0.78, 0.15), (0.8, 0.85))), ('river', ('w', 'e')), ('desert', ((0.15, 0.2), (0.15, 0.15))),
                ('desert', ((0.2, 0.85), (0.18, 0.12)))],
        prizes=['veteran-battalion', 'drill-order-xl'],
        keys=['order:metal>gold:6000; loss:20', 'order:stone>metal:8000; loss:20', 'order:gold>wood:12000; loss:25']),
    # The Tea-Horse Road: fog in the valleys, the gu villages in the forest, the cliff galleries, the snow mountain.
    ('tea', 1): dict(
        recipe=[('range', ((0.0, 0.08), (1.0, 0.15))), ('range', ((0.0, 0.93), (1.0, 0.86))), ('river', ('w', 'e')),
                ('forest', ((0.3, 0.3), (0.2, 0.15))), ('forest', ((0.7, 0.72), (0.22, 0.14))), ('marsh', ((0.55, 0.45), (0.08, 0.08)))],
        prizes=['study-order-xl'],
        keys=['order:food>wood:20000; loss:15', 'order:wood>stone:15000; loss:15', 'order:stone>food:18000; loss:20']),
    ('tea', 2): dict(
        recipe=[('forest', ((0.5, 0.5), (0.45, 0.42))), ('marsh', ((0.3, 0.65), (0.12, 0.12))), ('lake', ((0.7, 0.3), (0.06, 0.07))),
                ('river', ('n', 's')), ('marsh', ((0.82, 0.78), (0.1, 0.08)))],
        prizes=[],
        keys=['order:wood>stone:20000; loss:20', 'order:food>gold:8000; loss:20', 'order:stone>food:22000; loss:20']),
    ('tea', 3): dict(
        recipe=[('range', ((0.05, 0.2), (0.6, 0.35))), ('range', ((0.4, 0.8), (0.98, 0.6))), ('range', ((0.1, 0.7), (0.35, 0.95))),
                ('river', ('n', 's')), ('forest', ((0.75, 0.25), (0.15, 0.12)))],
        prizes=[],
        keys=['order:gold>metal:8000; loss:20', 'order:wood>food:24000; loss:20', 'order:metal>stone:12000; loss:25']),
    ('tea', 4): dict(
        recipe=[('range', ((0.0, 0.1), (0.5, 0.05))), ('range', ((0.5, 0.95), (1.0, 0.85))), ('range', ((0.2, 0.55), (0.45, 0.45))),
                ('lake', ((0.7, 0.4), (0.08, 0.1))), ('desert', ((0.35, 0.8), (0.2, 0.12))), ('forest', ((0.12, 0.35), (0.1, 0.12)))],
        prizes=['veteran-camp'],
        keys=['order:stone>gold:10000; loss:25', 'order:food>metal:12000; loss:25', 'order:wood>gold:11000; loss:30']),
    # The Sea Route: the harbour, the sea of fog, the mirage, the Abyss.
    ('sea', 1): dict(
        recipe=[('sea', ('s', 0.3)), ('river', ('n', 's')), ('wall', ((0.25, 0.55), (0.6, 0.6))),
                ('land', ((0.78, 0.88), (0.07, 0.05))), ('forest', ((0.2, 0.2), (0.15, 0.12)))],
        prizes=[],
        keys=['order:metal>food:15000; loss:20', 'order:gold>wood:12000; loss:20', 'order:stone>food:25000; loss:20']),
    ('sea', 2): dict(
        recipe=[('sea', ('e', 0.55)), ('land', ((0.62, 0.25), (0.06, 0.07))), ('land', ((0.75, 0.55), (0.07, 0.08))),
                ('land', ((0.88, 0.3), (0.05, 0.06))), ('land', ((0.9, 0.78), (0.06, 0.07))), ('marsh', ((0.25, 0.5), (0.1, 0.15)))],
        prizes=[],
        keys=['order:gold>wood:14000; loss:20', 'order:stone>food:28000; loss:25', 'order:food>metal:14000; loss:25']),
    ('sea', 3): dict(
        recipe=[('sea', ('n', 0.25)), ('desert', ((0.5, 0.6), (0.3, 0.2))), ('lake', ((0.3, 0.75), (0.05, 0.05))),
                ('land', ((0.6, 0.08), (0.06, 0.05))), ('range', ((0.8, 0.95), (0.95, 0.4)))],
        prizes=['veteran-army'],
        keys=['order:wood>metal:15000; loss:25', 'order:metal>gold:10000; loss:25', 'order:food>stone:30000; loss:30']),
    ('sea', 4): dict(
        recipe=[('sea', ('n', 0.2)), ('sea', ('s', 0.2)), ('land', ((0.5, 0.15), (0.08, 0.06))), ('land', ((0.3, 0.85), (0.07, 0.06))),
                ('range', ((0.55, 0.45), (0.75, 0.55))), ('marsh', ((0.2, 0.45), (0.08, 0.1)))],
        prizes=[],
        keys=['order:food>gold:15000; loss:30', 'order:wood>gold:15000; loss:30', 'order:stone>metal:20000; loss:30']),
}
