# Resource catalogs

These JSON files feed the "who can help" section of the impact briefing:
verified public drought resources, routed by the place a user selects and
ordered by stewardship (the deploying Tribe's own resources first, then
federal, then state).

## Files

- `federal.json`: federal programs, shown for every place.
- `<state postal code>.json` (for example `wa.json`): that state's
  resources, shown when a selection resolves to the state.

## Shape

Each file is one JSON object:

```json
{
  "label": "Washington",
  "verified": "2026-07-09",
  "resources": [
    {
      "label": "Statewide water-supply conditions",
      "url": "https://ecology.wa.gov/...",
      "agency": "Washington State Department of Ecology",
      "tier": "state",
      "description": "One line on what the resource offers."
    }
  ]
}
```

Rules the application enforces at load time:

- `verified` is a real ISO calendar date (YYYY-MM-DD) recording when a
  person last confirmed every link in the file is live and correct. It
  lives at the file level, not per row.
- Every `url` must be `https://`; rows without a usable URL render as
  plain attributed text, never as a broken link.
- `label`, `agency`, and `tier` are required per row; `description` is
  optional.
- A file's rows are locked to the file's tier: a state file may carry only
  `"tier": "state"` rows and `federal.json` only `"tier": "federal"` rows.
  A row that claims another tier is rejected. (The `tribal` tier is
  reserved for the deploying Nation's own resources, configured by the
  deployer; it never ships in this repository.)

## Wording convention

Resource rows link programs with program-page framing only: what the
program is and who runs it. Rows must never assert or imply that a place
or entity is ELIGIBLE for a program; eligibility is determined by the
administering agency.

## Adding your own

Deployers may edit these files on their own copy: keep the shape above,
re-verify every link you touch, and update the `verified` date. Changes
are validated by `npm run check:resources` (also part of `npm run gate`).
