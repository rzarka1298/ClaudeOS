import {
  ProjectRefusedError,
  type RegistrationPolicyContext,
  validateProjectCandidate,
} from "./registration.js";

/** How many times a validation is re-run after the vault root changed under it. */
export const MAX_POLICY_REVALIDATIONS = 3;

/**
 * Validates `candidate` and returns its realpath, judged against the vault
 * root the store holds NOW, not only the one read before validation began
 * (codex review 2, finding 1). Shared by manual registration
 * (`project-routes.ts`) and by registering a scan suggestion (`scan.ts`), so
 * both paths into the project registry apply one policy.
 *
 * Validation is asynchronous — a Files & Folders prompt can hold it for as
 * long as the owner takes — so vault setup can persist a new root while it
 * runs. Vault setup itself is synchronous from its overlap check to its
 * persist, so it can never interleave with the synchronous tail of a caller.
 * That makes a version check sufficient, with no lock: after each validation
 * the vault root is re-read, and if it changed the candidate is validated
 * again against the new one. The caller must not await between this
 * returning and its insert. A vault root that keeps changing is refused
 * rather than chased forever.
 *
 * `validate` is looked up at call time (a default parameter), so a test that
 * replaces `validateProjectCandidate` through the module mock sees every
 * call made from here.
 */
export async function validateAgainstSettledPolicy(
  candidate: string,
  initial: RegistrationPolicyContext,
  readPolicy: () => RegistrationPolicyContext,
  validate: (
    candidate: string,
    context: RegistrationPolicyContext,
  ) => Promise<string> = validateProjectCandidate,
): Promise<string> {
  let policy = initial;
  for (let attempt = 0; ; attempt += 1) {
    const resolved = await validate(candidate, policy);
    const current = readPolicy();
    if (current.vaultRoot === policy.vaultRoot) return resolved;
    if (attempt >= MAX_POLICY_REVALIDATIONS) {
      throw new ProjectRefusedError(candidate, "policy-changed");
    }
    policy = current;
  }
}
