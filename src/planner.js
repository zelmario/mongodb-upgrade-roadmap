// Upgrade roadmap planner. Pure functions only: no I/O, so the same code runs
// in Node (CLI, tests) and in a browser page.

const TOPOLOGIES = ['standalone', 'replset', 'sharded'];

export function parseVersion(v) {
  const raw = String(v ?? '').trim();
  // PSMDB builds: 7.0.14-8, older ones 3.0.15-1.10 or 3.0.5-rel0.7rc.
  const m = raw.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.]+))?$/);
  if (!m) throw new Error(`Cannot parse version "${raw}"`);
  const buildNums = m[4] ? (m[4].match(/\d+/g) ?? []).map(Number) : null;
  return {
    raw,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? null : Number(m[3]),
    build: buildNums && buildNums.length ? buildNums[0] : null,
    build2: buildNums && buildNums.length > 1 ? buildNums[1] : null,
  };
}

export function majorOf(v) {
  const p = parseVersion(v);
  return `${p.major}.${p.minor}`;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const k of ['major', 'minor', 'patch', 'build', 'build2']) {
    const d = (pa[k] ?? 0) - (pb[k] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const atLeast = (v, min) => compareVersions(v, min) >= 0;

function fill(text, vars) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function planPath(from, to, majors) {
  const fromMajor = majorOf(from);
  const toMajor = majorOf(to);
  const i = majors.indexOf(fromMajor);
  const j = majors.indexOf(toMajor);
  if (i === -1) throw new Error(`Unknown source major ${fromMajor}`);
  if (j === -1) throw new Error(`Unknown target major ${toMajor}`);
  if (j < i) throw new Error(`Target ${toMajor} is older than source ${fromMajor}, downgrades are not planned`);
  return majors.slice(i, j + 1);
}

function itemApplies(item, ctx) {
  // A change belongs to the hop whose range contains its version: a direct 8.0 -> 9.0 hop
  // also carries the 8.1, 8.2 and 8.3 changes.
  if (item.hop_to !== '*' && !(compareVersions(item.hop_to, ctx.from) > 0 && compareVersions(item.hop_to, ctx.to) <= 0)) return false;
  const w = item.when ?? {};
  if (w.topology && !w.topology.includes(ctx.topology)) return false;
  if (w.arch && ctx.arch && !w.arch.includes(ctx.arch)) return false;
  if (w.from_at_least && !atLeast(ctx.from, w.from_at_least)) return false;
  if (w.to_at_least && !atLeast(ctx.to, w.to_at_least)) return false;
  if (w.distribution && !w.distribution.includes(ctx.distribution)) return false;
  if (w.platform && !w.platform.includes(ctx.platform)) return false;
  if (w.from && !w.from.includes(ctx.from)) return false;
  if (w.pm && ctx.pm && !w.pm.includes(ctx.pm)) return false;
  if (w.os && ctx.os && !w.os.includes(ctx.os)) return false;
  return true;
}

// Where a check command has to run, so it is not run on the wrong node.
export function runOnFor(cmd) {
  const c = String(cmd ?? '');
  if (!c) return undefined;
  // mongod.conf and the mongod process exist only on hosts that run mongod, not on a mongos-only host.
  if (/\/etc\/mongod\.conf|pidof mongod/.test(c)) return 'each mongod host, in the OS shell';
  if (/^(sudo |cat |grep |sysctl |uname |df |diff |rpm |dpkg |ls |systemctl |pbm |pmm-admin |mongodump |mongod --|kubectl |curl |helm )/m.test(c)) return /^kubectl|^helm|^curl/m.test(c) ? 'your workstation with kubectl' : 'each host, in the OS shell';
  // getParameter featureCompatibilityVersion fails on a mongos ("no option found to get"): read it on every mongod (lab-tested).
  if (/getParameter/.test(c) && /featureCompatibilityVersion/.test(c)) return 'each mongod (in a sharded cluster, each shard and config server member)';
  if (/\bsh\.|flushRouterConfig|checkMetadataConsistency|isdbgrid|config\.(shards|chunks|databases)/.test(c)) return 'a mongos';
  if (/getCollectionInfos|getDBNames|setFeatureCompatibilityVersion|featureCompatibilityVersion|system\.buckets|listCollections|\bdb\.\w+\.(find|countDocuments|aggregate|getIndexes)\(/.test(c)) return 'the primary, or a mongos in a sharded cluster';
  if (/\brs\.|replSetGetStatus/.test(c)) return 'any replica set member';
  if (/getParameter|serverStatus|buildInfo|db\.version/.test(c)) return 'each mongod';
  return undefined;
}

// With the Operator there are no hosts: OS and mongosh commands run in a Pod, PBM in the backup-agent container (lab-tested).
function operatorRunOn(runOn, check) {
  if (!runOn || /kubectl|workstation|Kubernetes/.test(runOn) || /^\s*kubectl/m.test(check ?? '')) return runOn;
  if (/^\s*(sudo )?pbm /m.test(check ?? '')) return 'the backup-agent container of a mongod Pod, with kubectl exec -c backup-agent';
  if (/OS shell|host/.test(runOn)) return 'a mongod container, with kubectl exec -c mongod';
  // The clusterAdmin user cannot read user collections: these checks need the databaseAdmin user (lab-tested).
  if (/getCollectionInfos|getDBNames|\bdb\.(?!adminCommand|getSiblingDB\("admin"\))\w+\.(find|countDocuments|aggregate|getIndexes)\(/.test(check ?? '')) return `${runOn}, through kubectl exec into a mongod Pod as the databaseAdmin user (the MONGODB_DATABASE_ADMIN_* variables in the mongod container)`;
  return `${runOn}, through kubectl exec into a mongod Pod`;
}

function renderItem(item, vars) {
  return {
    id: item.id,
    section: item.section,
    severity: item.severity,
    title: fill(item.title, vars),
    action: fill(item.action, vars),
    check: item.check ? fill(item.check, vars) : undefined,
    runOn: item.run_on ?? runOnFor(item.check),
    fix: item.fix ? fill(item.fix, vars) : undefined,
    note: item.note ? fill(item.note, vars) : undefined,
    verified: item.verified === true,
    tested: item.tested,
    basis: item.basis ?? 'practice',
    sourceUrl: item.source_url,
    quote: item.quote,
  };
}

function setFcvCommand(to, versions) {
  const confirm = atLeast(to, versions.setfcv_requires_confirm_from) ? ', confirm: true' : '';
  return `db.adminCommand({ setFeatureCompatibilityVersion: "${to}"${confirm} })`;
}

function rollbackFor(to, procedures, vars, platform, operatorKb) {
  const rule = (vars.rapid && procedures.rollback.rapid) || procedures.rollback.by_target?.[to] || procedures.rollback.default;
  const out = {
    beforeSetFcv: fill(rule.before_setfcv, vars),
    afterSetFcv: fill(rule.after_setfcv, vars),
    sourceUrl: to === '9.0' && vars.from === '8.0' ? 'https://www.mongodb.com/docs/manual/release-notes/9.0-downgrade-to-8.0/' : rule.url,
    verified: Boolean(rule.url),
  };
  // With the Operator the rule is the Operator's: the image can go back while FCV is unchanged.
  if (platform === 'operator') {
    out.beforeSetFcv = `The Operator can move the cluster back to ${vars.from}: set upgradeOptions.apply (or spec.image) to the previous major. This works only while FCV is still "${vars.from}", so keep upgradeOptions.setFCV false until you have validated ${to}.`;
    out.afterSetFcv = 'Once setFCV is true and FCV has changed, the Operator does not support a major version rollback. Restore from a backup taken before the upgrade.';
    out.sourceUrl = 'https://docs.percona.com/percona-operator-for-mongodb/update-major.html#feature-compatibility-version';
  }
  return out;
}

// PBM, PMM and Operator: each target on the path must be at or above the documented
// minimum; a version past a documented maximum (support dropped) is flagged; targets
// newer than anything the release notes mention are reported as undocumented.
function componentFindings(input, path, kb) {
  const out = [];
  const supplied = input.components ?? {};
  for (const [key, comp] of Object.entries(kb.components.components)) {
    const have = supplied[key];
    if (have === undefined) continue;
    let rules = comp;
    let name = comp.name;
    if (comp.lines) {
      const line = parseVersion(have).major >= 3 ? 'pmm3' : 'pmm2';
      rules = comp.lines[line];
      name = `${comp.name} (${rules.label})`;
      if (rules.eol) out.push({ severity: 'warning', component: key, message: `${rules.label} reached end of life on ${rules.eol}. Plan a move to the current line.${rules.migration ? ' ' + rules.migration.text : ''}` });
    }
    const mins = rules.min_for_target ?? {};
    const newest = Object.keys(mins).sort(compareVersions).at(-1);
    for (const s of path.slice(1)) {
      const req = mins[s];
      if (req?.min && compareVersions(have, req.min) < 0) {
        out.push({ severity: 'blocker', component: key, hopTo: s, message: `${name} ${have} is below ${req.min}, the first release that supports ${s} (${req.source}). Upgrade it first.` });
      } else if (!req && newest && compareVersions(s, newest) > 0) {
        out.push({ severity: 'warning', component: key, hopTo: s, message: `No ${comp.name} release documents support for ${s} yet. Check ${comp.docs}` });
      } else if (req?.note) {
        out.push({ severity: 'warning', component: key, hopTo: s, message: `${name} and ${s}: ${req.note}.` });
      }
    }
    for (const s of path) {
      const max = rules.max_for_target?.[s];
      if (max?.max && compareVersions(have, max.max) > 0) {
        out.push({ severity: 'warning', component: key, hopTo: s, message: `${name} ${have} no longer supports ${s} officially (last version: ${max.max}, ${max.source}). Upgrade the cluster before or together with ${comp.name}.` });
      }
    }
  }
  return out;
}

// Summarise CVEs: how many affect the current version and the version you land on, and the patch that fixes them all.
export function cveSummary(list, which) {
  const xs = list.filter((c) => c.which === which);
  if (!xs.length) return null;
  const fixes = xs.map((c) => c.fixedIn).filter(Boolean).sort(compareVersions);
  return { count: xs.length, critical: xs.filter((c) => c.severity === 'critical').length, maxCvss: Math.max(...xs.map((c) => c.cvss ?? 0)),
    fixedBy: fixes.at(-1) ?? null, unfixed: xs.filter((c) => !c.fixedIn).length, items: xs };
}

// Each CVE that affects the current version or the version the plan lands on.
function cveFindings(input, path, kb, landing, distribution, targetDistribution) {
  const out = [];
  const check = (version, which, dist) => {
    if (!version) return;
    const name = dist === "psmdb" ? "PSMDB" : (DISTRIBUTIONS[dist] ?? dist);
    for (const cve of kb.cves.cves ?? []) {
      const a = (cve.affected ?? []).find((x) => x.major === majorOf(version));
      if (!a) continue;
      if (a.fixed_in && compareVersions(version, a.fixed_in) >= 0) continue;
      if (out.some((o) => o.which === which && o.id === cve.id)) continue;
      // The upstream fix only helps if this distribution shipped a release of the series that includes it.
      const rel = a.fixed_in ? releasesFor(kb, dist, a.major).filter((r) => (r.channel ?? 'release') === 'release' && !r.prerelease) : [];
      const shipped = a.fixed_in ? (rel.length ? rel.find((r) => compareVersions(r.version, a.fixed_in) >= 0)?.version ?? null : a.fixed_in) : null;
      out.push({ which, id: cve.id, severity: cve.severity, cvss: cve.cvss, title: cve.title, url: cve.url, fixedIn: shipped,
        message: !a.fixed_in ? `${version} is affected and ${a.major} has no fixed release.`
          : shipped ? `${version} is affected, fixed in ${shipped}${shipped !== a.fixed_in ? ` (MongoDB ${a.fixed_in})` : ''}.`
          : `${version} is affected. MongoDB fixed it in ${a.fixed_in}, but no ${name} ${a.major} release includes the fix.` });
    }
  };
  check(input.from, 'current', distribution);
  check(landing, 'target', targetDistribution ?? distribution);
  return out;
}

const inRange = (to, d) => (!d.min_target || atLeast(to, d.min_target)) && (!d.max_target || compareVersions(to, d.max_target) <= 0);

function hopDocs(from, to, topology, docs, dist, platform, operatorKb, officialUrl, distKey) {
  const vars = { from, to, fromnodot: from.replace('.', ''), from_nodot: from.replace('.', ''), to_nodot: to.replace('.', '') };
  const out = [];
  const topoName = topology === 'replset' ? 'replica set' : topology === 'sharded' ? 'sharded cluster' : 'standalone';
  if (platform === 'operator') {
    for (const d of operatorKb?.docs ?? []) out.push({ label: d.label, url: d.url });
  }
  // Percona pages for PSMDB; the MongoDB distribution entries are covered by the official page of this hop below.
  if (distKey === 'psmdb') {
    for (const d of dist?.docs ?? []) if (inRange(to, d) && /^https?:/.test(d.url) && !/\{[a-z_]+\}/.test(fill(d.url, vars))) out.push({ label: fill(d.label, vars), url: fill(d.url, vars) });
    if (!dist?.docs?.length) { const pu = docs.percona_upgrade; if (pu && inRange(to, pu)) out.push({ label: fill(pu.label, vars), url: fill(pu.url, vars) }); }
  }
  // The official upgrade page of this exact hop (from, to and topology), when it exists.
  if (officialUrl) out.push({ label: `MongoDB: upgrade a ${topoName} from ${from} to ${to}`, url: officialUrl.split('#')[0] });
  if (atLeast(to, docs.mongodb_min_target)) {
    out.push({ label: `MongoDB: ${to} compatibility changes`, url: fill(docs.mongodb_compatibility, vars) });
    out.push({ label: `MongoDB: downgrade ${to}`, url: to === '9.0' && from === '8.0' ? 'https://www.mongodb.com/docs/manual/release-notes/9.0-downgrade-to-8.0/' : fill(docs.mongodb_downgrade, vars) });
  } else if (atLeast(to, '3.4')) {
    const gh = `https://github.com/mongodb/docs/blob/v${to}/source/release-notes/${to}`;
    if (!officialUrl) out.push({ label: `MongoDB: upgrade a ${topoName} to ${to} (archived docs source)`, url: `${gh}-${({ replset: 'upgrade-replica-set', sharded: 'upgrade-sharded-cluster', standalone: 'upgrade-standalone' })[topology]}.txt` });
    out.push({ label: `MongoDB: ${to} compatibility changes (archived docs source)`, url: `${gh}-compatibility.txt` });
  } else {
    out.push({ label: 'MongoDB release notes index', url: docs.mongodb_index });
  }
  // The same page can be listed under /docs/vX.Y/ and /docs/manual/: keep one.
  const key = (u) => u.replace(/\/docs\/(v\d+\.\d+|manual)\//, '/docs/*/').replace(/#.*$/, '').replace(/\/$/, '');
  const seen = new Set();
  return out.filter((d) => !seen.has(key(d.url)) && seen.add(key(d.url)));
}

// Driver check: the driver must be supported by every server version it talks
// to during the upgrade, so we check each major on the path, the source included.
function driverFindings(input, path, kb) {
  const byHop = {};
  const summary = [];
  const table = kb.drivers?.drivers ?? {};
  for (const { key, version } of input.drivers ?? []) {
    const d = table[key];
    if (!d) {
      summary.push({ key, name: key, version, status: 'unknown', message: `No compatibility data for driver "${key}".`, source: 'https://www.mongodb.com/docs/drivers/compatibility/' });
      continue;
    }
    const mins = path.map((s) => d.min_for_server?.[s]).filter(Boolean);
    const maxes = path.map((s) => d.max_for_server?.[s]).filter(Boolean);
    const missing = path.filter((s) => !d.min_for_server?.[s]);
    const lo = mins.length ? mins.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)) : null;
    const hi = maxes.length ? maxes.reduce((a, b) => (compareVersions(a, b) <= 0 ? a : b)) : null;
    const problems = [];
    const partials = [];
    path.forEach((s, idx) => {
      const min = d.min_for_server?.[s];
      const max = d.max_for_server?.[s];
      const partial = d.min_partial_for_server?.[s];
      const when = idx === 0 ? 'you start' : `the ${path[idx - 1]} to ${s} hop`;
      let msg = null;
      if (min && compareVersions(version, min) < 0) {
        if (partial && compareVersions(version, partial) >= 0) {
          partials.push(`MongoDB marks ${d.name} ${version} as working with server ${s} without all its new features (full support from ${min}).`);
        } else {
          msg = `MongoDB lists ${d.name} ${partial ?? min}+ for server ${s}${partial ? ` (${min}+ for full support)` : ''}. Upgrade the driver before ${when}.`;
        }
      } else if (max && compareVersions(version, max) > 0) {
        msg = `${d.name} support for server ${s} ends at ${max}. Your ${version} is newer, so keep the driver at ${max} or lower until the cluster leaves ${s}.`;
      }
      if (msg) {
        problems.push({ server: s, message: msg });
        if (idx > 0) (byHop[s] ??= []).push({ key, name: d.name, version, message: msg });
      }
    });
    let recommended;
    if (lo && (!hi || compareVersions(lo, hi) <= 0)) {
      recommended = hi ? `${lo} to ${hi}` : `${lo} or newer`;
    } else if (lo && hi) {
      recommended = `no single version covers ${path[0]} to ${path[path.length - 1]}: upgrade the driver part way through the path`;
    }
    if (d.latest_listed && compareVersions(version, d.latest_listed) > 0) partials.push(`${version} is newer than the last version in MongoDB's compatibility table (${d.latest_listed}); the table has not caught up yet.`);
    const status = problems.length ? 'blocker' : missing.length ? 'unknown' : partials.length ? 'partial' : 'ok';
    const tail = [
      missing.length ? `MongoDB's table has no entry for server ${missing.join(', ')}, check ${d.source}` : '',
      ...partials,
      recommended && status !== 'ok' ? `A version that covers the whole path: ${recommended}.` : '',
    ].filter(Boolean).join(' ');
    const message = problems.length
      ? `${d.name} ${version}: ${problems.map((p) => p.message).join(' ')} ${tail}`.trim()
      : status === 'ok'
        ? `${d.name} ${version} is listed as compatible with every version on the path.`
        : `${d.name} ${version}: ${tail}`;
    summary.push({ key, name: d.name, version, status, message, recommended, source: d.source });
  }
  return { byHop, summary };
}

export const DISTRIBUTIONS = {
  psmdb: 'Percona Server for MongoDB',
  'mongodb-community': 'MongoDB Community',
};
const PLATFORMS = ['packages', 'operator'];

// Items from the distribution and operator files may carry "distribution" at top level.
function normaliseItems(list, extraWhen) {
  return (list ?? []).map((it) => {
    const when = { ...(it.when ?? {}), ...(extraWhen ?? {}) };
    if (it.distribution && !when.distribution) when.distribution = it.distribution;
    return { ...it, when };
  });
}

const releaseKey = (dist) => (dist === 'psmdb' ? 'psmdb' : 'mongodb');

export function releasesFor(kb, dist, major) {
  return kb.releases?.releases?.[releaseKey(dist)]?.[major] ?? [];
}

export function latestRelease(kb, dist, major) {
  const ga = releasesFor(kb, dist, major).filter((r) => (r.channel ?? 'release') === 'release' && !r.prerelease);
  return ga.length ? ga[ga.length - 1] : null;
}

// Upstream entries ("6.0.2") match every PSMDB build of that patch ("6.0.2-1").
function sameRelease(listed, version) {
  try {
    const a = parseVersion(listed), b = parseVersion(version);
    if (a.major !== b.major || a.minor !== b.minor || (a.patch ?? 0) !== (b.patch ?? 0)) return false;
    return a.build === null || b.build === null || a.build === b.build;
  } catch { return false; }
}
// Public bug trackers: MongoDB's Jira for SERVER-, WT-, TOOLS-; Percona's Jira for PSMDB-, PBM-, K8SPSMDB-.
export function issueUrl(id) {
  if (!id) return null;
  if (/^(SERVER|WT|TOOLS|DRIVERS|CDRIVER|NODE|PYTHON|JAVA|CSHARP|GODRIVER)-\d+$/.test(id)) return `https://jira.mongodb.org/browse/${id}`;
  if (/^(PSMDB|PBM|K8SPSMDB|PMM)-\d+$/.test(id)) return `https://perconadev.atlassian.net/browse/${id}`;
  return null;
}
const avoidApplies = (a, dist, topology) => (a.distribution === 'all' || a.distribution === releaseKey(dist) || a.distribution === dist)
  && (!a.topology || !topology || a.topology.includes(topology));

// A prerequisite that names Amazon Linux 2023 applies only when the OS is unknown or is Amazon Linux 2023.
const osPrereqApplies = (x, os) => !os || os === 'amzn2023' || !/Amazon Linux 2023/.test(x.text ?? '');

function avoidFor(kb, dist, version, topology) {
  return (kb.releases?.avoid ?? []).filter((a) => avoidApplies(a, dist, topology) && a.versions.some((v) => sameRelease(v, version)));
}

function previewFor(kb, dist, major) {
  if (dist === 'psmdb' && kb.versions.previews?.[major]) return kb.versions.previews[major].message;
  return kb.distributions?.distributions?.[dist]?.majors_preview?.[major] ?? null;
}

function majorsFor(kb, dist) {
  const meta = kb.distributions?.distributions?.[dist];
  if (!meta?.majors_ga) return kb.versions.majors;
  return [...new Set([...meta.majors_ga, ...Object.keys(meta.majors_preview ?? {})])];
}

// ---------- release series graph ----------
// A series is "8.0", "8.2", "6.1"... Edges are the documented upgrade steps between series.
// Without graph data we fall back to consecutive majors.
const SELF_MANAGED = (s) => !/atlas/i.test(s.availability ?? '');

export function seriesFor(kb, dist) {
  const listed = kb.series?.series?.[releaseKey(dist)];
  let out;
  if (listed?.length) out = listed.map((s) => s.series);
  else {
    const withReleases = Object.keys(kb.releases?.releases?.[releaseKey(dist)] ?? {});
    const known = new Set([...majorsFor(kb, dist), ...withReleases]);
    out = [...kb.versions.majors.filter((m) => known.has(m) || (dist === 'psmdb' && kb.versions.previews?.[m])), ...majorsFor(kb, dist)];
  }
  return [...new Set(out)].sort(compareVersions);
}

function edgesFor(kb, dist) {
  const listed = kb.series?.edges?.[releaseKey(dist)];
  // Forbidden jumps are dropped; "not-available" (PSMDB 9.0, not GA) stays as a preview edge.
  if (listed?.length) return listed.filter((e) => e.allowed !== false || e.status === 'not-available');
  const m = seriesFor(kb, dist);
  return m.slice(1).map((to, i) => ({ from: m[i], to }));
}

export function findPath(kb, dist, from, to) {
  if (from === to) return [from];
  const edges = edgesFor(kb, dist);
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    // Prefer the documented direct edge to the highest series first, so 8.0 -> 9.0 beats 8.0 -> 8.2 -> 8.3 -> 9.0.
    const next = edges.filter((e) => e.from === cur).map((e) => e.to).sort((a, b) => compareVersions(b, a));
    for (const n of next) {
      if (prev.has(n) || compareVersions(n, to) > 0) continue;
      prev.set(n, cur);
      if (n === to) {
        const path = [to];
        for (let p = cur; p !== null; p = prev.get(p)) path.unshift(p);
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}

export function seriesInfo(kb, dist, series) {
  return (kb.series?.series?.[releaseKey(dist)] ?? []).find((s) => s.series === series) ?? null;
}
export const isAtlasOnly = (kb, dist, series) => /atlas/i.test(seriesInfo(kb, dist, series)?.availability ?? '');

export function reachableFrom(kb, dist, from) {
  return seriesFor(kb, dist).filter((s) => compareVersions(s, from) > 0 && !isAtlasOnly(kb, dist, s) && findPath(kb, dist, from, s));
}

function edgeInfo(kb, dist, from, to) {
  return (kb.series?.edges?.[releaseKey(dist)] ?? []).find((e) => e.from === from && e.to === to) ?? null;
}

// ---------- official procedures ----------
function officialEntry(kb, key, from, to) {
  const t = kb.official?.[key]?.[to];
  if (!t) return null;
  return t[`from_${from}`] ?? (Object.keys(t).some((k) => k.startsWith('from_')) ? null : t);
}
const stripPrompt = (c) => (c ? String(c).split('\n').map((l) => l.replace(/^\s*[$>] /, '')).join('\n') : c);
const pmCmd = (st, pm) => stripPrompt(st[`cmd_${pm}`] ?? st.cmd ?? undefined);
const mapStep = (st, pm) => ({
  heading: st.doc_heading ? st.doc_heading.replace(/[.:]$/, '') : undefined,
  text: st.text,
  cmd: pmCmd(st, pm),
  snippet: st.config_snippet,
  substeps: st.substeps?.map((x) => mapStep(x, pm)),
  url: st.url,
});
// Use the doc heading as title, or the first sentence of the text when the heading is generic.
function prereqTitle(x) {
  const h = (x.doc_heading ?? '').replace(/[.:]$/, '').trim();
  if (h && !/^(percona prerequisite|prerequisites?|considerations?|upgrade considerations|note|important|steps|procedure)$/i.test(h)) return h;
  const first = String(x.text ?? '').split(/(?<=\.)\s/)[0].replace(/\.$/, '');
  return first.length > 90 ? first.slice(0, 87).replace(/\s+\S*$/, '') + '...' : first || 'Prerequisite';
}
// One list of steps: MongoDB's order across members, with the per-node package
// commands placed where that order says to replace the binary.
const RE_REPLACE = /replace|binar/i;
const RE_SHUTDOWN_ONLY = /shut ?down/i;
const RE_MEMBER_UPGRADE = /^upgrade (the )?(secondar|primary|previous primary|former primary)/i;
const RE_UPGRADE_MONGOS = /^upgrade (the |all )?mongos/i;
const RE_SHUTDOWN_STEP = /^shut ?down the (replica set member|mongod instance|mongod|standalone)/i;
const PKG = { psmdb: 'percona-server-mongodb', 'mongodb-community': 'mongodb-org' };

// Install exactly the version the plan lands on. The package set depends on the series:
// -database exists from 5.0, the legacy -shell until 5.0, mongosh is its own package from 5.0.
// PSMDB apt: the tools package has its own numbering (100.x) in current releases, so it is not pinned.
function pinnedInstall(kb, dist, pm, version, which = 'all') {
  if (!version) return null;
  const s = majorOf(version);
  if (dist === 'psmdb') {
    // Older releases depend on tools of the exact same version; newer ones on 100.x tools without a version.
    const from100 = kb.releases?.psmdb_tools_unpinned_from?.[s];
    const toolsPinned = !from100 || compareVersions(version, from100) < 0;
    // yum does not upgrade the tools with the server (lab-tested), so they are named in the same command.
    if (pm === 'yum') return which === 'mongos' ? `sudo yum install -y percona-server-mongodb-mongos-${version}$(rpm -E %{dist})`
      : `sudo yum install -y percona-server-mongodb-${version}$(rpm -E %{dist}) percona-server-mongodb-tools${toolsPinned ? `-${version}$(rpm -E %{dist})` : ''}`;
    const tag = `${version}.$(lsb_release -sc)`;
    const pk = which === 'mongos' ? ['percona-server-mongodb-mongos'] : ['percona-server-mongodb', 'percona-server-mongodb-server', 'percona-server-mongodb-mongos', 'percona-server-mongodb-shell'];
    const tools = which === 'mongos' ? '' : ` percona-server-mongodb-tools${toolsPinned ? `=${tag}` : ''}`;
    // --force-confold keeps your /etc/mongod.conf instead of stopping at the dpkg configuration file prompt.
    return `sudo apt install -y -o Dpkg::Options::="--force-confold" ${pk.map((x) => `${x}=${tag}`).join(' ')}${tools}`;
  }
  const v = version.replace(/-\d+$/, '');
  const b = PKG[dist];
  const pk = which === 'mongos' ? [`${b}-mongos`] : [b, `${b}-server`, `${b}-mongos`, `${b}-tools`, ...(atLeast(s, '5.0') ? [`${b}-database`] : []), ...(atLeast(s, '6.0') ? [] : [`${b}-shell`])];
  const extra = which !== 'mongos' && atLeast(s, '5.0') ? ' mongodb-mongosh' : '';
  return pm === 'yum' ? `sudo yum install -y ${pk.map((x) => `${x}-${v}`).join(' ')}${extra}` : `sudo apt-get install -y ${pk.map((x) => `${x}=${v}`).join(' ')}${extra}`;
}
const RE_PKG_INSTALL = /^(sudo )?(yum|dnf|apt|apt-get) install( -y)?( -o \S+)? (percona-server-mongodb|mongodb-org)\b/;
const splitChain = (cmd) => String(cmd).split(/\s+&&\s+/).map((c) => c.trim()).filter(Boolean);

// Repository and package commands of one series, adapted to the OS family and architecture.
function packageVars(kb, dist, pm, series, version, input) {
  const meta = kb.distributions?.distributions?.[dist];
  const vars = { major: series, major_nodot: series.replace('.', ''), to: series, version };
  const gpg = typeof meta?.repo_setup?.gpg_key === 'object' ? meta.repo_setup.gpg_key : kb.distributions?.distributions?.['mongodb-community']?.repo_setup?.gpg_key;
  if (gpg?.template && dist !== 'psmdb') { vars.key_name = gpg.key_name_by_major?.[series] ?? series; vars.gpg_key_url = fill(gpg.template, vars); }
  let repo = typeof meta?.repo_setup?.[pm] === 'string' ? fill(meta.repo_setup[pm], vars) : undefined;
  if (repo && pm === 'apt' && /^debian/.test(input?.os ?? '') && typeof meta?.repo_setup?.apt_debian === 'string') {
    const deb = fill(meta.repo_setup.apt_debian, vars);
    repo = splitChain(repo).map((c) => (/^echo "deb /.test(c) ? deb : c)).join(' && ');
  }
  if (repo && pm === 'yum' && input?.arch === 'aarch64') repo = repo.replace(/\/x86_64\//g, '/aarch64/');
  vars.repo = repo;
  vars.install = typeof meta?.upgrade_install?.[pm] === 'string' ? fill(meta.upgrade_install[pm], vars) : undefined;
  return vars;
}

// Commands to upgrade one member with packages: stop, repository, exact-version install, start.
function nodeCommands(kb, dist, pm, vars, perconaSteps, preview) {
  const pinned = pinnedInstall(kb, dist, pm, vars.version);
  if (dist === 'psmdb') {
    let node;
    if (perconaSteps?.length) {
      node = perconaSteps.map((st) => mapStep(st, pm)).filter((st) => st.cmd || st.snippet)
        .filter((st) => !/setFeatureCompatibilityVersion/.test(st.cmd ?? ''))
        .map((st) => (pinned && RE_PKG_INSTALL.test(st.cmd ?? '') ? { ...st, cmd: pinned } : st));
      if (pinned && !node.some((st) => RE_PKG_INSTALL.test(st.cmd ?? ''))) {
        const k = node.findIndex((st) => /systemctl start/.test(st.cmd ?? ''));
        node.splice(k >= 0 ? k : node.length, 0, { text: 'Install the packages (Percona installation docs).', cmd: pinned });
      }
    } else {
      node = [{ cmd: 'sudo systemctl stop mongod' }, { cmd: `sudo percona-release enable psmdb-${vars.major_nodot}${preview ? ' testing' : ''}` }, ...(pinned ? [{ cmd: pinned }] : []), { cmd: 'sudo systemctl start mongod' }];
    }
    if (pm === 'apt' && !node.some((st) => /apt(-get)? update/.test(st.cmd ?? ''))) {
      const k = node.findIndex((st) => RE_PKG_INSTALL.test(st.cmd ?? ''));
      if (k >= 0) node.splice(k, 0, { cmd: 'sudo apt update' });
    }
    return node;
  }
  if (!vars.repo && !vars.install) return [];
  const install = pinned ?? splitChain(vars.install).filter((c) => !/update$/.test(c)).join('\n');
  // Repository setup needs no downtime: it goes before the member is stopped.
  return [
    ...(vars.repo ? splitChain(vars.repo).map((c) => ({ cmd: c })) : []),
    ...(pm === 'apt' && !(vars.repo ?? '').includes('update') ? [{ cmd: 'sudo apt-get update' }] : []),
    { cmd: 'sudo systemctl stop mongod' },
    { cmd: install },
    { cmd: 'sudo systemctl start mongod' },
  ];
}

const VERIFY = (svc) => [`systemctl is-active ${svc}`, `${svc} --version | head -1`];

function nodeBlock(node, heading, url) {
  // Steps without a command are notes only when they carry a config change (e.g. remove fork).
  const notes = node.filter((st) => !st.cmd && st.snippet).map((st) => st.text);
  const cmds = node.filter((st) => st.cmd).map((st) => st.cmd);
  // Lab-tested: a failed install or a mongod that exits at start still lets the block finish quietly, so the last lines confirm the new version runs.
  if (cmds.some((c) => /systemctl (start|restart) mongod/.test(c))) cmds.push(...VERIFY('mongod'));
  const verify = cmds.length && VERIFY('mongod').every((c) => cmds.includes(c)) ? ' The last two lines confirm the service is active and runs the new version (tested on a lab cluster).' : '';
  return { heading, text: (notes.length ? notes.join(' ') : 'Run these commands on the member:') + verify, cmd: cmds.join('\n'), url, node: true };
}

function mongosBlock(kb, dist, pm, vars) {
  if (!vars?.version) return null;
  const install = pinnedInstall(kb, dist, pm, vars.version, 'mongos');
  if (dist === 'psmdb') {
    return { heading: 'On each mongos host', text: 'Install the mongos package of the same version and restart the mongos service. Percona documents a systemd unit for mongos; use your unit name if it differs.',
      cmd: [`sudo percona-release enable psmdb-${vars.major_nodot}`, ...(pm === 'apt' ? ['sudo apt update'] : []), install, 'sudo systemctl restart mongos', ...VERIFY('mongos')].join('\n'),
      url: `https://docs.percona.com/percona-server-for-mongodb/${atLeast(vars.major, '6.0') ? vars.major : '8.0'}/mongos-config.html`, node: true };
  }
  return { heading: 'On each mongos host', text: 'Install the mongos package of the same version, then restart mongos the way you run it (the MongoDB packages ship no mongos service).',
    cmd: [...(vars.repo ? splitChain(vars.repo) : []), ...(pm === 'apt' ? ['sudo apt-get update'] : []), install].join('\n'), node: true };
}

function mergeSteps(order, node, dist, to, nodeUrl, mongos, waitUrl, topology) {
  if (!order.length || !node.length) return null;
  const wait = { text: 'Wait for the member to recover to SECONDARY state before you upgrade the next secondary.', cmd: 'rs.status()', url: waitUrl };
  const label = (i) => (topology === 'standalone' ? 'On the server' : i === 0 ? 'On each secondary, one at a time' : 'On the former primary');
  // MongoDB's pages describe replacing binaries by hand (mongod --configsvr <options> ...).
  // With packages the per-node commands do it, so those hand-start commands are dropped.
  const manualStart = (c) => /<[^>]+>/.test(c ?? '') || /^mongo[ds] --/.test(c ?? '');
  const out = [];
  for (const st of order) {
    const heading = st.heading ?? '';
    if (RE_UPGRADE_MONGOS.test(heading)) { out.push({ ...st, cmd: manualStart(st.cmd) ? undefined : st.cmd, substeps: mongos ? [mongos] : st.substeps }); continue; }
    if (/mongos/i.test(heading)) { out.push({ ...st, cmd: manualStart(st.cmd) ? undefined : st.cmd }); continue; }
    if (RE_SHUTDOWN_STEP.test(heading) && !st.substeps?.length) continue;
    if (st.substeps?.length) {
      const subs = [];
      let replaced = 0;
      for (const sub of st.substeps) {
        // Inside a replica set procedure the first binary replacement is for the secondaries, the next for the former primary.
        if (RE_REPLACE.test(sub.text ?? '')) subs.push(nodeBlock(node, label(replaced++), nodeUrl));
        else if (RE_SHUTDOWN_ONLY.test(sub.text ?? '')) continue;
        else subs.push({ ...sub, cmd: manualStart(sub.cmd) ? undefined : sub.cmd });
      }
      out.push({ ...st, cmd: manualStart(st.cmd) ? undefined : st.cmd, substeps: subs });
      continue;
    }
    if (RE_MEMBER_UPGRADE.test(heading) || (RE_REPLACE.test(`${heading} ${st.text ?? ''}`) && !/feature/i.test(heading))) {
      const secondary = /secondar/i.test(heading + ' ' + (st.text ?? ''));
      const lab = label(secondary ? 0 : 1);
      out.push({ ...st, text: topology === 'standalone' ? 'Upgrade the packages and restart mongod.' : st.text, cmd: manualStart(st.cmd) ? undefined : st.cmd,
        substeps: secondary && topology !== 'standalone' ? [nodeBlock(node, lab, nodeUrl), wait] : [nodeBlock(node, lab, nodeUrl)] });
      continue;
    }
    out.push(st);
  }
  return out;
}

// ---------- patch upgrade inside one series ----------
// Patch upgrade steps: MongoDB's "Upgrade to the Latest Patch Release" page, with the
// package commands where it says to upgrade the instance (Percona's minor-upgrade page for PSMDB).
const RE_UPGRADE_INSTANCE = /upgrade (its|the secondary's|the) (mongod )?(instance|binary)|upgrade a mongodb instance/i;

function patchProcedure(kb, distribution, topology, pm, series, toVersion, input) {
  const p = kb.patch ?? {};
  const mdb = p.mongodb ?? {};
  const per = distribution === 'psmdb' ? p.psmdb?.[series] : null;
  if (input?.platform === 'operator') {
    const steps = (kb.operator?.patch_procedure ?? []).map((st) => ({ text: fill(st.text, { apply: toVersion }), cmd: st.cmd ? fill(st.cmd, { namespace: '<namespace>' }) : undefined, snippet: st.snippet ? fill(st.snippet, { apply: toVersion }) : undefined, url: st.url }));
    return { merged: steps, orderSource: steps[0]?.url ?? null, nodeSource: null, per: null, mdb: {}, order: [], node: [], prerequisites: [], issues: [] };
  }
  const vars = packageVars(kb, distribution, pm, series, toVersion, input);
  const node = nodeCommands(kb, distribution, pm, vars, per?.steps, false);
  const block = (label) => {
    const cmds = node.filter((n) => n.cmd).map((n) => n.cmd);
    const verify = cmds.some((c) => /systemctl (start|restart) mongod/.test(c));
    if (verify) cmds.push(...VERIFY('mongod'));
    return { heading: label, text: (per ? 'Commands from the Percona minor upgrade page:' : 'Commands from the MongoDB installation page:') + (verify ? ' The last two lines confirm the service is active and runs the new version (tested on a lab cluster).' : ''),
      cmd: cmds.join('\n'), url: per?.url, node: true };
  };
  const step = (st, label) => {
    const out = { text: st.text, cmd: RE_UPGRADE_INSTANCE.test(st.text) ? undefined : stripPrompt(st.cmd), url: st.url ?? mdb.url };
    if (RE_UPGRADE_INSTANCE.test(st.text) && node.length) out.substeps = [block(label)];
    else if (st.substeps?.length && !RE_UPGRADE_INSTANCE.test(st.text)) out.substeps = st.substeps.map((x) => ({ text: x.text, cmd: stripPrompt(x.cmd) }));
    return out;
  };
  const replset = (mdb.replset?.steps ?? []).map((st) => step(st, /secondar/i.test(st.text) ? 'On each secondary, one at a time' : 'On the former primary'));
  let merged;
  if (topology === 'standalone') {
    merged = [{ text: 'Upgrade the packages and restart mongod.', url: per?.url ?? mdb.url, substeps: node.length ? [block('On the server')] : undefined }];
  } else if (topology === 'replset') {
    merged = replset;
  } else {
    merged = (mdb.sharded?.steps ?? []).map((st) => {
      if (/replica sets? procedure/i.test(st.text)) return { text: st.text, url: st.url ?? mdb.url, substeps: replset };
      if (/upgrade each mongos|mongos instances?\b/i.test(st.text) && !/balancer/i.test(st.text)) {
        const mb = mongosBlock(kb, distribution, pm, vars);
        return { text: st.text, url: st.url ?? mdb.url, substeps: mb ? [mb] : undefined };
      }
      return { text: st.text, cmd: stripPrompt(st.cmd), url: st.url ?? mdb.url };
    });
  }
  const variant = Object.entries(mdb.variants ?? {}).find(([k]) => k === series || (k.includes('-') && compareVersions(series, k.split('-')[0]) >= 0 && compareVersions(series, k.split('-')[1]) <= 0))?.[1];
  return { merged, orderSource: variant?.url ?? mdb.url ?? null, nodeSource: per?.url ?? null, per, mdb, order: [], node: [], prerequisites: [], issues: [] };
}

function patchHop(input, kb, { distribution, topology, pm }) {
  const series = majorOf(input.from);
  const official = patchProcedure(kb, distribution, topology, pm, series, input.toVersion, input);
  const { mdb, per } = official;
  const items = [];
  for (const [k, x] of [...(mdb.prerequisites ?? []), ...(per?.prerequisites ?? [])].filter((x) => osPrereqApplies(x, input.os)).entries()) {
    items.push({ id: `patch-prereq-${k}`, section: 'preflight', severity: 'blocker', title: prereqTitle(x), action: x.text,
      check: stripPrompt(x.cmd ?? x[`cmd_${pm}`]), runOn: runOnFor(stripPrompt(x.cmd ?? x[`cmd_${pm}`])), verified: false, basis: 'docs', sourceUrl: x.url ?? mdb.url ?? per?.url });
  }
  for (const a of avoidFor(kb, distribution, input.toVersion, topology)) {
    items.push({ id: `patch-avoid-${a.issue}`, section: 'preflight', severity: 'warning', title: `${input.toVersion} has a known issue`,
      action: `${a.issue ?? 'Known issue'}: ${a.reason}.`, verified: false, basis: 'docs', sourceUrl: issueUrl(a.issue) ?? a.url });
  }
  const osIt = osItem(kb, distribution, input.os, input.arch, series, series);
  if (osIt) items.unshift(osIt);
  const dg = mdb.downgrade;
  return {
    from: input.from, to: input.toVersion, patch: true, series, distribution, distributionName: DISTRIBUTIONS[distribution], preview: null,
    latestTo: input.toVersion, preflight: items, behaviour: [], steps: [], official,
    stepsSource: official.orderSource, post: [],
    rollback: dg ? { beforeSetFcv: dg.text, afterSetFcv: 'The patch upgrade page does not change or mention FCV for patch releases.', sourceUrl: dg.url, verified: true } : null,
    docs: [official.orderSource ? { label: input.platform === 'operator' ? 'Percona Operator: upgrade to a specific version' : 'MongoDB: upgrade to the latest patch release', url: official.orderSource } : null,
      per?.url ? { label: `Percona: minor upgrade of PSMDB ${series}`, url: per.url } : null].filter(Boolean),
  };
}

// Generic checks that the official prerequisites replace when they exist.
const REPLACED_BY_PREREQS = new Set(['fcv-matches-current', 'rs-health', 'latest-minor-first', 'one-major-at-a-time']);

function officialProcedure(kb, dist, from, to, topology, pm, vars, preview) {
  const mdb = officialEntry(kb, 'mongodb', from, to);
  const order = mdb?.[topology] ?? null;
  const out = { order: [], orderSource: null, node: [], nodeSource: null, nodeLabel: null, prerequisites: [], issues: [] };
  const p = dist === 'psmdb' ? officialEntry(kb, 'psmdb', from, to) : null;
  out.node = nodeCommands(kb, dist, pm, vars, p?.steps, preview);
  if (p) {
    out.nodeSource = p.url;
    out.nodeLabel = 'Percona';
    out.prerequisites.push(...(p.prerequisites ?? []).map((x) => ({ ...x, doc_heading: !x.doc_heading || /^prerequisites?:?$/i.test(x.doc_heading) ? 'Percona prerequisite' : x.doc_heading, url: x.url ?? p.url })));
    const setFcvStep = p.steps?.find((st) => /setFeatureCompatibilityVersion/.test(st.cmd ?? ''));
    const pageFcv = setFcvStep?.cmd?.match(/setFeatureCompatibilityVersion:\s*"([\d.]+)"/)?.[1];
    if (pageFcv && pageFcv !== to) out.issues.push({ text: `The Percona page sets FCV "${pageFcv}". This plan sets "${to}", which MongoDB requires to enable ${to} features and to upgrade further.`, url: p.url });
  } else if (dist === 'psmdb') {
    out.nodeSource = 'https://docs.percona.com/percona-server-for-mongodb/8.0/install/index.html';
    out.nodeLabel = 'Percona installation docs';
  } else {
    out.nodeLabel = 'MongoDB installation docs';
  }
  if (order) { out.order = order.steps.map((st) => mapStep(st, pm)); out.orderSource = order.url; }
  out.merged = mergeSteps(out.order, out.node, dist, to, out.nodeSource, mongosBlock(kb, dist, pm, vars), order?.url, topology);
  // No MongoDB page for this hop: the per-node commands alone, then FCV.
  if (!out.merged && out.node.length) {
    out.merged = [{ heading: topology === 'standalone' ? 'Upgrade the server' : 'Upgrade each member, one at a time', text: 'Run these commands on each member.', substeps: [nodeBlock(out.node, topology === 'standalone' ? 'On the server' : 'On each member', out.nodeSource)] },
      ...(atLeast(to, '3.4') ? [{ heading: `Enable ${to} features`, text: `Set the feature compatibility version to "${to}".`, cmd: vars.setfcv }] : [])];
  }
  if (order) {
    out.prerequisites.push(...(order.prerequisites ?? []).map((x) => ({ ...x, url: x.url ?? order.url })));
    if (order.doc_issues) out.issues.push(...[].concat(order.doc_issues).map((t) => ({ text: typeof t === 'string' ? t : t.text ?? JSON.stringify(t), url: order.url })));
    if (order.warnings) out.issues.push(...[].concat(order.warnings).map((t) => ({ text: typeof t === 'string' ? t : t.text ?? JSON.stringify(t), url: order.url, kind: 'warning' })));
  }
  return out;
}

// ---------- operating system support ----------
function osList(kb, dist, series, arch) {
  const t = kb.os?.support?.[releaseKey(dist)]?.[series];
  if (!t) return null;
  const latest = latestRelease(kb, dist, series)?.version;
  const capped = (o) => t.max_patch?.[o] && latest && compareVersions(t.max_patch[o], latest) < 0;
  const lists = (arch && t[arch] ? [t[arch]] : ['x86_64', 'aarch64'].map((a) => t[a]).filter(Boolean)).map((l) => l.filter((o) => !capped(o)));
  const src = t.url ?? (Array.isArray(t.sources) ? (t.sources[0]?.url ?? t.sources[0]) : undefined);
  return { list: [...new Set(lists.flat())], url: src, quote: t.quote };
}
const osLabel = (kb, id) => kb.os?.os?.[id] ?? id;
const osFamily = (id) => id.replace(/[0-9]+$/, '');

function osItem(kb, dist, os, arch, from, to) {
  if (!os) return null;
  const target = osList(kb, dist, to, arch);
  if (!target || target.list.includes(os)) return null;
  const cap = kb.os?.support?.[releaseKey(dist)]?.[to]?.max_patch?.[os];
  const source = osList(kb, dist, from, arch);
  // A newer release of the same OS family that both versions support: upgrade the OS there first.
  const num = (o) => Number(o.replace(/^[a-z]+/, ''));
  const bridge = target.list.filter((o) => osFamily(o) === osFamily(os) && num(o) > num(os) && (!source || source.list.includes(o))).sort((a, b) => num(a) - num(b));
  const names = bridge.map((o) => osLabel(kb, o));
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
  const action = bridge.length
    ? `Upgrade the operating system to ${list} while the cluster still runs ${from}, one member at a time, then run this hop.`
    : `${to} has no build for ${osLabel(kb, os)}. Move the members to a supported operating system (rolling, by adding new members and removing old ones) before this hop.`;
  const capNote = cap ? ` The last ${to} build for ${osLabel(kb, os)} is ${cap}; newer ${to} patches, with their security fixes, are not built for it.` : '';
  return { id: `os-${to}`, section: 'preflight', severity: 'blocker', title: cap ? `${to} is no longer built for ${osLabel(kb, os)}` : `${to} does not support ${osLabel(kb, os)}`,
    action: action + capNote, verified: false, basis: 'docs', sourceUrl: target.url, quote: target.quote };
}

function minPatchFor(kb, dist, series, os) {
  const t = kb.os?.support?.[releaseKey(dist)]?.[series]?.min_patch;
  if (!t) return null;
  const hit = Object.entries(t).find(([k]) => k.split(/[^a-z0-9]+/).includes(os));
  return hit ? hit[1] : null;
}

// One OS upgrade for the whole path when possible: the first hop whose target does not
// support the current OS is where it has to happen; recommend OS releases supported by
// the series running at that moment and by every later series on the path.
function osPlanFor(kb, input, path, distAt, os = input.os, start = 0) {
  if (!os) return null;
  const arch = input.arch;
  const cur = osList(kb, distAt(start), path[start], arch);
  const currentUnsupported = start === 0 && cur && !cur.list.includes(os);
  let at = -1;
  for (let i = start + 1; i < path.length; i++) {
    const t = osList(kb, distAt(i), path[i], arch);
    if (t && !t.list.includes(os)) { at = i; break; }
  }
  if (at === -1) return currentUnsupported ? { os, label: osLabel(kb, os), currentUnsupported: true, series: path[0], url: cur.url } : null;
  const num = (o) => Number(o.replace(/^[a-z]+/, ''));
  const lists = path.slice(at - 1).map((sr, k) => osList(kb, distAt(at - 1 + k), sr, arch)).filter(Boolean);
  const all = lists.reduce((acc, l) => acc.filter((o) => l.list.includes(o)), lists[0]?.list ?? []);
  const sameFamily = (o) => osFamily(o) === osFamily(os) && num(o) > num(os);
  const recommend = all.filter(sameFamily).sort((a, b) => num(b) - num(a));
  const bridge = (lists[0]?.list ?? []).filter((o) => (lists[1]?.list ?? []).includes(o) && sameFamily(o)).sort((a, b) => num(b) - num(a));
  return {
    os, label: osLabel(kb, os), at, during: path[at - 1], before: path[at],
    recommend: recommend.map((o) => ({ id: o, label: osLabel(kb, o), minPatch: minPatchFor(kb, distAt(at - 1), path[at - 1], o) })),
    alternatives: bridge.filter((o) => !recommend.includes(o)).map((o) => ({ id: o, label: osLabel(kb, o) })),
    otherFamilies: all.filter((o) => osFamily(o) !== osFamily(os)).map((o) => ({ id: o, label: osLabel(kb, o) })),
    supportedDuring: (lists[0]?.list ?? []).map((o) => osLabel(kb, o)),
    supportedBefore: (lists[1]?.list ?? []).map((o) => osLabel(kb, o)),
    urls: [...new Set([lists[0]?.url, lists[1]?.url].filter(Boolean))],
    currentUnsupported,
  };
}

// Newest-last list of the PSMDB images that any Operator release certifies for a series.
export function certifiedImages(kb, series) {
  const all = new Set();
  for (const o of kb.operator?.operator_versions ?? []) for (const v of o.psmdb_versions ?? []) { try { if (majorOf(v) === series) all.add(v); } catch { /* skip */ } }
  return [...all].sort(compareVersions);
}

export function osOptions(kb) {
  return Object.entries(kb.os?.os ?? {}).map(([id, label]) => ({ id, label }));
}

export function buildRoadmap(input, kb) {
  const { versions, changes, procedures } = kb;
  const topology = input.topology ?? 'replset';
  const distribution = input.distribution ?? 'psmdb';
  const targetDistribution = input.targetDistribution ?? distribution;
  const platform = input.platform ?? 'packages';
  const pm = input.packageManager ?? 'apt';
  if (!TOPOLOGIES.includes(topology)) throw new Error(`Unknown topology "${topology}", use one of ${TOPOLOGIES.join(', ')}`);
  for (const d of [distribution, targetDistribution]) if (!DISTRIBUTIONS[d]) throw new Error(`Unknown distribution "${d}"`);
  if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform "${platform}"`);
  if (platform === 'operator') {
    if (topology === 'standalone') throw new Error('The Percona Operator runs replica sets and sharded clusters, not standalone servers.');
    if (distribution !== 'psmdb' || targetDistribution !== 'psmdb') throw new Error('The Percona Operator runs Percona Server for MongoDB only. Moving a cluster into Kubernetes is a migration, not an upgrade.');
  }
  if (input.toVersion && parseVersion(input.toVersion).build === null) {
    const full = releasesFor(kb, targetDistribution, majorOf(input.toVersion)).find((r) => sameRelease(r.version, input.toVersion));
    if (full) input = { ...input, toVersion: full.version };
  }
  const fromMajor = majorOf(input.from);
  const toSeries = majorOf(input.to);
  const sourceSeries = seriesFor(kb, distribution);
  if (!sourceSeries.includes(fromMajor)) {
    throw new Error(`${input.from} is not a ${DISTRIBUTIONS[distribution]} release series. Known series: ${sourceSeries.join(', ')}.`);
  }
  if (compareVersions(toSeries, fromMajor) < 0) throw new Error(`Target ${toSeries} is older than source ${fromMajor}, downgrades are not planned`);
  const path = findPath(kb, distribution, fromMajor, toSeries)
    ?? (targetDistribution !== distribution ? findPath(kb, targetDistribution, fromMajor, toSeries) : null);
  if (!path) throw new Error(`There is no documented upgrade path from ${fromMajor} to ${toSeries} for ${DISTRIBUTIONS[distribution]}.`);
  const blockers = [];
  const warnings = [];
  const distMeta = (d) => kb.distributions?.distributions?.[d];

  if (isAtlasOnly(kb, distribution, fromMajor)) {
    warnings.push(`${fromMajor} is a rapid release, supported only in MongoDB Atlas. MongoDB documents no self-managed upgrade procedure for it; the path below follows the documented release order.`);
  }

  // FCV state on the source cluster (check 2).
  if (input.fcv !== undefined && atLeast(fromMajor, versions.fcv_introduced)) {
    if (/upgrading|downgrading/i.test(String(input.fcv))) {
      blockers.push(`FCV is in a transitional state (${input.fcv}). Finish or revert the previous setFeatureCompatibilityVersion first.`);
    } else if (majorOf(input.fcv) !== fromMajor) {
      blockers.push(`FCV is "${majorOf(input.fcv)}" but binaries are ${fromMajor}. Run ${setFcvCommand(fromMajor, versions)} before the first hop.`);
    }
  }

  // Exact source version: latest patch and versions to avoid.
  const fromParsed = parseVersion(input.from);
  const latestFrom = platform === 'operator'
    ? (certifiedImages(kb, fromMajor).length ? { version: certifiedImages(kb, fromMajor).at(-1) } : null)
    : latestRelease(kb, distribution, fromMajor);
  const isPatchPlan = toSeries === fromMajor && targetDistribution === distribution && input.toVersion && compareVersions(input.toVersion, input.from) > 0;
  if (!isPatchPlan && fromParsed.patch !== null && latestFrom && !sameRelease(input.from, latestFrom.version) && compareVersions(input.from, latestFrom.version) < 0) {
    warnings.push(`You run ${input.from}. The latest ${DISTRIBUTIONS[distribution]} ${fromMajor} patch is ${latestFrom.version}${latestFrom.date ? ` (${latestFrom.date})` : ''}. Upgrade to it before the first hop.`);
  }
  for (const a of fromParsed.patch !== null ? avoidFor(kb, distribution, input.from, topology) : []) {
    const fixedHere = latestFrom && !avoidFor(kb, distribution, latestFrom.version, topology).some((b) => b.issue === a.issue);
    warnings.push(`${input.from} is affected by ${a.issue ?? 'a known issue'}: ${a.reason}. ${fixedHere ? `Move to a fixed patch (${latestFrom.version}) before the upgrade.` : `No ${fromMajor} patch fixes it; the upgrade itself moves you to a fixed series.`}`);
  }

  // Distribution switch.
  let sw = null;
  let switchIndex = Infinity;
  if (targetDistribution !== distribution) {
    const def = (kb.distributions?.switches ?? []).find((x) => x.from === distribution && x.to === targetDistribution);
    const targetMajors = majorsFor(kb, targetDistribution);
    switchIndex = path.findIndex((m) => targetMajors.includes(m) && !previewFor(kb, targetDistribution, m) && (!def?.majors || def.majors.includes(m)));
    if (switchIndex === -1) {
      blockers.push(`No major on this path supports a switch from ${DISTRIBUTIONS[distribution]} to ${DISTRIBUTIONS[targetDistribution]}.`);
      switchIndex = Infinity;
    } else {
      const at = path[switchIndex];
      const svars = { major: at, major_nodot: at.replace('.', ''), from: at, to: at };
      svars.repo_lines = splitChain(packageVars(kb, targetDistribution, pm, at, null, input).repo ?? '').join('\n');
      sw = {
        from: distribution, to: targetDistribution, at, index: switchIndex,
        fromName: DISTRIBUTIONS[distribution], toName: DISTRIBUTIONS[targetDistribution],
        sameMajor: def?.same_major_required !== false,
        steps: (Array.isArray(def?.steps) ? def.steps : (def?.steps?.[pm] ?? []))
          .map((st) => ({ text: fill(st.text, svars), cmd: st.cmd ? fill(st.cmd, svars) || undefined : undefined }))
          .filter((st) => st.cmd || !/repository for/.test(st.text)),
        order: topology === 'standalone' ? (def?.steps?.topology?.standalone ?? null)
          : (def?.steps?.rolling ?? []).find((x) => x.text.startsWith(topology === 'sharded' ? 'Sharded' : 'Replica set'))?.text
            ?? def?.steps?.topology?.[topology] ?? null,
        blockers: normaliseItems(def?.blockers).filter((i) => !i.hop_to || i.hop_to === '*' || i.hop_to === at).map((i) => renderItem({ section: 'preflight', ...i }, svars)),
        docs: (def?.docs ?? []).map((d) => ({ label: fill(d.label, svars), url: fill(d.url, svars) })),
        documented: Boolean(def) && def.documented !== false,
      };
      if (def && def.documented === false) warnings.push(`Neither MongoDB nor Percona documents a switch from ${DISTRIBUTIONS[distribution]} to ${DISTRIBUTIONS[targetDistribution]}. The steps below are pieced together from partial docs. Test it on a copy first.`);
      if (!def) warnings.push(`There is no documented procedure in the knowledge base for switching from ${DISTRIBUTIONS[distribution]} to ${DISTRIBUTIONS[targetDistribution]}. Treat it as a migration and test it first.`);
    }
  }

  const allItems = [
    ...changes.items,
    ...normaliseItems(kb.distributions?.items),
    ...normaliseItems(kb.operator?.items, { platform: ['operator'] }),
  ];

  // Every OS upgrade the path needs, in order: after each one the plan continues with the new OS.
  const distAt = (i) => (i >= switchIndex ? targetDistribution : distribution);
  const osPlans = [];
  for (let os = input.os, start = 0, guard = 0; os && guard < 6; guard++) {
    const pl = osPlanFor(kb, input, path, distAt, os, start);
    if (!pl) break;
    if (pl.currentUnsupported && !pl.at) { osPlans.push(pl); break; }
    if (pl.currentUnsupported) osPlans.push({ ...pl, at: undefined });
    osPlans.push({ ...pl, currentUnsupported: false });
    const next = pl.recommend[0]?.id ?? pl.alternatives[0]?.id;
    if (!next) break;
    os = next; start = pl.at;
  }
  // The OS each hop runs on, after the OS upgrades planned before it.
  const osForHop = (n) => osPlans.filter((x) => x.at > 0 && x.at <= n).reduce((os, x) => x.recommend[0]?.id ?? x.alternatives[0]?.id ?? os, input.os);
  const driverResults = driverFindings(input, path, kb);
  const hops = [];
  for (let n = 1; n < path.length; n++) {
    const from = path[n - 1];
    const to = path[n];
    const hopDist = n - 1 >= switchIndex ? targetDistribution : distribution;
    const meta = distMeta(hopDist);
    const hasFcv = atLeast(to, versions.fcv_introduced);
    const isLast = n === path.length - 1;
    // With the Operator the database runs certified images, not repository packages.
    const certified = platform === 'operator' ? certifiedImages(kb, to) : null;
    const candidates = certified ? certified.map((v) => ({ version: v })) : releasesFor(kb, hopDist, to);
    const wanted = isLast && input.toVersion && majorOf(input.toVersion) === to ? input.toVersion : null;
    const pinned = wanted ? candidates.find((x) => sameRelease(x.version, wanted) && (parseVersion(wanted).build === null || x.version === wanted)) ?? null : null;
    if (wanted && !pinned) warnings.push(certified
      ? `No Percona Operator release certifies ${wanted}. The plan lands on the newest certified ${to} image instead.`
      : `${wanted} is not a ${DISTRIBUTIONS[hopDist]} release. The plan lands on the latest ${to} patch instead.`);
    const latestTo = pinned ?? (certified ? (certified.length ? { version: certified.at(-1) } : null) : latestRelease(kb, hopDist, to));
    if (pinned) {
      const latestGa = certified ? { version: certified.at(-1) } : latestRelease(kb, hopDist, to);
      for (const a of avoidFor(kb, hopDist, pinned.version, topology)) {
        warnings.push(`Target ${pinned.version} is affected by ${a.issue ?? 'a known issue'}: ${a.reason}.${latestGa && latestGa.version !== pinned.version ? ` ${latestGa.version} is the latest ${to} ${certified ? 'certified image' : 'patch'}.` : ''}`);
      }
      if ((pinned.channel && pinned.channel !== 'release') || pinned.prerelease) {
        warnings.push(`Target ${pinned.version} is a ${pinned.channel ?? 'pre-release'} build, not a GA release.`);
      }
    }
    const latestFromHop = platform === 'operator' ? (certifiedImages(kb, from).length ? { version: certifiedImages(kb, from).at(-1) } : null) : latestRelease(kb, hopDist, from);
    const vars = {
      ...packageVars(kb, hopDist, pm, to, latestTo?.version, input),
      from, to, setfcv: setFcvCommand(to, versions),
      latest_from: latestFromHop?.version ?? `latest ${from}`,
      latest_to: latestTo?.version ?? `latest ${to}`,
      major: to, major_nodot: to.replace('.', ''), to_nodot: to.replace('.', ''), to_full: latestTo?.version ?? to,
      apply: pinned ? pinned.version : `${to}-recommended`,
      cluster: 'my-cluster-name', namespace: '<namespace>',
    };
    if (platform === 'operator') {
      const ops = (kb.operator?.operator_versions ?? []).filter((o) => o.psmdb_majors?.includes(to));
      const best = ops.length ? ops.reduce((x, y) => (compareVersions(x.version, y.version) >= 0 ? x : y)) : null;
      vars.operator_to = best?.version ?? '<operator-version>';
      vars.operator_version = input.components?.operator ?? '<running-operator-version>';
      vars.pbm_version = best?.pbm?.[best.pbm.length - 1] ?? '<pbm-version>';
      if (!best) blockers.push(`No Percona Operator release certifies ${to} yet. You cannot run the ${from} to ${to} hop with the Operator.`);
    }
    vars.image = fill('percona/percona-server-mongodb:{to_full}', vars);
    vars.rapid = isAtlasOnly(kb, hopDist, to);
    vars.from_nodot = from.replace('.', '');
    const ctx = { from, to, topology, arch: input.arch, distribution: hopDist, platform, pm, os: input.os };
    const items = allItems.filter((i) => itemApplies(i, ctx)).map((i) => renderItem(i, vars));

    // Generated items: required minimum patch and patches to avoid on the target.
    // The hop starts from the exact source version (first hop) or from the latest patch an earlier hop landed on.
    const hopFromVersion = n === 1 ? (fromParsed.patch !== null ? input.from : null) : latestFromHop?.version;
    const minMet = (m) => hopFromVersion && (m.from_min === 'latest'
      ? latestFromHop && compareVersions(hopFromVersion, latestFromHop.version) >= 0
      : /^\d/.test(m.from_min) && compareVersions(hopFromVersion, m.from_min) >= 0);
    (kb.releases?.upgrade_min_patch ?? []).filter((x) => x.to === to && !minMet(x)).forEach((m, k) => {
      const need = m.from_min === 'latest' ? `the latest ${from} patch (${vars.latest_from})` : `${from} ${m.from_min} or later`;
      items.unshift({ id: `min-patch-${to}-${k}`, section: 'preflight', severity: m.condition ? 'warning' : 'blocker',
        title: m.condition ? `${m.from_min} or later if ${m.condition.replace(/^only if /, '')}` : `Upgrade to ${need} first`,
        action: m.condition ? `Only ${m.condition.replace(/^only /, '')}: upgrade to ${need} before the ${from} to ${to} hop.` : `Upgrade every member to ${need} before the ${from} to ${to} hop.`,
        verified: false, basis: 'docs', sourceUrl: m.url, quote: m.quote });
    });
    if (items.some((i) => i.id.startsWith('min-patch-') && i.severity === 'blocker')) {
      const k = items.findIndex((i) => i.id === 'latest-minor-first');
      if (k >= 0) items.splice(k, 1);
    }
    // Land on a patch that is not on the avoid list; name the issues earlier patches carry.
    const avoidTo = (kb.releases?.avoid ?? []).filter((a) => avoidApplies(a, hopDist, topology) && a.versions.some((v) => { try { return majorOf(v) === to; } catch { return false; } }));
    if (avoidTo.length) {
      const landing = latestTo && !avoidTo.some((a) => a.versions.some((v) => sameRelease(v, latestTo.version))) ? latestTo.version : null;
      const bullets = avoidTo.map((a) => {
        const vs = a.versions.filter((v) => { try { return majorOf(v) === to; } catch { return false; } });
        const span = a.range ?? (vs.length > 3 ? `${vs[0]} to ${vs[vs.length - 1]}` : vs.join(', '));
        return { issue: a.issue ?? 'Known issue', affected: span, text: a.reason, url: issueUrl(a.issue) ?? a.url };
      });
      items.push({ id: `land-on-${to}`, section: 'preflight', severity: 'warning',
        title: landing ? `Land on ${landing}, not an earlier ${to} patch` : `${to} patches with known issues`,
        action: `Earlier ${to} patches carry these issues:`, bullets,
        verified: false, basis: 'docs', sourceUrl: avoidTo[0].url });
    }

    const official = platform === 'operator' ? null : officialProcedure(kb, hopDist, from, to, topology, pm, vars, Boolean(previewFor(kb, hopDist, to)));
    if (official) official.prerequisites = official.prerequisites.filter((x) => osPrereqApplies(x, input.os));
    if (official?.prerequisites.length) {
      for (let k = items.length - 1; k >= 0; k--) if (REPLACED_BY_PREREQS.has(items[k].id)) items.splice(k, 1);
      official.prerequisites.forEach((x, k) => {
        const lines = String(x.cmd ?? x[`cmd_${pm}`] ?? '').split('\n').filter((l) => l.trim());
        const writes = lines.filter((l) => /setFeatureCompatibilityVersion|\.drop\(|renameCollection|shutdown/.test(l));
        const reads = lines.filter((l) => !writes.includes(l));
        items.unshift({
          id: `prereq-${to}-${k}`, section: 'preflight', severity: 'blocker', title: prereqTitle(x),
          action: x.text, check: reads.join('\n') || undefined, runOn: runOnFor(reads.join('\n')), fix: writes.join('\n') || undefined,
          verified: false, basis: 'docs', sourceUrl: x.url,
        });
      });
      // Our own items that say the same as an official prerequisite or step are dropped.
      const officialText = [...official.prerequisites.map((x) => `${x.doc_heading} ${x.text}`), ...official.node.map((x) => `${x.heading ?? ''} ${x.text ?? ''}`)].join(' ');
      const SAME = { 'backup-before': /back ?up/i, 'journal-option-ignored-psmdb': /journal/i, 'system-buckets-non-ts-80': /system\.buckets/i,
        'psmdb-fork-pidfile-80': /fork/i, 'psmdb-fork-pidfile-83': /fork/i };
      for (let k = items.length - 1; k >= 0; k--) if (SAME[items[k].id]?.test(officialText)) items.splice(k, 1);
    }
    const source = platform === 'operator' ? (kb.operator?.procedure?.[topology] ?? []) : (official && (official.order.length || official.node.length) ? [] : []);
    const steps = source
      .filter((st) => hasFcv || !st.fcv)
      .map((st) => {
        const cmd = st.cmd ? fill(st.cmd, vars) : undefined;
        return { text: fill(st.text, vars), cmd: cmd && !/\{(repo|install)\}/.test(cmd) && cmd !== 'undefined' ? cmd : undefined,
          snippet: st.snippet ? fill(st.snippet, vars) : undefined, url: st.url };
      })
      .filter((st) => st.cmd || !/\{(repo|install)\}/.test(st.text));
    if (platform === 'operator' && !steps.length) {
      steps.push({ text: `Change the database image to ${vars.image} in the custom resource and let the operator do the rolling restart. Then set FCV "${to}".`, cmd: vars.setfcv });
    }
    const osIt = osItem(kb, hopDist, osForHop(n - 1), input.arch, from, to);
    if (osIt) items.unshift(osIt);
    const driverItems = (driverResults.byHop[to] ?? []).map((d) => ({
      id: `driver-${d.key}`, section: 'preflight', severity: 'blocker',
      title: `${d.name} ${d.version} does not support ${to}`,
      action: d.message, verified: true, basis: 'docs', sourceUrl: d.source,
    }));
    const preview = previewFor(kb, hopDist, to);
    // Two items with the same check command say the same thing: keep the first one.
    const seenChecks = new Set();
    for (let k = 0; k < items.length; k++) {
      const c = items[k].check?.replace(/\s+/g, ' ').trim();
      if (!c) continue;
      if (seenChecks.has(c)) { items.splice(k, 1); k--; } else seenChecks.add(c);
    }
    if (platform === 'operator') for (const it of items) it.runOn = operatorRunOn(it.runOn, it.check);
    hops.push({
      from, to, distribution: hopDist, distributionName: DISTRIBUTIONS[hopDist], preview,
      latestTo: platform === 'operator' && vars.to_full !== to ? vars.to_full : (latestTo?.version ?? null),
      preflight: [...driverItems, ...items.filter((i) => i.section === 'preflight')],
      behaviour: items.filter((i) => i.section === 'behaviour'),
      steps,
      official,
      stepsSource: official?.orderSource ?? official?.nodeSource ?? null,
      post: items.filter((i) => i.section === 'post'),
      rollback: hasFcv ? rollbackFor(to, procedures, vars, platform, kb.operator) : null,
      docs: hopDocs(from, to, topology, versions.docs, meta, platform, kb.operator, official?.orderSource, hopDist),
    });
    if (preview) warnings.unshift(preview);
  }

  for (const f of componentFindings(input, path, kb)) {
    if (f.component === 'operator' && platform !== 'operator' && !input.components?.operator) continue;
    (f.severity === 'blocker' ? blockers : warnings).push(f.message);
  }
  for (const d of driverResults.summary) {
    if (d.status === 'blocker') blockers.push(d.message);
  }
  if (hops.length === 0 && isPatchPlan) {
    hops.push(patchHop(input, kb, { distribution, topology, pm, platform }));
  } else if (hops.length === 0 && !sw) {
    const latestHere = latestRelease(kb, distribution, fromMajor);
    warnings.push(latestHere && compareVersions(input.from, latestHere.version) >= 0
      ? `You already run the latest ${fromMajor} patch (${latestHere.version}). Pick a newer series to upgrade.`
      : `Already on ${fromMajor}. Pick a newer exact version of ${fromMajor} for a patch upgrade, or a newer series.`);
  }

  if (input.os && platform === 'packages') {
    const aptOs = /^(ubuntu|debian)/.test(input.os);
    if (aptOs && pm === 'yum') warnings.unshift(`${osLabel(kb, input.os)} uses apt, not yum. Set the package manager to apt.`);
    if (!aptOs && pm === 'apt') warnings.unshift(`${osLabel(kb, input.os)} uses yum or dnf, not apt. Set the package manager to yum / dnf.`);
  }
  const osPlan = osPlans.find((x) => x.at > 0) ?? osPlans[0] ?? null;
  if (osPlans.some((x) => x.currentUnsupported)) warnings.unshift(`${osLabel(kb, input.os)} is not listed as supported for ${fromMajor}. Check the platform support table before you start.`);
  for (const osPlan of osPlans.filter((x) => x.at > 0).reverse()) {
    const rec = osPlan.recommend.length ? osPlan.recommend.map((o) => o.label) : osPlan.alternatives.map((o) => o.label);
    const first = osPlan.recommend[0];
    const pick = rec.length ? `Upgrade the OS to ${rec[0]}${rec.length > 1 ? ` (or ${rec.slice(1).join(', ')})` : ''}` : 'Move to a supported OS';
    if (first?.minPatch) warnings.push(`${first.label} needs ${osPlan.during} ${first.minPatch} or later: upgrade to that patch before you move the members to ${first.label}.`);
    blockers.unshift(`${osPlan.label} is not supported by ${osPlan.before}. ${pick} while the cluster runs ${osPlan.during}, before the ${osPlan.during} to ${osPlan.before} hop.${osPlan.recommend.length ? ` ${rec[0]} is supported by every version from ${osPlan.during} to ${path[path.length - 1]}${osPlans.filter((x) => x.at > 0).length === 1 ? ', so you upgrade the OS only once' : ''}.` : ''}`);
  }

  const operatorPrep = platform === 'operator'
    ? (() => {
      const last = path[path.length - 1];
      const certified = (kb.operator?.operator_versions ?? []).filter((o) => o.psmdb_majors?.includes(last));
      const best = certified.length ? certified.reduce((a, b) => (compareVersions(a.version, b.version) >= 0 ? a : b)) : (kb.operator?.operator_versions ?? []).at(-1);
      // One Operator minor version at a time: the latest patch of every minor between the running one and the target.
      const all = (kb.operator?.operator_versions ?? []).map((o) => o.version).sort(compareVersions);
      const running = input.components?.operator;
      const minorOf = (x) => x.split('.').slice(0, 2).join('.');
      const lastOfMinor = [...new Map(all.map((x) => [minorOf(x), x])).values()];
      const pathOps = running && best ? lastOfMinor.filter((x) => compareVersions(minorOf(x), minorOf(running)) > 0 && compareVersions(x, best.version) <= 0) : [];
      const next = pathOps[0] ?? best?.version;
      const v = { namespace: '<namespace>', cluster: 'my-cluster-name', operator_to: next ?? '<operator-version>',
        operator_version: input.components?.operator ?? '<running-operator-version>', pbm_version: best?.pbm?.at(-1) ?? '<pbm-version>', to: last, from: path[0] };
      const imgs = (best?.psmdb_versions ?? []).filter((x) => { try { return majorOf(x) === path[0]; } catch { return false; } });
      v.image = `percona/percona-server-mongodb:${imgs.length ? imgs.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)) : path[0]}`;
      const intro = pathOps.length > 1
        ? [{ text: `Operator upgrade path from ${running}: ${pathOps.join(' → ')}. The commands below use ${pathOps[0]}; repeat them for each version in the path.` }]
        : running && best && compareVersions(running, best.version) >= 0 ? [{ text: `Operator ${running} already supports ${last}. Nothing to upgrade here.` }]
        : !running ? [{ text: `Set your Operator version under More details to get the exact upgrade path. The Operator moves one minor version at a time; ${best?.version ?? 'the target'} is the newest that supports ${last}.` }] : [];
      return [...intro, ...(kb.operator?.upgrade_order ?? []).map((st) => ({ text: fill(st.text, v), cmd: st.cmd ? fill(st.cmd, v) : undefined }))];
    })()
    : [];

  return {
    input: { ...input, topology, distribution, targetDistribution, platform, packageManager: pm },
    path,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    cves: cveFindings(input, path, kb, hops.at(-1)?.latestTo ?? input.toVersion, distribution, targetDistribution),
    drivers: driverResults.summary,
    switch: sw,
    osPlan,
    osPlans: osPlans.filter((x) => x.at > 0),
    operatorPrep,
    latestFrom: latestFrom?.version ?? null,
    hops,
  };
}
