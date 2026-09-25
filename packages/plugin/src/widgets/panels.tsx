import type { WidgetDefinition } from "./contract.js";

/**
 * RED skeleton (plan 03-06 task 1).
 *
 * Every panel below is a placeholder whose renderers throw, so the module
 * graph LOADS and `registry.test.ts` fails on its own assertions rather than
 * on a missing import — the difference between `target_test_failed` and the
 * `fixture_or_load_failure` that would make the RED gate invalid (#3770).
 */
function notImplemented(id: string): WidgetDefinition<unknown> {
  return {
    id,
    title: "",
    dataKeys: [],
    refresh: { kind: "manual" },
    minSize: "small",
    preferredSize: "small",
    featureFlag: "",
    quickActions: [],
    renderBody: () => {
      throw new Error(`${id} renderBody is not implemented yet`);
    },
    renderEmpty: () => {
      throw new Error(`${id} renderEmpty is not implemented yet`);
    },
  };
}

export const todayWidget = notImplemented("today");
export const activeSessionsWidget = notImplemented("active-sessions");
export const projectShortcutsWidget = notImplemented("project-shortcuts");
export const claudeUsageWidget = notImplemented("claude-usage");
export const techIntelWidget = notImplemented("tech-intel");
export const githubDiscoveriesWidget = notImplemented("github-discoveries");
export const quickActionsWidget = notImplemented("quick-actions");
