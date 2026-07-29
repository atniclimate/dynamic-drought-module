/**
 * Coverage-matrix doc generator + gate drift check (0.8.0 T-P0-3).
 *
 * The ONE source of truth is src/config/capability-matrix.ts; this script
 * renders it to docs/COVERAGE_MATRIX.md (a GENERATED file, never hand
 * edited). Two modes:
 *
 *   node scripts/generate-coverage-matrix.mjs          # (re)write the doc
 *   node scripts/generate-coverage-matrix.mjs --check  # fail on drift
 *
 * The --check mode runs in `npm run gate` (as check:coverage): it renders
 * in memory, compares against the committed doc (line endings normalized;
 * core.autocrlf is on in this repo), and exits 1 when the doc is missing or
 * stale, so a matrix edit can never ship without its doc.
 *
 * Both modes also enforce the T-P0-3 consistency rules on the data itself,
 * so the gate catches an inconsistent matrix without waiting for the
 * Playwright spec:
 *   1. impactSynthesis never exceeds droughtState for any family (the
 *      briefing cannot claim more than the drought data supports);
 *   2. no axis is 'full' for a family whose display is 'none' (nothing is
 *      fully supported where the map does not even render).
 *
 * Import note: this script imports the TypeScript module directly via
 * Node's native type stripping (stable since Node 22.18 / 23.6; this repo
 * develops on Node 24). The deploy workflow never runs this script; if you
 * see an ERR_UNKNOWN_FILE_EXTENSION or syntax error here, upgrade Node
 * rather than duplicating the table.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DOC_PATH = fileURLToPath(
  new URL('../docs/COVERAGE_MATRIX.md', import.meta.url)
);

// Pre-flight BEFORE the .ts import: on an older Node the raw
// ERR_UNKNOWN_FILE_EXTENSION stack does not explain itself.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 18)) {
  console.error(
    `coverage-matrix: this script imports TypeScript via Node's native type stripping and needs Node >= 22.18; found ${process.versions.node}. Upgrade Node (the repo develops on 24; CI runs 22.x); do not duplicate the table into JavaScript.`
  );
  process.exit(1);
}

const {
  CAPABILITY_AXIS_KEYS,
  CAPABILITY_AXIS_LABELS,
  CAPABILITY_LEVEL_RANK,
  CAPABILITY_MATRIX,
  COVERAGE_FAMILY_KEYS,
  COVERAGE_FAMILY_LABELS
} = await import('../src/config/capability-matrix.ts');
const {
  CANONICAL_GEOGRAPHY_KEYS,
  CANONICAL_GEOGRAPHY_LABELS
} = await import('../src/config/geography.ts');
const {
  NATIONAL_HEAT_SOURCE_CAPABILITY
} = await import('../src/config/source-capability.ts');

/** The consistency rules; returns a list of violation messages. */
function consistencyProblems() {
  const problems = [];
  for (const family of COVERAGE_FAMILY_KEYS) {
    const row = CAPABILITY_MATRIX[family];
    const rank = (axis) => CAPABILITY_LEVEL_RANK[row[axis].level];
    if (rank('impactSynthesis') > rank('droughtState')) {
      problems.push(
        `${family}: impactSynthesis '${row.impactSynthesis.level}' exceeds droughtState '${row.droughtState.level}'`
      );
    }
    if (row.display.level === 'none') {
      for (const axis of CAPABILITY_AXIS_KEYS) {
        if (row[axis].level === 'full') {
          problems.push(`${family}: ${axis} is 'full' while display is 'none'`);
        }
      }
    }
    for (const axis of CAPABILITY_AXIS_KEYS) {
      const note = row[axis].note;
      if (!note.trim() || /[\r\n]/.test(note)) {
        problems.push(`${family}.${axis}: note must be one non-empty line`);
      }
    }
  }
  return problems;
}

