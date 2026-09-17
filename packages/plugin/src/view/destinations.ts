/**
 * The eight top-level destinations of the command-center shell (PLUG-02),
 * and the single tested definition of wrap-around keyboard navigation
 * between them. Every call site — the shell's arrow-key handler today,
 * anything else later — moves through {@link nextDestination} rather than
 * re-deriving index arithmetic locally.
 */
export interface Destination {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export const DESTINATIONS = [
  {
    id: "overview",
    label: "Overview",
    description: "The command-center summary. Filled in a later phase.",
  },
  {
    id: "projects",
    label: "Projects",
    description: "Registered project shortcuts and their git status. Filled in a later phase.",
  },
  {
    id: "research",
    label: "Research",
    description: "Cited reports and the knowledge lifecycle. Filled in a later phase.",
  },
  {
    id: "tasks",
    label: "Tasks",
    description: "The canonical Obsidian task store. Filled in a later phase.",
  },
  {
    id: "agent-runs",
    label: "Agent runs",
    description: "Concurrent Claude sessions and automation runs. Filled in a later phase.",
  },
  {
    id: "skills",
    label: "Skills",
    description: "Reusable, user-invocable capabilities. Filled in a later phase.",
  },
  {
    id: "knowledge",
    label: "Knowledge",
    description: "The managed vault's raw, wiki, and output lifecycle. Filled in a later phase.",
  },
  {
    id: "settings",
    label: "Settings",
    description: "Plugin configuration and diagnostics. Filled in a later phase.",
  },
] as const satisfies readonly Destination[];

export type DestinationId = (typeof DESTINATIONS)[number]["id"];

export type NavigationDirection = "next" | "previous";

/**
 * Wrap-around movement through {@link DESTINATIONS}: past the last entry
 * returns to the first, and back past the first returns to the last. One
 * tested definition rather than one per keyboard-handler call site.
 */
export function nextDestination(
  current: DestinationId,
  direction: NavigationDirection,
): DestinationId {
  const currentIndex = DESTINATIONS.findIndex((destination) => destination.id === current);
  const length = DESTINATIONS.length;
  const delta = direction === "next" ? 1 : -1;
  const nextIndex = (currentIndex + delta + length) % length;
  const next = DESTINATIONS[nextIndex];
  if (!next) {
    throw new Error(`nextDestination: computed index ${nextIndex} out of range`);
  }
  return next.id;
}
