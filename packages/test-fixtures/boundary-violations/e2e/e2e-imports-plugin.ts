// Deliberate boundary violation: this folder is classified as the `e2e` element by eslint.config.mjs, which may import only domain, service-api-client, keychain and test-fixtures, so importing the plugin must fail boundaries/dependencies. Proven to fire by boundary-lint.test.ts.
export { connectionState } from "@ccc/plugin";
