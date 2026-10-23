import type {
  DiagnosticsErrorCode,
  DiagnosticsHealthResponse,
  HealthTrigger,
} from "@ccc/domain/diagnostics.js";

/**
 * The seam between the Diagnostics section and the service (plan 08-13; D-02, D-05). The section
 * and the health state call this one plain function; `wireHealth` configures it from the
 * authenticated diagnostics client, which `main.ts` injects (the `research/api.ts` precedent).
 * The service client package is never imported here, because its value exports pull in Node HTTP
 * the browser-platform bundle cannot resolve, and nothing in this folder makes a network call.
 *
 * The trigger says why the check was requested (Amendment A1): `gesture` is an owner action and
 * the only one allowed to cause a Keychain presence check on the service; `reconnect` is the
 * automatic refetch. The holder passes anything but an exact `gesture` on as `reconnect`.
 */
export interface HealthApi {
  /** One read-only health check. Rejects with a {@link HealthApiError}. */
  get: (trigger: HealthTrigger) => Promise<DiagnosticsHealthResponse>;
}

/** What `configureHealth` installs. */
export interface HealthConfig {
  readonly api: HealthApi;
}

/**
 * The closed error vocabulary: the holder itself raises `service-disconnected`; the wiring maps
 * every client error onto the same codes. The message equals the code, so nothing a remote party
 * or the socket said can reach a string the view might render.
 */
export class HealthApiError extends Error {
  readonly code: DiagnosticsErrorCode;
  constructor(code: DiagnosticsErrorCode) {
    super(code);
    this.name = "HealthApiError";
    this.code = code;
  }
}

const DISCONNECTED_API: HealthApi = {
  get: () => Promise.reject(new HealthApiError("service-disconnected")),
};

let currentApi: HealthApi = DISCONNECTED_API;
let configured = false;

/** Installs the API (or, with `null`, the disconnected default). */
export function configureHealth(config: HealthConfig | null): void {
  if (config === null) {
    currentApi = DISCONNECTED_API;
    configured = false;
    return;
  }
  currentApi = config.api;
  configured = true;
}

/** True once a host has configured the health code. */
export function healthConfigured(): boolean {
  return configured;
}

/** The configured API: exactly one function, and the trigger is normalised on the way through. */
export function healthApi(): HealthApi {
  return {
    get: (trigger) => currentApi.get(trigger === "gesture" ? "gesture" : "reconnect"),
  };
}
