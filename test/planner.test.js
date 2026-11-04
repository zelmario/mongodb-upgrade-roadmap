import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKb } from '../src/load-kb.js';
import { buildRoadmap, compareVersions, majorOf, planPath, seriesFor, findPath, reachableFrom } from '../src/planner.js';
import { renderMarkdown } from '../src/render.js';

const kb = loadKb();
const ids = (items) => items.map((i) => i.id);
const flat = (xs) => (xs ?? []).flatMap((x) => [x, ...flat(x.substeps)]);
const cmds = (h) => [...h.steps, ...flat(h.official?.order), ...flat(h.official?.node)].map((x) => x.cmd ?? '').join('\n');

test('version parsing handles PSMDB build suffixes', () => {
  assert.equal(majorOf('7.0.14-8'), '7.0');
  assert.equal(compareVersions('7.0.14-8', '7.0.14-9'), -1);
  assert.equal(compareVersions('2.6.0', '2.10.0'), -1);
  assert.equal(compareVersions('8.0', '8.0.0'), 0);
});

test('path goes one major at a time', () => {
  assert.deepEqual(planPath('5.0.14', '8.0', kb.versions.majors), ['5.0', '6.0', '7.0', '8.0']);
  assert.deepEqual(planPath('3.2.22', '4.0', kb.versions.majors), ['3.2', '3.4', '3.6', '4.0']);
  assert.throws(() => planPath('7.0.1', '6.0', kb.versions.majors), /older/);
});

test('rapid releases are rejected with a clear message', () => {
  assert.throws(() => buildRoadmap({ from: '6.3.1', to: '7.0' }, kb), /not a Percona Server for MongoDB release series/);
});

test('FCV behind the binaries is a blocker', () => {
  const r = buildRoadmap({ from: '6.0.19', to: '7.0', fcv: '5.0' }, kb);
  assert.match(r.blockers[0], /FCV is "5.0" but binaries are 6.0/);
});

test('transitional FCV is a blocker', () => {
  const r = buildRoadmap({ from: '6.0.19', to: '7.0', fcv: 'upgrading to 7.0' }, kb);
  assert.match(r.blockers[0], /transitional/);
});

test('setFCV gets confirm: true from 7.0', () => {
  const r = buildRoadmap({ from: '5.0.14', to: '7.0' }, kb);
  assert.match(cmds(r.hops[0]), /setFeatureCompatibilityVersion: "6.0" \}/);
  assert.match(cmds(r.hops[1]), /setFeatureCompatibilityVersion: "7.0", confirm: true/);
});

test('sharded 5.0 to 6.0 hop includes OP_QUERY blocker and no unsourced flushRouterConfig', () => {
  const r = buildRoadmap({ from: '5.0.14', to: '6.0', topology: 'sharded' }, kb);
  const hop = r.hops[0];
  assert.ok(!ids(hop.post).includes('flush-router-config'));
  assert.ok(ids(hop.preflight).includes('legacy-opcodes-removed'));
});

test('replica set does not get sharded-only items', () => {
  const r = buildRoadmap({ from: '5.0.14', to: '6.0', topology: 'replset' }, kb);
  assert.ok(!ids(r.hops[0].post).includes('flush-router-config'));
  assert.ok(!ids(r.hops[0].preflight).includes('sharded-metadata-hygiene'));
});

test('AVX check only on x86_64 when arch is given', () => {
  const arm = buildRoadmap({ from: '4.4.29', to: '5.0', arch: 'aarch64' }, kb);
  assert.ok(!ids(arm.hops[0].preflight).includes('avx-required'));
  const x86 = buildRoadmap({ from: '4.4.29', to: '5.0', arch: 'x86_64' }, kb);
  assert.ok(ids(x86.hops[0].preflight).includes('avx-required'));
});

test('old PBM is a blocker for the 7.0 hop', () => {
  const r = buildRoadmap({ from: '6.0.19', to: '7.0', components: { pbm: '2.3.0' } }, kb);
  assert.ok(r.blockers.some((b) => b.includes('2.3.0 is below 2.3.1')));
  const ok = buildRoadmap({ from: '6.0.19', to: '7.0', components: { pbm: '2.3.1' } }, kb);
  assert.equal(ok.blockers.length, 0);
});

test('rollback rule switches at 7.0', () => {
  const r = buildRoadmap({ from: '5.0.14', to: '8.0' }, kb);
  assert.match(r.hops[0].rollback.beforeSetFcv, /Binary rollback is supported/);
  assert.match(r.hops[1].rollback.beforeSetFcv, /not supported for MongoDB Community/);
  assert.match(r.hops[2].rollback.afterSetFcv, /transitionToDedicatedConfigServer/);
  assert.ok(r.hops.every((h) => h.rollback.sourceUrl));
});

test('pre-FCV hops have no setFCV step and no rollback block', () => {
  const r = buildRoadmap({ from: '3.0.15', to: '3.4' }, kb);
  assert.equal(r.hops[0].rollback, null);
  assert.doesNotMatch(cmds(r.hops[0]), /setFeatureCompatibilityVersion/);
  assert.match(cmds(r.hops[1]), /setFeatureCompatibilityVersion: "3.4"/);
});

test('CVE entries flag affected versions', () => {
  const withCve = { ...kb, cves: { cves: [{ id: 'CVE-TEST-1', severity: 'high', title: 'test', affected: [{ major: '7.0', fixed_in: '7.0.15' }] }] } };
  assert.equal(buildRoadmap({ from: '7.0.14-8', to: '8.0' }, withCve).cves.length, 1);
  assert.equal(buildRoadmap({ from: '7.0.15-9', to: '8.0' }, withCve).cves.length, 0);
});

