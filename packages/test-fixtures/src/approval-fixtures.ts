// RED skeleton (plan 06-24 task 1): the fixtures are not written yet.
const notImplemented = (..._args: unknown[]): never => {
  throw new Error("approval fixtures are not implemented yet (RED)");
};

export type OpenedEngine = Record<string, never>;
export const FIXTURE_EPOCH = "2026-10-06T12:00:00.000Z";
export const FAKE_CONNECTOR = "connector.fake-send";
export const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export const addProductionRow = notImplemented;
export const auditEvents = notImplemented;
export const countAudit = notImplemented;
export const createCountingOperation = notImplemented;
export const createFakeClock = notImplemented;
export const createFakeConnector = notImplemented;
export const createRecordingLog = notImplemented;
export const diagnosticEffectRows = notImplemented;
export const logViolations = notImplemented;
export const readExecutions = notImplemented;
export const createRigs = (): { start: () => never; connect: () => never; dispose: () => void } => ({
  start: notImplemented,
  connect: notImplemented,
  dispose: () => undefined,
});