/** Deterministic render of the whole doc (LF endings, trailing newline). */
function renderDoc() {
  const lines = [];
  lines.push('# Coverage and capability matrix');
  lines.push('');
  lines.push(
    '<!-- GENERATED FILE. Do not edit by hand: edit src/config/capability-matrix.ts'
  );
  lines.push(
    '     and run `npm run build:coverage-matrix`. `npm run gate` fails on drift. -->'
  );
  lines.push('');
  lines.push(
    'What the Dynamic Drought Module (DDM) actually does today for each coverage'
  );
  lines.push(
    'family, as recorded in `src/config/capability-matrix.ts` (the source of'
  );
  lines.push(
    'truth; this file is generated from it). Levels: **full** (shipped and'
  );
  lines.push(
    'verified), **partial** (shipped with the named limitation), **none** (not'
  );
  lines.push('supported; the note says why).');
  lines.push('');

  const header = ['Family', ...CAPABILITY_AXIS_KEYS.map((a) => CAPABILITY_AXIS_LABELS[a])];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`|${header.map(() => ' --- ').join('|')}|`);
  for (const family of COVERAGE_FAMILY_KEYS) {
    const row = CAPABILITY_MATRIX[family];
    const cells = CAPABILITY_AXIS_KEYS.map((axis) => row[axis].level);
    lines.push(`| ${COVERAGE_FAMILY_LABELS[family]} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Notes');
  for (const family of COVERAGE_FAMILY_KEYS) {
    lines.push('');
    lines.push(`### ${COVERAGE_FAMILY_LABELS[family]}`);
    lines.push('');
    const row = CAPABILITY_MATRIX[family];
    for (const axis of CAPABILITY_AXIS_KEYS) {
      const cell = row[axis];
      lines.push(
        `- **${CAPABILITY_AXIS_LABELS[axis]}** (${cell.level}): ${cell.note}`
      );
    }
  }
  lines.push('');
  lines.push('## Independent heat-source capability');
  lines.push('');
  lines.push(
    'Point heat and heat-related issuer products use canonical selected-place'
  );
  lines.push(
    'geography and independent source policy. They do not promote the broader'
  );
  lines.push(
    '`impactSynthesis` cell or activate unrelated drought, fire, climate, or'
  );
  lines.push('water sources.');
  lines.push('');
  const heatHeader = [
    'Canonical geography',
    'Point observation and grid',
    'Point forecast',
    'Active alerts',
    'HeatRisk'
  ];
  lines.push(`| ${heatHeader.join(' | ')} |`);
  lines.push(`|${heatHeader.map(() => ' --- ').join('|')}|`);
  for (const geography of CANONICAL_GEOGRAPHY_KEYS) {
    const row = NATIONAL_HEAT_SOURCE_CAPABILITY[geography];
    lines.push(
      `| ${CANONICAL_GEOGRAPHY_LABELS[geography]} | ` +
        `${row.pointHeat.state} | ${row.nwsForecast.state} | ` +
        `${row.nwsAlerts.state} | ${row.heatRisk.state} |`
    );
  }
  lines.push('');
  lines.push('### Heat-source qualifications');
  for (const geography of CANONICAL_GEOGRAPHY_KEYS) {
    const row = NATIONAL_HEAT_SOURCE_CAPABILITY[geography];
    lines.push('');
    lines.push(`#### ${CANONICAL_GEOGRAPHY_LABELS[geography]}`);
    lines.push('');
    for (const [key, label] of [
      ['pointHeat', 'Point observation and grid'],
      ['nwsForecast', 'Point forecast'],
      ['nwsAlerts', 'Active alerts'],
      ['heatRisk', 'HeatRisk']
    ]) {
      const cell = row[key];
      lines.push(`- **${label}** (${cell.state}): ${cell.note}`);
    }
  }
  lines.push('');
  lines.push('## Fire follow-on');
  lines.push('');
  lines.push(
    'The fire module should receive the same architectural expansion: canonical'
  );
  lines.push(
    'geography, independent per-source capability, time-aware source contracts,'
  );
  lines.push(
    'cross-source synthesis that preserves issuer support, and bounded'
  );
  lines.push(
    'cancellable caching. This record does not activate or broaden a fire source;'
  );
  lines.push('that work requires its own implementation and verification.');
  lines.push('');
  return lines.join('\n');
}

const problems = consistencyProblems();
if (problems.length > 0) {
  console.error('capability-matrix consistency FAILED:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const rendered = renderDoc();
const checkMode = process.argv.includes('--check');

if (checkMode) {
  let existing = null;
  try {
    existing = await readFile(DOC_PATH, 'utf8');
  } catch {
    console.error(
      'coverage-matrix check FAILED: docs/COVERAGE_MATRIX.md is missing; run `npm run build:coverage-matrix`.'
    );
    process.exit(1);
  }
  if (existing.replace(/\r\n?/g, '\n') !== rendered) {
    console.error(
      'coverage-matrix check FAILED: docs/COVERAGE_MATRIX.md is stale; run `npm run build:coverage-matrix` and commit the result.'
    );
    process.exit(1);
  }
  console.log('coverage-matrix check: clean (doc matches the source module)');
} else {
  await writeFile(DOC_PATH, rendered, 'utf8');
  console.log('coverage-matrix: wrote docs/COVERAGE_MATRIX.md');
}
