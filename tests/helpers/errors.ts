/**
 * Helpers for asserting on server errors. Framework-free so the spike script
 * can use them too.
 */
import { MongoServerError, type Document } from 'mongodb';

/** Server error codes this project asserts on. */
export const ERROR_CODES = {
  /** Unauthorized: the user's roles lack the action. */
  UNAUTHORIZED: 13,
  /** DocumentValidationFailure: a validator rejected the write. */
  DOCUMENT_VALIDATION_FAILURE: 121,
  /** DuplicateKey (E11000): a unique index rejected the write. */
  DUPLICATE_KEY: 11000,
} as const;

/** Run `fn` and return the MongoServerError it throws. Throws if it succeeds or throws something else. */
export async function captureServerError(fn: () => Promise<unknown>): Promise<MongoServerError> {
  let result: unknown;
  try {
    result = await fn();
  } catch (err) {
    if (err instanceof MongoServerError) return err;
    // Bulk write errors wrap the server error; surface the first write error's details.
    throw err;
  }
  throw new Error(`Expected a MongoServerError, but the operation succeeded: ${JSON.stringify(result)}`);
}

/** Like captureServerError, and also checks the code. */
export async function expectServerError(fn: () => Promise<unknown>, code: number): Promise<MongoServerError> {
  const err = await captureServerError(fn);
  if (err.code !== code) {
    throw new Error(`Expected server error code ${code}, got ${String(err.code)} (${err.codeName ?? ''}): ${err.message}`);
  }
  return err;
}

/** The parts of a server error worth recording in findings or a review_queue document. */
export function summarizeServerError(err: MongoServerError): Document {
  return {
    code: err.code,
    codeName: err.codeName,
    errmsg: err.errmsg ?? err.message,
    ...(err.errInfo ? { errInfo: err.errInfo } : {}),
  };
}

/**
 * Walk a code-121 `errInfo.details` tree and collect every `operatorName`
 * (e.g. "maximum", "required", "additionalProperties", "$expr"). Use it to
 * assert that a rejection names the expected rule.
 */
export function validatorOperatorNames(errInfo: unknown): string[] {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'operatorName' && typeof value === 'string') names.add(value);
        visit(value);
      }
    }
  };
  visit(errInfo);
  return [...names];
}
