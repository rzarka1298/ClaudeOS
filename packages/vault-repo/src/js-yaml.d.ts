/**
 * Ambient types for `js-yaml@3`, which ships no bundled declarations.
 *
 * Only the surface the task note reader and writer call is declared: the safe
 * load and dump pair plus the YAML core schema. The core schema is NARROWER
 * than the default safe schema (no timestamp, merge or binary types), which
 * is what keeps an unquoted date such as the one Obsidian's Properties editor
 * writes a plain string. It mirrors the plugin's declaration file; no
 * `@types` package is added.
 */
declare module "js-yaml" {
  /** An opaque schema object; only ever passed back to `safeLoad`. */
  interface Schema {
    readonly __schema: never;
  }
  const yaml: {
    readonly CORE_SCHEMA: Schema;
    safeLoad(input: string, options?: { readonly schema?: Schema }): unknown;
    safeDump(value: unknown, options?: { readonly noRefs?: boolean }): string;
  };
  export default yaml;
}
