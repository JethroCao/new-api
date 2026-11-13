import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {buildStandardCreditPricing, prepareStandardCreditPricing} from './standard-credit-pricing.mjs';

const option = 'billing_setting.plugin_billing_expr';
const catalog = buildStandardCreditPricing();
const models = Object.keys(catalog[option]).map(key => key.split('::')[1]);
const snapshot = () => ({entries: models.map((model_name, i) => ({
  model_name, version: String(i + 1).padStart(64, '0'),
  configured: {ModelPrice: 0, 'billing_setting.billing_mode': 'tiered_expr',
    'billing_setting.billing_expr': 'v1:tier("ordinary", fixed(0))',
    [option]: {other: 'v1:tier("other", u("seconds") * 2)'}},
}))});

test('review artifact records historical CNY baseline and distinct model-resolution credit prices', async () => {
  assert.deepEqual(JSON.parse(await readFile(new URL('./standard-credit-pricing.json', import.meta.url))), catalog);
  assert.equal(Object.keys(catalog.prices).length, 9);
  assert.equal(catalog.currency, 'CNY');
  assert.equal(catalog.quota_per_currency_unit, 500000);
  assert.equal(catalog.group_ratio, 1);
  assert.match(catalog.scope, /Kemeng pricing is excluded/);
  assert.match(catalog.scope, /host group ratio for other groups/);
  assert.match(catalog.provenance.baseline, /not newly verified/);
  const flash = catalog.prices['seedance_2.5_flash'];
  assert.equal(flash['480p'].cny_per_credit, 0.044);
  assert.ok(Math.abs(95 * flash['720p'].cny_per_credit - 3.465) < 1e-12);
  assert.equal(catalog.provenance.model_overrides.seedance_2_5_flash.verified_date, '2026-11-13');
  const prices = catalog.prices['seedance_2.5'];
  assert.ok(Math.abs(120 * prices['480p'].cny_per_credit - 4.690) < 1e-12);
  assert.ok(Math.abs(120 * prices['720p'].cny_per_credit - 6.342) < 1e-12);
  assert.equal(catalog[option]['dreamina-cli::dreamina-video'], catalog[option]['dreamina-cli::seedance_2.5']);
  for (const expression of Object.values(catalog[option])) {
    assert.match(expression, /^v1:/);
    assert.doesNotMatch(expression, /seconds|7\.3|0\.7\b|cost_cny/);
  }
});

test('versioned drafts retain administrator fields and other providers without mutating input', () => {
  const original = snapshot();
  const before = structuredClone(original);
  const result = prepareStandardCreditPricing({success: true, data: original});
  assert.equal(result.changes.length, 10);
  assert.deepEqual(result.replacements, []);
  for (const change of result.changes) {
    const entry = original.entries.find(entry => entry.model_name === change.model_name);
    assert.equal(change.expected_version, entry.version);
    assert.equal(change.pricing.ModelPrice, 0);
    assert.equal(change.pricing['billing_setting.billing_expr'], entry.configured['billing_setting.billing_expr']);
    assert.equal(change.pricing[option].other, entry.configured[option].other);
    assert.equal(change.pricing[option]['dreamina-cli'], catalog[option]['dreamina-cli::' + change.model_name]);
  }
  assert.deepEqual(original, before);
});

test('existing prices require explicit replacement, identical expressions retain their version', () => {
  const existing = snapshot();
  const previous = 'v1:tier("admin", u("credits") * 0.12345)';
  existing.entries[0].configured[option]['dreamina-cli'] = previous;
  assert.throws(() => prepareStandardCreditPricing(existing), /requires --replace-existing/);
  const reviewed = prepareStandardCreditPricing(existing, {replaceExisting: true});
  assert.equal(reviewed.replacements.length, 1);
  assert.equal(reviewed.replacements[0].previous, previous);
  assert.equal(reviewed.changes[0].expected_version, existing.entries[0].version);
  for (const entry of existing.entries) entry.configured[option]['dreamina-cli'] = catalog[option]['dreamina-cli::' + entry.model_name];
  assert.deepEqual(prepareStandardCreditPricing(existing), {changes: [], replacements: []});
  for (const bad of [undefined, {}, {success: false, data: existing}, {entries: []},
    {...existing, entries: [...existing.entries, existing.entries[0]]},
    {...existing, entries: [{...existing.entries[0], version: ''}, ...existing.entries.slice(1)]},
  ]) assert.throws(() => prepareStandardCreditPricing(bad));
});

test('local CLI generates once and refuses replacing a reviewed artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dreamina-standard-price-'));
  try {
    const path = join(dir, 'pricing.json');
    const script = new URL('./standard-credit-pricing.mjs', import.meta.url);
    execFileSync(process.execPath, [fileURLToPath(script), path]);
    const first = await readFile(path, 'utf8');
    assert.deepEqual(JSON.parse(first), catalog);
    const again = spawnSync(process.execPath, [fileURLToPath(script), path], {encoding: 'utf8'});
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /EEXIST/);
    assert.equal(await readFile(path, 'utf8'), first);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
