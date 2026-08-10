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

/**
 * Differences we EXPECT, with the reason.
 *
 * Snowflake's CLOUD_FORMGOUP_SS keeps only one "current" SCD2 row and it is
 * eight months stale -- 14 checklist items updated 2025-12-02, where MongoDB has
 * 20 updated 2026-07-31. Everything derived from the checklist therefore differs,
 * and MongoDB is the correct side.
 *
 * These are listed rather than silenced so the harness still fails on anything
 * unexpected. A test that always reports 18 differences hides the nineteenth.
 */
const EXPECTED_DIFFS = {
  'metrics.mappedStages': 'stale Snowflake checklist (14 items vs 20)',
  'metrics.totalStages': 'stale Snowflake checklist (14 items vs 20)',
  'metrics.stagePhotos': 'stale Snowflake checklist -- missing stages carry photos',
  'milestone.m1 done/total': 'stale Snowflake checklist',
  'milestone.m2 done/total': 'stale Snowflake checklist',
  'milestone.m3 done/total': 'stale Snowflake checklist',
  'milestone.m4 done/total': 'stale Snowflake checklist',
};

let failures = 0;
let expected = 0;
let checks = 0;

function cmp(label, a, b, { note } = {}) {
  checks += 1;
  const same = JSON.stringify(a) === JSON.stringify(b);
  const known = EXPECTED_DIFFS[label];

  let tag = 'ok    ';
  if (!same && known) { expected += 1; tag = 'xdiff '; }
  else if (!same) { failures += 1; tag = 'DIFF  '; }

  const fmt = (v) => (v === undefined ? '(undefined)' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  console.log(
    '    ' + tag + label.padEnd(30) +
    fmt(a).slice(0, 28).padEnd(30) + fmt(b).slice(0, 28).padEnd(30) +
    (!same ? '  <- ' + (known || note || '') : '')
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

    // ---- node metrics: the numbers on the cards ----
    const [sM, mM] = await Promise.all([
      sfService.getNodeMetrics(scope),
      mgService.getNodeMetrics(scope),
    ]);
    cmp('metrics.nodeCount', sM.nodeCount, mM.nodeCount);

    /*
     * Summed across every node in scope rather than spot-checked, so one node
     * quietly disagreeing cannot hide inside a total that happens to match.
     * Per-field mismatch counts are reported alongside.
     */
    const METRIC_FIELDS = [
      'photoFields', 'photos', 'photosAllMedia', 'fieldsCovered',
      'reports', 'reportDays', 'missedDays',
      'mappedStages', 'totalStages', 'stagePhotos',
    ];
    const sumOf = (byNode, field) =>
      Object.values(byNode).reduce((t, n) => t + (Number(n[field]) || 0), 0);

    for (const f of METRIC_FIELDS) {
      const bad = [];
      for (const [id, s] of Object.entries(sM.byNode)) {
        const m = mM.byNode[id];
        if (!m) continue;
        const sv = s[f] === null || s[f] === undefined ? null : Number(s[f]);
        const mv = m[f] === null || m[f] === undefined ? null : Number(m[f]);
        if (String(sv) !== String(mv)) bad.push(`${id.slice(0, 8)} ${sv}!=${mv}`);
      }
      cmp(
        'metrics.' + f,
        `${sumOf(sM.byNode, f)} (${bad.length} bad)`,
        `${sumOf(mM.byNode, f)} (0 bad)`,
        { note: bad[0] }
      );
    }

    // Milestone bars, per milestone key, across all nodes in scope.
    for (const key of ['m1', 'm2', 'm3', 'm4']) {
      const pick = (byNode, part) =>
        Object.values(byNode).reduce((t, n) => {
          const ms = (n.milestones || []).find((x) => x.key === key);
          return t + (ms && Number(ms[part]) ? Number(ms[part]) : 0);
        }, 0);
      cmp(`milestone.${key} done/total`,
        `${pick(sM.byNode, 'done')}/${pick(sM.byNode, 'total')}`,
        `${pick(mM.byNode, 'done')}/${pick(mM.byNode, 'total')}`);
    }

    const mappedCount = (byNode) => Object.values(byNode).filter((n) => n.milestonesMapped).length;
    cmp('metrics.milestonesMapped', mappedCount(sM.byNode), mappedCount(mM.byNode));

    console.log('');
  }

  console.log('----------------------------------------------------------');
  console.log(`${checks} checks: ${checks - failures - expected} match, ` +
    `${expected} expected divergence (xdiff), ${failures} UNEXPECTED`);
  if (expected) {
    console.log('');
    console.log('expected divergences -- MongoDB is the correct side:');
    for (const [k, why] of Object.entries(EXPECTED_DIFFS)) console.log('  ' + k.padEnd(28) + why);
  }
  console.log('');
  console.log(failures === 0 ? 'PASS -- no unexpected differences.' : 'FAIL -- see DIFF rows above.');

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
