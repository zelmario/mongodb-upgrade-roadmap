#!/usr/bin/env python3
"""Point every documentation link in the KB at the exact section it comes from.

For each cited page we download the HTML, collect the heading anchors, and place
each item at the heading that contains its quote (or whose title matches the
step heading). mongodb.com and docs.percona.com get "#anchor"; MongoDB's archived
docs source on GitHub (3.4 to 6.0) gets a line anchor "#L123" on the blob URL.

Usage: python3 scripts/deep-links.py [--cache DIR]
"""
import argparse
import hashlib
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
KB = os.path.join(ROOT, 'kb')


def norm(s):
    s = html.unescape(s or '').lower()
    s = re.sub(r'[‘’“”"\'`]', '', s)
    s = re.sub(r'[^a-z0-9.$]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


class Page(HTMLParser):
    """Flattens a page into text and remembers where each heading anchor starts."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.size = [], 0
        self.anchors = []          # (text offset, id, heading text)
        self.heading = None        # [id, text] while inside h1-h6
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('script', 'style', 'svg'):
            self.skip += 1
        if re.fullmatch(r'h[1-6]', tag):
            self.heading = [a.get('id'), '']
        elif self.heading is not None and a.get('id') and not self.heading[0]:
            self.heading[0] = a['id']

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'svg') and self.skip:
            self.skip -= 1
        if re.fullmatch(r'h[1-6]', tag) and self.heading is not None:
            hid, text = self.heading
            if hid:
                self.anchors.append((self.size, hid, norm(text)))
            self.heading = None
            self._add(' ')

    def handle_data(self, data):
        if self.skip:
            return
        if self.heading is not None:
            self.heading[1] += data
        self._add(data)

    def _add(self, data):
        t = norm(data)
        if t:
            self.parts.append(t + ' ')
            self.size += len(t) + 1

    @property
    def text(self):
        return ''.join(self.parts)


def fetch(url, cache):
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, hashlib.sha1(url.encode()).hexdigest())
    if os.path.exists(path):
        return open(path, encoding='utf-8', errors='replace').read()
    req = urllib.request.Request(url, headers={'User-Agent': 'upgrade-roadmap-deeplinks'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode('utf-8', errors='replace')
    except Exception as e:  # noqa: BLE001
        print(f'  fetch failed {url}: {e}', file=sys.stderr)
        body = ''
    open(path, 'w', encoding='utf-8').write(body)
    return body


def needles(quote):
    """Pieces of a quote to look for: the doc text may have elisions ("...")."""
    out = []
    for piece in re.split(r'\.\.\.|…', quote or ''):
        n = norm(piece)
        if len(n) >= 25:
            out.append(n[:90])
    return sorted(out, key=len, reverse=True)


class Locator:
    def __init__(self, cache):
        self.cache, self.pages, self.raw = cache, {}, {}

    def page(self, url):
        if url not in self.pages:
            p = Page()
            p.feed(fetch(url, self.cache))
            self.pages[url] = p
        return self.pages[url]

    def by_heading(self, url, heading):
        h = norm(heading).rstrip('.')
        if not h:
            return None
        p = self.page(url)
        for _, hid, text in p.anchors:
            if text.rstrip('.') == h:
                return hid
        for _, hid, text in p.anchors:
            if text.startswith(h) or h.startswith(text) and len(text) > 8:
                return hid
        return None

    def by_text(self, url, *texts):
        p = self.page(url)
        full = p.text
        for t in texts:
            if not t:
                continue
            cands = needles(t) or ([norm(t).rstrip('.')] if len(norm(t)) >= 12 else [])
            for n in cands:
                pos = full.find(n)
                if pos >= 0:
                    best = None
                    for off, hid, _ in p.anchors:
                        if off <= pos:
                            best = hid
                        else:
                            break
                    return best
        return None

    def text_fragment(self, url, *snippets):
        full = self.page(url).text
        for snip in snippets:
            if not snip:
                continue
            raw = re.split(r'\.\.\.|\u2026', snip)[0]
            raw = re.sub(r'\s+', ' ', raw).strip().rstrip(':.;,')
            words = raw.split(' ')
            # 3 to 9 words of verbatim text, and they must occur on the page
            for n in (9, 7, 5, 3):
                if len(words) < 3:
                    break
                piece = ' '.join(words[:n])
                if norm(piece) and len(norm(piece)) >= 12 and norm(piece) in full and full.count(norm(piece)) == 1:
                    return urllib.parse.quote(piece, safe='')
        # Same text more than once (apt and yum tabs): the browser jumps to the first one.
        for snip in snippets:
            raw = re.sub(r'\s+', ' ', re.split(r'\.\.\.|\u2026', snip or '')[0]).strip().rstrip(':.;,')
            if len(norm(raw)) >= 12 and norm(raw) in full:
                return urllib.parse.quote(' '.join(raw.split(' ')[:9]), safe='')
        return None

    # ---- GitHub docs source: blob URL with a line anchor ----
    def github_line(self, url, heading=None, *texts):
        m = re.match(r'https://(?:raw\.githubusercontent\.com|github\.com)/mongodb/docs/(?:blob/)?([^/]+)/(.+?)(?:#.*)?$', url)
        if not m:
            return None
        branch, path = m.groups()
        raw_url = f'https://raw.githubusercontent.com/mongodb/docs/{branch}/{path}'
        if raw_url not in self.raw:
            self.raw[raw_url] = fetch(raw_url, self.cache).splitlines()
        lines = self.raw[raw_url]
        normed = [norm(l) for l in lines]
        blob = f'https://github.com/mongodb/docs/blob/{branch}/{path}'
        hit = self._find_lines(lines, heading, texts)
        if hit is not None:
            return f'{blob}#L{hit + 1}'
        # Steps usually live in included files: .. include:: /includes/steps-6.0-upgrade-replica-set.rst
        for inc in re.findall(r'^\s*\.\. include:: (/includes/\S+)', '\n'.join(lines), re.M):
            stem = inc.rsplit('.', 1)[0]
            # Generated step files: /includes/steps/X.rst comes from source/includes/steps-X.yaml
            alts = [f'source{stem}{ext}' for ext in ('.yaml', '.rst', '.txt')]
            if stem.startswith('/includes/steps/'):
                alts.insert(0, 'source/includes/steps-' + stem.split('/includes/steps/')[1] + '.yaml')
            for ipath in alts:
                iraw = f'https://raw.githubusercontent.com/mongodb/docs/{branch}/{ipath}'
                if iraw not in self.raw:
                    body = fetch(iraw, self.cache)
                    self.raw[iraw] = [] if body.startswith('404') or not body else body.splitlines()
                ilines = self.raw[iraw]
                if not ilines:
                    continue
                hit = self._find_lines(ilines, heading, texts)
                if hit is not None:
                    return f'https://github.com/mongodb/docs/blob/{branch}/{ipath}#L{hit + 1}'
        return blob

    def _find_lines(self, lines, heading, texts):
        normed = [norm(l) for l in lines]
        if heading:
            h = norm(heading).rstrip('.')
            for i, l in enumerate(normed):
                l2 = re.sub(r'^(step|title|procedure|topic)\s+', '', l).rstrip('.')
                if h and (l2 == h or (h in l2 and len(l2) <= len(h) + 12)):
                    return i
        for t in texts:
            for n in needles(t):
                for i in range(len(normed)):
                    if n[:50] in ' '.join(normed[i:i + 6]):
                        return i
        return None



def anchored(loc, url, heading=None, *texts):
    if not url or not url.startswith('http'):
        return url
    base = url.split('#')[0]
    if 'github' in base and '/mongodb/docs/' in base:
        return loc.github_line(base, heading, *texts) or url
    if not re.search(r'(mongodb\.com/docs|docs\.percona\.com)', base):
        return url
    hid = loc.by_heading(base, heading) if heading else None
    if hid:
        return f'{base}#{hid}'
    # No heading of its own (a list item, a paragraph): link to the exact text.
    # Text fragments are supported by Chrome, Edge, Safari and Firefox 131+.
    frag = loc.text_fragment(base, heading, *texts)
    if frag:
        return f'{base}#:~:text={frag}'
    hid = loc.by_text(base, heading, *texts)
    return f'{base}#{hid}' if hid else base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(ROOT, '.cache', 'pages'))
    args = ap.parse_args()
    loc = Locator(args.cache)
    stats = {'anchored': 0, 'page only': 0}

    def count(old, new):
        stats['anchored' if new and ('#' in new) else 'page only'] += 1

    # 1. checks in changes.json, distributions.json and operator.json
    for fname in ('changes.json', 'distributions.json', 'operator.json'):
        path = os.path.join(KB, fname)
        data = json.load(open(path))
        lists = [data.get('items', [])]
        for sw in data.get('switches', []):
            lists.append(sw.get('blockers', []))
        for items in lists:
            for it in items:
                if it.get('source_url'):
                    new = anchored(loc, it['source_url'], None, it.get('quote'), it.get('title'), it.get('action'))
                    count(it['source_url'], new)
                    it['source_url'] = new
        json.dump(data, open(path, 'w'), indent=2, ensure_ascii=False)
        print(f'{fname}: done')

    # 2. official steps and prerequisites: one link per step, at its own heading
    path = os.path.join(KB, 'official-steps.json')
    data = json.load(open(path))

    def walk_entry(entry):
        url = entry.get('url')
        if not url:
            return
        for group in ('prerequisites', 'steps'):
            for st in entry.get(group, []) or []:
                st['url'] = anchored(loc, url, st.get('doc_heading'), st.get('text'))
                count(url, st['url'])
                for sub in st.get('substeps', []) or []:
                    sub['url'] = st['url']

    for key in ('mongodb', 'psmdb'):
        for target, block in data.get(key, {}).items():
            entries = []
            if 'url' in block:
                entries.append(block)
            for k, v in block.items():
                if isinstance(v, dict):
                    if 'url' in v:
                        entries.append(v)
                    else:
                        entries.extend(x for x in v.values() if isinstance(x, dict) and 'url' in x)
            for e in entries:
                walk_entry(e)
    json.dump(data, open(path, 'w'), indent=2, ensure_ascii=False)
    print('official-steps.json: done')

    # 3. avoid list and minimum-patch rules
    path = os.path.join(KB, 'releases.json')
    data = json.load(open(path))
    for a in data.get('avoid', []) + data.get('upgrade_min_patch', []):
        if a.get('url'):
            new = anchored(loc, a['url'], None, a.get('quote'))
            count(a['url'], new)
            a['url'] = new
    json.dump(data, open(path, 'w'), indent=2, ensure_ascii=False)
    print('releases.json: done')

    print(json.dumps(stats))


if __name__ == '__main__':
    main()
