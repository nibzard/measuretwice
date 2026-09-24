// SPDX-License-Identifier: Apache-2.0
/**
 * The public failure type of the measuretwice package.
 *
 * Every public operation rejects invalid data before execution with one
 * `ValidationError`. The `code` field holds a stable reason code from the
 * registry in `contracts/README.md`. The `fieldPath` field holds the JSON
 * Pointer of the rejected field, in the portable contract. The message keeps
 * a short cause and names the next useful action. It contains no credentials
 * and no raw case content.
 */

/** One typed validation failure, reported before execution. */
export class ValidationError extends Error {
  /** Stable reason code from the published registry. */
  readonly code: string;
  /** JSON Pointer to the rejected field. An empty path means the complete document. */
  readonly fieldPath: string;

  constructor(code: string, message: string, fieldPath: string) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.fieldPath = fieldPath;
  }
}
