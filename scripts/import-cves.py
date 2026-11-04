#!/usr/bin/env python3
"""Import MongoDB Server CVEs from the official security bulletins page into kb/cves.json.

Each bulletin row reads like:
  CVE-2026-82067 9.2 <title> ... Affects: MongoDB Server Versions:
  8.3.0 affects versions prior to 8.3.9 8.0.0 affects versions prior to 8.0.30 ...
Only server CVEs with CVSS >= --min-cvss (default 7.0) are kept, with the fixed
patch per series. Existing entries that are not on the page (for example older
ones added by hand) are kept.

Usage: python3 scripts/import-cves.py [--min-cvss 7.0] [--html FILE]
"""
import argparse
import html
import json
import os
import re
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
URL = 'https://www.mongodb.com/resources/products/mongodb-security-bulletins'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--min-cvss', type=float, default=7.0)
    ap.add_argument('--html', help='use a saved copy of the page instead of downloading it')
    args = ap.parse_args()
    raw = open(args.html, encoding='utf-8', errors='replace').read() if args.html else \
        urllib.request.urlopen(urllib.request.Request(URL, headers={'User-Agent': 'upgrade-roadmap'}), timeout=60).read().decode('utf-8', 'replace')
    # One card per bulletin: date, CVE id, score, <h4> title, product, version lines, reference link.
    found = {}
    cards = re.split(r'(?=<div class="AlertsCardGrid__Header)', raw)
    clean = lambda x: re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', x))).strip()
    for card in cards:
        m = re.search(r'<strong>(CVE-\d{4}-\d+)</strong>', card)
        if not m:
            continue
        cve = m.group(1)
        score = re.search(r'<small><b>(\d+(?:\.\d)?)</b></small>', card)
        score = float(score.group(1)) if score else 0.0
        title = re.search(r'<h4[^>]*>(.*?)</h4>', card, re.S)
        date = re.search(r'<strong>(\d{2}/\d{2}/\d{4})</strong>', card)
        ref = re.search(r'href="(https://jira\.mongodb\.org/browse/[A-Z]+-\d+)"', card)
        products = [clean(x) for x in re.findall(r'<p class="m-t-0 m-b-10"><b>(.*?)</b></p>', card, re.S)]
        if score < args.min_cvss or not any(pr == 'MongoDB Server' for pr in products):
            continue
        # Version lines follow the "MongoDB Server" product block.
        # Only the version paragraph that follows the "MongoDB Server" product line;
        # other products (drivers, tools) in the same card have their own version lists.
        server_block = card.split('<b>MongoDB Server</b>', 1)[1]
        vm = re.search(r'Versions:</div>\s*<p[^>]*>(.*?)</p>', server_block, re.S)
        # Older cards put the versions inline: "MongoDB Server versions: 4.0 affects versions prior to 4.0.9 ...".
        server_block = vm.group(1) if vm else re.split(r'<div class="AlertsCardGrid__Footer|<b>', server_block)[0]
        affected = []
        for a in re.finditer(r'(\d+\.\d+)(?:\.\d+)? affects versions prior to (\d+\.\d+\.\d+)', clean(server_block)):
            maj = a.group(1)
            # Server series only (3.0 ... 9.x) and a fix in the same series.
            if not re.fullmatch(r'[3-9]\.\d', maj) or not a.group(2).startswith(maj + '.'):
                continue
            if not any(x['major'] == maj for x in affected):
                affected.append({'major': a.group(1), 'fixed_in': a.group(2)})
        if not affected:
            continue
        mm, dd, yy = date.group(1).split('/') if date else ('', '', '')
        found[cve] = {'id': cve, 'cvss': score, 'severity': 'critical' if score >= 9 else 'high',
                      'title': clean(title.group(1)) if title else cve, 'date': f'{yy}-{mm}-{dd}' if date else None,
                      'url': ref.group(1) if ref else f'https://www.cve.org/CVERecord?id={cve}', 'source': URL, 'affected': affected}

    path = os.path.join(ROOT, 'kb', 'cves.json')
    data = json.load(open(path))
    old = {c['id']: c for c in data.get('cves', [])}
    for cve, c in found.items():
        for a in old.get(cve, {}).get('affected', []):
            if a.get('fixed_in') is None and not any(x['major'] == a['major'] for x in c['affected']):
                c['affected'].append(a)
    kept = [c for c in data.get('cves', []) if c['id'] not in found]
    data['cves'] = sorted(kept + list(found.values()), key=lambda c: (-c.get('cvss', 0), c['id']))
    data['retrieved_from'] = URL
    data['min_cvss'] = args.min_cvss
    json.dump(data, open(path, 'w'), indent=2)
    print(f'{len(found)} CVEs imported (CVSS >= {args.min_cvss}), {len(kept)} kept, {len(data["cves"])} total')


if __name__ == '__main__':
    main()