test('markdown renders every hop', () => {
  const md = renderMarkdown(buildRoadmap({ from: '6.0.19', to: '8.0', topology: 'sharded' }, kb));
  assert.match(md, /## Hop 1: 6.0 to 7.0/);
  assert.match(md, /## Hop 2: 7.0 to 8.0/);
});

test('KB lint: unique ids, valid fields', () => {
  const seen = new Set();
  const majors = new Set(kb.versions.majors);
  for (const i of kb.changes.items) {
    assert.ok(!seen.has(i.id), `duplicate id ${i.id}`);
    for (const d of ['psmdb', 'mongodb-community']) for (const x of seriesFor(kb, d)) majors.add(x);
    seen.add(i.id);
    assert.ok(i.hop_to === '*' || majors.has(i.hop_to), `${i.id}: bad hop_to ${i.hop_to}`);
    assert.ok(['preflight', 'behaviour', 'post'].includes(i.section), `${i.id}: bad section`);
    assert.ok(['blocker', 'warning', 'info'].includes(i.severity), `${i.id}: bad severity`);
    assert.ok(i.title && i.action, `${i.id}: title and action required`);
    assert.equal(typeof i.verified, 'boolean', `${i.id}: verified flag required`);
  }
});

const withDrivers = {
  ...kb,
  drivers: { drivers: {
    fake: { name: 'Fake driver', source: 'https://example.invalid',
      min_for_server: { '5.0': '3.0', '6.0': '3.2', '7.0': '3.5', '8.0': '3.8' },
      max_for_server: { '5.0': '3.9' } },
  } },
};

test('driver too old for an intermediate hop is a blocker on that hop', () => {
  const r = buildRoadmap({ from: '5.0.14', to: '8.0', drivers: [{ key: 'fake', version: '3.2.1' }] }, withDrivers);
  assert.equal(r.drivers[0].status, 'blocker');
  assert.ok(ids(r.hops[1].preflight).includes('driver-fake'));
  assert.ok(!ids(r.hops[0].preflight).includes('driver-fake'));
  assert.equal(r.drivers[0].recommended, '3.8 to 3.9');
});

test('driver too new for the source server is flagged', () => {
  const r = buildRoadmap({ from: '5.0.14', to: '6.0', drivers: [{ key: 'fake', version: '4.0' }] }, withDrivers);
  assert.equal(r.drivers[0].status, 'blocker');
  assert.match(r.drivers[0].message, /ends at 3.9/);
});

test('compatible driver passes, missing data is a warning', () => {
  const ok = buildRoadmap({ from: '6.0.1', to: '8.0', drivers: [{ key: 'fake', version: '3.8.0' }] }, withDrivers);
  assert.equal(ok.drivers[0].status, 'ok');
  const unk = buildRoadmap({ from: '4.4.1', to: '5.0', drivers: [{ key: 'fake', version: '3.8.0' }] }, withDrivers);
  assert.equal(unk.drivers[0].status, 'unknown');
  assert.match(unk.drivers[0].message, /no entry for server 4.4/);
});

test('real driver table: partial support is a warning, below partial is a blocker', () => {
  const partial = buildRoadmap({ from: '7.0.14', to: '8.0', drivers: [{ key: 'pymongo', version: '4.4' }] }, kb);
  assert.equal(partial.drivers[0].status, 'partial');
  const old = buildRoadmap({ from: '5.0.14', to: '6.0', drivers: [{ key: 'pymongo', version: '3.6' }] }, kb);
  assert.equal(old.drivers[0].status, 'blocker');
  const ok = buildRoadmap({ from: '6.0.19', to: '8.0', drivers: [{ key: 'java-sync', version: '5.2.0' }] }, kb);
  assert.equal(ok.drivers[0].status, 'ok');
});

test('9.0 is a preview target with MongoDB docs only', () => {
  const r = buildRoadmap({ from: '8.0.12', to: '9.0', topology: 'replset' }, kb);
  assert.match(r.warnings[0], /not released yet/);
  const last = r.hops.at(-1);
  assert.equal(last.to, '9.0');
  assert.ok(last.preview);
  assert.match(cmds(last), /"9.0",\s+confirm: true/);
});

test('journal option is a blocker on MongoDB and a warning on PSMDB', () => {
  const m = buildRoadmap({ from: '6.0.19', to: '7.0', distribution: 'mongodb-community' }, kb);
  assert.ok(m.hops[0].preflight.some((i) => i.id === 'journal-option-removed' && i.severity === 'blocker'));
  const p = buildRoadmap({ from: '6.0.19', to: '7.0', distribution: 'psmdb' }, kb);
  assert.ok(p.hops[0].preflight.some((i) => /journal/i.test(`${i.title} ${i.action}`) && /percona\.com/.test(i.sourceUrl ?? '')), 'the Percona prerequisite covers journaling');
  assert.ok(!ids(p.hops[0].preflight).includes('journal-option-ignored-psmdb'), 'no duplicate of the official prerequisite');
  assert.ok(!ids(p.hops[0].preflight).includes('journal-option-removed'));
});

test('9.0 is GA for MongoDB, preview for PSMDB', () => {
  assert.ok(buildRoadmap({ from: '8.0.12', to: '9.0', distribution: 'psmdb' }, kb).hops.at(-1).preview);
  assert.equal(buildRoadmap({ from: '8.0.12', to: '9.0', distribution: 'mongodb-community' }, kb).hops.at(-1).preview, null);
});

test('operator platform rejects standalone and non-PSMDB', () => {
  assert.throws(() => buildRoadmap({ from: '7.0.1', to: '8.0', topology: 'standalone', platform: 'operator' }, kb), /standalone/);
  assert.throws(() => buildRoadmap({ from: '7.0.1', to: '8.0', distribution: 'mongodb-community', platform: 'operator' }, kb), /PSMDB only|Percona Server for MongoDB only/);
  const r = buildRoadmap({ from: '7.0.1', to: '8.0', platform: 'operator', components: { operator: '1.18.0' } }, kb);
  assert.ok(r.blockers.some((b) => b.includes('1.18.0 is below 1.19.0')));
});

test('switching distribution happens at the first shared major', () => {
  const r = buildRoadmap({ from: '6.0.19', to: '8.0', distribution: 'mongodb-community', targetDistribution: 'psmdb' }, kb);
  assert.equal(r.switch.at, '6.0');
  assert.ok(r.hops.every((h) => h.distribution === 'psmdb'));
});

test('every item that claims docs has a source url', () => {
  for (const i of kb.changes.items) if (i.basis === 'docs') assert.ok(i.source_url, i.id);
});

test('no unfilled placeholders in any plan', () => {
  const cases = [
    { from: '7.0.14', to: '8.0', topology: 'sharded', platform: 'operator', components: { operator: '1.17.0' } },
    { from: '6.0.19', to: '7.0', topology: 'replset', platform: 'operator' },
    { from: '4.4.29', to: '8.0', topology: 'sharded', distribution: 'mongodb-community', targetDistribution: 'psmdb', packageManager: 'yum' },
    { from: '3.0.15', to: '9.0', topology: 'standalone', distribution: 'mongodb-community' },
  ];
  for (const c of cases) {
    const md = renderMarkdown(buildRoadmap(c, kb));
    const left = md.match(/\{(to|from|image|to_full|operator_to|operator_version|pbm_version|namespace|cluster|setfcv|repo|install|latest_from|latest_to|major|major_nodot)\}/g);
    assert.equal(left, null, `${JSON.stringify(c)} leaves ${left}`);
  }
});

test('operator plan uses the certified image and blocks 9.0', () => {
  const r = buildRoadmap({ from: '7.0.14', to: '8.0', topology: 'sharded', platform: 'operator' }, kb);
  assert.ok(r.operatorPrep.length > 0);
  assert.ok(r.hops[0].steps.some((s) => /upgradeOptions/.test(`${s.snippet ?? ''} ${s.text}`)));
  assert.ok(r.hops[0].steps.some((s) => /apply: 8\.0-recommended/.test(s.snippet ?? '')), 'documented apply value');
  const r9 = buildRoadmap({ from: '8.0.4', to: '9.0', platform: 'operator' }, kb);
  assert.ok(r9.blockers.some((b) => /certifies 9.0/.test(b)));
});

test('PSMDB series include 3.0 to 3.4 builds and 8.3', () => {
  const s = seriesFor(kb, 'psmdb');
  assert.ok(s.includes('3.0') && s.includes('8.0') && s.includes('8.3'));
  assert.deepEqual(findPath(kb, 'psmdb', '8.0', '8.3'), ['8.0', '8.3']);
});

test('package procedures come from the official pages', () => {
  const p = buildRoadmap({ from: '7.0.20', to: '8.0', topology: 'replset', distribution: 'psmdb', packageManager: 'yum' }, kb);
  assert.match(p.hops[0].official.orderSource, /mongodb\.com/);
  assert.match(p.hops[0].official.nodeSource, /percona\.com/);
  assert.match(cmds(p.hops[0]), /sudo yum install -y percona-server-mongodb/);
  assert.equal(p.hops[0].steps.length, 0);
  assert.ok(!ids(p.hops[0].preflight).includes('fcv-matches-current'));
  const sa = buildRoadmap({ from: '7.0.20', to: '8.0', topology: 'standalone', distribution: 'psmdb' }, kb);
  assert.ok(sa.hops[0].official.merged.some((x) => x.substeps?.some((y) => y.heading === 'On the server')), 'standalone: one block on the server');
  assert.match(cmds(sa.hops[0]), /setFeatureCompatibilityVersion: "8\.0",\s+confirm: true/);
});

test('series graph: documented jumps only', () => {
  assert.deepEqual(findPath(kb, 'mongodb-community', '8.0', '9.0'), ['8.0', '9.0']);
  assert.deepEqual(findPath(kb, 'mongodb-community', '8.2', '9.0'), ['8.2', '8.3', '9.0']);
  assert.deepEqual(findPath(kb, 'mongodb-community', '6.1', '7.0'), ['6.1', '6.2', '6.3', '7.0']);
  assert.deepEqual(findPath(kb, 'mongodb-community', '5.0', '6.0'), ['5.0', '6.0']);
  assert.deepEqual(findPath(kb, 'psmdb', '8.0', '9.0'), ['8.0', '9.0']);
  assert.ok(!reachableFrom(kb, 'mongodb-community', '6.0').includes('6.1'));
  const r = buildRoadmap({ from: '6.2.1', to: '7.0', distribution: 'mongodb-community' }, kb);
  assert.ok(r.warnings.some((w) => /Atlas/.test(w)));
});

test('pinned target version lands there and warns when it is on the avoid list', () => {
  const r = buildRoadmap({ from: '7.0.20', to: '8.0', toVersion: '8.0.4-1', topology: 'sharded' }, kb);
  assert.equal(r.hops.at(-1).latestTo, '8.0.4-1');
  assert.ok(r.warnings.some((w) => /Target 8\.0\.4-1 is affected/.test(w)));
  const bad = buildRoadmap({ from: '7.0.20', to: '8.0', toVersion: '8.0.3' }, kb);
  assert.ok(bad.warnings.some((w) => /8\.0\.3 is not a Percona Server for MongoDB release/.test(w)));
  const ok = buildRoadmap({ from: '7.0.20', to: '8.0' }, kb);
  assert.notEqual(ok.hops.at(-1).latestTo, '8.0.3');
});

test('component checks: PMM lines, PBM max and undocumented targets', () => {
  const pmm2 = buildRoadmap({ from: '7.0.20', to: '8.0', components: { pmm: '2.43.0' } }, kb);
  assert.ok(pmm2.blockers.some((b) => /PMM 2\) 2\.43\.0 is below 2\.44\.0/.test(b)));
  assert.ok(pmm2.warnings.some((w) => /end of life/.test(w)));
  const pmm3 = buildRoadmap({ from: '8.0.34-15', to: '8.3', components: { pmm: '3.10.0' } }, kb);
  assert.ok(pmm3.warnings.some((w) => /No Percona Monitoring and Management release documents support for 8\.3/.test(w)));
  const pbm = buildRoadmap({ from: '6.0.29-23', to: '7.0', components: { pbm: '2.12.0' } }, kb);
  assert.ok(pbm.warnings.some((w) => /no longer supports 6\.0/.test(w)));
  const pbm83 = buildRoadmap({ from: '8.0.34-15', to: '8.3', components: { pbm: '2.15.0' } }, kb);
  assert.ok(pbm83.blockers.some((b) => /below 2\.16\.0/.test(b)));
});

test('steps are one list: MongoDB order with the Percona commands inside', () => {
  const r = buildRoadmap({ from: '8.0.34-15', to: '8.3', topology: 'replset', packageManager: 'yum' }, kb);
  const m = r.hops[0].official.merged;
  assert.deepEqual(m.map((s) => s.heading), ['Upgrade secondary members of the replica set', 'Step down the replica set primary', 'Upgrade the previous primary', 'Enable backwards-incompatible 8.3 features']);
  assert.equal(m[0].substeps[0].heading, 'On each secondary, one at a time');
  assert.match(m[0].substeps[0].cmd, /systemctl stop mongod\nsudo percona-release enable psmdb-83\nsudo yum install -y percona-server-mongodb-8\.3\.13-4\$\(rpm -E %\{dist\}\) percona-server-mongodb-tools\nsudo systemctl start mongod/);
  assert.doesNotMatch(m[0].substeps[0].text, /Debian/);
  const sh = buildRoadmap({ from: '7.0.20', to: '8.0', topology: 'sharded' }, kb).hops[0].official.merged;
  const cfg = sh.find((s) => /config servers/i.test(s.heading));
  assert.deepEqual(cfg.substeps.filter((x) => x.node).map((x) => x.heading), ['On each secondary, one at a time', 'On the former primary']);
});

test('CVE-2025-14847 flags affected and unfixed versions', () => {
  assert.ok(buildRoadmap({ from: '8.0.16-5', to: '8.3' }, kb).cves.some((c) => c.id === 'CVE-2025-14847' && c.which === 'current'));
  assert.ok(!buildRoadmap({ from: '8.0.17-6', to: '8.3' }, kb).cves.some((c) => c.id === 'CVE-2025-14847'));
  assert.ok(buildRoadmap({ from: '4.2.25-25', to: '4.4' }, kb).cves.some((c) => c.id === 'CVE-2025-14847' && /no fixed release/.test(c.message)));
  assert.ok(buildRoadmap({ from: '7.0.28', to: '8.0', toVersion: '8.0.16-5' }, kb).cves.some((c) => c.id === 'CVE-2025-14847' && c.which === 'target'));
  assert.equal(buildRoadmap({ from: '7.0.45-24', to: '8.0', toVersion: '8.0.34-15' }, kb).cves.filter((c) => c.which === 'target').length, 0, 'latest 8.0 has no open CVE');
});

test('OS support: blocker with the OS version to move to first', () => {
  const r = buildRoadmap({ from: '7.0.20', to: '8.0', distribution: 'mongodb-community', os: 'rhel7' }, kb);
  const it = r.hops[0].preflight.find((i) => i.id === 'os-8.0');
  assert.ok(it && it.severity === 'blocker');
  assert.match(it.action, /RHEL 8/);
  assert.equal(buildRoadmap({ from: '7.0.20', to: '8.0', os: 'rhel9' }, kb).hops[0].preflight.find((i) => i.id === 'os-8.0'), undefined);
});

test('patch upgrade inside a series', () => {
  const r = buildRoadmap({ from: '8.0.20-8', to: '8.0', toVersion: '8.0.34-15', topology: 'replset', packageManager: 'yum' }, kb);
  assert.equal(r.hops.length, 1);
  assert.ok(r.hops[0].patch);
  const flat = (xs) => (xs ?? []).flatMap((x) => [x, ...flat(x.substeps)]);
  const all = flat(r.hops[0].official.merged).map((x) => x.cmd ?? '').join('\n');
  assert.match(all, /sudo yum install -y percona-server-mongodb/);
  assert.match(all, /rs\.stepDown\(\)/);
  assert.doesNotMatch(all, /^\$ /m);
  const sh = buildRoadmap({ from: '8.0.20-8', to: '8.0', toVersion: '8.0.34-15', topology: 'sharded' }, kb);
  assert.match(flat(sh.hops[0].official.merged).map((x) => x.cmd ?? '').join('\n'), /sh\.stopBalancer\(\)/);
});

test('package installs: exact version, systemctl, no hand-started binaries', () => {
  const flat = (xs) => (xs ?? []).flatMap((x) => [x, ...flat(x.substeps)]);
  const cmds = (r) => r.hops.flatMap((h) => flat(h.official?.merged)).map((x) => x.cmd ?? '').join('\n');
  for (const distribution of ['psmdb', 'mongodb-community']) {
    for (const topology of ['replset', 'sharded']) {
      const all = cmds(buildRoadmap({ from: '7.0.20', to: '8.0', toVersion: distribution === 'psmdb' ? '8.0.32-14' : '8.0.32', topology, distribution, packageManager: 'yum' }, kb));
      assert.match(all, /sudo systemctl stop mongod/, `${distribution} ${topology}`);
      assert.match(all, /sudo systemctl start mongod/, `${distribution} ${topology}`);
      assert.match(all, /8\.0\.32/, `${distribution} ${topology} pins the version`);
      assert.doesNotMatch(all, /mongo[ds] --(?!version)|<replSetName>|shutdown: 1/, `${distribution} ${topology} no hand-started binaries`);
      assert.doesNotMatch(all, / && /, `${distribution} ${topology} one command per line`);
    }
  }
  const a = cmds(buildRoadmap({ from: '7.0.20', to: '8.0', toVersion: '8.0.29-13', topology: 'replset' }, kb));
  const b = cmds(buildRoadmap({ from: '7.0.20', to: '8.0', toVersion: '8.0.34-15', topology: 'replset' }, kb));
  assert.notEqual(a, b, 'changing the target version changes the commands');
});

test('lab findings: mongos block, wait for SECONDARY, read-only checks, no duplicates', () => {
  const flat = (xs) => (xs ?? []).flatMap((x) => [x, ...flat(x.substeps)]);
  const r = buildRoadmap({ from: '6.0.29-23', to: '8.0', topology: 'sharded', packageManager: 'yum' }, kb);
  assert.ok(!r.warnings.some((w) => /latest Percona Server for MongoDB 6\.0 patch/.test(w)), 'no false latest-patch warning');
  for (const h of r.hops) {
    const steps = flat(h.official.merged);
    const mongos = steps.find((x) => x.heading === 'On each mongos host');
    assert.ok(mongos && /percona-server-mongodb-mongos-/.test(mongos.cmd) && /systemctl restart mongos/.test(mongos.cmd), `${h.to} mongos block`);
    for (const i of h.preflight) if (i.check) assert.doesNotMatch(i.check, /setFeatureCompatibilityVersion/, `${i.id} check must be read-only`);
    const titles = h.preflight.map((i) => i.title);
    assert.ok(!(titles.some((t) => /system\.buckets/i.test(t)) && h.preflight.filter((i) => /system\.buckets/i.test(i.title)).length > 1), 'buckets once');
  }
  const rs = buildRoadmap({ from: '7.0.20', to: '8.0', topology: 'replset' }, kb);
  const up = rs.hops[0].official.merged.find((x) => /secondar/i.test(x.heading));
  assert.ok(up.substeps.some((x) => /SECONDARY/.test(x.text) && x.cmd === 'rs.status()'), 'wait for SECONDARY');
  const pinned = buildRoadmap({ from: '8.0.20-8', to: '8.0', toVersion: '8.0.32', topology: 'replset', packageManager: 'yum' }, kb);
  assert.equal(pinned.hops[0].to, '8.0.32-14', '8.0.32 resolves to its release');
});

test('lab-tested items appear with yum PSMDB package installs', () => {
  const r = buildRoadmap({ from: '6.0.29-23', to: '7.0', topology: 'replset', packageManager: 'yum' }, kb);
  const post = r.hops[0].post;
  const tools = post.find((i) => i.id === 'lab-tools-mongosh-not-upgraded');
  assert.ok(tools && tools.basis === 'lab' && tools.tested);
  assert.match(tools.fix, /yum install -y percona-server-mongodb-tools percona-mongodb-mongosh$/);
  assert.match(post.find((i) => i.id === 'lab-old-psmdb-repo-enabled').fix, /disable psmdb-60$/);
  const apt = buildRoadmap({ from: '6.0.29-23', to: '7.0', topology: 'replset', packageManager: 'apt' }, kb);
  assert.ok(!apt.hops[0].post.some((i) => i.id === 'lab-tools-mongosh-not-upgraded'), 'yum only');
});

test('OS plan: one OS upgrade for the whole path, shown as a blocker', () => {
  const r = buildRoadmap({ from: '6.0.20', to: '8.0', distribution: 'mongodb-community', os: 'rhel7' }, kb);
  assert.equal(r.osPlan.at, 2);
  assert.equal(r.osPlan.during, '7.0');
  assert.ok(r.osPlan.recommend.length > 0);
  assert.match(r.blockers[0], /RHEL 7 is not supported by 8\.0\. Upgrade the OS to RHEL/);
  assert.equal(buildRoadmap({ from: '7.0.20', to: '8.0', os: 'rhel9' }, kb).osPlan, null);
});

test('data review fixes: 8.3 advisory, Java 8.3 driver minimum, PSMDB OS ceilings', () => {
  const r = buildRoadmap({ from: '8.3.11-3', to: '9.0', distribution: 'mongodb-community', topology: 'sharded' }, kb);
  assert.ok(r.warnings.some((w) => /SERVER-131805/.test(w)));
  const rs = buildRoadmap({ from: '8.3.11-3', to: '9.0', distribution: 'mongodb-community', topology: 'replset' }, kb);
  assert.ok(!rs.warnings.some((w) => /SERVER-131805/.test(w)), 'sharded-only advisory stays out of replica set plans');
  const j = buildRoadmap({ from: '8.0.20', to: '8.3', distribution: 'mongodb-community', drivers: [{ key: 'java-sync', version: '5.2.0' }] }, kb);
  assert.notEqual(j.drivers[0].status, 'ok');
  const o = buildRoadmap({ from: '6.0.29-23', to: '7.0', os: 'rhel7' }, kb);
  assert.ok(o.hops[0].preflight.some((i) => i.id === 'os-7.0' && /7\.0\.12-7/.test(i.action)));
});

test('a direct 8.0 -> 9.0 hop carries the 8.2 and 8.3 changes', () => {
  const r = buildRoadmap({ from: '8.0.20', to: '9.0', distribution: 'mongodb-community', topology: 'sharded' }, kb);
  assert.deepEqual(r.path, ['8.0', '9.0']);
  const all = [...r.hops[0].preflight, ...r.hops[0].behaviour].map((i) => i.id);
  assert.ok(all.includes('catalogcache-param-removed-82'), '8.2 change on the 8.0 -> 9.0 hop');
  assert.ok(all.some((i) => /83$/.test(i)), '8.3 changes on the 8.0 -> 9.0 hop');
  const op = buildRoadmap({ from: '7.0.20', to: '8.0', topology: 'replset', platform: 'operator' }, kb);
  assert.ok(!op.hops[0].preflight.some((i) => /\/etc\/|sysctl/.test(i.check ?? '')), 'no host checks on the Operator');
});

test('procedure review fixes: package names per series, install always present, mongos order, FCV value', () => {
  const flat = (xs) => (xs ?? []).flatMap((x) => [x, ...flat(x.substeps)]);
  const all = (r) => r.hops.flatMap((h) => flat(h.official?.merged)).map((x) => x.cmd ?? '').join('\n');
  // C2: no 5.0+ package names on 4.x
  const c44 = all(buildRoadmap({ from: '4.2.20', to: '4.4', toVersion: '4.4.29', distribution: 'mongodb-community', packageManager: 'apt', topology: 'replset' }, kb));
  assert.doesNotMatch(c44, /mongodb-org-database|mongodb-mongosh/);
  assert.match(c44, /mongodb-org-shell=4\.4\.29/);
  // C1: PSMDB apt does not pin tools
  const pa = all(buildRoadmap({ from: '7.0.45-24', to: '8.0', distribution: 'psmdb', packageManager: 'apt', topology: 'replset' }, kb));
  assert.doesNotMatch(pa, /percona-server-mongodb-tools=/);
  // C3: an install is always there
  const p40 = all(buildRoadmap({ from: '3.6.23-13', to: '4.0', distribution: 'psmdb', packageManager: 'yum', topology: 'replset' }, kb));
  assert.match(p40, /yum install -y percona-server-mongodb-4\.0/);
  // C4: in 5.0 -> 6.0 sharded the mongos package block is in the Upgrade the mongos step only
  const sh = buildRoadmap({ from: '5.0.29-25', to: '6.0', distribution: 'psmdb', topology: 'sharded' }, kb).hops[0].official.merged;
  const withMongos = sh.filter((x) => x.substeps?.some((y) => y.heading === 'On each mongos host')).map((x) => x.heading);
  assert.equal(withMongos.length, 1);
  assert.match(withMongos[0], /^Upgrade (the |all )?mongos/i);
  // M3: PSMDB 9.0 preview has package commands
  assert.match(all(buildRoadmap({ from: '8.0.34-15', to: '9.0', distribution: 'psmdb', packageManager: 'yum', topology: 'replset' }, kb)), /percona-release enable psmdb-90 testing/);
  // M1: Community patch upgrade stops and starts
  assert.match(all(buildRoadmap({ from: '8.0.20', to: '8.0', toVersion: '8.0.34', distribution: 'mongodb-community', topology: 'replset' }, kb)), /systemctl stop mongod[\s\S]*systemctl start mongod/);
  // Debian and ARM repositories
  assert.match(all(buildRoadmap({ from: '7.0.20', to: '8.0', distribution: 'mongodb-community', os: 'debian12', packageManager: 'apt' }, kb)), /repo\.mongodb\.org\/apt\/debian/);
  assert.match(all(buildRoadmap({ from: '7.0.20', to: '8.0', distribution: 'mongodb-community', arch: 'aarch64', packageManager: 'yum' }, kb)), /\/aarch64\//);
});

test('no unfilled placeholder in any plan or Markdown (matrix)', () => {
  const RE = /(?<![%$])\{(?!end\})[a-z_]+\}/; // {end} is kubectl jsonpath syntax
  const paths = [['6.0.29-23', '7.0'], ['7.0.45-24', '8.0'], ['8.0.34-15', '8.3'], ['8.0.34-15', '9.0'], ['4.2.25-25', '4.4'], ['3.6.23-13', '4.0'], ['8.0.20-8', '8.0', '8.0.34-15']];
  let n = 0;
  for (const distribution of ['psmdb', 'mongodb-community']) {
    for (const topology of ['standalone', 'replset', 'sharded']) {
      for (const pm of ['apt', 'yum']) {
        for (const platform of ['packages', 'operator']) {
          if (platform === 'operator' && (distribution !== 'psmdb' || topology === 'standalone')) continue;
          for (const [from, to, toVersion] of paths) {
            const f = distribution === 'psmdb' ? from : from.replace(/-\d+$/, '');
            const tv = toVersion && (distribution === 'psmdb' ? toVersion : toVersion.replace(/-\d+$/, ''));
            let r;
            try { r = buildRoadmap({ from: f, to, toVersion: tv, topology, distribution, packageManager: pm, platform, os: pm === 'apt' ? 'ubuntu2204' : 'rhel8', arch: 'x86_64' }, kb); } catch { continue; }
            const text = JSON.stringify(r) + renderMarkdown(r);
            const m = text.match(RE);
            assert.equal(m, null, `${distribution} ${topology} ${pm} ${platform} ${f}->${to}: ${m && text.slice(Math.max(0, m.index - 80), m.index + 40)}`);
            n++;
          }
        }
      }
    }
  }
  assert.ok(n > 100);
});

test('lab test 2: apt tools pin, -y, confold, min-patch, OS filter, processManagement', () => {
  const flat = (xs) => (xs ?? []).flatMap((x) => [x, ...flat(x.substeps)]);
  const cmds = (r) => r.hops.flatMap((h) => flat(h.official?.merged)).map((x) => x.cmd ?? '').join('\n');
  // Releases before 8.0.34-15 depend on tools of the same version; later ones on 100.x tools.
  const old = cmds(buildRoadmap({ from: '8.0.29-13', to: '8.0', toVersion: '8.0.32-14', packageManager: 'apt' }, kb));
  assert.match(old, /percona-server-mongodb-tools=8\.0\.32-14\.\$\(lsb_release -sc\)/);
  assert.match(old, /apt install -y -o Dpkg::Options::="--force-confold"/);
  assert.equal((old.match(/apt install -y/g) ?? []).length, 2, 'one install per member block, no duplicate');
  const cur = cmds(buildRoadmap({ from: '7.0.45-24', to: '8.0', packageManager: 'apt' }, kb));
  assert.match(cur, /percona-server-mongodb-tools(\n| |$)/);
  assert.doesNotMatch(cur, /percona-server-mongodb-tools=/);
  assert.match(cur, /systemctl is-active mongod\nmongod --version \| head -1/);
  // Running the latest patch already: no "upgrade to the latest patch first" blocker.
  const r = buildRoadmap({ from: '6.0.29-23', to: '8.0', os: 'ubuntu2204' }, kb);
  assert.ok(!r.hops.flatMap((h) => h.preflight).some((i) => /^min-patch-/.test(i.id)));
  assert.ok(!r.hops.flatMap((h) => h.preflight).some((i) => /Amazon Linux 2023/.test(i.action)), 'AL2023 prerequisite only on AL2023');
  const al = buildRoadmap({ from: '6.0.29-23', to: '7.0', os: 'amzn2023' }, kb);
  assert.ok(al.hops[0].preflight.some((i) => /Amazon Linux 2023/.test(i.action)));
  const pm = JSON.stringify(buildRoadmap({ from: '7.0.45-24', to: '8.0', packageManager: 'yum' }, kb));
  assert.match(pm, /the processManagement: line and the fork and pidFilePath lines/);
  // 6.0 has no fixed patch for SERVER-131805: the warning must not name 6.0.29-23 as the fix.
  const sh = buildRoadmap({ from: '6.0.29-23', to: '7.0', topology: 'sharded' }, kb);
  const w = sh.warnings.find((x) => /SERVER-131805/.test(x));
  assert.ok(w && !/fixed patch \(6\.0\.29-23\)/.test(w));
});

test('minor polish: Enterprise is out of scope, driver links, all-database checks', () => {
  assert.throws(() => buildRoadmap({ from: '7.0.45', to: '8.0', distribution: 'mongodb-enterprise' }, kb));
  assert.ok(!JSON.stringify(kb.distributions.switches).includes('mongodb-enterprise'));
  const d = buildRoadmap({ from: '7.0.45', to: '8.0', distribution: 'mongodb-community', drivers: [{ key: 'motor', version: '3.0.0' }, { key: 'nope', version: '1.0' }] }, kb);
  assert.match(d.drivers[0].source, /python-driver-framework=motor/);
  assert.ok(d.drivers[1].source);
  const all = JSON.stringify(buildRoadmap({ from: '7.0.45', to: '8.0', distribution: 'mongodb-community', topology: 'sharded' }, kb));
  assert.match(all, /getDBNames\(\)\.forEach\(d => db\.getSiblingDB\(d\)\.getCollectionInfos/);
  assert.doesNotMatch(all, /up to 128|PMM 2\.44\.0\+/);
  const tls = buildRoadmap({ from: '7.0.45-24', to: '8.0', packageManager: 'yum' }, kb).hops[0].preflight.find((i) => i.id === 'tls-cafile');
  assert.match(tls.check, /\(tls\|ssl\)/);
});

test('lab test 3: FCV run-on, switch steps, Operator schedule, legacy shell', () => {
  const sh = buildRoadmap({ from: '7.0.45-24', to: '8.0', topology: 'sharded', packageManager: 'yum', os: 'rhel8' }, kb);
  const fcv = sh.hops[0].preflight.find((i) => /getParameter/.test(i.check ?? '') && /featureCompatibilityVersion/.test(i.check ?? ''));
  assert.match(fcv.runOn, /each mongod/);

  const sw = buildRoadmap({ from: '7.0.45-24', to: '8.0', distribution: 'psmdb', targetDistribution: 'mongodb-community', packageManager: 'apt', os: 'ubuntu2204' }, kb);
  const cmds = sw.switch.steps.map((s) => s.cmd ?? '').join('\n');
  assert.match(cmds, /apt remove -y percona-server-mongodb/);
  assert.match(cmds, /--force-confold" mongodb-org/);
  assert.match(cmds, /chown -R mongodb:mongodb/);
  assert.match(cmds, /repo\.mongodb\.org\/apt\/ubuntu .*mongodb-org\/7\.0/);
  assert.ok(!/\{repo_lines\}/.test(cmds));
  const swYum = buildRoadmap({ from: '7.0.45-24', to: '7.0', distribution: 'psmdb', targetDistribution: 'mongodb-community', packageManager: 'yum', os: 'rhel8' }, kb);
  assert.match(swYum.switch.steps.map((s) => s.cmd ?? '').join('\n'), /mongod\.conf\.rpmsave/);
  assert.ok(!swYum.warnings.some((w) => /Pick a newer series/.test(w)));

  const op = buildRoadmap({ from: '7.0.43-23', to: '8.0', platform: 'operator', components: { operator: '1.23.1' } }, kb);
  assert.ok(op.hops[0].steps.some((s) => /schedule: "\* \* \* \* \*"/.test(s.snippet ?? '')));
  const opFcv = op.hops[0].preflight.find((i) => i.id === 'op-fcv-previous-major');
  assert.match(opFcv.check, /-- bash -c 'mongosh/);
  assert.ok(op.hops[0].post.concat(op.hops[0].preflight).filter((i) => /^pbm /.test(i.check ?? '')).every((i) => /backup-agent/.test(i.runOn)));

  const old = buildRoadmap({ from: '4.4.29-28', to: '6.0', packageManager: 'yum', os: 'rhel8' }, kb);
  assert.ok(old.hops[0].preflight.some((i) => i.id === 'legacy-mongo-shell-before-60'));
  assert.ok(!old.hops.some((h) => h.post.some((i) => i.id === 'lab-tools-mongosh-not-upgraded')));
});

test('lab test 4: Operator patches keep the image, quoted keyfile, yum tools', () => {
  const op = buildRoadmap({ from: '7.0.43-23', to: '8.0', platform: 'operator', components: { operator: '1.23.1' } }, kb);
  const after = op.hops[0].steps.slice(3).map((s) => s.cmd ?? '').join('\n');
  assert.ok(!/kubectl apply -f deploy\/cr\.yaml/.test(after));
  assert.match(after, /kubectl patch psmdb .*setFCV/);
  const sw = buildRoadmap({ from: '7.0.45-24', to: '7.0', distribution: 'psmdb', targetDistribution: 'mongodb-community', packageManager: 'apt', os: 'ubuntu2204' }, kb);
  const c = sw.switch.steps.map((s) => s.cmd ?? '').join('\n');
  assert.match(c, /gsub/);
  assert.match(c, /percona-release disable telemetry/);
  const p = buildRoadmap({ from: '7.0.43-23', to: '7.0', toVersion: '7.0.45-24', packageManager: 'yum', os: 'rhel8' }, kb);
  assert.match(JSON.stringify(p), /percona-server-mongodb-7\.0\.45-24\$\(rpm -E %\{dist\}\) percona-server-mongodb-tools/);
  assert.match(renderMarkdown(op), /```yaml/);
});

test('CVE fixes point only at releases the distribution shipped', () => {
  const r = buildRoadmap({ from: '4.4.29-28', to: '5.0', toVersion: '5.0.29-25' }, kb);
  const t = r.cves.filter((c) => c.which === 'target');
  assert.ok(t.length);
  for (const c of t) {
    assert.equal(c.fixedIn, null, c.id);
    assert.match(c.message, /no PSMDB 5\.0 release includes the fix/);
  }
  const p = buildRoadmap({ from: '7.0.20-12', to: '8.0' }, kb).cves.filter((c) => c.which === 'current' && c.fixedIn);
  assert.ok(p.every((c) => /-\d+$/.test(c.fixedIn)), 'PSMDB fixes name a PSMDB build');
});

test('zlib mitigation for CVE-2025-14847 shows once where no fix exists', () => {
  const count = (c) => buildRoadmap(c, kb).hops.map((h) => h.preflight.filter((i) => i.id.startsWith('zlib-mongobleed')).length);
  assert.deepEqual(count({ from: '4.4.29-28', to: '6.0' }), [1, 0]);
  assert.deepEqual(count({ from: '6.0.20-17', to: '7.0' }), [0]);
  assert.deepEqual(count({ from: '4.2.25', to: '4.4', distribution: 'mongodb-community' }), [1]);
  assert.deepEqual(count({ from: '4.4.29', to: '5.0', distribution: 'mongodb-community' }), [0]);
});
