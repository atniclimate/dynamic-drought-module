/** Additive ENSO context preferences, independent of the SST date rail. */
export type EnsoFlowKind = 'off' | 'currents' | 'wind' | 'waves';
export type EnsoFlowInk = 'light' | 'dark';

export interface EnsoFlowPreference {
  readonly kind: EnsoFlowKind;
  readonly ink: EnsoFlowInk;
}

export function parseEnsoFlowParams(params: URLSearchParams): EnsoFlowPreference {
  const values = params.getAll('flow');
  const value = values.length === 1 ? values[0] : null;
  const kind = value === 'currents' || value === 'wind' || value === 'waves' ? value : 'off';
  const inks = params.getAll('flowink');
  return { kind, ink: inks.length === 1 && inks[0] === 'dark' ? 'dark' : 'light' };
}

export function writeEnsoFlowParams(params: URLSearchParams, preference: EnsoFlowPreference): void {
  params.delete('flow');
  params.delete('flowink');
  if (preference.kind !== 'off') {
    params.set('flow', preference.kind);
    if (preference.ink === 'dark') params.set('flowink', 'dark');
  }
}

export function syncEnsoFlowParams(preference: EnsoFlowPreference): void {
  const params = new URLSearchParams(window.location.search);
  writeEnsoFlowParams(params, preference);
  const query = params.toString();
  window.history.replaceState(window.history.state, '', window.location.pathname + (query ? `?${query}` : ''));
}
