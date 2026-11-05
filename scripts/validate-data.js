#!/usr/bin/env node
/**
 * Data validation gate - run before EVERY commit of data/ (all workflows).
 *
 * Exits non-zero (blocking the commit) when:
 *   - data/visa-rules.json or data/version.json is malformed JSON or fails the schema
 *   - version.json does not match the version fields inside visa-rules.json
 *   - versus the previous committed version (git HEAD by default):
 *       * the number of "unknown" pairs rises
 *       * the total number of pairs drops (or a passport disappears)
 *       * dataVersion goes backwards, or rules changed without a dataVersion bump
 *   - currency files (if present) are malformed or fail their schema
 *
 * Usage:
 *   node scripts/validate-data.js                       # compare with git HEAD
 *   node scripts/validate-data.js --baseline-ref origin/main
 *   node scripts/validate-data.js --file some.json --version-file v.json --baseline old.json
 *   node scripts/validate-data.js --no-baseline         # schema checks only
 *   node scripts/validate-data.js --allow-unknown-increase   # manual override, use with care
 *
 * Env: GIT_BIN (optional) path to git if it is not on PATH.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REQUIREMENTS = ['visa-free', 'visa-on-arrival', 'e-visa', 'eta', 'visa-required', 'unknown'];
const ENTRY_KEYS = new Set(['requirement', 'duration', 'notes', 'lastChecked', 'source', 'verified', 'validUntil', 'restoredFrom']);
const CODE_RE = /^[A-Z]{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv) {
  const args = {
    file: path.join(ROOT, 'data', 'visa-rules.json'),
    versionFile: path.join(ROOT, 'data', 'version.json'),
    currencyFile: path.join(ROOT, 'data', 'currency-rates.json'),
    currencyVersionFile: path.join(ROOT, 'data', 'currency-version.json'),
    baseline: null,
    baselineRef: 'HEAD',
    noBaseline: false,
    allowUnknownIncrease: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--file') args.file = path.resolve(next());
    else if (a === '--version-file') args.versionFile = path.resolve(next());
    else if (a === '--currency-file') args.currencyFile = path.resolve(next());
    else if (a === '--currency-version-file') args.currencyVersionFile = path.resolve(next());
    else if (a === '--baseline') args.baseline = path.resolve(next());
    else if (a === '--baseline-ref') args.baselineRef = next();
    else if (a === '--no-baseline') args.noBaseline = true;
    else if (a === '--allow-unknown-increase') args.allowUnknownIncrease = true;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
const isPosInt = (n) => Number.isInteger(n) && n > 0;

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail(`${label}: cannot read ${file} (${e.code || e.message})`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`${label}: malformed JSON (${e.message})`);
    return null;
  }
}

/** Schema-check visa-rules data. Returns stats or null. */
function checkVisaRules(d, label) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) { fail(`${label}: top level must be an object`); return null; }
  if (typeof d.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(d.version)) fail(`${label}: "version" must be a semver string like "3.1.0"`);
  if (!isIso(d.lastUpdated)) fail(`${label}: "lastUpdated" must be an ISO 8601 timestamp`);
  if (!isPosInt(d.dataVersion)) fail(`${label}: "dataVersion" must be a positive integer (ms since epoch)`);
  if (!d.rules || typeof d.rules !== 'object' || Array.isArray(d.rules)) { fail(`${label}: "rules" must be an object`); return null; }

  const stats = { passports: 0, total: 0, unknown: 0, byRequirement: {} };
  let shown = 0;
  const bad = (msg) => { if (shown++ < 25) fail(`${label}: ${msg}`); else if (shown === 26) fail(`${label}: ...more schema errors suppressed`); };
  const unknownKeys = new Set();

  for (const [p, dests] of Object.entries(d.rules)) {
    stats.passports++;
    if (!CODE_RE.test(p)) bad(`passport key "${p}" is not a 2-letter uppercase code`);
    if (!dests || typeof dests !== 'object' || Array.isArray(dests)) { bad(`rules.${p} must be an object`); continue; }
    for (const [dst, e] of Object.entries(dests)) {
      stats.total++;
      const where = `rules.${p}.${dst}`;
      if (!CODE_RE.test(dst)) bad(`${where}: destination key is not a 2-letter uppercase code`);
      if (p === dst) bad(`${where}: passport and destination are the same`);
      if (!e || typeof e !== 'object' || Array.isArray(e)) { bad(`${where}: entry must be an object`); continue; }
      if (!REQUIREMENTS.includes(e.requirement)) { bad(`${where}: invalid requirement ${JSON.stringify(e.requirement)}`); continue; }
      stats.byRequirement[e.requirement] = (stats.byRequirement[e.requirement] || 0) + 1;
      if (e.requirement === 'unknown') stats.unknown++;
      if (e.duration !== undefined && e.duration !== null && !(isPosInt(e.duration) && e.duration <= 3650)) bad(`${where}: duration must be null or a whole number of days (1-3650), got ${JSON.stringify(e.duration)}`);
      if (e.notes !== undefined && e.notes !== null && typeof e.notes !== 'string') bad(`${where}: notes must be a string or null`);
      if (e.lastChecked !== undefined && e.lastChecked !== null && !isIso(e.lastChecked)) bad(`${where}: lastChecked must be ISO 8601`);
      if (e.source !== undefined && (typeof e.source !== 'string' || !e.source.trim())) bad(`${where}: source must be a non-empty string`);
      if (e.verified !== undefined && !(typeof e.verified === 'string' && DATE_RE.test(e.verified))) bad(`${where}: verified must be YYYY-MM-DD`);
      if (e.validUntil !== undefined && !(typeof e.validUntil === 'string' && DATE_RE.test(e.validUntil))) bad(`${where}: validUntil must be YYYY-MM-DD`);
      for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) unknownKeys.add(k);
    }
  }
  if (unknownKeys.size) warn(`${label}: entries contain unrecognised fields: ${[...unknownKeys].join(', ')}`);
  return stats;
}

