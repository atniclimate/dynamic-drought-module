import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { test, expect } from '@playwright/test';

import {
  isLandscapeBundle,
  isTerrainSignature,
  isTerrainSource,
  isUnavailableSignature,
  loadLandscapeSignature,
  type LandscapeSignatureResult
} from '../src/impact/landscape';
import type { fetchJsonWithBudget } from '../src/util/fetch';

/**
 * T-M0-3 (L1c): the landscape-signature loader stub. Pure Node in the
 * s1-substrate pattern (no browser): every case injects `url` plus a stub
 * `fetchJsonImpl`, so the lazy default Uniform Resource Locator (URL)
 * branch (a dynamic import of
 * config/urls, which only evaluates under the Vite bundle) is never taken
 * here. That branch is exercised by the first real consumer's rendered
 * verification (T-S1/M-DEMO); until then it is a documented, untested-in-
 * Node seam, stated in the module header.
 *
 * The failure contract under test is the MACHINE-READABLE reason code,
 * not prose: absence/timeout -> 'unavailable', cancel -> 'aborted',
 * parse -> 'malformed-json', shape -> 'invalid-shape', version ->
 * 'unsupported-version'. Body-stall and abort-through-body semantics of
 * the real transport (fetchJsonWithBudget) are pinned in fetch.spec.ts;
 * here the stubs assert the LOADER's mapping and its final
 * superseded-response check. (HTTP = Hypertext Transfer Protocol;
 * JSON = JavaScript Object Notation.)
 */

type FetchJsonImpl = typeof fetchJsonWithBudget;

const URL_UNDER_TEST = 'https://example.invalid/data/landscape.json';

function validArtifact(): Record<string, unknown> {
  return {
    schemaVersion: '1.3.0',
    retrieved: '2026-01-01',
    analysisCrs: 'EPSG:5070',
    gridResolutionMeters: 30,
    aggregationUnit:
      'EPA Omernik ecoregion (unsimplified Region 10 Albers source)',
    sources: {
      terrain: {
        source: 'USGS 3D Elevation Program (3DEP) seamless DEM',
        sourceUrl: 'https://www.usgs.gov/3d-elevation-program',
        vintage: 'continuously updated (seamless VRT)',
        resolutionMeters: 10,
        method: 'test method',
        methodVersion: 2,
        acquired: '2026-01-01',
        materializedRasterSha256: 'a'.repeat(64)
      }
    },
    bundles: {
      '1': {
        level: 3,
        usL3Code: '1',
        usL3Name: 'Test Flats',
        terrain: {
          elevMeanM: 591.6,
          elevMinM: 580.8,
          elevMaxM: 599.5,
          slopeMeanDeg: 5.44,
          aspectMeanDeg: 196.5,
          aspectCardinal: 'S',
          coveragePct: 49.5
        }
      }
    }
  };
}

function stubResolving(payload: unknown): FetchJsonImpl {
  return async () => payload;
}

function stubThrowing(err: unknown): FetchJsonImpl {
  return async () => {
    throw err;
  };
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function expectFailure(
  result: LandscapeSignatureResult,
  reason: string
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
    expect(result.note.length).toBeGreaterThan(0);
  }
}

