/**
 * S30D D1 M23 (the Codex Tier 2 review, PF2 and PF4, "invalid popup variants
 * do not compile"): this file is SUPPOSED to fail typechecking, once on each
 * pinned line below and nowhere else.
 *
 * It is excluded from `tsconfig.tests.json` and checked on its own, under
 * `tsconfig.popup-model-invalid.json`, by
 * `tests/types/check-popup-model-invalid.mjs`, which fails if any pinned line
 * compiles (the popup model silently admitted an invalid variant) or if any
 * OTHER line errors (the valid scaffolding broke, which would make every
 * pinned error meaningless). The runtime half of each rule is
 * tests/popup-frame.test.mjs; a runtime test cannot prove a type rejects.
 *
 * Do not "fix" the pinned lines. Their numbers are pinned in the checker;
 * the two files are edited together.
 */

import type { GroupInput, PopupClock, PopupModel, RecordBlock, ValueRow } from '../../src/ui/popup-frame';

const CLOCKS: readonly [PopupClock] = [{ kind: 'not-stated', label: 'Edition', reason: 'Fixture reason.' }];
const VALUE: readonly [ValueRow] = [{ text: 'Fixture value' }];
const RECORD: RecordBlock = { key: 'k', issuer: 'nifc', identifier: 'id', sizes: [], clocks: CLOCKS, links: [] };
const GROUP: GroupInput = { groupKey: 'g', computedAt: 0, zone: 'UTC', issuers: ['nifc'], records: [RECORD, RECORD] };

// The valid shapes compile (a positive control for the scaffolding above).
export const VALID: readonly PopupModel[] = [
  { kind: 'group', group: GROUP },
  { kind: 'place', title: 'x', issuer: { role: 'boundary-from', name: 'x', productKey: 'aiannh' }, value: VALUE, clocks: CLOCKS, source: { none: 'x' }, representation: { product: 'aiannh', variant: 'otsa', text: 'x' } },
  { kind: 'place', title: 'x', issuer: { role: 'supplied-by-deployment', productKey: 'tribal' }, value: VALUE, clocks: CLOCKS, source: { none: 'x' }, representation: { product: 'tribal', variant: 'deployer', text: 'x' } }
];

// Pinned, line 33: CWFIS M3 is its own layer and never a group issuer (DR-104).
export const M3_ISSUER: GroupInput = { groupKey: 'g', computedAt: 0, zone: 'UTC', issuers: ['m3'], records: [RECORD, RECORD] };
// Pinned, line 35: a group holds two records at least.
export const ONE_RECORD: GroupInput = { groupKey: 'g', computedAt: 0, zone: 'UTC', issuers: ['nifc'], records: [RECORD] };
// Pinned, line 37: the group head is derived; a caller cannot supply one.
export const GROUP_HEAD: PopupModel = { kind: 'group', title: 'Fixture Creek Complex', group: GROUP };
// Pinned, line 39: an AIANNH place without its representation caveat (plan_rules 8).
export const NO_CAVEAT: PopupModel = { kind: 'place', title: 'x', issuer: { role: 'boundary-from', name: 'x', productKey: 'aiannh' }, value: VALUE, clocks: CLOCKS, source: { none: 'x' } };
// Pinned, line 41: the deployer popup links nowhere (plan_rules 7).
export const DEPLOYER_LINK: PopupModel = { kind: 'place', title: 'x', issuer: { role: 'supplied-by-deployment', productKey: 'tribal' }, value: VALUE, clocks: CLOCKS, source: { link: { label: 'x', href: 'https://example.org/' } }, representation: { product: 'tribal', variant: 'deployer', text: 'x' } };
// Pinned, line 43: the per-record source marker belongs to the generated group head only.
export const PER_RECORD_SOURCE: PopupModel = { kind: 'surface', title: 'x', issuer: { role: 'issued-by', name: 'x', productKey: 'usdm' }, value: VALUE, clocks: CLOCKS, source: { perRecord: true } };
// Pinned, line 45: AIANNH's caveat is one of its own three branches, never another product's.
export const WRONG_VARIANT: PopupModel = { kind: 'place', title: 'x', issuer: { role: 'boundary-from', name: 'x', productKey: 'aiannh' }, value: VALUE, clocks: CLOCKS, source: { none: 'x' }, representation: { product: 'aiannh', variant: 'lar', text: 'x' } };
// Pinned, line 47: a deployer source is its no-source reason alone; a link beside it never compiles (plan_rules 7).
export const DEPLOYER_MIXED_SOURCE: PopupModel = { kind: 'place', title: 'x', issuer: { role: 'supplied-by-deployment', productKey: 'tribal' }, value: VALUE, clocks: CLOCKS, source: { none: 'x', link: { label: 'x', href: 'https://example.org/' } }, representation: { product: 'tribal', variant: 'deployer', text: 'x' } };
