/** The plugin files a build hash covers, in the fixed order they are hashed. */
export const BUILD_FILES = ["main.js", "manifest.json", "styles.css"] as const;

export function buildHash(_dir: string): string {
  throw new Error("buildHash is not implemented yet (typed skeleton)");
}
