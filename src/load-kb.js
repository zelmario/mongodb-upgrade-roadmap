// Node-only loader. A browser page fetches the same JSON files instead.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'kb');
const read = (name, dir) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));

export function loadKb(dir = KB_DIR) {
  return {
    versions: read('versions', dir),
    changes: read('changes', dir),
    procedures: read('procedures', dir),
    components: read('components', dir),
    cves: read('cves', dir),
    drivers: read('drivers', dir),
    distributions: read('distributions', dir),
    releases: read('releases', dir),
    operator: read('operator', dir),
    series: read('series', dir),
    official: read('official-steps', dir),
    expected: read('expected-outputs', dir),
    os: read('os-support', dir),
    patch: read('patch-steps', dir),
  };
}
