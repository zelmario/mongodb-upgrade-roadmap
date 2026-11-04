// Render a roadmap object as Markdown. Pure function, browser safe.

const mark = { blocker: '[BLOCKER]', warning: '[WARN]', info: '[INFO]' };

function renderItems(items) {
  return items.map((i) => {
    const basis = i.basis === 'docs' ? 'docs' : i.basis === 'lab' ? 'tested on a lab cluster' : 'practice';
    const lines = [`- ${mark[i.severity] ?? ''} **${i.title}** _(${basis})_`, `  ${i.action}`];
    for (const b of i.bullets ?? []) lines.push(`  - ${b.url ? `[${b.issue}](${b.url})` : b.issue} (${b.affected}): ${b.text}.`);
    // Multi-line commands go in an indented code block; one-liners stay inline.
    const code = (label, c) => (String(c).includes('\n')
      ? [`  ${label}:`, '', '  ```', ...String(c).split('\n').map((l) => `  ${l}`), '  ```', '']
      : [`  ${label}: \`${c}\``]);
    if (i.check) lines.push(...code(`Check${i.runOn ? ` (run on ${i.runOn})` : ''}`, i.check));
    if (i.fix) lines.push(...code('If needed', i.fix));
    if (i.note) lines.push(`  Note: ${i.note}`);
    if (i.sourceUrl) lines.push(`  Source: ${i.sourceUrl}`);
    if (i.tested) lines.push(`  Tested: ${i.tested}`);
    return lines.join('\n');
  }).join('\n');
}