test.describe('loadLandscapeSignature', () => {
  test('returns the snapshot for a valid artifact', async () => {
    const result = await loadLandscapeSignature({
      url: URL_UNDER_TEST,
      fetchJsonImpl: stubResolving(validArtifact())
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.schemaVersion).toBe('1.3.0');
      expect(result.snapshot.retrieved).toBe('2026-01-01');
      expect(Object.keys(result.snapshot.bundles)).toEqual(['1']);
    }
  });

  test('minor-tolerant inside the reviewed line only: 1.3.9 passes', async () => {
    const artifact = validArtifact();
    artifact.schemaVersion = '1.3.9';
    const result = await loadLandscapeSignature({
      url: URL_UNDER_TEST,
      fetchJsonImpl: stubResolving(artifact)
    });
    expect(result.ok).toBe(true);
  });

  // 1.2.0 is the RETIRED line (extended to 1.3.x on 2026-07-27 for the
  // T-S1-4 schema); it must now fail exactly as any other foreign version
  // does. The schema file pins schemaVersion as a const of 1.3.0 and the
  // artifact validator's own self-test asserts 1.2.0 fails, so retaining it
  // here would contradict the normative shape.
  for (const version of ['1.2.0', '2.0.0', '1.1.0']) {
    test(`schemaVersion ${version} is unsupported (known-minor policy)`, async () => {
      const artifact = validArtifact();
      artifact.schemaVersion = version;
      const result = await loadLandscapeSignature({
        url: URL_UNDER_TEST,
        fetchJsonImpl: stubResolving(artifact)
      });
      expectFailure(result, 'unsupported-version');
      if (!result.ok) expect(result.note).toContain(version);
    });
  }

  test('an HTTP error is honest absence, not a throw', async () => {
    const result = await loadLandscapeSignature({
      url: URL_UNDER_TEST,
      fetchJsonImpl: stubThrowing(new Error('HTTP 404 Not Found'))
    });
    expectFailure(result, 'unavailable');
  });

  test('a network failure is honest absence', async () => {
    const result = await loadLandscapeSignature({
      url: URL_UNDER_TEST,
      fetchJsonImpl: stubThrowing(new TypeError('fetch failed'))
    });
    expectFailure(result, 'unavailable');
  });

  test('a timeout (AbortError WITHOUT a master-signal abort) maps to unavailable', async () => {
    // fetchJsonWithBudget throws AbortError for both the per-call timeout
    // and a master cancel; the loader distinguishes them by whether the
    // caller's signal is aborted. No signal aborted here = timeout.
    const result = await loadLandscapeSignature({
      url: URL_UNDER_TEST,
      fetchJsonImpl: stubThrowing(abortError())
    });
    expectFailure(result, 'unavailable');
  });

  test('a master-signal cancel maps to aborted', async () => {
    const controller = new AbortController();
    const result = await loadLandscapeSignature({
      url: URL_UNDER_TEST,
      signal: controller.signal,
      fetchJsonImpl: async () => {
        controller.abort();
        throw abortError();
      }
    });
    expectFailure(result, 'aborted');
  });

  for (const [label, thrown] of [
    ['SyntaxError', new SyntaxError('Unexpected end of JSON input')],
    ['TypeError', new TypeError('network stream torn')]
  ] as const) {
    test(`master abort wins over a ${label} rejection (superseded outcomes are dropped)`, async () => {
      // G4: whatever the transport threw, an aborted operation must be
      // reported 'aborted', never reclassified as a parse or
      // availability statement.
      const controller = new AbortController();
      const result = await loadLandscapeSignature({
        url: URL_UNDER_TEST,
        signal: controller.signal,
        fetchJsonImpl: async () => {
          controller.abort();
          throw thrown;
        }
      });
      expectFailure(result, 'aborted');
    });
  }

  test('a response that completes after supersession is dropped, not returned', async () => {
    // The transport resolves successfully, but the master signal aborted
    // while the body was in flight: the loader's final aborted check must
    // report 'aborted' rather than handing a superseded snapshot to the
    // caller (CLAUDE.md section 6 rule 5).
    const controller = new AbortController();
    const result = await loadLandscapeSignature({
      url: URL_UNDER_TEST,
      signal: controller.signal,
      fetchJsonImpl: async () => {
        controller.abort();
        return validArtifact();
      }
    });
    expectFailure(result, 'aborted');
  });

  test('unparseable JSON maps to malformed-json', async () => {
    const result = await loadLandscapeSignature({
      url: URL_UNDER_TEST,
      fetchJsonImpl: stubThrowing(
        new SyntaxError('Unexpected token < in JSON')
      )
    });
    expectFailure(result, 'malformed-json');
  });

  for (const [label, mutate] of [
    ['a non-object payload', () => 'nope'],
    ['an array payload', () => [validArtifact()]],
    [
      'an array sources container',
      () => {
        const a = validArtifact();
        a.sources = [];
        return a;
      }
    ],
    [
      'an array bundles container',
      () => {
        const a = validArtifact();
        a.bundles = [];
        return a;
      }
    ],
    [
      'a missing bundles object',
      () => {
        const a = validArtifact();
        delete a.bundles;
        return a;
      }
    ],
    [
      'a non-string schemaVersion',
      () => {
        const a = validArtifact();
        a.schemaVersion = 12;
        return a;
      }
    ]
  ] as const) {
    test(`${label} maps to invalid-shape`, async () => {
      const result = await loadLandscapeSignature({
        url: URL_UNDER_TEST,
        fetchJsonImpl: stubResolving(mutate())
      });
      expectFailure(result, 'invalid-shape');
    });
  }
});

