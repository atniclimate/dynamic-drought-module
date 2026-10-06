/**
 * Config/file-routing proof (DDM-P15-T08 and ENSO-FLOW-PLAN E2-2).
 * Ordinary scripts exclude both measurement specs; each measurement script
 * selects only its own file. This is the config-object fallback anticipated by
 * the former --list checks, whose repeated spec collection exceeded their 20 s
 * assumption. Import the actual config once; never start a CLI, collect test
 * declarations, launch a browser or start its webServer here.
 *
 * Keep this proof deliberately narrow: literal spec lists, the current default
 * match and test directory, and explicit script arguments. A broader pattern,
 * dependency or filter fails closed until this proof covers its semantics.
 * Actual test registration and execution remain the browser lanes' job.
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import config from '../playwright.config.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const THREE_PROJECTS = ['chromium', 'chromium-interaction', 'chromium-3d'];
const MEASURE_SCRIPTS = [
  ['measure:mode-switch', 'tests/mode-switch-cost.spec.ts'],
  ['measure:flow', 'tests/flow-measure.spec.ts']
];
const MEASURE_FILES = MEASURE_SCRIPTS.map(([, spec]) => spec.slice('tests/'.length));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function scriptArgs(script, label) {
  assert.equal(typeof script, 'string', `${label} script is missing`);
  const words = script.trim().split(/\s+/);
  assert.deepEqual(words.splice(0, 2), ['playwright', 'test'], `${label}: direct default-config invocation`);
  // Fail closed on shell syntax, alternate config, grep, shard, positional
  // patterns or any other argument this file-routing proof does not cover.
  for (const word of words) {
    assert.match(word, /^(?:--project=[a-z0-9-]+|--workers=1|--reporter=list|tests\/[a-z0-9-]+\.spec\.ts)$/, `${label}: unsupported argument ${word}`);
  }
  return {
    projects: words.filter((word) => word.startsWith('--project=')).map((word) => word.slice('--project='.length)),
    files: words.filter((word) => word.startsWith('tests/')),
    words
  };
}

function proveScripts(scripts) {
  for (const name of ['test', 'test:serial']) {
    const args = scriptArgs(scripts[name], name);
    assert.deepEqual(args.projects, THREE_PROJECTS, `${name}: exactly the three CI projects, in order`);
    assert.deepEqual(args.files, [], `${name}: no narrowed ordinary file selection`);
  }
  for (const [name, spec] of MEASURE_SCRIPTS) {
    const args = scriptArgs(scripts[name], name);
    assert.deepEqual(args.projects, ['chromium-measure'], `${name}: only chromium-measure`);
    assert.deepEqual(args.files, [spec], `${name}: only its own spec`);
  }
  assert.ok(scriptArgs(scripts['measure:flow'], 'measure:flow').words.includes('--workers=1'), 'measure:flow runs one worker');
}

function literalFiles(patterns, label) {
  assert.ok(Array.isArray(patterns) && patterns.length > 0, `${label}: nonempty literal spec list`);
  return patterns.map((pattern) => {
    assert.equal(typeof pattern, 'string', `${label}: string pattern`);
    const match = /^\*\*\/([a-z0-9-]+\.spec\.ts)$/.exec(pattern);
    assert.ok(match, `${label}: unsupported nonliteral pattern ${pattern}`);
    return match[1];
  });
}

function proveConfig(candidate) {
  assert.equal(resolve(ROOT, candidate.testDir ?? ''), resolve(ROOT, 'tests'), 'root testDir stays tests');
  assert.equal(candidate.testMatch, undefined, 'root retains the default .spec.ts match');
  assert.equal(candidate.testIgnore, undefined, 'root has no unexamined ignore');
  for (const owner of [candidate, ...candidate.projects]) {
    for (const key of ['grep', 'grepInvert', 'dependencies', 'teardown']) {
      assert.equal(owner[key], undefined, `${owner.name ?? 'root'}: no unexamined ${key}`);
    }
    assert.notEqual(owner.respectGitIgnore, true, 'explicit testDir is not narrowed by gitignore');
  }
  assert.deepEqual(candidate.projects.map((project) => project.name), [...THREE_PROJECTS, 'chromium-measure'], 'exact named projects');
  for (const project of candidate.projects) {
    assert.equal(resolve(ROOT, project.testDir ?? candidate.testDir), resolve(ROOT, 'tests'), `${project.name}: shared testDir`);
    if (project.name === 'chromium') {
      assert.equal(project.testMatch, undefined, 'chromium retains its default .spec.ts match');
      assert.ok(Array.isArray(project.testIgnore), 'chromium uses an explicit ignore list');
      for (const file of MEASURE_FILES) {
        assert.ok(project.testIgnore.includes(`**/${file}`), `chromium explicitly ignores ${file}`);
      }
    } else {
      const files = literalFiles(project.testMatch, project.name);
      if (project.name === 'chromium-measure') {
        assert.deepEqual([...files].sort(), [...MEASURE_FILES].sort(), 'measurement project matches exactly both measurement files');
        // This is the only broad ignore admitted by this narrow proof. It
        // cannot match either .spec.ts file. Other ignores must be literal.
        for (const ignore of project.testIgnore ?? []) {
          if (ignore === '**/*.test.mjs') continue;
          const [file] = literalFiles([ignore], 'measurement ignore');
          assert.ok(!MEASURE_FILES.includes(file), `measurement file is ignored: ${file}`);
        }
      } else {
        assert.ok(files.every((file) => !MEASURE_FILES.includes(file)), `${project.name}: measurement files excluded`);
      }
    }
  }
}

test('ordinary and measurement scripts retain exact projects and file selections', () => {
  proveScripts(pkg.scripts);
});

test('actual config isolates both measurement files from all ordinary projects', () => {
  proveConfig(config);
  for (const [, spec] of MEASURE_SCRIPTS) {
    assert.ok(statSync(join(ROOT, spec)).isFile(), `${spec} exists as a real spec file`);
  }
});

function changedProject(name, change) {
  return {
    ...config,
    projects: config.projects.map((project) => project.name === name ? { ...project, ...change(project) } : project)
  };
}

for (const file of MEASURE_FILES) {
  test(`mutation control: losing the ordinary ignore for ${file} is rejected`, () => {
    const changed = changedProject('chromium', (project) => ({ testIgnore: project.testIgnore.filter((pattern) => pattern !== `**/${file}`) }));
    assert.throws(() => proveConfig(changed), /chromium explicitly ignores/);
  });
}

for (const [name, match] of [
  ['broadened', ['**/*.spec.ts']],
  ['empty', []],
  ['incomplete', ['**/mode-switch-cost.spec.ts']],
  ['extra ordinary file', ['**/mode-switch-cost.spec.ts', '**/flow-measure.spec.ts', '**/popup-viewport.spec.ts']]
]) {
  test(`mutation control: ${name} measurement match is rejected`, () => {
    assert.throws(() => proveConfig(changedProject('chromium-measure', () => ({ testMatch: match }))), /literal|exactly both/);
  });
}

for (const ignore of ['**/flow-measure.spec.ts', '**/*.spec.ts', /measure/]) {
  test(`mutation control: excluding a measurement through ${ignore} is rejected`, () => {
    assert.throws(() => proveConfig(changedProject('chromium-measure', () => ({ testIgnore: [ignore] }))), /ignored|nonliteral|string pattern/);
  });
}

for (const name of ['chromium-interaction', 'chromium-3d']) {
  test(`mutation control: ${name} cannot broaden or include a measurement`, () => {
    for (const testMatch of [['**/*.spec.ts'], ['**/flow-measure.spec.ts']]) {
      assert.throws(() => proveConfig(changedProject(name, () => ({ testMatch }))), /nonliteral|measurement files excluded/);
    }
  });
}

test('mutation control: config directory, defaults, dependencies and project drift fail closed', () => {
  for (const change of [
    { testDir: './other-tests' },
    { testMatch: '**/nothing.spec.ts' },
    { testIgnore: '**/*.spec.ts' },
    { grep: /nothing/ },
    { projects: config.projects.slice(1) }
  ]) assert.throws(() => proveConfig({ ...config, ...change }));
  for (const change of [
    { testDir: './other-tests' },
    { testIgnore: '**/mode-switch-cost.spec.ts **/flow-measure.spec.ts' },
    { dependencies: ['chromium-measure'] },
    { teardown: 'chromium-measure' },
    { grepInvert: /.*/ },
    { respectGitIgnore: true }
  ]) assert.throws(() => proveConfig(changedProject('chromium', () => change)));
});

test('mutation control: script project, spec, config and extra-filter drift fail closed', () => {
  for (const [name, script] of [
    ['test', 'playwright test'],
    ['test', `${pkg.scripts.test} --project=chromium-measure`],
    ['test', `${pkg.scripts.test} tests/popup-viewport.spec.ts`],
    ['test', `${pkg.scripts.test} --config=other.ts`],
    ['test', `${pkg.scripts.test} --grep=nothing`],
    ['test', `${pkg.scripts.test} && playwright test`],
    ['measure:flow', 'playwright test --project=chromium-measure --workers=1'],
    ['measure:flow', `${pkg.scripts['measure:flow']} tests/mode-switch-cost.spec.ts`],
    ['measure:flow', pkg.scripts['measure:flow'].replace('--workers=1', '')]
  ]) assert.throws(() => proveScripts({ ...pkg.scripts, [name]: script }), `${name}: ${script}`);
});
