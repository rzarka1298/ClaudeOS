// STUB for TDD RED capture -- deliberately does not dispose anything and
// never validates registration kinds. Replaced by the real implementation
// immediately after RED evidence is captured.
export type Disposer = () => void;

export interface RegistrationHost {
  registerEvent(name: string, handler: (payload?: unknown) => void): Disposer;
  registerInterval(callback: () => void, ms: number): Disposer;
  registerDomEvent(
    target: { addEventListener: unknown; removeEventListener: unknown },
    type: string,
    handler: (ev: unknown) => void,
  ): Disposer;
  registerView(type: string, factory: unknown): Disposer;
  addRibbonIcon(icon: string, title: string, callback: () => void): Disposer;
  addCommand(command: { id: string; name: string; callback: () => void }): Disposer;
}

export interface DisposalFailure {
  error: unknown;
}

export interface HostRegistry {
  event(name: string, handler: (payload?: unknown) => void): void;
  interval(callback: () => void, ms: number): void;
  domEvent(
    target: { addEventListener: unknown; removeEventListener: unknown },
    type: string,
    handler: (ev: unknown) => void,
  ): void;
  view(type: string, factory: unknown): void;
  ribbon(icon: string, title: string, callback: () => void): void;
  command(cmd: { id: string; name: string; callback: () => void }): void;
  disposeAll(): DisposalFailure[];
  liveCount(): number;
  registerRaw(kind: string, dispose: Disposer): void;
}

export function createHostRegistry(_host: RegistrationHost): HostRegistry {
  return {
    event() {},
    interval() {},
    domEvent() {},
    view() {},
    ribbon() {},
    command() {},
    disposeAll() {
      return [];
    },
    liveCount() {
      return 0;
    },
    registerRaw() {},
  };
}
