import { SST_ANOMALY_LABELS, SST_ANOMALY_LEGEND_TITLE, SST_ANOMALY_SCALE } from '../config/palette';
import { escapeHtml } from '../util/escape';

/** Full source colors, reversed only to retain the existing warm-to-cool direction.
 * Equal slots express ordered colors, not the width of unbounded endpoint bins.
 * Transparent no-data is not part of the color ramp. Words remain qualitative.
 */
export function sstAnomalyScaleHtml(): string {
  const colors = SST_ANOMALY_SCALE.filter(entry => !entry.transparent).slice().reverse();
  return '<span class="sst-anomaly-scale">' +
    '<span class="sst-anomaly-ramp" aria-hidden="true">' +
    colors.map(entry => `<span data-sst-color="${entry.ref}" style="background:${escapeHtml(entry.color)}"></span>`).join('') +
    '</span><span class="sst-anomaly-orientation">' +
    SST_ANOMALY_LABELS.map(label => `<span>${escapeHtml(label)}</span>`).join('') +
    '</span></span>';
}

export function renderSstAnomalyLegend(body: HTMLElement): void {
  body.innerHTML =
    `<h3 class="legend-section-title">${escapeHtml(SST_ANOMALY_LEGEND_TITLE)}</h3>` +
    sstAnomalyScaleHtml() +
    '<p class="legend-note">NASA GHRSST MUR daily anomaly · the dashed box is Nino 3.4, the region the ENSO index measures</p>';
}
