#!/usr/bin/env node
/**
 * One-off, re-runnable data repair (2026-11-05).
 *
 * 1. Restores every "unknown" pair to its last good value from the git history
 *    of data/visa-rules.json (newest non-unknown value wins; values written by
 *    the broken "rapidapi-pro" parser are never used as a source).
 *    Fallback: data/passport-index-iso2.csv (ilyankou dataset, in this repo).
 *    Pairs with no good source stay "unknown" and are listed.
 * 2. Applies rule changes that were verified against official / reputable
 *    sources (see RULE_CHANGES), adding `source`, `verified` (and `validUntil`).
 * 3. Bumps version / dataVersion / lastUpdated in visa-rules.json and version.json.
 * 4. Writes a machine-readable summary to docs/repair-2026-11-05.json.
 *
 * The resulting values (requirement/duration/notes) do not depend on which copy
 * of visa-rules.json you start from (local HEAD or the live GitHub copy):
 * restored values come from history. Only the restoredFrom/source annotations
 * differ (they mark exactly the pairs that were unknown in the input).
 * If main moved on (e.g. after `git fetch`), re-run it on the newest file:
 *
 *   node scripts/repair-2026-11-05.js [--input data/visa-rules.json]
 *        [--output data/visa-rules.json] [--version-output data/version.json]
 *        [--summary docs/repair-2026-11-05.json] [--now 2026-11-05T12:00:00Z]
 *
 * Env: GIT_BIN (optional) path to git if it is not on PATH.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NEW_VERSION = '3.1.0';
const VERIFIED = '2026-11-05';
const UNTRUSTED_SOURCES = new Set(['rapidapi-pro']); // written by the broken pre-2026-11-05 parser

// ---------------------------------------------------------------------------
// Verified rule changes (only those confirmed from official or reputable sources)
// ---------------------------------------------------------------------------
const TH_SOURCES = [
  'Thailand Ministry of Interior notifications, Royal Gazette 31 Aug 2026 (Vol. 143, Special Issue 207 Ngor), summarised at https://vialtopartners.com/regional-alerts/thailand-immigration-changes-to-visa-exemption-scheme-effective-15-september-2026',
  'https://www.ttgasia.com/2026/09/08/thailand-cuts-visa-free-stay-to-30-days-for-60-countries/',
].join(' ; ');
// The 60 countries/territories on Thailand's 30-day visa exemption list from 15 Sep 2026.
const TH_30_DAY = ['AU', 'AT', 'BH', 'BE', 'BT', 'BN', 'BG', 'CA', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FJ', 'FI', 'FR',
  'GE', 'DE', 'GR', 'HU', 'IS', 'IN', 'ID', 'IE', 'IL', 'IT', 'JP', 'JO', 'KW', 'KG', 'LV', 'LI', 'LT', 'LU', 'MY',
  'MV', 'MT', 'NL', 'NZ', 'NO', 'OM', 'PH', 'PL', 'PT', 'QA', 'RO', 'SA', 'SG', 'SK', 'SI', 'ZA', 'ES', 'SE', 'CH',
  'TW', 'TR', 'UA', 'AE', 'GB', 'US'];

const UK_ETA_SOURCES = [
  'https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-eta-national-list',
  'https://www.gov.uk/government/news/no-permission-no-travel-uk-set-to-enforce-eta-scheme',
  'https://www.gov.uk/guidance/apply-for-an-electronic-travel-authorisation-eta',
].join(' ; ');
// Appendix ETA National List, group (d): ETA required from 2 April 2025 (Ireland is not on it).
const UK_ETA_EUROPE = ['AD', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS',
  'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'MC', 'NL', 'NO', 'PL', 'PT', 'RO', 'SM', 'SK', 'SI', 'ES', 'SE', 'CH', 'VA'];

const CN_SOURCES = [
  'https://toronto.china-consulate.gov.cn/eng/zytzxx/202602/t20260217_11860939.htm',
  'https://english.shanghai.gov.cn/en-PolicyLibrary-EntryExit/20260818/8aa6aa1bc34b4228be0c87a14c75875f.html',
].join(' ; ');

const RULE_CHANGES = [
  {
    id: 'TH-30-day-exemption-2026-09-15',
    description: 'Thailand visa exemption cut from 60 to 30 days (tourism) for 60 countries, entries from 15 Sep 2026',
    pairs: TH_30_DAY.map((p) => [p, 'TH']),
    entry: {
      requirement: 'visa-free',
      duration: 30,
      notes: 'Visa exemption for tourism, up to 30 days (was 60 days before 15 Sep 2026).',
      source: TH_SOURCES,
    },
  },
  {
    id: 'UK-ETA-europe-2025-04-02',
    description: 'UK ETA required for European visa-exempt nationals from 2 Apr 2025, enforced by carriers from 25 Feb 2026',
    pairs: UK_ETA_EUROPE.map((p) => [p, 'GB']),
    entry: {
      requirement: 'eta',
      duration: 180,
      notes: 'UK Electronic Travel Authorisation (ETA) required before travel (since 2 Apr 2025; boarding refused without one from 25 Feb 2026). Visits up to 6 months.',
      source: UK_ETA_SOURCES,
    },
  },
  {
    id: 'CN-visa-free-GB-2026-02-17',
    description: 'China: UK ordinary passports visa-free up to 30 days, 17 Feb 2026 - 31 Dec 2026',
    pairs: [['GB', 'CN']],
    entry: {
      requirement: 'visa-free',
      duration: 30,
      notes: 'Visa-free up to 30 days for business, tourism, visiting family/friends, exchanges and transit, 17 Feb 2026 to 31 Dec 2026. Work, study, journalism or longer stays still need a visa.',
      source: CN_SOURCES,
      validUntil: '2026-12-31',
    },
  },
];

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    input: path.join(ROOT, 'data', 'visa-rules.json'),
    output: path.join(ROOT, 'data', 'visa-rules.json'),
    versionOutput: path.join(ROOT, 'data', 'version.json'),
    summary: path.join(ROOT, 'docs', 'repair-2026-11-05.json'),
    now: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${k}`);
    if (k === '--input') a.input = path.resolve(v);
    else if (k === '--output') a.output = path.resolve(v);
    else if (k === '--version-output') a.versionOutput = path.resolve(v);
    else if (k === '--summary') a.summary = path.resolve(v);
    else if (k === '--now') a.now = v;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

const git = (...args) => execFileSync(process.env.GIT_BIN || 'git', args, { cwd: ROOT, maxBuffer: 1 << 30, encoding: 'utf8' });

const isGood = (e) => e && typeof e === 'object' && e.requirement && e.requirement !== 'unknown' && !UNTRUSTED_SOURCES.has(e.source);

function lastGoodFromHistory() {
  const log = git('log', '--reverse', '--format=%H|%h|%aI|%s', '--', 'data/visa-rules.json').trim();
  const commits = log ? log.split('\n').map((l) => { const [H, h, date, ...s] = l.split('|'); return { H, h, date, subject: s.join('|') }; }) : [];
  const lastGood = new Map();
  const scanned = [];
  for (const c of commits) {
    let d;
    try { d = JSON.parse(git('show', `${c.H}:data/visa-rules.json`)); } catch { scanned.push({ commit: c.h, date: c.date, error: 'unparseable' }); continue; }
    let unknown = 0;
    let total = 0;
    for (const [p, dests] of Object.entries(d.rules || {})) {
      for (const [k, e] of Object.entries(dests || {})) {
        total++;
        if (!isGood(e)) { unknown++; continue; }
        const key = `${p}-${k}`;
        const prev = lastGood.get(key);
        if (prev && JSON.stringify(prev.value) === JSON.stringify(e)) {
          // same value as before: keep the commit that introduced it, note where it was last seen
          prev.lastSeen = c.h;
          prev.lastSeenDate = c.date.slice(0, 10);
        } else {
          lastGood.set(key, { value: e, commit: c.h, date: c.date.slice(0, 10), subject: c.subject, lastSeen: c.h, lastSeenDate: c.date.slice(0, 10) });
        }
      }
    }
    scanned.push({ commit: c.h, date: c.date, subject: c.subject, total, unknownOrUntrusted: unknown });
  }
  return { lastGood, scanned };
}

function passportIndexCsv() {
  const file = path.join(ROOT, 'data', 'passport-index-iso2.csv');
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const [p, d, r] = line.split(',').map((s) => (s || '').trim());
    if (!p || !d || !r || p === d) continue;
    const req = r.toLowerCase();
    let v = null;
    if (/^\d+$/.test(req)) v = { requirement: 'visa-free', duration: parseInt(req, 10) };
    else if (req === 'visa free') v = { requirement: 'visa-free', duration: null };
    else if (req === 'visa on arrival') v = { requirement: 'visa-on-arrival', duration: null };
    else if (req === 'eta') v = { requirement: 'eta', duration: null };
    else if (req === 'e-visa') v = { requirement: 'e-visa', duration: null };
    else if (req === 'visa required') v = { requirement: 'visa-required', duration: null };
    if (v) map.set(`${p.toUpperCase()}-${d.toUpperCase()}`, { ...v, source: 'passport-index' });
  }
  return map;
}

function count(d) {
  let total = 0;
  let unknown = 0;
  for (const dests of Object.values(d.rules)) for (const e of Object.values(dests)) { total++; if (e.requirement === 'unknown') unknown++; }
  return { total, unknown };
}

const brief = (e) => (e ? { requirement: e.requirement, duration: e.duration ?? null } : null);

function main() {
  const args = parseArgs(process.argv);
  const data = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const before = { ...count(data), version: data.version, dataVersion: data.dataVersion, lastUpdated: data.lastUpdated };

  // 1. Restore unknowns
  const { lastGood, scanned } = lastGoodFromHistory();
  const csv = passportIndexCsv();
  const restored = [];
  const remaining = [];
  for (const [p, dests] of Object.entries(data.rules)) {
    for (const [k, e] of Object.entries(dests)) {
      if (e.requirement !== 'unknown') continue;
      const key = `${p}-${k}`;
      const h = lastGood.get(key);
      if (h) {
        const value = { ...h.value };
        if (!value.source) value.source = 'passport-index';
        value.restoredFrom = `git ${h.commit} (${h.date}), last good in ${h.lastSeen} (${h.lastSeenDate})`;
        dests[k] = value;
        restored.push({ passport: p, destination: k, ...brief(value), from: 'git-history', commit: h.commit, date: h.date, commitSubject: h.subject, lastSeenCommit: h.lastSeen, lastSeenDate: h.lastSeenDate, overwrittenAt: e.lastChecked || null });
        continue;
      }
      const c = csv.get(key);
      if (c) {
        dests[k] = { ...c, restoredFrom: 'data/passport-index-iso2.csv' };
        restored.push({ passport: p, destination: k, ...brief(c), from: 'passport-index-csv', commit: null, date: null, overwrittenAt: e.lastChecked || null });
        continue;
      }
      remaining.push({ passport: p, destination: k, overwrittenAt: e.lastChecked || null });
    }
  }
  const afterRestore = count(data);

  // 2. Verified rule changes
  const nowIso = args.now ? new Date(args.now).toISOString() : new Date().toISOString();
  const applied = [];
  for (const rc of RULE_CHANGES) {
    const changes = [];
    for (const [p, dst] of rc.pairs) {
      if (!data.rules[p]) { changes.push({ passport: p, destination: dst, skipped: 'passport not in data' }); continue; }
      const prev = data.rules[p][dst];
      const next = { ...rc.entry, lastChecked: nowIso, verified: VERIFIED };
      data.rules[p][dst] = next;
      changes.push({ passport: p, destination: dst, before: brief(prev), after: brief(next) });
    }
    applied.push({ id: rc.id, description: rc.description, source: rc.entry.source, changes });
  }

  // 3. Version bump (same instant in both fields)
  const dv = args.now ? Date.parse(args.now) : Date.now();
  data.version = NEW_VERSION;
  data.dataVersion = Math.max(dv, (before.dataVersion || 0) + 1);
  data.lastUpdated = new Date(data.dataVersion).toISOString();
  const after = { ...count(data), version: data.version, dataVersion: data.dataVersion, lastUpdated: data.lastUpdated };

  fs.writeFileSync(args.output, JSON.stringify(data, null, 2));
  fs.writeFileSync(args.versionOutput, JSON.stringify({ version: data.version, lastUpdated: data.lastUpdated, dataVersion: data.dataVersion }, null, 2));
  fs.mkdirSync(path.dirname(args.summary), { recursive: true });
  fs.writeFileSync(args.summary, JSON.stringify({ input: path.basename(args.input), before, afterRestore, after, historyScanned: scanned, restored, remainingUnknown: remaining, ruleChanges: applied }, null, 2));

  console.log(`before:  ${before.total} pairs, ${before.unknown} unknown`);
  console.log(`restored ${restored.length} (${restored.filter((r) => r.from === 'git-history').length} from git history, ${restored.filter((r) => r.from === 'passport-index-csv').length} from passport-index CSV)`);
  console.log(`after:   ${after.total} pairs, ${after.unknown} unknown`);
  for (const a of applied) console.log(`rule change ${a.id}: ${a.changes.filter((c) => !c.skipped).length} pairs`);
  console.log(`version ${after.version}, dataVersion ${after.dataVersion}, lastUpdated ${after.lastUpdated}`);
}

main();
