/**
 * The MongoDB read-only guard.
 *
 * These matter because the target is the live ECSite production cluster. The
 * cases that would actually hurt are the nested ones -- a $merge hidden inside a
 * $lookup or $facet -- so those are tested explicitly rather than assumed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertReadOnlyPipeline,
  ReadOnlyViolation,
} = require('../src/db/mongoReadOnly');

test('accepts a plain read pipeline', () => {
  assert.equal(
    assertReadOnlyPipeline([
      { $match: { nodeIdList: 'abc' } },
      { $unwind: '$list' },
      { $group: { _id: null, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 10 },
    ]),
    true
  );
});

test('accepts $lookup with a read-only sub-pipeline', () => {
  assert.equal(
    assertReadOnlyPipeline([
      { $match: { siteId: 'x' } },
      {
        $lookup: {
          from: 'FieldMedia',
          let: { fid: '$_id' },
          pipeline: [{ $match: { $expr: { $eq: ['$formId', '$$fid'] } } }, { $count: 'n' }],
          as: 'media',
        },
      },
    ]),
    true
  );
});

test('rejects $out at the top level', () => {
  assert.throws(
    () => assertReadOnlyPipeline([{ $match: {} }, { $out: 'somewhere' }]),
    (err) => err instanceof ReadOnlyViolation && /\$out/.test(err.message)
  );
});

test('rejects $merge at the top level', () => {
  assert.throws(
    () => assertReadOnlyPipeline([{ $merge: { into: 'x' } }]),
    (err) => err instanceof ReadOnlyViolation && /\$merge/.test(err.message)
  );
});

test('rejects $merge hidden inside a $lookup sub-pipeline', () => {
  assert.throws(
    () =>
      assertReadOnlyPipeline([
        {
          $lookup: {
            from: 'FieldMedia',
            pipeline: [{ $match: {} }, { $merge: { into: 'evil' } }],
            as: 'x',
          },
        },
      ]),
    (err) => err instanceof ReadOnlyViolation && /\$merge/.test(err.message)
  );
});

test('rejects $out hidden inside a $facet branch', () => {
  assert.throws(
    () =>
      assertReadOnlyPipeline([
        { $facet: { good: [{ $count: 'n' }], bad: [{ $out: 'evil' }] } },
      ]),
    (err) => err instanceof ReadOnlyViolation && /\$out/.test(err.message)
  );
});

test('rejects an unknown stage -- fails closed rather than open', () => {
  assert.throws(
    () => assertReadOnlyPipeline([{ $someFutureStage: {} }]),
    (err) => err instanceof ReadOnlyViolation && /unrecognised/.test(err.message)
  );
});

test('rejects a stage object with more than one operator', () => {
  assert.throws(
    () => assertReadOnlyPipeline([{ $match: {}, $out: 'evil' }]),
    (err) => err instanceof ReadOnlyViolation && /exactly one/.test(err.message)
  );
});

test('rejects a non-array pipeline', () => {
  assert.throws(
    () => assertReadOnlyPipeline({ $match: {} }),
    (err) => err instanceof ReadOnlyViolation && /must be an array/.test(err.message)
  );
});

test('rejects a non-object stage', () => {
  assert.throws(
    () => assertReadOnlyPipeline([{ $match: {} }, 'DROP EVERYTHING']),
    (err) => err instanceof ReadOnlyViolation && /not a valid aggregation stage/.test(err.message)
  );
});
