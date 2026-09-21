import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http, { type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  VAULT_SETUP_PATH,
  VAULT_SETUP_PLAN_PATH,
  VaultSetupPlanResponseSchema,
  VaultSetupResponseSchema,
} from "@ccc/domain";
import { type OperationalStore, openStore } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintToken } from "./auth/token.js";
import { createEventBus } from "./events/event-bus.js";
import { assertPathAllowed, clearApprovedRoots, PathNotAllowedError } from "./path-allowlist.js";
import { createRequestListener } from "./routes.js";
import { startSocketServer } from "./socket-server.js";
import { registerPersistedVaultRoot, VAULT_ROOT_META_KEY } from "./vault-root.js";

// The same short, fixed base directory every other socket test in this
// repository uses — macOS's randomized per-user $TMPDIR is long enough to
// break the `sun_path` cap these tests bind a real socket inside (ADR-0001).
const TEST_BASE = join(homedir(), ".ccc-test");

/**
 * Built rather than written as an inline escape: the formatter rewrites
 * that escape into a RAW NUL byte in the source file, which is invisible in
 * review. Constructing it keeps this file pure ASCII while the byte the
 * service is asked to reject is still a real NUL.
 */
const NUL_BYTE = String.fromCharCode(0);

interface SocketReply<T> {
  status: number;
  body: T;
  raw: string;
}

/**
 * A minimal request helper with a BODY — `@ccc/test-fixtures`'
 * `requestOverSocket` is body-less, and this package cannot import it
 * anyway (`test-fixtures` depends on `@ccc/service`, so the edge would be
 * a cycle). Deliberately raw `node:http` rather than the api-client: these
 * tests are about what the SERVICE does with a payload, including payloads
 * no well-behaved client would ever send.
 */