function checkVersionFile(v, d) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { fail('version.json: top level must be an object'); return; }
  if (typeof v.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(v.version)) fail('version.json: "version" must be a semver string');
  if (!isIso(v.lastUpdated)) fail('version.json: "lastUpdated" must be ISO 8601');
  if (!isPosInt(v.dataVersion)) fail('version.json: "dataVersion" must be a positive integer (ms since epoch)');
  if (!d) return;
  for (const k of ['version', 'lastUpdated', 'dataVersion']) {
    if (v[k] !== d[k]) fail(`version.json: "${k}" (${JSON.stringify(v[k])}) does not match visa-rules.json (${JSON.stringify(d[k])})`);
  }
}

function checkCurrency(args) {
  if (!fs.existsSync(args.currencyFile) && !fs.existsSync(args.currencyVersionFile)) return;
  const c = readJson(args.currencyFile, 'currency-rates.json');
  const cv = readJson(args.currencyVersionFile, 'currency-version.json');
  if (c) {
    if (typeof c.base !== 'string' || !/^[A-Z]{3}$/.test(c.base)) fail('currency-rates.json: "base" must be a 3-letter code');
    if (!isPosInt(c.dataVersion)) fail('currency-rates.json: "dataVersion" must be a positive integer');
    if (!c.rates || typeof c.rates !== 'object' || Array.isArray(c.rates) || Object.keys(c.rates).length === 0) {
      fail('currency-rates.json: "rates" must be a non-empty object');
    } else {
      const badRates = Object.entries(c.rates).filter(([k, r]) => !/^[A-Z]{3}$/.test(k) || typeof r !== 'number' || !(r > 0) || !Number.isFinite(r));
      if (badRates.length) fail(`currency-rates.json: ${badRates.length} invalid rate(s), e.g. ${JSON.stringify(badRates.slice(0, 3))}`);
    }
  }
  if (cv && (!isPosInt(cv.dataVersion) || !isIso(cv.lastUpdated))) fail('currency-version.json: needs dataVersion (int) and lastUpdated (ISO)');
}

