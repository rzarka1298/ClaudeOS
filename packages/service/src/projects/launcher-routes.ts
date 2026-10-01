import type { Handler } from "../route-kit.js";
import type { Detector } from "./detection.js";
import type { Spawner } from "./spawner.js";

// RED stub (04-11 Task 1): the shapes only; GREEN adds the routes.

export interface LauncherServices {
  readonly detector: Detector;
  readonly homeDir: string;
  onLaunchersChanged(): void;
  readonly spawner: Spawner;
  readonly scriptDir: string;
  readonly isExecutable?: (path: string) => Promise<boolean>;
  readonly testCapMs?: number;
  readonly automationTestCapMs?: number;
}

export const launcherRoutes: Record<string, Record<string, Handler>> = {};
