import { createContext } from "preact";

/**
 * What a widget body may reach of its host beyond the frame's own props
 * (wave-5 review findings 4 and 6). The shell provides it; a body reads it
 * with `useContext`. Nothing here executes on its own: each member is either
 * a flag describing what the host wired, or a port the host already owns.
 *
 * - `switcherAvailable`: the host provides a quick switcher. Until it does
 *   (plan 04-14), S8's `Start a Claude Code session` takes the UI-SPEC
 *   unavailable treatment instead of sitting live and doing nothing.
 * - `openSystemSettings`: opens one of the two fixed System Settings panes
 *   through the service (RR-16). Absent, the launch error lines omit their
 *   pane buttons — the next-step line already names the path.
 *
 * The default is the honest no-host value: no switcher, no settings route.
 */
export interface WidgetHost {
  readonly switcherAvailable: boolean;
  readonly openSystemSettings?: ((pane: "automation" | "privacy-security") => void) | undefined;
}

export const NO_WIDGET_HOST: WidgetHost = Object.freeze({ switcherAvailable: false });

export const WidgetHostContext = createContext<WidgetHost>(NO_WIDGET_HOST);
