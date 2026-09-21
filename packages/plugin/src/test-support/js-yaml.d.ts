/**
 * Ambient types for `js-yaml@3`, which ships no bundled declarations.
 *
 * Only the two functions {@link ./obsidian-stub.ts} calls are declared, and
 * they are deliberately the `safe*` pair: `@ccc/vault-repo`'s service-side
 * serializer reaches the same engine through gray-matter's default
 * `safeLoad`/`safeDump` calls, so the plugin-vs-service byte-parity test is
 * comparing two paths into ONE engine rather than two engines that merely
 * look alike. The safe schema is also the one that does not instantiate
 * arbitrary JS types from YAML tags (threat T-02-03 / T-02-08).
 *
 * Declared here rather than pulling in `@types/js-yaml`: three lines of
 * surface used by one test-support file does not justify a DefinitelyTyped
 * dependency, and a narrower declaration cannot drift into calls this
 * repository never makes.
 */
declare module "js-yaml" {
  const yaml: {
    safeLoad(input: string): unknown;
    safeDump(value: unknown): string;
  };
  export default yaml;
}
