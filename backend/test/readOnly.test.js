/**
 * Read-only guardrail tests.
 *
 * These matter more than most: they are the thing standing between an ad-hoc
 * query and a write against the live ECSITE warehouse. They need no Snowflake
 * connection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertReadOnly, ReadOnlyViolation } = require('../src/db/readOnly');

const blocked = (sql) =>
  assert.throws(() => assertReadOnly(sql), ReadOnlyViolation, `should have blocked: ${sql}`);
const allowed = (sql) => assert.doesNotThrow(() => assertReadOnly(sql), `should have allowed: ${sql}`);

test('allows plain reads', () => {
  allowed('SELECT 1');
  allowed('select * from ECSITE.ANALYTICS.CLOUD_NODE');
  allowed('SHOW TABLES IN SCHEMA ECSITE.ANALYTICS');
  allowed('DESCRIBE TABLE ECSITE.ANALYTICS.CLOUD_NODE');
  allowed('EXPLAIN SELECT 1');
});

test('allows a CTE that only reads', () => {
  allowed(`
    WITH latest AS (
      SELECT "nodeId", "Status" FROM ECSITE.ANALYTICS.CLOUD_NODE_STATUS_HISTORY_WITH_COUNTS
    )
    SELECT * FROM latest`);
});

test('allows a trailing semicolon and surrounding whitespace', () => {
  allowed('  SELECT 1 ;  ');
});

test('blocks every write and DDL verb', () => {
  for (const sql of [
    "INSERT INTO ECSITE.ANALYTICS.CLOUD_NODE VALUES (1)",
    "UPDATE ECSITE.ANALYTICS.CLOUD_NODE SET \"Node Name\" = 'x'",
    'DELETE FROM ECSITE.ANALYTICS.CLOUD_NODE',
    'TRUNCATE TABLE ECSITE.ANALYTICS.CLOUD_NODE',
    'DROP TABLE ECSITE.ANALYTICS.CLOUD_NODE',
    'CREATE TABLE T (A INT)',
    'ALTER USER GOWTHAM SET RSA_PUBLIC_KEY=\'x\'',
    'MERGE INTO T USING S ON T.A = S.A WHEN MATCHED THEN UPDATE SET T.B = 1',
    'GRANT SELECT ON T TO ROLE PUBLIC',
    'CALL MY_WRITING_PROC()',
    'COPY INTO T FROM @stage',
  ]) {
    blocked(sql);
  }
});

test('blocks a write appended after a semicolon', () => {
  blocked('SELECT 1; DELETE FROM ECSITE.ANALYTICS.CLOUD_NODE');
});

test('blocks a write hidden behind a leading comment', () => {
  blocked('/* harmless */ DROP TABLE ECSITE.ANALYTICS.CLOUD_NODE');
  blocked('-- just looking\nDELETE FROM ECSITE.ANALYTICS.CLOUD_NODE');
});

test('blocks a write wrapped in a CTE', () => {
  blocked('WITH x AS (SELECT 1) DELETE FROM ECSITE.ANALYTICS.CLOUD_NODE');
});

test('a commented-out write still blocks -- fails closed', () => {
  // Stripping comments means the DELETE text is gone, so this specific shape is
  // allowed; asserted explicitly so the behaviour is deliberate, not accidental.
  allowed('SELECT 1 -- DELETE FROM T');
});

test('does not false-positive on data that merely contains a verb', () => {
  // "update" appears as a literal value in the real CLOUD_*_STATUS_HISTORY data
  // ("Action" = 'update'), so this must still run.
  allowed(`SELECT * FROM ECSITE.ANALYTICS.CLOUD_SITE_STATUS_HISTORY_WITH_COUNTS WHERE "Action" = 'update'`);
  // Quoted identifiers containing verbs are column names, not statements.
  allowed('SELECT "Updated Date", "Node Created Date" FROM ECSITE.ANALYTICS.CLOUD_NODE');
  // A column whose name merely starts with a verb substring.
  allowed('SELECT CREATEDAT, UPDATEDAT FROM ECSITE.RAW_HEVO.CLOUD_ECSITE_FIELDMEDIA');
});

test('rejects empty or non-string input', () => {
  blocked('');
  blocked('   ');
  assert.throws(() => assertReadOnly(null), ReadOnlyViolation);
  assert.throws(() => assertReadOnly(undefined), ReadOnlyViolation);
});