export function renderMarkdown(r) {
  const out = [];
  const { from, to, topology, platform } = r.input;
  const stepList = (steps) => steps.map((s, i) => `${i + 1}. ${s.text}${s.snippet ? ['', '', '   ```yaml', ...String(s.snippet).split('\n').map((l) => `   ${l}`), '   ```'].join('\n') + (s.cmd ? '\n' : '') : ''}${!s.cmd ? '' : String(s.cmd).includes('\n') ? ['', '', '   ```', ...String(s.cmd).split('\n').map((l) => `   ${l}`), '   ```'].join('\n') : ` \`${s.cmd}\``}`);
  const topoName = { standalone: 'standalone', replset: 'replica set', sharded: 'sharded cluster' }[topology] ?? topology;
  out.push(`# Upgrade roadmap: ${from} to ${r.hops.at(-1)?.latestTo ?? to} (${topoName}${platform === 'operator' ? ', Percona Operator' : ''})`, '');
  if (r.hops[0]) out.push(`Distribution: ${r.hops[0].distributionName}${r.switch ? ` (switching from ${r.switch.fromName} at ${r.switch.at})` : ''}`, '');
  out.push(`Path: ${r.path.join(' -> ')}`, '');

  if (r.blockers.length) {
    out.push('## Blockers before you start', '');
    out.push(...r.blockers.map((b) => `- ${b}`), '');
  }
  if (r.warnings.length) {
    out.push('## Warnings', '');
    out.push(...r.warnings.map((w) => `- ${w}`), '');
  }
  if (r.drivers?.length) {
    out.push('## Application drivers', '');
    out.push(...r.drivers.map((d) => `- ${d.status === 'ok' ? '[OK]' : d.status === 'blocker' ? '[BLOCKER]' : d.status === 'partial' ? '[PARTIAL]' : '[CHECK]'} ${d.message}${d.source ? ` Source: ${d.source}` : ''}`), '');
  }
  for (const which of ['current', 'target']) {
    const xs = r.cves.filter((c) => c.which === which);
    if (!xs.length) continue;
    out.push(which === 'current' ? '## Known CVEs in the current version' : '## Known CVEs still open in the version you land on', '');
    out.push(...xs.map((c) => `- [${c.id}](${c.url}) (CVSS ${c.cvss ?? '?'}): ${c.title}. ${c.message}`), '');
  }

  if (r.operatorPrep?.length) out.push('## First: upgrade the Operator', '', ...stepList(r.operatorPrep), '');
  const osMd = (pl) => {
    const rec = pl.recommend.length ? pl.recommend : pl.alternatives;
    out.push(`## Upgrade the OS before the ${pl.during} to ${pl.before} hop`, '', `${pl.label} is not supported by ${pl.before}. Upgrade the operating system while the cluster runs ${pl.during}: ${rec.map((x) => x.label).join(', ') || 'see the platform support table'}.`, ...pl.urls.map((u) => `- ${u}`), '');
  };
  const switchMd = () => {
    const sw = r.switch;
    out.push(`## Switch from ${sw.fromName} to ${sw.toName} at ${sw.at}`, '');
    if (sw.order) out.push(`Order: ${sw.order}`, '');
    if (sw.blockers.length) out.push(renderItems(sw.blockers), '');
    out.push(...(sw.steps.length ? stepList(sw.steps) : ['No documented procedure in the knowledge base yet.']), '');
    if (sw.docs.length) out.push(...sw.docs.map((d) => `- [${d.label}](${d.url})`), '');
  };
  if (r.switch && r.switch.index === 0) switchMd();
  r.hops.forEach((h, n) => {
    if (r.switch && r.switch.index === n && n > 0) switchMd();
    for (const pl of r.osPlans ?? []) if (pl.at === n + 1) osMd(pl);
    out.push(`## Hop ${n + 1}: ${h.from} to ${h.to}${h.latestTo ? ` (land on ${h.latestTo})` : ''}`, '');
    if (h.preflight.length) out.push('### Pre-flight checks', '', renderItems(h.preflight), '');
    if (h.behaviour.length) out.push('### Behaviour changes', '', renderItems(h.behaviour), '');
    const stepMd = (st, i, indent = '') => {
      const lines = [`${indent}${i + 1}. ${st.heading ? (st.url ? `**[${st.heading}](${st.url}).** ` : `**${st.heading}.** `) : ''}${st.text ?? ''}`];
      if (st.snippet) lines.push('', `${indent}   \`\`\`yaml`, ...st.snippet.split('\n').map((c) => `${indent}   ${c}`), `${indent}   \`\`\``, '');
      if (st.cmd) lines.push('', `${indent}   \`\`\``, ...st.cmd.split('\n').map((c) => `${indent}   ${c}`), `${indent}   \`\`\``, '');
      (st.substeps ?? []).forEach((x, k) => lines.push(...stepMd(x, k, indent + '   ')));
      return lines;
    };
    const o = h.official;
    if (h.steps.length) out.push('### Procedure', '', ...h.steps.flatMap((x, i) => stepMd(x, i)), '');
    if (o?.merged?.length) out.push('### Procedure', '', ...o.merged.flatMap((x, i) => stepMd(x, i)), '', `Order: ${o.orderSource}`, ...(o.nodeSource ? [`Package commands: ${o.nodeSource}`] : []), '');
    else {
      if (o?.order.length) out.push('### Procedure', '', ...o.order.flatMap((x, i) => stepMd(x, i)), '', `Source: ${o.orderSource}`, '');
      if (o?.node.length) out.push(o.order.length ? '### Package commands' : '### Procedure', '', ...o.node.flatMap((x, i) => stepMd(x, i)), '', ...(o.nodeSource ? [`Source: ${o.nodeSource}`, ''] : []));
    }
    if (o && !o.order.length && !o.node.length && !h.steps.length && !o.merged?.length) out.push('### Procedure', '', 'No official procedure page exists for this hop.', '');
    for (const iss of o?.issues ?? []) out.push(`> Note on the docs: ${iss.text}`, '');
    if (h.rollback) {
      out.push('### Rollback window', '');
      out.push(`- ${h.patch ? `Going back to ${h.from}` : 'Before setFCV'}: ${h.rollback.beforeSetFcv}`);
      out.push(`- ${h.patch ? 'FCV' : 'After setFCV'}: ${h.rollback.afterSetFcv}`);
      if (h.rollback.sourceUrl) out.push(`- Source: ${h.rollback.sourceUrl}`);
      out.push('');
    }
    if (h.post.length) out.push('### Post-upgrade checks', '', renderItems(h.post), '');
    out.push('### Documentation', '', ...h.docs.map((d) => `- [${d.label}](${d.url})`), '');
  });
  if (r.switch && r.switch.index > 0 && r.switch.index >= r.hops.length) switchMd();
  out.push('---', '', 'Created by Zelmar Michelini · [LinkedIn](https://uy.linkedin.com/in/zelmario) · [GitHub](https://github.com/zelmario)', '');
  return out.join('\n');
}
