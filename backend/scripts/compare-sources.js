#!/usr/bin/env node
/**
 * Snowflake vs MongoDB, same scope, same moment.
 *
 * Run:  npm run compare
 *
 * This is the acceptance test for the migration. Both adapters are called with
 * identical scopes and their outputs diffed field by field. The flag stays off
 * throughout -- nothing here touches what the dashboard serves.
 *
 * Both sources are read at the same instant deliberately: the warehouse lags the
 * source by ~10 minutes, so comparing figures captured minutes apart produces
 * differences that look like bugs and are not.
 *
 * READ-ONLY on both sides.
 */
require('dotenv').config({ quiet: true });
const sfService = require('../src/services/monitorService');
const mgService = require('../src/services/monitorMongoService');
const sfDb = require('../src/db/snowflake');
const mgDb = require('../src/db/mongo');

/** Nodes with figures validated against the client's portal. */
const SCOPES = [
  ['all Telamon', {}],
  ['route: LUMEN-ILA-HOUSTON-ATLANTA', { siteId: '691d0d237c15176b4539f146' }],
  ['node: Wadley', { nodeId: '692f6fc9ffda99c8f8423306' }],
];

let failures = 0;
let checks = 0;

function cmp(label, a, b, { note } = {}) {
  checks += 1;
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) failures += 1;
  const fmt = (v) => (v === undefined ? '(undefined)' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  console.log(
    '    ' + (same ? 'ok    ' : 'DIFF  ') + label.padEnd(30) +
    fmt(a).slice(0, 28).padEnd(30) + fmt(b).slice(0, 28).padEnd(30) +
    (note && !same ? '  <- ' + note : '')
  );
}

(async () => {
  console.log('Comparing Snowflake (left) against MongoDB (right)\n');

  for (const [name, scope] of SCOPES) {
    console.log('=== ' + name + ' ===');
    console.log('    ' + 'CHECK'.padEnd(36) + 'SNOWFLAKE'.padEnd(30) + 'MONGODB');

    // ---- status counts (the KPI card) ----
    const [sKpi, mKpi] = await Promise.all([
      sfService.getStatusCounts(scope),
      mgService.getStatusCounts(scope),
    ]);
    cmp('kpi.complete', sKpi.complete, mKpi.complete);
    cmp('kpi.inProgress', sKpi.inProgress, mKpi.inProgress);
    cmp('kpi.yetToStart', sKpi.yetToStart, mKpi.yetToStart);
    cmp('kpi.total', sKpi.total, mKpi.total);
    cmp('kpi.scopeLabel', sKpi.scopeLabel, mKpi.scopeLabel);
    cmp('kpi.companies', sKpi.companies, mKpi.companies);
    cmp('kpi.unmapped', sKpi.unmapped.length, mKpi.unmapped.length);

    // ---- nodes ----
    const [sNodes, mNodes] = await Promise.all([
      sfService.listNodes(scope),
      mgService.listNodes(scope),
    ]);
    cmp('nodes.count', sNodes.nodes.length, mNodes.nodes.length);

    const key = (n) => n.nodeId;
    const sById = new Map(sNodes.nodes.map((n) => [key(n), n]));
    const mById = new Map(mNodes.nodes.map((n) => [key(n), n]));
    const onlyS = [...sById.keys()].filter((k) => !mById.has(k));
    const onlyM = [...mById.keys()].filter((k) => !sById.has(k));
    cmp('nodes.onlyInSnowflake', onlyS.length, 0, { note: onlyS.slice(0, 3).join(',') });
    cmp('nodes.onlyInMongo', 0, onlyM.length, { note: onlyM.slice(0, 3).join(',') });

    // Field-level diff across every shared node -- one line per mismatching field.
    const FIELDS = ['nodeName', 'nodeCode', 'routeName', 'companyName', 'workStatus', 'recordStatus', 'siteStatus', 'startDate'];
    const mismatched = {};
    for (const [id, s] of sById) {
      const m = mById.get(id);
      if (!m) continue;
      for (const f of FIELDS) {
        const sv = s[f] === undefined ? null : s[f];
        const mv = m[f] === undefined ? null : m[f];
        if (String(sv) !== String(mv)) {
          (mismatched[f] = mismatched[f] || []).push(`${s.nodeName}: ${sv} != ${mv}`);
        }
      }
    }
    for (const f of FIELDS) {
      const bad = mismatched[f] || [];
      cmp('nodes.' + f, bad.length + ' mismatched', '0 mismatched', { note: bad[0] });
    }

    // ---- routes ----
    const [sR, mR] = await Promise.all([sfService.listRoutes(scope), mgService.listRoutes(scope)]);
    cmp('routes.count', sR.routes.length, mR.routes.length);
    const sRm = new Map(sR.routes.map((r) => [r.siteId, r]));
    const rBad = [];
    for (const r of mR.routes) {
      const s = sRm.get(r.siteId);
      if (!s) { rBad.push('extra ' + r.routeName); continue; }
      if (s.routeName !== r.routeName) rBad.push(`name ${s.routeName} != ${r.routeName}`);
      if (Number(s.nodeCount) !== Number(r.nodeCount)) rBad.push(`${r.routeName} count ${s.nodeCount} != ${r.nodeCount}`);
      if (s.companyName !== r.companyName) rBad.push(`${r.routeName} company ${s.companyName} != ${r.companyName}`);
    }
    cmp('routes.fields', rBad.length + ' mismatched', '0 mismatched', { note: rBad[0] });

    // ---- hierarchy ----
    const [sH, mH] = await Promise.all([sfService.getHierarchy(scope), mgService.getHierarchy(scope)]);
    cmp('hierarchy.companies', sH.totals.companies, mH.totals.companies);
    cmp('hierarchy.sites', sH.totals.sites, mH.totals.sites);
    cmp('hierarchy.nodes', sH.totals.nodes, mH.totals.nodes);

    console.log('');
  }

  console.log('----------------------------------------------------------');
  console.log(failures === 0
    ? `ALL ${checks} CHECKS MATCH`
    : `${failures} of ${checks} checks DIFFER`);

  await sfDb.close().catch(() => {});
  await mgDb.close().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('\nharness error: ' + err.message);
  console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  await sfDb.close().catch(() => {});
  await mgDb.close().catch(() => {});
  process.exit(1);
});
