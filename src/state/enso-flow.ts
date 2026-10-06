import { HAZARD_CLUSTERS, type HazardClusterDef } from '../config/clusters';
import { normalizeSidebarParam } from './url';

/** Additive ENSO context preferences, independent of the SST date rail. */
export type EnsoFlowKind = 'off' | 'currents' | 'wind' | 'waves';
export type EnsoFlowInk = 'light' | 'dark';

export interface EnsoFlowPreference {
  readonly kind: EnsoFlowKind;
  readonly ink: EnsoFlowInk;
}

/**
 * The flow kind a display opens with when its link names no `flow=`: the
 * mode's own `flowDefault` (src/config/clusters.ts; DR-111, precedence.md
 * 2.4), read from the cluster definition and never from a mode literal
 * (DR-113). `layers=` outranks `cluster=` (url.ts `parseShellParams`), and a
 * granular display is no mode, so it has no default. No `cluster=` is the
 * cluster whose URL truth is absence (a null `urlToken`); an unknown token
 * names no cluster and has no default. `clusters` is a parameter only so a
 * test can supply a table.
 */
export function ensoFlowModeDefault(
  params: URLSearchParams,
  clusters: Readonly<Record<string, HazardClusterDef>> = HAZARD_CLUSTERS
): EnsoFlowKind {
  return (
    Object.values(clusters).find((def) => !params.has('layers') && def.urlToken === params.get('cluster'))
      ?.flowDefault ?? 'off'
  );
}

/**
 * No `flow=` opens the mode default; one known kind, `off` included, is that
 * kind; a duplicate or unknown `flow=` is off (C-fit.md 1.4).
 */
export function parseEnsoFlowParams(
  params: URLSearchParams,
  modeDefault: EnsoFlowKind = ensoFlowModeDefault(params)
): EnsoFlowPreference {
  const values = params.getAll('flow');
  // No key reads as the mode default, which is itself a kind or off.
  const value = values.length > 1 ? null : (values[0] ?? modeDefault);
  const kind = value === 'currents' || value === 'wind' || value === 'waves' ? value : 'off';
  const inks = params.getAll('flowink');
  return { kind, ink: inks.length === 1 && inks[0] === 'dark' ? 'dark' : 'light' };
}

/**
 * The mode default is written as absence; `flow=off` is written only where
 * that default is on, so an off link keeps meaning off (moving-paths
 * section 12).
 */
export function writeEnsoFlowParams(
  params: URLSearchParams,
  preference: EnsoFlowPreference,
  modeDefault: EnsoFlowKind = ensoFlowModeDefault(params)
): void {
  params.delete('flow');
  params.delete('flowink');
  if (preference.kind !== modeDefault) params.set('flow', preference.kind);
  if (preference.kind !== 'off' && preference.ink === 'dark') params.set('flowink', 'dark');
}

export function syncEnsoFlowParams(preference: EnsoFlowPreference): void {
  const params = new URLSearchParams(window.location.search);
  writeEnsoFlowParams(params, preference);
  // This writer clones the current query, so it runs the shared sidebar=
  // normalizer like every other cloning writer (D1 M7, S3). url.ts imports
  // this module too; the cycle is call-time only (neither module reads the
  // other while it evaluates).
  normalizeSidebarParam(params);
  const query = params.toString();
  window.history.replaceState(window.history.state, '', window.location.pathname + (query ? `?${query}` : ''));
}
