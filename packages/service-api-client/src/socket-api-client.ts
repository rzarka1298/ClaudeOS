import http from "node:http";
import {
  ApiErrorBodySchema,
  VAULT_SETUP_PATH,
  VAULT_SETUP_PLAN_PATH,
  type VaultSetupPlanResponse,
  VaultSetupPlanResponseSchema,
  type VaultSetupResponse,
  VaultSetupResponseSchema,
} from "@ccc/domain";

/**
 * Thrown when the socket cannot be reached at all — connection refused, no
 * such file, or a request timeout. Carries the underlying errno so callers
 * can distinguish "service not running" from "service refused."
 */
export class SocketUnreachableError extends Error {
  readonly errno: string | undefined;

  constructor(socketPath: string, cause: NodeJS.ErrnoException) {
    super(`Could not reach the service socket at ${socketPath}: ${cause.message}`);
    this.name = "SocketUnreachableError";
    this.errno = cause.code;
    this.cause = cause;
  }
}

export interface SocketApiClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export interface SocketRequestOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface SocketResponse<T> {
  status: number;
  body: T;
}

export interface SocketApiClient {
  request<T>(opts: SocketRequestOptions): Promise<SocketResponse<T>>;
}

/**
 * The inbound cap, mirroring the service's own `DEFAULT_BODY_LIMIT_BYTES`.
 *
 * Duplicated as a literal rather than imported because the import-boundary
 * map forbids this package from depending on `@ccc/service`. The service
 * caps what it will READ from a caller; this caps what the plugin will
 * accumulate from the service, so neither direction can be made to buffer
 * without bound.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Builds a typed client over `http.request({ socketPath })` — this is the
 * one package permitted to speak the Unix-domain-socket transport
 * directly (research §Recommended Project Structure); the Obsidian plugin
 * imports this client rather than speaking HTTP itself.
 */
export function createSocketApiClient({
  socketPath,
  timeoutMs = 5000,
}: SocketApiClientOptions): SocketApiClient {
  return {
    request<T>(opts: SocketRequestOptions): Promise<SocketResponse<T>> {
      return new Promise((resolve, reject) => {
        const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
        const req = http.request(
          {
            socketPath,
            path: opts.path,
            method: opts.method,
            timeout: timeoutMs,
            headers: {
              ...(payload ? { "Content-Type": "application/json" } : {}),
              ...opts.headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let received = 0;

            // Every listener below settles the promise exactly once. The
            // executor has already RETURNED by the time any of them fires,
            // so a throw inside one is not captured by the promise: it
            // surfaces as an uncaught exception in Obsidian's renderer
            // while the caller's `await` never settles. That is a hung
            // command with no error in front of the user, which is why the
            // JSON parse below is inside a `try` rather than inline.
            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              if (received > MAX_RESPONSE_BYTES) {
                chunks.length = 0;
                // Settle BEFORE destroying: `destroy()` emits `aborted`
                // synchronously, and that handler would otherwise win the
                // race and report "the service went away" for what is
                // really "the service said too much".
                reject(new VaultSetupRequestError(res.statusCode ?? 0, UNRECOGNISED_RESPONSE));
                res.destroy();
                return;
              }
              chunks.push(chunk);
            });

            // A connection torn down AFTER headers arrived never emits
            // `end`, and `req`'s own `error` handler does not fire for it
            // either — without these two the promise stays pending forever.
            res.on("aborted", () => {
              const abortErr = Object.assign(new Error("response aborted"), {
                code: "ECONNRESET",
              }) as NodeJS.ErrnoException;
              reject(new SocketUnreachableError(socketPath, abortErr));
            });
            res.on("error", (err: NodeJS.ErrnoException) => {
              reject(new SocketUnreachableError(socketPath, err));
            });

            res.on("end", () => {
              const raw = Buffer.concat(chunks).toString("utf8");
              try {
                const body = raw.length > 0 ? (JSON.parse(raw) as T) : (undefined as T);
                resolve({ status: res.statusCode ?? 0, body });
              } catch {
                // A truncated body, a proxy error page, a stack trace, or a
                // future non-JSON route all land here. The status is kept
                // so a caller can still tell a refusal from a success.
                reject(new VaultSetupRequestError(res.statusCode ?? 0, UNRECOGNISED_RESPONSE));
              }
            });
          },
        );

        req.once("timeout", () => {
          req.destroy();
          const timeoutErr = Object.assign(new Error("request timed out"), {
            code: "ETIMEDOUT",
          }) as NodeJS.ErrnoException;
          reject(new SocketUnreachableError(socketPath, timeoutErr));
        });
        req.once("error", (err: NodeJS.ErrnoException) => {
          reject(new SocketUnreachableError(socketPath, err));
        });

        if (payload) req.write(payload);
        req.end();
      });
    },
  };
}

/**
 * Thrown when a vault-setup call reached the service and the service
 * refused it — a 401, a 400 for a malformed body, a 422 for a missing
 * vault root, or a response whose shape the domain schema does not
 * recognise. Distinct from {@link SocketUnreachableError}, which means the
 * service was never reached at all: the two need different words in front
 * of a user, and only one of them means "start the service".
 *
 * `message` is whatever the service put in its constant error body. By
 * construction (routes.ts) that never contains a filesystem path, so a UI
 * may display it verbatim.
 */
export class VaultSetupRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "VaultSetupRequestError";
    this.status = status;
  }
}

/** Used when a refusal carries no readable `error` field of its own. */
const UNRECOGNISED_FAILURE = "The service refused the request.";
const UNRECOGNISED_RESPONSE = "The service returned a response this client does not recognise.";

/**
 * A schema shape, structurally — the same trick the service's
 * `readJsonBody` uses, kept here so this module's two call sites read the
 * same way whichever response they are validating.
 */
interface ResponseParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/**
 * The one place a vault-setup response becomes a value or an error.
 *
 * Validating the 200 body rather than casting it is the point: the plugin
 * renders the entry list straight into a confirmation modal, so a
 * malformed or truncated response must become a visible failure here and
 * not a modal that silently displays fewer paths than setup will write.
 */
async function postVaultSetupRequest<T>(
  client: SocketApiClient,
  path: string,
  vaultRoot: string,
  schema: ResponseParser<T>,
): Promise<T> {
  const res = await client.request<unknown>({ method: "POST", path, body: { vaultRoot } });
  if (res.status !== 200) {
    const parsed = ApiErrorBodySchema.safeParse(res.body);
    throw new VaultSetupRequestError(
      res.status,
      parsed.success ? parsed.data.error : UNRECOGNISED_FAILURE,
    );
  }
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) {
    throw new VaultSetupRequestError(res.status, UNRECOGNISED_RESPONSE);
  }
  return parsed.data;
}

/**
 * Fetches the show-paths-first plan (VAULT-01): every path setup would
 * touch and whether it is already there. Writes nothing.
 */
export function requestVaultSetupPlan(
  client: SocketApiClient,
  vaultRoot: string,
): Promise<VaultSetupPlanResponse> {
  return postVaultSetupRequest(
    client,
    VAULT_SETUP_PLAN_PATH,
    vaultRoot,
    VaultSetupPlanResponseSchema,
  );
}

/** Applies setup, creating the managed tree the plan described. */
export function requestVaultSetup(
  client: SocketApiClient,
  vaultRoot: string,
): Promise<VaultSetupResponse> {
  return postVaultSetupRequest(client, VAULT_SETUP_PATH, vaultRoot, VaultSetupResponseSchema);
}