test.describe('landscape type guards', () => {
  test('isTerrainSignature accepts stats and enforces the aspect pair', () => {
    const artifact = validArtifact();
    const bundles = artifact.bundles as Record<
      string,
      Record<string, unknown>
    >;
    const stats = bundles['1'].terrain as Record<string, unknown>;
    expect(isTerrainSignature(stats)).toBe(true);
    expect(
      isTerrainSignature({ ...stats, aspectMeanDeg: null, aspectCardinal: null })
    ).toBe(true);
    expect(isTerrainSignature({ ...stats, slopeMeanDeg: null })).toBe(true);
    // One-sided aspect null is the F6 dishonest state: rejected.
    expect(isTerrainSignature({ ...stats, aspectMeanDeg: null })).toBe(false);
    expect(isTerrainSignature({ ...stats, elevMeanM: null })).toBe(false);
    expect(isTerrainSignature({ unavailable: true, reason: 'x' })).toBe(false);
  });

  test('isUnavailableSignature accepts only the explicit variant', () => {
    expect(isUnavailableSignature({ unavailable: true, reason: 'empty' })).toBe(
      true
    );
    expect(isUnavailableSignature({ unavailable: false, reason: 'x' })).toBe(
      false
    );
    expect(isUnavailableSignature({ unavailable: true })).toBe(false);
  });

  test('isTerrainSource checks the 1.3.0 provenance fields', () => {
    const artifact = validArtifact();
    const sources = artifact.sources as Record<string, unknown>;
    expect(isTerrainSource(sources.terrain)).toBe(true);
    const nullProvenance = {
      ...(sources.terrain as Record<string, unknown>),
      acquired: null,
      materializedRasterSha256: null
    };
    expect(isTerrainSource(nullProvenance)).toBe(true);
    const missingMethodVersion = {
      ...(sources.terrain as Record<string, unknown>)
    };
    delete missingMethodVersion.methodVersion;
    expect(isTerrainSource(missingMethodVersion)).toBe(false);
  });

  test('isLandscapeBundle narrows both terrain variants', () => {
    const artifact = validArtifact();
    const bundles = artifact.bundles as Record<string, unknown>;
    expect(isLandscapeBundle(bundles['1'])).toBe(true);
    const unavailable = {
      ...(bundles['1'] as Record<string, unknown>),
      terrain: { unavailable: true, reason: 'empty geometry' }
    };
    expect(isLandscapeBundle(unavailable)).toBe(true);
    const missingTerrain = { ...(bundles['1'] as Record<string, unknown>) };
    delete missingTerrain.terrain;
    expect(isLandscapeBundle(missingTerrain)).toBe(false);
  });

  test('isLandscapeBundle checks every promised property per level (G3)', () => {
    const artifact = validArtifact();
    const bundles = artifact.bundles as Record<string, unknown>;
    const l3 = bundles['1'] as Record<string, unknown>;
    // Arrays are not bundles.
    expect(isLandscapeBundle([l3])).toBe(false);
    // A Level III bundle carrying Level IV fields is rejected (the
    // schema's level-local closed shapes).
    expect(isLandscapeBundle({ ...l3, usL4Code: '1a' })).toBe(false);
    // A Level IV bundle with a malformed optional-turned-required field
    // is rejected; the type promises strings.
    const l4 = {
      ...l3,
      level: 4,
      usL4Code: '1a',
      usL4Name: 'Sub',
      parent: '1'
    };
    expect(isLandscapeBundle(l4)).toBe(true);
    expect(isLandscapeBundle({ ...l4, usL4Code: 7 })).toBe(false);
    expect(isLandscapeBundle({ ...l4, parent: undefined })).toBe(false);
    // A level outside {3, 4} is rejected.
    expect(isLandscapeBundle({ ...l3, level: 5 })).toBe(false);
  });
});

test.describe('validate-landscape-artifact.mjs command-line contract', () => {
  // G5: the two modes are mutually exclusive and fail CLOSED; a
  // --self-test flag must never silently bypass an artifact validation.
  // Pinned by spawning the real script (the parser is not importable
  // without executing main).
  const execFileAsync = promisify(execFile);
  const script = fileURLToPath(
    new URL('../scripts/validate-landscape-artifact.mjs', import.meta.url)
  );
  const fixture = fileURLToPath(
    new URL(
      '../scripts/landscape/tests/fixtures/corrected/snapshot_terrain_l3.json',
      import.meta.url
    )
  );

  async function runValidator(
    args: string[]
  ): Promise<{ code: number; output: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [script, ...args],
        { timeout: 60_000 }
      );
      return { code: 0, output: stdout + stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof e.code === 'number' ? e.code : -1,
        output: (e.stdout ?? '') + (e.stderr ?? '')
      };
    }
  }

  test('--self-test alone exits 0', async () => {
    const { code, output } = await runValidator(['--self-test']);
    expect(code).toBe(0);
    expect(output).toContain('self-test OK');
  });

  test('a valid artifact path alone exits 0', async () => {
    const { code } = await runValidator([fixture]);
    expect(code).toBe(0);
  });

  test('--self-test plus a path is a usage error (exit 2), not a bypass', async () => {
    const { code, output } = await runValidator(['--self-test', fixture]);
    expect(code).toBe(2);
    expect(output).toContain('usage');
  });

  test('zero arguments and extra arguments are usage errors (exit 2)', async () => {
    expect((await runValidator([])).code).toBe(2);
    expect((await runValidator([fixture, fixture])).code).toBe(2);
  });

  test('a missing artifact file exits 2 with a self-explaining message', async () => {
    const { code, output } = await runValidator(['no-such-artifact.json']);
    expect(code).toBe(2);
    expect(output).toContain('cannot read or parse');
  });
});
