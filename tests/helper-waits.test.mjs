import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { expect as realExpect } from '@playwright/test';
import { untilAnswered } from './answered-read.ts';

// Run the actual helper bodies. Only unrelated boot fixtures/chrome assertions
// are no-ops; polling, page reads, status classification and diagnostics run.
const source = readFileSync(new URL('./helpers.ts', import.meta.url), 'utf8');
function body(name) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `actual ${name} declaration`);
  const text = source.slice(start).match(/^[\s\S]*?\n\}/)?.[0];
  assert.ok(text, `complete ${name} body`);
  return stripTypeScriptTypes(text.replace(/^export /, ''));
}

function clock() {
  let now = 0;
  return { now: () => now, advance: (ms) => { now += ms; }, sleep: async (ms) => { now += ms; } };
}

function harness({ read, timing = clock(), seam = null, seamError } = {}) {
  const budgets = [];
  const reads = [];
  const noops = { toHaveCount: async () => {}, toHaveAttribute: async () => {} };
  const expect = () => ({ ...noops, not: noops });
  // The before-fix helper really uses Playwright's wall-clock poll. No copied
  // polling implementation decides the regression proof.
  expect.poll = realExpect.configure({ timeout: 10_000 }).poll;
  const bindings = {
    expect,
    untilAnswered: (readValue, accept, budget, what) => {
      budgets.push(budget);
      return untilAnswered(readValue, accept, budget, what, timing);
    },
    layerPill: (page, key) => page.locator(`[data-layer-status="${key}"]`),
    PRESET_LABELS: [], ROLE_GROUPS: []
  };
  for (const name of [...body('gotoApp').matchAll(/(?:await )?((?:stub|install|cover|assertBuild)[A-Za-z]+)\(/g)].map((m) => m[1])) {
    bindings[name] = async () => {};
  }
  const terminalClasses = source.match(/const TERMINAL_STATUS_CLASSES:[\s\S]*?\];/)?.[0];
  assert.ok(terminalClasses, 'actual terminal class vocabulary');
  const functions = new Function(...Object.keys(bindings),
    `${stripTypeScriptTypes(terminalClasses)}\n${body('readDdmSeam')}\n${body('gotoApp')}\n${body('waitForLayerSettled')}\nreturn { gotoApp, waitForLayerSettled };`)(...Object.values(bindings));
  const page = {
    goto: async () => {},
    locator: (selector) => ({ getAttribute: async (attribute) => {
      reads.push([selector, attribute]);
      return read?.(selector, attribute) ?? null;
    } }),
    evaluate: async (fn, arg) => {
      if (fn.toString().includes('__ddm')) {
        if (seamError) throw seamError;
        return runInNewContext(`(${fn.toString()})()`, { window: { __ddm: seam === null ? undefined : { snapshot: () => seam } } });
      }
      // The DOM read is immediate even when the requested element is absent.
      const value = await read?.(arg);
      reads.push([arg, 'evaluate']);
      const element = value === null || value === undefined ? null : { getAttribute: () => value };
      return runInNewContext(`(${fn.toString()})(arg)`, {
        arg, document: { documentElement: element, querySelector: () => element }
      });
    }
  };
  return { ...functions, page, budgets, reads, timing };
}

test('waitForLayerSettled survives a blocked renderer read beyond its caller budget', async () => {
  let reads = 0;
  // Real elapsed time and the real former expect.poll prove the old failure.
  const h = harness({ timing: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, read: async () => {
    if (++reads === 1) {
      await new Promise((r) => setTimeout(r, 3_000));
      return 'layer-toggle-status loading';
    }
    return 'layer-toggle-status ready';
  } });
  await h.waitForLayerSettled(h.page, 'usdm', 2_000);
  assert.equal(reads, 2);
});

test('gotoApp uses the unchanged 10 s budget and tolerates a blocked boot read', async () => {
  const timing = clock();
  let reads = 0;
  const h = harness({ timing, read: () => {
    timing.advance(++reads === 1 ? 15_000 : 0);
    return reads === 1 ? 'booting' : 'idle';
  } });
  await h.gotoApp(h.page, '?view=console');
  assert.deepEqual(h.budgets, [10_000]);
  assert.equal(timing.now(), 15_250);
});

test('gotoApp bootIdle:false still skips the boot read', async () => {
  const h = harness({ read: () => { throw new Error('unexpected boot read'); } });
  await h.gotoApp(h.page, '?view=console', { bootIdle: false });
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.budgets, []);
});

test('gotoApp retains pending keys and transports plus the original timeout cause', async () => {
  const seam = { pendingLayerKeys: ['usdm'], pendingTransportCount: 2, pendingTransportKeys: { frame: 2 } };
  const h = harness({ read: () => 'booting', seam });
  await assert.rejects(h.gotoApp(h.page), (error) => {
    assert.match(error.message, /pending layer keys = \["usdm"\]/);
    assert.match(error.message, /pending shared transports = 2 \(by key: \{"frame":2\}\)/);
    assert.match(error.cause.message, /still "booting" after 10000 ms of answered reads/);
    return true;
  });
  assert.equal(h.timing.now(), 10_000);
});

test('gotoApp retains read errors as cause when its diagnostic also fails', async () => {
  const original = new Error('page closed during boot read');
  const h = harness({ read: () => { throw original; }, seamError: new Error('seam unavailable') });
  await assert.rejects(h.gotoApp(h.page), (error) => {
    assert.equal(error.cause, original);
    assert.match(error.message, /the boot-idle seam could not be read \(seam unavailable\)/);
    return true;
  });
});

test('gotoApp preserves the missing-seam diagnostic', async () => {
  const h = harness({ read: () => 'booting' });
  await assert.rejects(h.gotoApp(h.page), /window.__ddm is not installed/);
});

test('settle accepts exactly the existing terminal classes after a missing pill', async () => {
  for (const status of ['ready', 'degraded', 'error', 'no-data', 'zoom-in']) {
    let reads = 0;
    const h = harness({ read: () => ++reads === 1 ? null : `layer-toggle-status ${status}` });
    await h.waitForLayerSettled(h.page, 'fixture');
    assert.deepEqual(h.budgets, [25_000]);
    assert.equal(reads, 2);
  }
});

test('missing and nonterminal pills fail at the caller budget with raw class diagnostics', async () => {
  for (const value of [null, 'layer-toggle-status loading', 'layer-toggle-status not-ready']) {
    const h = harness({ read: () => value });
    await assert.rejects(h.waitForLayerSettled(h.page, 'fixture', 750), (error) => {
      assert.match(error.message, /layer "fixture" never left the loading state/);
      assert.ok(error.message.includes(`still ${JSON.stringify(value)}`));
      assert.match(error.message, /after 750 ms of answered reads/);
      return true;
    });
    assert.equal(h.timing.now(), 750);
  }
});

test('settle preserves page exception identity', async () => {
  const error = new Error('target closed');
  const h = harness({ read: () => { throw error; } });
  await assert.rejects(h.waitForLayerSettled(h.page, 'fixture'), (caught) => caught === error);
});
