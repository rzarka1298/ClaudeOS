// RED stub: signatures only, behaviour arrives in the GREEN step.
export interface CodexHookMeta {
  readonly eventId: string;
  readonly observedAt: string;
}

export interface CodexMinimizeOptions {
  readonly overflowed?: boolean;
}

export function minimizeCodexHookInput(
  _raw: string | null,
  _meta: CodexHookMeta,
  _options: CodexMinimizeOptions = {},
): Record<string, unknown> | null {
  return null;
}
