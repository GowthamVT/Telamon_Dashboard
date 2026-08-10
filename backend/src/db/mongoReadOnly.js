/**
 * Read-only guardrail for MongoDB access.
 *
 * The counterpart to db/readOnly.js, which guards Snowflake SQL. This project
 * connects to the live ECSite production cluster, so only reads are permitted:
 * nothing may insert, update, delete, or create an index, for any reason.
 *
 * Two layers, deliberately:
 *   1. The Atlas user has role `read`, so a write is refused by the server. That
 *      is the real protection.
 *   2. This module, so a mistake fails loudly in our code with an actionable
 *      message instead of arriving as a permissions error from the driver.
 *
 * Like the SQL guard, stages are a WHITELIST rather than a blacklist of writers.
 * A blacklist silently permits anything it has not heard of; a whitelist fails
 * closed on the unknown, which is the correct default when the target is a
 * production database other people depend on.
 */

/** Aggregation stages that cannot modify data. */
const READ_STAGES = new Set([
  '$addFields',
  '$bucket',
  '$bucketAuto',
  '$count',
  '$densify',
  '$documents',
  '$facet',
  '$fill',
  '$geoNear',
  '$graphLookup',
  '$group',
  '$limit',
  '$lookup',
  '$match',
  '$project',
  '$redact',
  '$replaceRoot',
  '$replaceWith',
  '$sample',
  '$set',
  '$setWindowFields',
  '$skip',
  '$sort',
  '$sortByCount',
  '$unionWith',
  '$unset',
  '$unwind',
]);

/**
 * Stages that write, named explicitly so the error message can say WHY rather
 * than just "unknown stage". $out and $merge are the only two aggregation stages
 * that persist anything, and both would write to the production cluster.
 */
const WRITE_STAGES = new Set(['$out', '$merge']);

class ReadOnlyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadOnlyViolation';
    this.statusCode = 500;
  }
}

/**
 * Assert that an aggregation pipeline only reads.
 *
 * Recurses into $lookup and $unionWith sub-pipelines and into $facet branches,
 * because a $merge nested inside one of those would otherwise slip past a
 * top-level-only check.
 */
function assertReadOnlyPipeline(pipeline, path = 'pipeline') {
  if (!Array.isArray(pipeline)) {
    throw new ReadOnlyViolation(`${path} must be an array of aggregation stages.`);
  }

  pipeline.forEach((stage, i) => {
    const at = `${path}[${i}]`;
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new ReadOnlyViolation(`${at} is not a valid aggregation stage object.`);
    }

    const names = Object.keys(stage);
    if (names.length !== 1) {
      throw new ReadOnlyViolation(
        `${at} must contain exactly one stage operator, found ${names.length}: ${names.join(', ')}.`
      );
    }

    const name = names[0];
    if (WRITE_STAGES.has(name)) {
      throw new ReadOnlyViolation(
        `${at} uses ${name}, which writes to the database. This dashboard is read-only.`
      );
    }
    if (!READ_STAGES.has(name)) {
      throw new ReadOnlyViolation(
        `${at} uses unrecognised stage ${name}. Read-only stages must be whitelisted in ` +
          'mongoReadOnly.js before use, so an unknown stage can never write by accident.'
      );
    }

    // Nested pipelines can hide a writer.
    const body = stage[name];
    if (name === '$lookup' && body && Array.isArray(body.pipeline)) {
      assertReadOnlyPipeline(body.pipeline, `${at}.$lookup.pipeline`);
    }
    if (name === '$unionWith' && body && Array.isArray(body.pipeline)) {
      assertReadOnlyPipeline(body.pipeline, `${at}.$unionWith.pipeline`);
    }
    if (name === '$facet' && body && typeof body === 'object') {
      Object.entries(body).forEach(([branch, sub]) =>
        assertReadOnlyPipeline(sub, `${at}.$facet.${branch}`)
      );
    }
  });

  return true;
}

module.exports = {
  assertReadOnlyPipeline,
  ReadOnlyViolation,
  READ_STAGES,
  WRITE_STAGES,
};