function loadBaseline(args) {
  if (args.noBaseline) return { data: null, label: 'none (--no-baseline)' };
  if (args.baseline) {
    const errCount = errors.length;
    const data = readJson(args.baseline, 'baseline');
    if (errors.length > errCount) return { data: null, label: args.baseline };
    return { data, label: args.baseline };
  }
  const gitBin = process.env.GIT_BIN || 'git';
  const rel = path.relative(ROOT, path.join(ROOT, 'data', 'visa-rules.json')).split(path.sep).join('/');
  try {
    const text = execFileSync(gitBin, ['show', `${args.baselineRef}:${rel}`], { cwd: ROOT, maxBuffer: 1 << 30, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { data: JSON.parse(text), label: `git ${args.baselineRef}:${rel}` };
  } catch (e) {
    const msg = String((e.stderr || '') + e.message);
    if (/does not exist|exists on disk, but not in|invalid object name|unknown revision|bad revision/i.test(msg)) {
      warn(`baseline ${args.baselineRef}:${rel} not found - skipping regression checks`);
      return { data: null, label: 'not found' };
    }
    fail(`could not read baseline ${args.baselineRef}:${rel} via git (${msg.split('\n')[0]}). Use --baseline <file> or --no-baseline.`);
    return { data: null, label: 'error' };
  }
}

function main() {
  const args = parseArgs(process.argv);

  const d = readJson(args.file, 'visa-rules.json');
  const stats = d ? checkVisaRules(d, 'visa-rules.json') : null;
  const v = readJson(args.versionFile, 'version.json');
  if (v) checkVersionFile(v, d);
  checkCurrency(args);

  const base = loadBaseline(args);
  let baseStats = null;
  if (base.data) {
    baseStats = checkVisaRules(base.data, 'baseline') ;
    // A broken baseline should not block a repair; downgrade its schema errors to warnings.
    const baseErrors = errors.filter((e) => e.startsWith('baseline:'));
    for (const e of baseErrors) { errors.splice(errors.indexOf(e), 1); warn(e); }
  }

  if (stats && baseStats) {
    if (stats.unknown > baseStats.unknown) {
      const msg = `unknown pairs rose from ${baseStats.unknown} to ${stats.unknown} (+${stats.unknown - baseStats.unknown})`;
      if (args.allowUnknownIncrease) warn(`${msg} - allowed by --allow-unknown-increase`); else fail(msg);
    }
    if (stats.total < baseStats.total) fail(`total pairs dropped from ${baseStats.total} to ${stats.total}`);
    if (stats.passports < baseStats.passports) fail(`passports dropped from ${baseStats.passports} to ${stats.passports}`);
    for (const p of Object.keys(base.data.rules || {})) {
      if (!d.rules[p]) { fail(`passport ${p} disappeared`); continue; }
      const lost = Object.keys(base.data.rules[p] || {}).filter((k) => !(k in d.rules[p]));
      if (lost.length) fail(`passport ${p} lost ${lost.length} destination(s): ${lost.slice(0, 10).join(',')}`);
    }
    if (isPosInt(d.dataVersion) && isPosInt(base.data.dataVersion)) {
      if (d.dataVersion < base.data.dataVersion) fail(`dataVersion went backwards (${base.data.dataVersion} -> ${d.dataVersion})`);
      const changed = JSON.stringify(d.rules) !== JSON.stringify(base.data.rules);
      if (changed && d.dataVersion <= base.data.dataVersion) fail('rules changed but dataVersion was not increased - the app would not detect the new data');
    }
  }

  console.log('=== validate-data ===');
  console.log(`file:      ${path.relative(process.cwd(), args.file) || args.file}`);
  console.log(`baseline:  ${base.label}`);
  if (stats) {
    console.log(`passports: ${stats.passports}${baseStats ? ` (baseline ${baseStats.passports})` : ''}`);
    console.log(`pairs:     ${stats.total}${baseStats ? ` (baseline ${baseStats.total})` : ''}`);
    console.log(`unknown:   ${stats.unknown}${baseStats ? ` (baseline ${baseStats.unknown})` : ''}`);
    console.log(`by type:   ${JSON.stringify(stats.byRequirement)}`);
  }
  if (d) console.log(`version:   ${d.version}  dataVersion: ${d.dataVersion}  lastUpdated: ${d.lastUpdated}`);
  for (const w of warnings) console.log(`WARN: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`FAIL: ${e}`);
    console.error(`\nVALIDATION FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'}) - do not commit this data.`);
    process.exit(1);
  }
  console.log('\nVALIDATION PASSED');
}

try {
  main();
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
}
