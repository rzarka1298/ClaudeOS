import { z } from "zod";
import type { Brand } from "./ids.js";

/**
 * The approval vocabulary (D-12). Browser-safe: no `node:` import, and
 * `ids.ts` is imported as a type only, so this file stays a leaf the plugin
 * bundle can reach. Task 2 of plan 06-04 fills in the rest of the module; the
 * identifier shape lives first because `newProposalId` (in `ids.ts`) is typed
 * against it.
 */

/** The service-minted identifier of one approval request (D-12, D-15). */
export type ProposalId = Brand<string, "ProposalId">;

/**
 * The shape of a minted {@link ProposalId}: 25 lowercase alphanumerics (a
 * base-36 millisecond prefix and a hex suffix, the `newRunId` scheme). Looser
 * than the minted shape on purpose: the check at a boundary asks "could this
 * be an id", never "was this minted here".
 */
export const PROPOSAL_ID_PATTERN = /^[0-9a-z]{25}$/;

/** A ProposalId crossing the wire: validated against the minted shape, never minted here. */
export const ProposalIdSchema = z.custom<ProposalId>(
  (value) => typeof value === "string" && PROPOSAL_ID_PATTERN.test(value),
  { message: "must be a ProposalId" },
);
