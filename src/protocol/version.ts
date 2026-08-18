/**
 * The module owns its copy of the protocol constants rather than importing a
 * shared package. That is deliberate (design doc, "Protocol v1"): a package
 * shared between a Rails app and a Foundry module is a release-coupling device,
 * and the versioned envelope plus ignore-unknown already does the job.
 */

/** Envelope `v`. Bump only for a breaking envelope change, never for new types. */
export const PROTOCOL_VERSION = 1;

/** Foundry module id. Also the settings namespace and the loop-guard flag scope. */
export const MODULE_ID = "masteroftales-bridge";

/**
 * Fallback module version. The real value comes from `game.modules` at runtime
 * (see `moduleVersion()`); this constant only covers the case where the module
 * somehow isn't in the registry, and it is kept in step with module.json and
 * package.json by the release workflow.
 */
export const MODULE_VERSION = "0.2.1";

/** Prefix on every idempotency key this module mints. */
export const KEY_PREFIX = "fvtt";
