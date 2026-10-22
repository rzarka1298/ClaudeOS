import type { VNode } from "preact";
import { SettingRow, SettingSelect } from "./settings-controls.js";
import type { SettingsHost } from "./settings-host.js";
import {
  applyReducedMotionChange,
  asMotionPreference,
  REDUCED_MOTION_DESC,
  REDUCED_MOTION_NAME,
  REDUCED_MOTION_OPTIONS,
} from "./settings-model.js";

/**
 * The Visual section (plan 08-11 Task 3; 08-UI-SPEC S2 Visual, D-18).
 *
 * One setting, `Reduced motion`, which the native settings tab also holds so it stays findable
 * in Obsidian's own settings search: both write the one `settings.reducedMotion` through the
 * same `applyReducedMotionChange` (persist first, then apply, restore and say so on failure).
 * The select applies at once; tokens re-resolve and nothing animates. A static note says the
 * command center keeps its dark look in both Obsidian themes.
 */

export const VISUAL_SECTION_DESCRIPTION = "How the command center looks and moves.";
export const VISUAL_DARK_NOTE = "The command center keeps its dark look in both Obsidian themes.";

export interface VisualSettingsProps {
  readonly host: SettingsHost;
  /** Posts an outcome to the destination's status line. */
  readonly notify: (message: string) => void;
}

export function VisualSettings({ host, notify }: VisualSettingsProps): VNode {
  return (
    <>
      <h3 tabIndex={-1} className="ccc-settings-section-title">
        Visual
      </h3>
      <p>{VISUAL_SECTION_DESCRIPTION}</p>
      <SettingRow
        name={REDUCED_MOTION_NAME}
        description={REDUCED_MOTION_DESC}
        control={({ nameId, descriptionId }) => (
          <SettingSelect
            value={host.settings.reducedMotion}
            pendingKey="reduced-motion"
            options={REDUCED_MOTION_OPTIONS}
            labelledBy={nameId}
            describedBy={descriptionId}
            onChange={(value) => applyReducedMotionChange(host, asMotionPreference(value), notify)}
          />
        )}
      />
      <p className="ccc-field-help">{VISUAL_DARK_NOTE}</p>
    </>
  );
}
