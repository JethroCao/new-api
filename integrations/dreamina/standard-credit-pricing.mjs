import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {VIDEO_MODELS} from './plugin.js';

const PLUGIN_KEY = 'dreamina-cli';
const OPTION = 'billing_setting.plugin_billing_expr';

// Archived 2026-10-29 no-video-input output-second benchmark already discounted
// to 70%. These are historical CNY prices, not a claim about today's list price.
// Denominators are the 2026-11-05 Canvas CLI 1.2.0 no-reference credit survey.
// Reference video uses the SAME tier price per accepted credit; it does not
// preserve the former output-seconds-only charge. No procurement cost is used.
const BASELINE = {
  'seedance_2.5': {'480p': [0.469, 12], '720p': [1.057, 20], '1080p': [2.618, 64]},
  'seedance_2.5_draft': {'480p': [0.469, 9]},
  'seedance_2.0_vip': {'720p': [0.693, 14], '1080p': [1.736, 33], '4k': [3.535, 80]},
  'seedance_2.0_fast_vip': {'720p': [0.56, 6]},
  'seedance_2.0_mini': {'720p': [0.35, 6]},
  'seedance_pro_fast': {'720p': [0.06054048, 2], '1080p': [0.1439424, 4]},
  'happyhorse_1.1': {'720p': [0.63, 14], '1080p': [0.84, 18]},
  'wan_3.0': {'720p': [0.42, 14], '1080p': [0.84, 33]},
};

// Generate opt-in configuration, never host defaults. The site's existing money
// convention is explicitly CNY 1:1 and 500000 quota/CNY at group ratio 1. Neither
// the historical /7.3 conversion nor another 0.7 discount belongs in the host.
export function buildStandardCreditPricing() {
  const prices = {};
  const expressions = {};
  for (const [model, resolutions] of Object.entries(BASELINE)) {
    const supported = VIDEO_MODELS[model]?.resolutions.map(value => value.toLowerCase());
    if (!supported || supported.join(',') !== Object.keys(resolutions).join(',')) {
      throw new Error('Credit pricing resolution table needs review: ' + model);
    }
    const tiers = [];
    prices[model] = {};
    for (const [resolution, [cnyPerSecond, creditsPerSecond]] of Object.entries(resolutions)) {
      const price = cnyPerSecond / creditsPerSecond;
      prices[model][resolution] = {
        baseline_cny_per_output_second: cnyPerSecond,
        no_reference_credits_per_output_second: creditsPerSecond,
        cny_per_credit: price,
      };
      tiers.push({resolution, expression: `tier("${resolution}", u("credits") * ${price})`});
    }
    // The plugin validates dimensions before billing. Its default and case
    // normalization produce one of these tiers; the last leaf is canonical
    // expression syntax, not authorization for unsupported resolutions.
    expressions[`${PLUGIN_KEY}::${model}`] = 'v1:' + tiers.map((tier, index) =>
      index === tiers.length - 1 ? tier.expression :
        `u("resolution") == "${tier.resolution}" ? ${tier.expression} : `).join('');
  }
  expressions[`${PLUGIN_KEY}::dreamina-video`] = expressions[`${PLUGIN_KEY}::seedance_2.5`];
  return {
    schema_version: 1,
    policy_version: 'standard-credit-70-2026-11-07',
    scope: 'Normal/default group baseline; plugin model overrides also use the host group ratio for other groups. Kemeng pricing is excluded and this artifact must not enable a Kemeng cost group',
    currency: 'CNY',
    quota_per_currency_unit: 500000,
    group_ratio: 1,
    provenance: {
      baseline_date: '2026-10-29',
      baseline_archive: 'dreamina-pricing-70-20261029/plan.json',
      baseline: 'Archived no-video-input output-second benchmark at 70%; not newly verified official prices',
      credits_date: '2026-11-05',
      credits_source: 'Canvas CLI 1.2.0 quote-only survey; not ledger deductions',
      sources: [
        'https://docs.volcengine.com/docs/ark/model-pricing?lang=zh',
        'https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh',
        'https://help.aliyun.com/zh/model-studio/model-pricing',
        'https://help.aliyun.com/zh/model-studio/wan3-0-video',
      ],
    },
    settlement: 'Estimate credits for reservation; original accepted batch quote credits times delivered/n at the frozen model-resolution price per credit',
    prices,
    aliases: {'dreamina-video': 'seedance_2.5'},
    [OPTION]: expressions,
  };
}

// Use a GET /api/option/model_pricing snapshot requesting all listed models.
// PATCH replaces each complete model draft, so preserve every unrelated field
// and provider and use its exact optimistic-lock version. Existing prices only
// change after an explicit replacement choice. This function does no I/O.
export function prepareStandardCreditPricing(snapshot, {replaceExisting = false} = {}) {
  if (snapshot?.success === true) snapshot = snapshot.data;
  if (!Array.isArray(snapshot?.entries)) throw new Error('A model-pricing snapshot is required');
  const entries = new Map();
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.model_name !== 'string' || entries.has(entry.model_name)) {
      throw new Error('Invalid or duplicate pricing snapshot entry');
    }
    entries.set(entry.model_name, entry);
  }
  const changes = [];
  const replacements = [];
  for (const [key, expression] of Object.entries(buildStandardCreditPricing()[OPTION])) {
    const model = key.slice(PLUGIN_KEY.length + 2);
    const entry = entries.get(model);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.version) || !entry.configured ||
        typeof entry.configured !== 'object' || Array.isArray(entry.configured)) {
      throw new Error('Missing complete versioned pricing snapshot: ' + model);
    }
    const pricing = structuredClone(entry.configured);
    const existing = pricing[OPTION];
    if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
      throw new Error('Invalid provider pricing snapshot: ' + model);
    }
    const previous = existing?.[PLUGIN_KEY];
    if (previous === expression) continue;
    if (previous !== undefined) {
      if (!replaceExisting) throw new Error('Existing administrator price requires --replace-existing: ' + model);
      replacements.push({model_name: model, previous, proposed: expression});
    }
    pricing[OPTION] = {...existing, [PLUGIN_KEY]: expression};
    changes.push({model_name: model, expected_version: entry.version, pricing});
  }
  return {changes, replacements};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outputPath = args.shift();
  let snapshotPath;
  let replaceExisting = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--snapshot' && !snapshotPath && args.length) snapshotPath = args.shift();
    else if (flag === '--replace-existing' && !replaceExisting) replaceExisting = true;
    else throw new Error('Unknown or duplicate option: ' + flag);
  }
  if (!outputPath || outputPath.startsWith('--') || (replaceExisting && !snapshotPath)) {
    throw new Error('Usage: node standard-credit-pricing.mjs output.json [--snapshot snapshot.json] [--replace-existing]');
  }
  const artifact = buildStandardCreditPricing();
  if (snapshotPath) {
    const {changes, replacements} = prepareStandardCreditPricing(JSON.parse(await readFile(snapshotPath, 'utf8')), {replaceExisting});
    artifact.request = {method: 'PATCH', path: '/api/option/model_pricing', body: {changes}};
    artifact.replacements = replacements;
  }
  // No network or database writes; never replace an existing reviewed artifact.
  await writeFile(outputPath, JSON.stringify(artifact, null, 2) + '\n', {flag: 'wx', mode: 0o600});
}
