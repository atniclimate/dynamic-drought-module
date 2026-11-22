// The bundled ENSO snapshot and its reader, shared by tests/enso-observed-state.spec.ts and tests/enso-observed-state-logic.spec.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SNAPSHOT_PATH = join(process.cwd(), 'public', 'data', 'enso-indices.json');

interface SnapshotPoint {
  readonly preliminary?: boolean;
  readonly [key: string]: unknown;
}

export interface SnapshotState {
  readonly conditions: string;
  readonly episode: string;
  readonly direction: string;
  readonly emerging: boolean;
  readonly threshold: number;
  readonly conditionsRule: string;
  readonly episodeRule: string;
}

interface SnapshotSeries {
  readonly sourceUrl: string;
  readonly published: string;
  readonly latest: SnapshotPoint;
  readonly values: SnapshotPoint[];
  readonly block?: string;
  readonly phase?: string;
  readonly state?: SnapshotState;
}

export interface SnapshotFixture {
  readonly retrieved: string;
  readonly roni: SnapshotSeries;
  readonly oni: SnapshotSeries;
  readonly nino34: SnapshotSeries;
  readonly soi: SnapshotSeries;
  readonly probabilities?: unknown;
  readonly sourceQuotes?: readonly { readonly text: string; readonly source: string; readonly url: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSnapshotSeries(value: unknown): value is SnapshotSeries {
  return (
    isRecord(value) &&
    typeof value.sourceUrl === 'string' &&
    typeof value.published === 'string' &&
    isRecord(value.latest) &&
    Array.isArray(value.values) &&
    value.values.every(isRecord)
  );
}

function isSnapshotFixture(value: unknown): value is SnapshotFixture {
  return (
    isRecord(value) &&
    typeof value.retrieved === 'string' &&
    isSnapshotSeries(value.roni) &&
    isSnapshotSeries(value.oni) &&
    isSnapshotSeries(value.nino34) &&
    isSnapshotSeries(value.soi)
  );
}

export function readSnapshot(): SnapshotFixture {
  const parsed: unknown = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  if (!isSnapshotFixture(parsed)) throw new Error('malformed bundled ENSO test fixture');
  return parsed;
}
