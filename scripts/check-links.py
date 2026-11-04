#!/usr/bin/env python3
"""Check every documentation link in the knowledge base.

For each URL: the page must answer 200 without redirecting to an index page, a
#anchor must exist on the page, and a #:~:text= fragment must occur in the page text.

Usage: python3 scripts/check-links.py [--cache DIR] [--json OUT]
"""
import argparse
import importlib.util
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from collections import defaultdict

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
spec = importlib.util.spec_from_file_location('deeplinks', os.path.join(ROOT, 'scripts', 'deep-links.py'))
dl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dl)


def collect():
    urls = defaultdict(set)

    def walk(x, where):
        if isinstance(x, dict):
            for k, v in x.items():
                if isinstance(v, str) and v.startswith('http') and (k in ('url', 'source_url', 'source', 'docs', 'enterprise_url', 'version_service_url') or k.endswith('_url')):
                    if '{' not in v:
                        urls[v].add(where)
                walk(v, where)
        elif isinstance(x, list):
            for v in x:
                walk(v, where)

    for f in sorted(os.listdir(os.path.join(ROOT, 'kb'))):
        if f.endswith('.json'):
            walk(json.load(open(os.path.join(ROOT, 'kb', f))), f)
    return urls


def final_url(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'upgrade-roadmap-linkcheck'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, url
    except Exception as e:  # noqa: BLE001
        return f'error: {e.__class__.__name__}', url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(ROOT, '.cache', 'pages'))
    ap.add_argument('--json')
    args = ap.parse_args()
    loc = dl.Locator(args.cache)
    urls = collect()
    status = {}
    problems = []
    for url in sorted(urls):
        base, _, frag = url.partition('#')
        if base not in status:
            status[base] = final_url(base)
        code, final = status[base]
        where = ', '.join(sorted(urls[url]))
        if code != 200:
            problems.append({'url': url, 'problem': f'HTTP {code}', 'in': where})
            continue
        b = base.rstrip('/')
        f = final.split('#')[0].rstrip('/')
        if f != b and (f.endswith('/docs/manual') or f.endswith('/release-notes') or f.count('/') < b.count('/') - 1):
            problems.append({'url': url, 'problem': f'redirects to {final}', 'in': where})
            continue
        if not frag or 'github.com' in base and re.match(r'L\d+$', frag):
            continue
        if frag.startswith(':~:text='):
            text = urllib.parse.unquote(frag[len(':~:text='):])
            if dl.norm(text) not in loc.page(base).text:
                problems.append({'url': url, 'problem': 'text fragment not found on page', 'in': where})
        elif 'github.com' not in base and 'jira' not in base:
            ids = {a[1] for a in loc.page(base).anchors}
            raw = dl.fetch(base, args.cache)
            if frag not in ids and f'id="{frag}"' not in raw:
                problems.append({'url': url, 'problem': f'anchor #{frag} not found', 'in': where})
    print(f'{len(urls)} links checked, {len(problems)} problems')
    for p in problems:
        print(f"  {p['problem']}: {p['url']}  ({p['in']})")
    if args.json:
        json.dump(problems, open(args.json, 'w'), indent=2)
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
