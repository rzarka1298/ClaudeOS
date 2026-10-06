// The one module allowed to mint a capability token (APPR-01, D-03, T-06-01).
//
// Element: `approval-minter` (eslint.config.mjs). Import rule: `@ccc/domain`
// only, and nothing outside `packages/service/src/approval/` may import this
// file -- not another service file, not an untrusted module, not a test. The
// single `CapabilityToken` cast of the whole repository will live here; the
// grep backstop (scripts/check-boundaries.sh) carves out exactly this path.
// Later plans add the minting function; this plan adds only the boundary.
export {};
