#!/usr/bin/env node
/**
 * Weekly visa-data import from two free, open datasets.
 *
 *   1. visafreely.com dataset (github.com/honru09/visa-requirements-dataset), CC BY 4.0.
 *      Rows marked verified=true were checked against official government sources.
 *   2. Wikipedia "Visa requirements for X citizens" articles, parsed weekly by
 *      github.com/Riedel-David/Visa-requirements, CC BY-SA 4.0.
 *
 * Precedence for each passport -> destination pair already in data/visa-rules.json:
 *   a. Our own hand-verified entries (`verified` set, `validUntil` not passed) are kept.
 *      Sources that disagree are listed in the report for review.
 *   b. visafreely row verified against an official source.
 *   c. Wikipedia (fresher than the unverified seed rows).
 *   d. visafreely unverified row (Passport Index seed, Feb 2026).
 *   e. Otherwise the existing entry is kept.
 * The set of pairs never changes, and nothing is ever written as "unknown".
 *
 * Safety:
 *   - Refuses to write if more than --max-change-pct (default 3%) of pairs change
 *     requirement, unless --allow-large is given (use for the first import only).
 *   - Refuses to run on a missing/corrupt source or a source with too few rows.
 *   - The workflow runs scripts/validate-data.js before committing.
 *
 * Usage:
 *   node scripts/import-open-sources.js                 # download latest, write data
 *   node scripts/import-open-sources.js --dry-run       # report only
 *   node scripts/import-open-sources.js --riedel all.json --visafreely visa-requirements.json
 *   options: --allow-large  --max-change-pct N  --report docs/last-import.md  --today YYYY-MM-DD
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RULES_FILE = path.join(ROOT, 'data', 'visa-rules.json');
const VERSION_FILE = path.join(ROOT, 'data', 'version.json');
const RIEDEL_REPO = 'Riedel-David/Visa-requirements';
const VISAFREELY_URL = 'https://raw.githubusercontent.com/honru09/visa-requirements-dataset/main/visa-requirements.json';
const VISAFREELY_COMMITS = 'https://api.github.com/repos/honru09/visa-requirements-dataset/commits?per_page=1';
const NOTE_MAX = 220;

const ATTRIBUTION = [
  { name: 'visafreely.com visa requirements dataset', url: 'https://github.com/honru09/visa-requirements-dataset', license: 'CC BY 4.0', credit: 'Visa data verification by visafreely.com (CC BY 4.0)' },
  { name: 'Wikipedia "Visa requirements for X citizens" articles via Riedel-David/Visa-requirements', url: 'https://github.com/Riedel-David/Visa-requirements', license: 'CC BY-SA 4.0', credit: 'Visa data from Wikipedia contributors (CC BY-SA 4.0), normalised' },
];

function parseArgs(argv) {
  const a = { riedel: null, visafreely: null, dryRun: false, allowLarge: false, maxChangePct: 3, report: path.join(ROOT, 'docs', 'last-import.md'), today: new Date().toISOString().slice(0, 10) };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--riedel') a.riedel = path.resolve(next());
    else if (k === '--visafreely') a.visafreely = path.resolve(next());
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--allow-large') a.allowLarge = true;
    else if (k === '--max-change-pct') a.maxChangePct = Number(next());
    else if (k === '--report') a.report = path.resolve(next());
    else if (k === '--today') a.today = next();
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

async function getJson(url) {
  const headers = { 'User-Agent': 'borderwise-data-import', Accept: 'application/json' };
  if (process.env.GITHUB_TOKEN && url.startsWith('https://api.github.com')) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const warnings = [];
const warn = (m) => { warnings.push(m); console.warn('WARN', m); };

async function loadSources(args) {
  const meta = {};
  let riedel, visafreely;
  if (args.riedel) {
    riedel = JSON.parse(fs.readFileSync(args.riedel, 'utf8'));
    meta.riedel = { from: path.basename(args.riedel), generatedAt: riedel.generated_at || null };
  } else {
    const rel = await getJson(`https://api.github.com/repos/${RIEDEL_REPO}/releases/latest`);
    const asset = (rel.assets || []).find((x) => x.name === 'all.json');
    if (!asset) throw new Error(`Riedel release ${rel.tag_name} has no all.json`);
    riedel = await getJson(asset.browser_download_url);
    meta.riedel = { from: rel.tag_name, publishedAt: rel.published_at, generatedAt: riedel.generated_at || null };
    const ageDays = (Date.parse(args.today) - Date.parse(rel.published_at)) / 864e5;
    if (ageDays > 21) warn(`Wikipedia dataset release ${rel.tag_name} is ${Math.round(ageDays)} days old - the upstream project may have stopped`);
  }
  if (args.visafreely) {
    visafreely = JSON.parse(fs.readFileSync(args.visafreely, 'utf8'));
    meta.visafreely = { from: path.basename(args.visafreely) };
  } else {
    visafreely = await getJson(VISAFREELY_URL);
    try {
      const [c] = await getJson(VISAFREELY_COMMITS);
      meta.visafreely = { from: c.sha.slice(0, 7), committedAt: c.commit.author.date, message: c.commit.message.split('\n')[0] };
      const ageDays = (Date.parse(args.today) - Date.parse(c.commit.author.date)) / 864e5;
      if (ageDays > 45) warn(`visafreely dataset last updated ${Math.round(ageDays)} days ago - the upstream project may have stopped`);
    } catch (e) {
      meta.visafreely = { from: 'main' };
      warn(`could not read visafreely commit date (${e.message})`);
    }
  }
  if (!riedel || typeof riedel.passports !== 'object') throw new Error('Wikipedia dataset: missing "passports"');
  if (!Array.isArray(visafreely)) throw new Error('visafreely dataset: expected an array of rows');
  if (Object.keys(riedel.passports).length < 150) throw new Error(`Wikipedia dataset: only ${Object.keys(riedel.passports).length} passports - refusing`);
  if (visafreely.length < 30000) throw new Error(`visafreely dataset: only ${visafreely.length} rows - refusing`);
  return { riedel, visafreely, meta };
}

const VF_STATUS = { 'visa free': 'visa-free', 'visa on arrival': 'visa-on-arrival', 'e-visa': 'e-visa', eta: 'eta', 'visa required': 'visa-required', 'no admission': 'visa-required' };
const WP_STATUS = { visa_free: 'visa-free', visa_on_arrival: 'visa-on-arrival', eta: 'eta', evisa: 'e-visa', visa_required: 'visa-required', permit_required: 'visa-required', admission_refused: 'visa-required' };
// Wikipedia lists these as "visa free" with an electronic authorisation in the notes.
const ETA_NOTE = /\b(ESTA|eTA|ETA|NZeTA|K-ETA|eVisitor|electronic travel authori[sz]ation)\b/;

const posDays = (n) => (Number.isInteger(n) && n > 0 && n <= 3650 ? n : null);

function shortNote(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('*')) || '';
  t = t
    .replace(/\[\d+\]/g, '')                          // citation markers
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')  // [url label] wiki links -> label
    .replace(/\[?https?:\/\/\S+\]?/g, '')             // bare URLs
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1') // [[page|label]] -> label
    .replace(/\[\[|\]\]/g, '')                        // stray wiki brackets
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  if (t.length > NOTE_MAX) t = t.slice(0, NOTE_MAX - 1).replace(/\s+\S*$/, '') + '…';
  return t;
}

function indexVisafreely(rows) {
  const idx = new Map();
  for (const r of rows) {
    const req = VF_STATUS[r.status];
    if (!req || !/^[A-Z]{2}$/.test(r.passport_code) || !/^[A-Z]{2}$/.test(r.destination_code)) continue;
    idx.set(`${r.passport_code}>${r.destination_code}`, {
      requirement: req,
      duration: posDays(r.max_stay_days),
      verified: r.verified === true,
      lastVerified: r.last_verified || null,
      noAdmission: r.status === 'no admission',
      sourceName: r.source_name || null,
    });
  }
  return idx;
}

function indexWikipedia(riedel) {
  const idx = new Map();
  const statusCounts = {};
  for (const [p, recs] of Object.entries(riedel.passports)) {
    const list = Array.isArray(recs) ? recs : recs.records || [];
    const byDest = new Map();
    for (const r of list) {
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      if (!r.destination || !/^[A-Z]{2}$/.test(r.destination)) continue;
      const cur = byDest.get(r.destination);
      const score = (r.area == null ? 2 : 0) + (r.is_territory_or_restricted ? 0 : 1);
      if (!cur || score > cur.score) byDest.set(r.destination, { r, score });
    }
    for (const [d, { r }] of byDest) {
      let req = WP_STATUS[r.status];
      if (!req) continue; // "special" / unmapped: no opinion
      if (req === 'visa-free' && ETA_NOTE.test(r.notes || '')) req = 'eta';
      idx.set(`${p}>${d}`, {
        requirement: req,
        duration: posDays(r.allowed_stay_days),
        note: r.status === 'admission_refused' ? 'Entry refused for holders of this passport.' : shortNote(r.notes),
        revision: r.source_revision || null,
      });
    }
  }
  return { idx, statusCounts };
}

function decide(existing, vf, wp, today) {
  const ours = existing && existing.verified && !(existing.validUntil && existing.validUntil < today);
  if (ours) return { entry: null, from: 'ours' };
  const nowIso = new Date().toISOString();
  if (vf && vf.verified) {
    const duration = vf.duration ?? (wp && wp.requirement === vf.requirement ? wp.duration : null);
    // Compact tag; the official source name/URL lives in the visafreely dataset.
    const e = { requirement: vf.requirement, duration, lastChecked: nowIso, source: `visafreely-official${vf.lastVerified ? `:${vf.lastVerified}` : ''}` };
    const note = vf.noAdmission ? 'Entry refused for holders of this passport.' : wp && wp.requirement === vf.requirement ? wp.note : null;
    if (note) e.notes = note;
    return { entry: e, from: 'visafreely-verified' };
  }
  if (wp) {
    const duration = wp.duration ?? (vf && vf.requirement === wp.requirement ? vf.duration : null) ?? (existing && existing.requirement === wp.requirement ? posDays(existing.duration) : null);
    const e = { requirement: wp.requirement, duration, lastChecked: nowIso, source: `wikipedia${wp.revision ? `:${wp.revision}` : ''}` };
    if (wp.note) e.notes = wp.note;
    return { entry: e, from: 'wikipedia' };
  }
  if (vf) {
    return { entry: { requirement: vf.requirement, duration: vf.duration, lastChecked: nowIso, source: 'visafreely-seed' }, from: 'visafreely-seed' };
  }
  return { entry: null, from: 'kept' };
}

function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '');
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '3.2.0';
}

async function main() {
  const args = parseArgs(process.argv);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${RULES_FILE}: ${e.message} - refusing to run`);
  }
  if (!data.rules || Object.keys(data.rules).length < 150) throw new Error('visa-rules.json looks corrupt - refusing to run');

  const { riedel, visafreely, meta } = await loadSources(args);
  const vfIdx = indexVisafreely(visafreely);
  const { idx: wpIdx, statusCounts } = indexWikipedia(riedel);

  const counts = { total: 0, changedRequirement: 0, changedDuration: 0, from: {} };
  const reviewOurs = [];      // our verified entries a source disagrees with
  const sourceConflicts = []; // official-verified vs Wikipedia disagreement
  const changes = [];

  for (const [p, dests] of Object.entries(data.rules)) {
    for (const [d, existing] of Object.entries(dests)) {
      counts.total++;
      const key = `${p}>${d}`;
      const vf = vfIdx.get(key);
      const wp = wpIdx.get(key);
      const { entry, from } = decide(existing, vf, wp, args.today);
      counts.from[from] = (counts.from[from] || 0) + 1;

      if (from === 'ours') {
        const other = vf && vf.verified ? vf : wp;
        if (other && other.requirement !== existing.requirement) reviewOurs.push(`${key}: ours ${existing.requirement}/${existing.duration ?? '-'} vs ${vf && vf.verified ? 'visafreely(official)' : 'Wikipedia'} ${other.requirement}/${other.duration ?? '-'}`);
        continue;
      }
      if (vf && vf.verified && wp && wp.requirement !== vf.requirement) sourceConflicts.push(`${key}: official ${vf.requirement}/${vf.duration ?? '-'} vs Wikipedia ${wp.requirement}/${wp.duration ?? '-'}`);
      if (!entry) continue;

      if (entry.requirement !== existing.requirement) {
        counts.changedRequirement++;
        changes.push(`${key}: ${existing.requirement}/${existing.duration ?? '-'} -> ${entry.requirement}/${entry.duration ?? '-'} (${from})`);
      } else if ((entry.duration ?? null) !== (existing.duration ?? null)) counts.changedDuration++;
      dests[d] = entry;
    }
  }

  const pct = (100 * counts.changedRequirement) / counts.total;
  const blocked = pct > args.maxChangePct && !args.allowLarge;

  const lines = [];
  lines.push(`# Visa data import ${args.today}`, '');
  lines.push(`Sources: Wikipedia dataset ${meta.riedel.from}${meta.riedel.publishedAt ? ` (${meta.riedel.publishedAt.slice(0, 10)})` : ''}; visafreely ${meta.visafreely.from}${meta.visafreely.committedAt ? ` (${meta.visafreely.committedAt.slice(0, 10)}, ${meta.visafreely.message})` : ''}.`, '');
  lines.push(`| | Count |`, `|---|---|`);
  lines.push(`| Pairs | ${counts.total} |`);
  for (const [k, v] of Object.entries(counts.from)) lines.push(`| Decided by ${k} | ${v} |`);
  lines.push(`| Requirement changed | ${counts.changedRequirement} (${pct.toFixed(2)}%) |`);
  lines.push(`| Duration changed only | ${counts.changedDuration} |`, '');
  lines.push(`Wikipedia status counts: ${JSON.stringify(statusCounts)}`, '');
  if (warnings.length) lines.push('## Warnings', ...warnings.map((w) => `- ${w}`), '');
  lines.push(`## Our hand-verified entries a source disagrees with (${reviewOurs.length}) - review`, ...reviewOurs.map((s) => `- ${s}`), '');
  lines.push(`## Official-verified vs Wikipedia disagreements (${sourceConflicts.length}) - official value used`, ...sourceConflicts.slice(0, 5000).map((s) => `- ${s}`), sourceConflicts.length > 5000 ? `- ...${sourceConflicts.length - 5000} more` : '', '');
  lines.push(`## Requirement changes (${changes.length})`, ...changes.slice(0, 10000).map((s) => `- ${s}`), changes.length > 10000 ? `- ...${changes.length - 10000} more` : '');
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, lines.join('\n') + '\n');

  console.log(`pairs ${counts.total}; requirement changed ${counts.changedRequirement} (${pct.toFixed(2)}%); duration-only ${counts.changedDuration}`);
  console.log('decided by', counts.from);
  console.log(`review (ours vs sources): ${reviewOurs.length}; official vs Wikipedia: ${sourceConflicts.length}`);
  console.log(`report: ${path.relative(ROOT, args.report)}`);

  if (blocked) {
    console.error(`BLOCKED: ${pct.toFixed(2)}% of pairs changed requirement (limit ${args.maxChangePct}%). Nothing written. Review the report; rerun with --allow-large if it is genuine.`);
    process.exit(2);
  }
  if (args.dryRun) { console.log('dry run: nothing written'); return; }
  if (counts.changedRequirement === 0 && counts.changedDuration === 0) { console.log('no changes: nothing written'); return; }

  const now = new Date();
  data.version = bumpPatch(data.version);
  data.lastUpdated = now.toISOString();
  data.dataVersion = now.getTime();
  data.source = 'visafreely.com dataset (official-source verified) + Wikipedia via Riedel-David/Visa-requirements';
  data.notes = 'Free open data. Attribution required: see "attribution".';
  data.attribution = ATTRIBUTION;
  data.importedFrom = meta;
  const ordered = { version: data.version, lastUpdated: data.lastUpdated, dataVersion: data.dataVersion, source: data.source, notes: data.notes, attribution: data.attribution, importedFrom: data.importedFrom, rules: data.rules };
  fs.writeFileSync(RULES_FILE, JSON.stringify(ordered, null, 2) + '\n');
  fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: data.version, lastUpdated: data.lastUpdated, dataVersion: data.dataVersion }, null, 2) + '\n');
  console.log(`written: version ${data.version}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
