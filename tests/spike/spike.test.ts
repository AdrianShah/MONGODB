/**
 * Phase 0 spike on the test harness. The check logic lives in ./checks.ts
 * and is shared with `npm run spike`; these tests run it and pin the
 * findings docs/SPIKE.md relies on.
 */
import { describe, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import { useTestDb } from '../helpers/index.js';
import {
  checkBudgetCap,
  checkChangeStreams,
  checkCustomRole,
  checkTransactions,
  checkValidatorErrorShape,
} from './checks.js';

const t = useTestDb('spike');

describe('Phase 0 spike', () => {
  it('a. collection-level custom role: insert allowed, everything else is code 13', async () => {
    const { findings } = await checkCustomRole.run(t());
    const denied = findings['denied'] as Record<string, Document>;
    expect(Object.keys(denied).sort()).toEqual(
      ['collMod', 'find', 'insertOtherCollection', 'insertWithBypassDocumentValidation', 'remove', 'update'].sort(),
    );
    for (const result of Object.values(denied)) {
      expect(result).toMatchObject({ code: 13, codeName: 'Unauthorized' });
    }
  });

  it('b. validator rejection is code 121 with errInfo.details naming the rule', async () => {
    const { findings } = await checkValidatorErrorShape.run(t());
    const shapes = findings['shapes'] as Record<string, Document>;
    // Write errors from insertOne carry code and errmsg but no codeName: assert on the code.
    expect(shapes['maximum']).toMatchObject({ code: 121, errmsg: 'Document failed validation' });
    expect(shapes['maximum']?.['codeName']).toBeUndefined();
    expect(shapes['maximum']?.['errInfo']).toMatchObject({ failingDocumentId: expect.anything(), details: expect.any(Object) });
    expect(shapes['maximum']?.['operatorNames']).toContain('maximum');
    expect(shapes['required']?.['operatorNames']).toContain('required');
    expect(shapes['additionalProperties']?.['operatorNames']).toContain('additionalProperties');
    expect(shapes['expr']?.['operatorNames']).toContain('$expr');
  });

  it('c. change stream delivers filtered inserts and resumes from a saved token', async () => {
    const { findings } = await checkChangeStreams.run(t());
    expect(findings['resumedEvents']).toEqual([2, 3]);
    const matrix = findings['actionMatrix'] as Record<string, Document>;
    expect(matrix['find_and_changeStream']?.['allowed']).toBe(true);
    expect(matrix['changeStream_only']).toMatchObject({ allowed: false, code: 13 });
    expect(matrix['find_only']).toMatchObject({ allowed: false, code: 13 });
  });

  it('d. multi-document transaction commits atomically and aborts cleanly', async () => {
    const { findings } = await checkTransactions.run(t());
    expect(findings['validatorAbort']).toMatchObject({ code: 121 });
  });

  it('e. $expr budget cap rejects over-cap $inc, including 20 concurrent increments', async () => {
    const { findings } = await checkBudgetCap.run(t());
    expect(findings['overCapError']).toMatchObject({ code: 121 });
    expect(findings['concurrent']).toMatchObject({ accepted: 14, rejected: 6, final: 9_800, rejectedCodes: [121] });
  });
});
