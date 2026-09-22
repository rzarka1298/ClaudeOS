/**
 * Ambient types for `js-yaml@3`, which ships no bundled declarations.
 *
 * Only the two functions this package calls are declared, and they are
 * deliberately the `safe*` pair: `@ccc/vault-repo`'s service-side serializer
 * reaches the same engine through gray-matter's default `safeLoad`/`safeDump`
 * calls, so `frontmatter-serializer.ts`'s byte-parity with the service is two
 * paths into ONE engine rather than two engines that merely look alike. The
 * safe schema is also the one that does not instantiate arbitrary JS types
 * from YAML tags (threat T-02-03 / T-02-08).
 *
 * This declaration used to live under `src/test-support/` because js-yaml was
 * a devDependency reached only by the Obsidian stub. It moved here when
 * `frontmatter-serializer.ts` made js-yaml a real, BUNDLED dependency of the
 * shipped plugin (GAP-1, plan 02-09): a production module must not depend on
 * a declaration filed under test support.
 *
 * Declared here rather than pulling in `@types/js-yaml`: three lines of
 * surface used by two files does not justify a DefinitelyTyped dependency,
 * and a narrower declaration cannot drift into calls this repository never
 * makes.
 */
declare module "js-yaml" {
  const yaml: {
    safeLoad(input: string): unknown;
    safeDump(value: unknown): string;
  };
  export default yaml;
}