function requestWithBody<T>(
  socketPath: string,
  opts: { method: string; path: string; rawBody?: string; token?: string },
): Promise<SocketReply<T>> {
  return new Promise((resolve, reject) => {
    const payload = opts.rawBody ?? "";
    const req = http.request(
      {
        socketPath,
        path: opts.path,
        method: opts.method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: (raw.length > 0 ? JSON.parse(raw) : undefined) as T,
            raw,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function postVaultRoot<T>(
  socketPath: string,
  path: string,
  vaultRoot: string,
  token: string,
): Promise<SocketReply<T>> {
  return requestWithBody<T>(socketPath, {
    method: "POST",
    path,
    rawBody: JSON.stringify({ vaultRoot }),
    token,
  });
}

let dir: string;
let socketPath: string;
let dbPath: string;
let vaultRoot: string;
let store: OperationalStore;
let server: Server;
let secret: Buffer;
let token: string;

beforeEach(async () => {
  // A registry left populated by a previous test would make a later
  // `assertPathAllowed` pass for the wrong reason — the restart test in
  // particular has to start from deny-by-default.
  clearApprovedRoots();

  mkdirSync(TEST_BASE, { recursive: true });
  dir = mkdtempSync(join(TEST_BASE, "vsr-"));
  socketPath = join(dir, "t.sock");
  dbPath = join(dir, "operational.db");
  vaultRoot = join(dir, "Vault");
  mkdirSync(vaultRoot);

  store = openStore(dbPath);
  secret = randomBytes(32);
  token = mintToken(secret, { nowMs: Date.now() });

  server = await startSocketServer({
    socketPath,
    requestListener: createRequestListener({
      store,
      getSecret: () => secret,
      eventBus: createEventBus(),
    }),
  });
});

afterEach(() => {
  server.close();
  store.close();
  clearApprovedRoots();
  rmSync(dir, { recursive: true, force: true });
});

describe("vault-setup routes: authentication", () => {
  it("rejects an unauthenticated setup-plan request with the same 401 body every other authed route returns", async () => {
    const res = await requestWithBody<{ error: string }>(socketPath, {
      method: "POST",
      path: VAULT_SETUP_PLAN_PATH,
      rawBody: JSON.stringify({ vaultRoot }),
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "authentication required" });
  });

  it("rejects an unauthenticated setup request and writes nothing", async () => {
    const res = await requestWithBody<{ error: string }>(socketPath, {
      method: "POST",
      path: VAULT_SETUP_PATH,
      rawBody: JSON.stringify({ vaultRoot }),
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "authentication required" });
    expect(readdirSync(vaultRoot)).toEqual([]);
  });
});

describe("POST /api/v1/vault/setup-plan", () => {
  it("returns the planned entries for an existing vault root without writing anything", async () => {
    const res = await postVaultRoot<unknown>(socketPath, VAULT_SETUP_PLAN_PATH, vaultRoot, token);

    expect(res.status).toBe(200);
    const parsed = VaultSetupPlanResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.vaultRoot).toBe(vaultRoot);
    const paths = parsed.data.entries.map((entry) => entry.relativePath);
    expect(paths).toContain("global/raw");
    expect(paths).toContain("inbox/index.md");
    expect(paths).toContain("CLAUDE.md");
    // Every entry on an empty vault root is honestly reported as absent.
    expect(parsed.data.entries.every((entry) => entry.exists === false)).toBe(true);
    // Purely read-only: a plan call must be safe on a vault the user has
    // not decided about yet (VAULT-01).
    expect(readdirSync(vaultRoot)).toEqual([]);
  });

  it("reports accurate exists flags after the tree has been created", async () => {
    await postVaultRoot<unknown>(socketPath, VAULT_SETUP_PATH, vaultRoot, token);
    const res = await postVaultRoot<unknown>(socketPath, VAULT_SETUP_PLAN_PATH, vaultRoot, token);

    const parsed = VaultSetupPlanResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.entries.every((entry) => entry.exists === true)).toBe(true);
  });
});

describe("POST /api/v1/vault/setup", () => {
  it("creates the managed tree, persists the vault root, and reports created and existing", async () => {
    const res = await postVaultRoot<unknown>(socketPath, VAULT_SETUP_PATH, vaultRoot, token);

    expect(res.status).toBe(200);
    const parsed = VaultSetupResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.existing).toEqual([]);
    expect(parsed.data.created).toContain("global/raw");
    expect(parsed.data.created).toContain("CLAUDE.md");

    expect(existsSync(join(vaultRoot, "global", "raw", "index.md"))).toBe(true);
    expect(existsSync(join(vaultRoot, "CLAUDE.md"))).toBe(true);
    expect(store.readServiceMeta(VAULT_ROOT_META_KEY)).toBe(vaultRoot);

    // Registered into the allowlist by the same handler, so a later
    // path-accepting route does not have to wait for a restart.
    expect(assertPathAllowed(join(vaultRoot, "global", "raw"))).toBeTruthy();
  });

  it("a setup against a different root REPLACES the approved root rather than widening it", async () => {
    // `service_meta` is keyed, so the persisted root was always replaced —
    // but the in-memory registry only ever appended, leaving both
    // directories approved for the rest of the process lifetime. That is
    // exactly the "something a request can widen on the way back in" that
    // threat T-02-18 forbids, and it goes live the moment a handler calls
    // `assertPathAllowed`.
    const second = join(dir, "SecondVault");
    mkdirSync(second);

    await postVaultRoot<unknown>(socketPath, VAULT_SETUP_PATH, vaultRoot, token);
    expect(assertPathAllowed(join(vaultRoot, "global"))).toBeTruthy();

    await postVaultRoot<unknown>(socketPath, VAULT_SETUP_PATH, second, token);

    expect(store.readServiceMeta(VAULT_ROOT_META_KEY)).toBe(second);
    expect(assertPathAllowed(join(second, "global"))).toBeTruthy();
    expect(() => assertPathAllowed(join(vaultRoot, "global"))).toThrow(PathNotAllowedError);
  });

  it("is idempotent over the socket: a second call creates nothing and reports everything existing", async () => {
    await postVaultRoot<unknown>(socketPath, VAULT_SETUP_PATH, vaultRoot, token);
    const claudeMd = join(vaultRoot, "CLAUDE.md");
    const before = readFileSync(claudeMd);

    const res = await postVaultRoot<unknown>(socketPath, VAULT_SETUP_PATH, vaultRoot, token);
    const parsed = VaultSetupResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.created).toEqual([]);
    expect(Buffer.compare(readFileSync(claudeMd), before)).toBe(0);
  });

  it("refuses a nonexistent vault root with a body carrying no filesystem path", async () => {
    const missing = join(dir, "NoSuchVault");
    const res = await postVaultRoot<{ error: string }>(
      socketPath,
      VAULT_SETUP_PATH,
      missing,
      token,
    );

    expect(res.status).toBe(422);
    // The literal T-02-19 assertion: the response body discloses nothing
    // about this machine's filesystem layout.
    expect(res.raw).not.toContain(missing);
    expect(res.raw).not.toContain(dir);
    expect(res.raw).not.toContain(homedir());
    expect(res.raw).not.toMatch(/\/[A-Za-z0-9._-]+\//);
    expect(existsSync(missing)).toBe(false);
    expect(store.readServiceMeta(VAULT_ROOT_META_KEY)).toBeNull();
  });
});

describe("vault-setup request bodies", () => {
  it("refuses a relative vault root with 400 and writes nothing", async () => {
    const res = await postVaultRoot<{ error: string }>(
      socketPath,
      VAULT_SETUP_PATH,
      "relative/Vault",
      token,
    );
    expect(res.status).toBe(400);
    expect(readdirSync(vaultRoot)).toEqual([]);
    expect(store.readServiceMeta(VAULT_ROOT_META_KEY)).toBeNull();
  });

  it("refuses a vault root containing a NUL byte with 400 and writes nothing", async () => {
    const res = await postVaultRoot<{ error: string }>(
      socketPath,
      VAULT_SETUP_PATH,
      `${vaultRoot}${NUL_BYTE}/etc`,
      token,
    );
    expect(res.status).toBe(400);
    expect(readdirSync(vaultRoot)).toEqual([]);
  });

  it("refuses a non-JSON body with 400 and writes nothing", async () => {
    const res = await requestWithBody<{ error: string }>(socketPath, {
      method: "POST",
      path: VAULT_SETUP_PATH,
      rawBody: "this is not json",
      token,
    });
    expect(res.status).toBe(400);
    expect(readdirSync(vaultRoot)).toEqual([]);
  });

  it("refuses a body over the 64KB cap with 400 and writes nothing", async () => {
    const oversized = JSON.stringify({ vaultRoot, padding: "x".repeat(128 * 1024) });
    const res = await requestWithBody<{ error: string }>(socketPath, {
      method: "POST",
      path: VAULT_SETUP_PATH,
      rawBody: oversized,
      token,
    });
    expect(res.status).toBe(400);
    expect(readdirSync(vaultRoot)).toEqual([]);
  });
});

describe("vault root persistence across a service restart", () => {
  it("re-registers the persisted vault root at startup so a path inside it is allowed again", async () => {
    await postVaultRoot<unknown>(socketPath, VAULT_SETUP_PATH, vaultRoot, token);
    store.close();

    // A restart: nothing in memory carries over — a fresh process would
    // begin with an empty allowlist and would have to deny everything.
    clearApprovedRoots();
    expect(() => assertPathAllowed(join(vaultRoot, "global"))).toThrow(PathNotAllowedError);

    store = openStore(dbPath);
    const registered = registerPersistedVaultRoot(store);

    expect(registered).toBe(vaultRoot);
    expect(assertPathAllowed(join(vaultRoot, "global", "raw"))).toBeTruthy();
  });

  it("registers nothing and reports null when no vault root has been set up yet", () => {
    expect(registerPersistedVaultRoot(store)).toBeNull();
    expect(() => assertPathAllowed(join(vaultRoot, "global"))).toThrow(PathNotAllowedError);
  });
});
