/**
 * Pure landscape-context rendering for the drought briefing.
 *
 * Dynamic strings come from the schema-validated artifact but still pass
 * through escapeHtml. Source links render only for https URLs.
 */

import type {
  LandscapeContext,
  LandscapeContextSource
} from '../impact/types';
import { escapeHtml } from '../util/escape';

function renderSource(source: LandscapeContextSource): string {
  const label =
    source.url?.startsWith('https://') === true
      ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.label)}</a>`
      : escapeHtml(source.label);
  const acquired = source.acquired
    ? `; acquired ${escapeHtml(source.acquired)}`
    : '';
  return `
    <li class="impact-landscape-source">
      ${label}
      <span>Vintage: ${escapeHtml(source.vintage)}${acquired}; method v${escapeHtml(
        String(source.methodVersion)
      )}.</span>
    </li>
  `;
}

export function renderLandscapeContext(context: LandscapeContext): string {
  let body: string;
  if (context.status === 'loading') {
    body = `
      <div class="impact-landscape-state" role="status">
        <span class="impact-spinner" aria-hidden="true"></span>
        Reading the baked ecoregion signature...
      </div>
    `;
  } else if (context.status === 'unavailable') {
    body = `
      <p class="impact-landscape-unavailable">${escapeHtml(
        context.note ??
          'Landscape context is unavailable for this selection.'
      )}</p>
    `;
  } else {
    const ecoregion = context.ecoregion;
    const identity = ecoregion
      ? `<p class="impact-landscape-identity">EPA Omernik Level ${
          ecoregion.level === 3 ? 'III' : 'IV'
        } <strong>${escapeHtml(ecoregion.name)}</strong> <span>(${escapeHtml(
          ecoregion.code
        )})</span></p>`
      : '';
    const facts = context.facts
      .map(
        (fact) => `
          <article class="impact-landscape-fact" data-landscape-fact="${escapeHtml(
            fact.key
          )}">
            <h4>${escapeHtml(fact.label)}</h4>
            <p>${escapeHtml(fact.text)}</p>
            ${
              fact.note
                ? `<p class="impact-landscape-fact-note">${escapeHtml(
                    fact.note
                  )}</p>`
                : ''
            }
          </article>
        `
      )
      .join('');
    const date = context.artifactDate
      ? `Artifact dated ${escapeHtml(context.artifactDate)}`
      : 'Artifact date unavailable';
    const analysis =
      context.analysisCrs && context.gridResolutionMeters !== undefined
        ? `; ${escapeHtml(context.analysisCrs)}; ${escapeHtml(
            String(context.gridResolutionMeters)
          )} m analysis grid`
        : '';
    const sources =
      context.sources.length > 0
        ? `
          <div class="impact-landscape-provenance">
            <p class="impact-landscape-provenance-title">Sources and method</p>
            <p class="impact-landscape-artifact-date">${date}${analysis}.</p>
            <ul>${context.sources.map(renderSource).join('')}</ul>
          </div>
        `
        : `<p class="impact-landscape-artifact-date">${date}${analysis}.</p>`;
    body = `
      ${identity}
      ${
        context.support
          ? `<p class="impact-landscape-support">${escapeHtml(
              context.support
            )}</p>`
          : ''
      }
      <div class="impact-landscape-facts">${facts}</div>
      ${
        context.note
          ? `<p class="impact-landscape-unavailable">${escapeHtml(
              context.note
            )}</p>`
          : ''
      }
      ${sources}
    `;
  }

  return `
    <section class="impact-landscape" aria-label="Landscape context">
      <h3 class="impact-section-title">Landscape context</h3>
      <div class="impact-landscape-card">${body}</div>
    </section>
  `;
}
