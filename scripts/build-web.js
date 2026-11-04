#!/usr/bin/env node
// Inline the knowledge base, planner and renderer into one HTML file.
//   dist/mongodb-upgrade-roadmap.html  page body only (for hosts that add the document skeleton)
//   dist/index.html            full standalone document, opens from disk or any web server
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadKb } from '../src/load-kb.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const stripModule = (code) => code.replace(/^import .*$/gm, '').replace(/^export /gm, '');

const kb = loadKb();

// Example drivers for the demo state: a driver that is fine on the source but
// too old for a later hop, so the first view shows what the check does.
const exampleDrivers = [];
for (const key of ['java-sync', 'pymongo', 'node']) {
  const d = kb.drivers.drivers[key];
  if (d?.min_for_server?.['6.0'] && d.min_for_server['8.0'] && d.min_for_server['6.0'] !== d.min_for_server['8.0']) {
    exampleDrivers.push({ key, version: d.min_for_server['6.0'] });
  }
}

const rel60 = kb.releases?.releases?.psmdb?.['6.0'] ?? [];
const exampleFrom = rel60.length > 2 ? rel60[rel60.length - 3].version : '6.0.19-16';

const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const body = src('web/app.html')
  .replace('/*__PLANNER__*/', () => stripModule(src('src/planner.js')))
  .replace('/*__RENDER__*/', () => stripModule(src('src/render.js')))
  .replace('/*__KB__*/', () => json(kb))
  .replace('/*__BUILD__*/', () => json({ date: new Date().toISOString().slice(0, 10), exampleDrivers, exampleFrom }));

for (const marker of ['__PLANNER__', '__RENDER__', '__KB__', '__BUILD__']) {
  if (body.includes(marker)) throw new Error(`Marker ${marker} was not replaced`);
}

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/mongodb-upgrade-roadmap.html'), body);
writeFileSync(join(root, 'dist/index.html'),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`);
console.log(`Built dist/index.html and dist/mongodb-upgrade-roadmap.html (${(body.length / 1024).toFixed(0)} KB, ${kb.changes.items.length} KB entries, ${Object.keys(kb.drivers.drivers).length} drivers)`);
