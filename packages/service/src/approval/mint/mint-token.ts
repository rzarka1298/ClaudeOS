// The one module allowed to mint a capability token (APPR-01, D-03, T-06-01).
//
// Element: `approval-minter` (eslint.config.mjs). Import rule: `@ccc/domain`
// only, and nothing outside `packages/service/src/approval/` may import this
// file. The single `CapabilityToken` cast of the whole repository lives here;
// the grep backstop (scripts/check-boundaries.sh) carves out exactly this path.
// The only caller is `engine.ts`.
import type { ApprovalRequiredOperation, CapabilityToken } from "@ccc/domain";

export function mintToken<Op extends ApprovalRequiredOperation>(input: {
  readonly proposalId: string;
  readonly operation: Op;
  readonly subject: string;
  readonly expiresAt: string;
}): CapabilityToken<Op> {
  const { proposalId, operation, subject, expiresAt } = input;
  return Object.freeze({
    proposalId,
    operation,
    subject,
    expiresAt,
  }) as unknown as CapabilityToken<Op>;
}
