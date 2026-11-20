# -*- coding: utf-8 -*-
# Checks a chapter's stories against its skeleton (bible.md, section 三): every place written, a name and the story's two
# parts in Chinese and English, a supply point's first / pass, lengths, portraits known.
#   python3 scripts/trade-routes/check_story.py silk-1        (stories/silk-1.json, or its parts stories/silk-1.part*.json)
import json, pathlib, re, sys
HERE = pathlib.Path(__file__).parent
PORTRAITS = {'bookkeeper', 'oasis-king', 'lu-jiu', 'mountain-god', 'shen-du', 'postmaster', 'hawk', 'bandit-king', 'gold-mask',
             'tax-clerk', 'fog-master', 'gu-woman', 'gu-king', 'harbour-official', 'dragon-king', 'admiral', 'ruins-lord'}
CJK = re.compile(r'[一-鿿]')


def load(name):
    whole = HERE / 'stories' / f'{name}.json'
    if whole.exists(): return json.loads(whole.read_text(encoding='utf8'))
    out = {}
    for part in sorted((HERE / 'stories').glob(f'{name}.part*.json')):
        out.update(json.loads(part.read_text(encoding='utf8')))
    return out


def check(name):
    skel = json.loads((HERE / 'skeleton' / f'{name}.json').read_text(encoding='utf8'))
    story = load(name)
    problems = []
    if not (isinstance(story.get('title'), list) and len(story['title']) == 2): problems.append('title: [zh, en] missing')
    names = set()
    for nd in skel['nodes']:
        s = story.get(nd['id'])
        if not s: problems.append(f"{nd['id']}: missing"); continue
        parts = ['name', 'before', 'after'] + (['first', 'pass'] if nd['kind'] == 'supply' else [])
        for k in parts:
            v = s.get(k)
            if not (isinstance(v, list) and len(v) == 2 and all(isinstance(x, str) and x.strip() for x in v)):
                problems.append(f"{nd['id']}.{k}: [zh, en] missing"); continue
            zh, en = v
            if not CJK.search(zh): problems.append(f"{nd['id']}.{k}: the first is not Chinese")
            if CJK.search(en): problems.append(f"{nd['id']}.{k}: the second has Chinese in it")
        if isinstance(s.get('name'), list) and s['name'][0] in names: problems.append(f"{nd['id']}: name {s['name'][0]} used twice")
        if isinstance(s.get('name'), list): names.add(s['name'][0])
        if isinstance(s.get('before'), list) and len(s['before'][0]) < 40: problems.append(f"{nd['id']}.before: too short ({len(s['before'][0])})")
        if isinstance(s.get('after'), list) and len(s['after'][0]) < 20: problems.append(f"{nd['id']}.after: too short ({len(s['after'][0])})")
        if s.get('portrait') and s['portrait'] not in PORTRAITS: problems.append(f"{nd['id']}: no portrait {s['portrait']}")
    extra = set(story) - {nd['id'] for nd in skel['nodes']} - {'title'}
    if extra: problems.append(f'not in the skeleton: {sorted(extra)[:5]}')
    print(f"{name}: {len(skel['nodes'])} places, {len(problems)} problems")
    for p in problems[:40]: print('  ', p)
    return not problems


if __name__ == '__main__':
    ok = all(check(n) for n in sys.argv[1:])
    sys.exit(0 if ok else 1)
