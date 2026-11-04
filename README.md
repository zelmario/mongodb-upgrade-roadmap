# MongoDB upgrade roadmap

Upgrading MongoDB across several versions means reading a different upgrade page for every hop, plus the compatibility notes, the driver tables and the backup and monitoring tool requirements. Miss one and the upgrade stops halfway: FCV left on the old version, a backup agent that does not support the new server, a driver that still sends legacy opcodes.

This page puts that documentation in one plan. You give it the current version, the target version and how the deployment runs, and it shows every hop with its prerequisites, the official steps, what changes, the rollback window and the post-upgrade checks. **It never connects to your cluster.**

It covers Percona Server for MongoDB (PSMDB) and MongoDB Community, from 3.0 to 9.0, including the 8.2 and 8.3 minor releases and the Percona Operator for MongoDB on Kubernetes.

Open it at https://zelmario.github.io/mongodb-upgrade-roadmap/

## Where the content comes from

Every check and every step comes from official documentation, and each one links to the exact section it was taken from:

- MongoDB release notes, upgrade and downgrade pages (mongodb.com for 7.0 and later, the [mongodb/docs](https://github.com/mongodb/docs) source on GitHub for 3.4 to 6.0).
- Percona Server for MongoDB upgrade pages and release notes.
- Percona Backup for MongoDB, PMM and Percona Operator for MongoDB release notes and compatibility pages.
- MongoDB's driver compatibility tables and the drivers' package registries.

Where the documentation contradicts itself, the plan says so instead of picking a side. For example, the PSMDB 8.3 upgrade page sets FCV "8.0", while MongoDB requires FCV "8.3" before a later upgrade to 9.0.

The plan is not a substitute for testing. Run it on a staging environment before production.

## Web page

Build it once, then open `dist/index.html` in a browser or copy it to any web server:

```
$ npm run build
Built dist/index.html and dist/mongodb-upgrade-roadmap.html (...)
```

The page is one self-contained file. The knowledge base, the planner and the styles are inlined, and it makes no network calls except for fonts.

- **Plan:** pick the distribution, the current and target version (series and exact version), the topology, where it runs and the current FCV. Under **More details** you can add the package manager, CPU, PBM, PMM and Operator versions and the application drivers. Each field has a **(?)** that explains what it is and how to get it.
- **All changes by version:** pick a source and a target version and see every documented change between them, hop by hop.
- **Copy as Markdown** puts the plan on the clipboard.

## Development

You need Node.js 18+. There are no dependencies to install.

Run the tests:

```
$ npm test
```

## Layout

- `kb/`: the knowledge base, plain JSON.
- `src/planner.js`: planning logic, no I/O. Runs in Node and in the browser.
- `src/render.js`: Markdown output for **Copy as Markdown**.
- `web/app.html`: page template. `scripts/build-web.js` inlines everything into `dist/`.
- `scripts/deep-links.py`: points every documentation link at the exact section (`npm run links`).
- `scripts/check-links.py`: checks that every link answers and every anchor or highlighted text exists (`npm run check-links`).
- `scripts/import-cves.py`: imports MongoDB Server CVEs with CVSS 7.0 or higher from the official security bulletins page (`npm run import-cves`).

## Knowledge base

| File | Content |
|---|---|
| `changes.json` | Checks and behaviour changes per target version, each with `source_url` and `quote`. |
| `official-steps.json` | Upgrade steps and prerequisites per version and topology, from the MongoDB and Percona pages. |
| `series.json` | Release series and the upgrade paths the documentation allows between them. |
| `releases.json` | Every patch release, versions to avoid and required minimum patches. |
| `procedures.json` | Rollback rules per target version. |
| `distributions.json` | Package commands and distribution-specific checks. |
| `components.json` | PBM, PMM and Operator releases and the minimum version per target. |
| `drivers.json` | Driver versions and MongoDB's compatibility table per server version. |
| `operator.json` | Percona Operator releases, certified images and upgrade procedure. |
| `versions.json` | FCV rules and documentation URL templates. |

An entry in `changes.json` looks like this:

```json
{
  "id": "null-undefined",
  "hop_to": "8.0",
  "section": "behaviour",
  "severity": "warning",
  "title": "Equality to null no longer matches undefined",
  "action": "Queries like { field: null } stop matching documents where field is undefined...",
  "check": "db.coll.countDocuments({ field: { $type: \"undefined\" } })",
  "basis": "docs",
  "source_url": "https://www.mongodb.com/docs/v8.0/release-notes/8.0-compatibility/#:~:text=...",
  "quote": "Starting in MongoDB 8.0, comparisons to null in equality match expressions don't match undefined values."
}
```

`when` accepts `topology`, `distribution`, `platform`, `arch`, `from`, `from_at_least` and `to_at_least`. After adding entries, run `npm run links` so the links point at the right section, `npm run check-links`, then `npm test` and `npm run build`. Before a release, also run `npm run import-cves` and review the diff.

## Contributing

Corrections and new entries are welcome. Every entry needs an official source and a short quote from it.

---

Created by Zelmar Michelini · [LinkedIn](https://uy.linkedin.com/in/zelmario) · [GitHub](https://github.com/zelmario)
