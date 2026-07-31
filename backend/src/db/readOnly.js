/**
 * Read-only guardrail for ad-hoc Snowflake access.
 *
 * This project connects to the live ECSITE warehouse. Only reads are permitted:
 * no DELETE / UPDATE / INSERT / ALTER / DROP / CREATE / MERGE / TRUNCATE / GRANT,
 * on any object, for any reason. If a write is ever genuinely needed, the SQL is
 * handed over to be run deliberately by a human -- the same pattern used for
 * `ALTER USER ... SET RSA_PUBLIC_KEY`.
 *
 * The guard is deliberately a WHITELIST of read verbs rather than a blacklist of
 * write verbs: a blacklist silently permits anything it has not heard of (CALL,
 * COPY, PUT, EXECUTE IMMEDIATE, a stored procedure that writes), whereas a
 * whitelist fails closed on the unknown.
 */

/** Statement kinds that cannot modify data or schema. */
const READ_VERBS = new Set([
  'select',
  'with', // CTE -- verified below to not wrap a write
  'show',
  'describe',
  'desc',
  'explain',
  'list',
  'table', // Snowflake's TABLE(...) shorthand
  'values',
]);

/**
 * Write/DDL verbs that must never appear anywhere in the statement, even inside
 * a CTE or subquery. `WITH x AS (...) DELETE ...` is a real shape, so checking
 * only the leading keyword is not enough.
 */
const FORBIDDEN = [
  'insert',
  'update',
  'delete',
  'merge',
  'upsert',
  'alter',
  'drop',
  'create',
  'replace',
  'truncate',
  'grant',
  'revoke',
  'copy',
  'put',
  'remove',
  'unload',
  'call',
  'execute',
  'begin',
  'commit',
  'rollback',
  'undrop',
  'rename',
  'swap',
  'use',
  'set',
  'unset',
  'comment',
  'pipe',
  'task',
  'stream',
];

class ReadOnlyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadOnlyViolation';
  }
}

/**
 * Strip comments and string literals before scanning for keywords.
 *
 * Without this, a legitimate query containing the word "update" in a filter
 * (e.g. `WHERE "Action" = 'update'`) would be rejected, and conversely a write
 * hidden inside a block comment could evade a naive check.
 */
function stripNoise(sql) {
  return (
    sql
      // Block comments.
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // Line comments.
      .replace(/--[^\n]*/g, ' ')
      // Single-quoted literals (handles '' escapes).
      .replace(/'(?:[^']|'')*'/g, "''")
      // Double-quoted identifiers -- these are column/table names like
      // "Previous Status", never statement verbs.
      .replace(/"(?:[^"]|"")*"/g, '""')
  );
}

/** Split on semicolons that are not inside literals/identifiers. */
function statementCount(cleaned) {
  return cleaned
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/**
 * Throw unless `sql` is a single read-only statement.
 * Returns the trimmed SQL so callers can use it directly.
 */
function assertReadOnly(sql) {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new ReadOnlyViolation('No SQL provided.');
  }

  const trimmed = sql.trim().replace(/;\s*$/, '');
  const cleaned = stripNoise(trimmed);

  if (statementCount(cleaned) > 1) {
    throw new ReadOnlyViolation(
      'Refusing to run multiple statements in one call -- a write could be appended after a semicolon. Run one SELECT at a time.'
    );
  }

  const firstWord = (cleaned.match(/[a-z]+/i) || [''])[0].toLowerCase();
  if (!READ_VERBS.has(firstWord)) {
    throw new ReadOnlyViolation(
      `Refusing to run "${firstWord.toUpperCase()}": this project has read-only Snowflake access. ` +
        `Allowed: ${[...READ_VERBS].join(', ').toUpperCase()}.`
    );
  }

  // Keyword scan, word-boundary matched so "created" does not trip "create"
  // and a column called "UPDATED_DATE" does not trip "update".
  for (const verb of FORBIDDEN) {
    if (new RegExp(`\\b${verb}\\b`, 'i').test(cleaned)) {
      throw new ReadOnlyViolation(
        `Refusing to run: found the forbidden keyword "${verb.toUpperCase()}". ` +
          `Snowflake access here is read-only. If this is a false positive (a column or ` +
          `literal named "${verb}"), quote the identifier or alias it.`
      );
    }
  }

  return trimmed;
}

module.exports = { assertReadOnly, ReadOnlyViolation, READ_VERBS, FORBIDDEN };
