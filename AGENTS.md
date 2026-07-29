# AGENTS.md

These project rules supplement the machine-wide operating contract.

## Purpose

The Dynamic Drought Module (DDM) is an embeddable static web map built by
ATNI Climate for Tribal Nations, state agencies, federal partners, and
researchers. Keep changes small, visible to users, and directly connected
to the requested task.

## Stewardship and product invariants

1. Do not redistribute Tribal, Treaty, or other sovereign-jurisdiction
   polygons. Deployer-owned files remain empty placeholders unless the
   relevant sovereign authority explicitly authorizes data for this copy.
2. Describe agency Treaty polygons as representations, not jurisdictional
   truth. Preserve the existing sovereignty caveats.
3. Do not add proprietary tile providers, authentication, tracking,
   analytics, or telemetry collection.
4. Keep the application static. The optional Cloudflare Worker may only
   act as an allowlisted, body-transparent Cross-Origin Resource Sharing
   shim.
5. Preserve `?embed=true`, URL-as-state behavior, sidebar controls, and
   iframe operation.
6. Preserve the six honest layer states: `loading`, `live`,
   `live (partial)`, `unavailable`, `no data`, and `zoom in to load`.
7. Non-trivial network work must be cancellable and time-bounded.
8. Capitalize Tribe, Tribal, and Treaty when referring to Tribal Nations
   or Treaty rights. Do not abbreviate the formal name of a Tribal Nation.
9. Do not author the U+2014 em dash. Verbatim upstream data is exempt.

## Engineering conventions

- Use strict TypeScript. Prefer named exports and preserve existing module
  contracts.
- Use CSS custom properties for visual tokens and preserve established
  responsive behavior.
- Treat `src/config/layers.ts` and the runtime code as the authority when
  old prose disagrees.
- Do not add process ledgers, phase harnesses, review queues, or parallel
  version clocks. Use issues and ordinary Git history for durable work.
- Do not publish, deploy, or change external services unless the task asks.

## Verification

- Run the narrowest relevant check while developing.
- Run `npm run gate` for cross-cutting application changes.
- Run targeted Playwright specs, then `npm run test:serial` when the change
  affects shared navigation, map lifecycle, state, or release readiness.
- Report exactly what ran and any verification that was skipped.
