import type { ComponentChildren, VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";

/**
 * The controls the Settings sections share (plan 08-11 Task 3; 08-UI-SPEC S2 Controls,
 * accessibility additions 6 to 8): a row that groups a name, a description and one control, a
 * switch that is a button, a native select in its wrap, and the destination's one status line.
 *
 * None of them uses the native `disabled` attribute: a control that cannot act is `aria-disabled`
 * with a visible, undimmed reason beside it, so it stays focusable and the contrast harvest
 * exempts it. State reaches CSS through `aria-*` attributes only; there is no inline style.
 */

/** The visible reason a service-bound control is `aria-disabled` for (UI-SPEC S2). */
export const SERVICE_AWAY_REASON = "The companion service isn't running.";

/** What a change did, so the control can keep or revert what it shows. */
export type SettingChangeOutcome = "saved" | "reverted";

export interface SettingRowIds {
  /** The element carrying the row's name: the control's accessible name. */
  readonly nameId: string;
  /** The description paragraph, or `undefined` when the row has none. */
  readonly descriptionId: string | undefined;
}

export interface SettingRowProps {
  readonly name: string;
  readonly description?: string | undefined;
  /** Renders the control, given the ids it labels and describes itself by. */
  readonly control: (ids: SettingRowIds) => ComponentChildren;
  /** Extra paragraphs under the description (a status text, a visible reason). */
  readonly children?: ComponentChildren;
}

/**
 * One setting: a `group` named by its row name, so the name, the description and the control are
 * announced together. The name is the FIRST child of the text block (the stylesheet styles it
 * as Body 600), the description and any extra lines are paragraphs after it.
 */
export function SettingRow({ name, description, control, children }: SettingRowProps): VNode {
  const nameId = useId();
  const descriptionId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset implies form controls and brings browser chrome; this is a labelled group of a name, a description and one control.
    <div className="ccc-setting-row" role="group" aria-labelledby={nameId}>
      <div className="ccc-setting-row-text">
        <span id={nameId}>{name}</span>
        {description !== undefined && <p id={descriptionId}>{description}</p>}
        {children}
      </div>
      <div className="ccc-setting-row-control">
        {control({ nameId, descriptionId: description === undefined ? undefined : descriptionId })}
      </div>
    </div>
  );
}

export interface SettingSwitchProps {
  /** The committed value. The switch follows it whenever it changes and nothing is pending. */
  readonly checked: boolean;
  /** The id of the row's name: the switch's accessible name. */
  readonly labelledBy: string;
  /** The ids of the row's description and any visible reason, space separated. */
  readonly describedBy?: string | undefined;
  /** True when the setting cannot be changed now (the service is away): `aria-disabled`, inert. */
  readonly unavailable?: boolean | undefined;
  /**
   * Applies the change. `saved` keeps the new value, `reverted` (or a rejection) puts the
   * previous one back; the caller reports the outcome to the status line.
   */
  readonly onChange: (next: boolean) => Promise<SettingChangeOutcome>;
}

/**
 * A switch: a button with `role="switch"`, never a checkbox, so Obsidian's checkbox variables
 * never apply and the contrast harvest measures it as text and as a field edge. The visible
 * word (`On` or `Off`) is `aria-hidden`: the name comes from the row. A pending change sets
 * `aria-busy` and `aria-disabled` BEFORE the await and ignores a second activation, and the word
 * shows the value being saved.
 */
export function SettingSwitch({
  checked,
  labelledBy,
  describedBy,
  unavailable = false,
  onChange,
}: SettingSwitchProps): VNode {
  const [shown, setShown] = useState(checked);
  const [pending, setPending] = useState(false);
  // The rendered `pending` only reaches the handler on the next render; the ref is read at once,
  // so a second activation in the same tick is refused too.
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!pendingRef.current) setShown(checked);
  }, [checked]);

  async function activate(): Promise<void> {
    if (pendingRef.current || unavailable) return;
    const previous = shown;
    pendingRef.current = true;
    setPending(true);
    setShown(!previous);
    let outcome: SettingChangeOutcome;
    try {
      outcome = await onChange(!previous);
    } catch {
      outcome = "reverted";
    }
    pendingRef.current = false;
    setPending(false);
    if (outcome === "reverted") setShown(previous);
  }

  return (
    <button
      type="button"
      role="switch"
      className="ccc-switch"
      aria-checked={shown ? "true" : "false"}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={pending ? "true" : undefined}
      aria-disabled={pending || unavailable ? "true" : undefined}
      onClick={() => void activate()}
    >
      <span aria-hidden="true">{shown ? "On" : "Off"}</span>
    </button>
  );
}

export interface SettingSelectProps {
  readonly value: string;
  /** Option value to visible label, in display order. */
  readonly options: Readonly<Record<string, string>>;
  readonly labelledBy: string;
  readonly describedBy?: string | undefined;
  readonly onChange: (value: string) => Promise<SettingChangeOutcome>;
}

/**
 * A native `select` inside `.ccc-select-wrap` (the wrap draws the arrow). A change applies at
 * once; a failed or rejected save puts the previous option back, and a second change while one
 * is being saved is refused (the select keeps what is in effect).
 */
export function SettingSelect({
  value,
  options,
  labelledBy,
  describedBy,
  onChange,
}: SettingSelectProps): VNode {
  const [shown, setShown] = useState(value);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!pendingRef.current) setShown(value);
  }, [value]);

  async function change(select: HTMLSelectElement): Promise<void> {
    if (pendingRef.current) {
      select.value = shown;
      return;
    }
    const previous = shown;
    const next = select.value;
    if (next === previous) return;
    pendingRef.current = true;
    setPending(true);
    setShown(next);
    let outcome: SettingChangeOutcome;
    try {
      outcome = await onChange(next);
    } catch {
      outcome = "reverted";
    }
    pendingRef.current = false;
    setPending(false);
    if (outcome === "reverted") setShown(previous);
  }

  return (
    <span className="ccc-select-wrap">
      <select
        className="ccc-select"
        value={shown}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-busy={pending ? "true" : undefined}
        onChange={(event) => void change(event.currentTarget)}
      >
        {Object.entries(options).map(([optionValue, label]) => (
          <option key={optionValue} value={optionValue}>
            {label}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * The destination's one polite status line: a `role="status"` paragraph that is mounted before
 * its first message and only ever changes its text. It announces outcomes (a setting saved or
 * reverted, a copy, a check, a rebuild, a bundle) and never a section change.
 */
export function StatusLine({ message }: { readonly message: string }): VNode {
  return (
    <p className="ccc-settings-status" role="status">
      {message}
    </p>
  );
}
