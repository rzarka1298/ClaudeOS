import { deleteSecret } from "@ccc/keychain";
import { assertUatAccount } from "./isolation-guards.js";

/**
 * Keychain cleanup for the throwaway service's install-secret item (05.2-03, D-05, T-05.2-09).
 * Deletion goes only through `deleteSecret` from @ccc/keychain, never a direct spawn of the
 * macOS tool, and only for a ccc-uat account.
 */

export type CleanupResult = "deleted" | "absent";

/** `security` exit code for "item could not be found". */
const ITEM_NOT_FOUND_EXIT_CODE = 44;

export interface KeychainCleanupDeps {
  deleter?: (account: string) => Promise<void>;
}

function exitCodeOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "exitCode" in err) {
    const code = (err as { exitCode: unknown }).exitCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

/** Deletes a ccc-uat account; an already-absent item (exit 44) is tolerated. */
export async function deleteUatAccount(
  account: string,
  deps: KeychainCleanupDeps = {},
): Promise<CleanupResult> {
  assertUatAccount(account);
  const deleter = deps.deleter ?? deleteSecret;
  try {
    await deleter(account);
    return "deleted";
  } catch (err) {
    if (exitCodeOf(err) === ITEM_NOT_FOUND_EXIT_CODE) return "absent";
    throw err;
  }
}
