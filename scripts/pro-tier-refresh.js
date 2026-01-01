/**
 * Pro Tier Smart Refresh Script - $4.99/month
 *
 * SMART REFRESH STRATEGY:
 * ========================
 * Problem: 39,402 pairs to keep fresh with only 3,000 requests/month
 * Solution: Age-based prioritization with rolling refresh
 *
 * HOW IT WORKS:
 * 1. Scans ALL existing entries and sorts by lastChecked date (oldest first)
 * 2. SKIPS any entry updated within the last 30 days (fresh enough)
 * 3. Prioritizes entries that are 60+ days old (most stale)
 * 4. Then fills remaining quota with 30-60 day old entries
 *
 * MATH:
 * - 39,402 total pairs
 * - 3,000 requests/month
 * - Full cycle = ~13 months
 * - Each entry refreshed roughly every 13 months
 * - Nothing should go more than ~14 months without refresh
 *
 * PRIORITY ORDER:
 * 1. Entries 60+ days old (CRITICAL - refresh these first)
 * 2. Entries 30-60 days old (STALE - refresh if quota remains)
 * 3. Entries <30 days old (FRESH - skip entirely)
 * 4. Missing entries (no data yet - fill gaps)
 */

const fs = require('fs');
const path = require('path');

const API_URL = 'https://visa-requirement.p.rapidapi.com/v2/visa/check';
const API_HOST = 'visa-requirement.p.rapidapi.com';
const API_KEY = process.env.RAPIDAPI_KEY;

if (!API_KEY) {
  console.error('ERROR: RAPIDAPI_KEY environment variable is not set');
  process.exit(1);
}

// All 199 country codes
const ALL_COUNTRIES = [
  'AF', 'AL', 'DZ', 'AD', 'AO', 'AG', 'AR', 'AM', 'AU', 'AT', 'AZ',
  'BS', 'BH', 'BD', 'BB', 'BY', 'BE', 'BZ', 'BJ', 'BT', 'BO', 'BA', 'BW', 'BR', 'BN', 'BG', 'BF', 'BI',
  'KH', 'CM', 'CA', 'CV', 'CF', 'TD', 'CL', 'CN', 'CO', 'KM', 'CG', 'CD', 'CR', 'CI', 'HR', 'CU', 'CY', 'CZ',
  'DK', 'DJ', 'DM', 'DO',
  'EC', 'EG', 'SV', 'GQ', 'ER', 'EE', 'SZ', 'ET',
  'FJ', 'FI', 'FR',
  'GA', 'GM', 'GE', 'DE', 'GH', 'GR', 'GD', 'GT', 'GN', 'GW', 'GY',
  'HT', 'HN', 'HK', 'HU',
  'IS', 'IN', 'ID', 'IR', 'IQ', 'IE', 'IL', 'IT',
  'JM', 'JP', 'JO',
  'KZ', 'KE', 'KI', 'XK', 'KP', 'KR', 'KW', 'KG',
  'LA', 'LV', 'LB', 'LS', 'LR', 'LY', 'LI', 'LT', 'LU',
  'MO', 'MG', 'MW', 'MY', 'MV', 'ML', 'MT', 'MH', 'MR', 'MU', 'MX', 'FM', 'MD', 'MC', 'MN', 'ME', 'MA', 'MZ', 'MM',
  'NA', 'NR', 'NP', 'NL', 'NZ', 'NI', 'NE', 'NG', 'MK', 'NO',
  'OM',
  'PK', 'PW', 'PS', 'PA', 'PG', 'PY', 'PE', 'PH', 'PL', 'PT',
  'QA',
  'RO', 'RU', 'RW',
  'KN', 'LC', 'VC', 'WS', 'SM', 'ST', 'SA', 'SN', 'RS', 'SC', 'SL', 'SG', 'SK', 'SI', 'SB', 'SO', 'ZA', 'SS', 'ES', 'LK', 'SD', 'SR', 'SE', 'CH', 'SY',
  'TW', 'TJ', 'TZ', 'TH', 'TL', 'TG', 'TO', 'TT', 'TN', 'TR', 'TM', 'TV',
  'UG', 'UA', 'AE', 'GB', 'US', 'UY', 'UZ',
  'VU', 'VA', 'VE', 'VN',
  'YE',
  'ZM', 'ZW'
];

// Priority passports - these get weighted higher when sorting
const PRIORITY_PASSPORTS = [
  'GB', 'US', 'NG', 'GH', 'IN', 'PK', 'CA', 'AU', 'IE', 'NZ', 'ZA', 'KE', 'JM',
  'BD', 'PH', 'EG', 'MA', 'TT', 'SL', 'ZM', 'UG', 'CM', 'SN', 'CI', 'TZ', 'ET',
];

// Configuration for Pro tier (1 request/second)
const REQUEST_DELAY_MS = 1100;  // 1.1 seconds (safely under 1 req/sec)
const REQUESTS_PER_RUN = 2800;  // Leave buffer under 3,000
const SAVE_INTERVAL = 50;       // Save progress every 50 requests
const MAX_RETRIES = 3;
const BACKOFF_MULTIPLIER = 2;

// Age thresholds (in days)
const FRESH_THRESHOLD_DAYS = 30;    // Skip if updated within 30 days
const STALE_THRESHOLD_DAYS = 60;    // Priority refresh if older than 60 days

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getDaysSinceUpdate(lastChecked) {
  if (!lastChecked) return Infinity; // Never checked = infinitely old
  const lastDate = new Date(lastChecked);
  const now = new Date();
  const diffMs = now - lastDate;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function loadData() {
  const dataPath = path.join(__dirname, '..', 'data', 'visa-rules.json');
  try {
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch {
    return {
      version: '3.0.0',
      lastUpdated: null,
      dataVersion: 0,
      source: 'Mixed sources',
      rules: {},
    };
  }
}

function saveData(data) {
  const dataPath = path.join(__dirname, '..', 'data', 'visa-rules.json');
  data.lastUpdated = new Date().toISOString();
  data.dataVersion = Date.now();
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

  const versionPath = path.join(__dirname, '..', 'data', 'version.json');
  fs.writeFileSync(versionPath, JSON.stringify({
    version: data.version,
    lastUpdated: data.lastUpdated,
    dataVersion: data.dataVersion,
  }, null, 2));
}

/**
 * Analyze database and generate prioritized refresh queue
 */
function generateRefreshQueue(data) {
  const queue = [];
  const stats = {
    total: 0,
    fresh: 0,      // <30 days - SKIP
    stale: 0,      // 30-60 days
    critical: 0,   // 60+ days
    missing: 0,    // No data
  };

  const now = new Date();

  // Check all possible passport-destination pairs
  for (const passport of ALL_COUNTRIES) {
    for (const destination of ALL_COUNTRIES) {
      if (passport === destination) continue;
      stats.total++;

      const entry = data.rules[passport]?.[destination];
      const lastChecked = entry?.lastChecked;
      const daysSince = getDaysSinceUpdate(lastChecked);

      // Categorize and potentially add to queue
      if (!lastChecked) {
        // Missing - needs data
        stats.missing++;
        queue.push({
          passport,
          destination,
          daysSince: Infinity,
          priority: PRIORITY_PASSPORTS.includes(passport) ? 1 : 2,
          category: 'missing',
        });
      } else if (daysSince >= STALE_THRESHOLD_DAYS) {
        // Critical - 60+ days old
        stats.critical++;
        queue.push({
          passport,
          destination,
          daysSince,
          priority: PRIORITY_PASSPORTS.includes(passport) ? 1 : 2,
          category: 'critical',
        });
      } else if (daysSince >= FRESH_THRESHOLD_DAYS) {
        // Stale - 30-60 days old
        stats.stale++;
        queue.push({
          passport,
          destination,
          daysSince,
          priority: PRIORITY_PASSPORTS.includes(passport) ? 3 : 4,
          category: 'stale',
        });
      } else {
        // Fresh - skip
        stats.fresh++;
      }
    }
  }

  // Sort queue: priority first, then by age (oldest first)
  queue.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.daysSince - a.daysSince; // Older first
  });

  return { queue, stats };
}

async function checkVisaRequirement(passport, destination, retryCount = 0) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-rapidapi-host': API_HOST,
        'x-rapidapi-key': API_KEY,
      },
      body: new URLSearchParams({
        passport: passport.toUpperCase(),
        destination: destination.toUpperCase(),
      }).toString(),
    });

    if (response.status === 429) {
      if (retryCount < MAX_RETRIES) {
        const backoffMs = 2000 * Math.pow(BACKOFF_MULTIPLIER, retryCount);
        console.log(`  Rate limited, waiting ${backoffMs/1000}s...`);
        await sleep(backoffMs);
        return checkVisaRequirement(passport, destination, retryCount + 1);
      }
      return { rateLimited: true };
    }

    if (!response.ok) {
      console.warn(`  Error ${passport}->${destination}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return {
      requirement: normalizeRequirement(data.requirement || data.visa_requirement),
      duration: data.duration || data.stay_duration || data.allowed_stay || null,
      notes: data.notes || data.additional_info || null,
      lastChecked: new Date().toISOString(),
      source: 'rapidapi-pro',
    };
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      const backoffMs = 1000 * Math.pow(BACKOFF_MULTIPLIER, retryCount);
      await sleep(backoffMs);
      return checkVisaRequirement(passport, destination, retryCount + 1);
    }
    console.error(`  Failed ${passport}->${destination}: ${error.message}`);
    return null;
  }
}

function normalizeRequirement(requirement) {
  if (!requirement) return 'unknown';
  const normalized = requirement.toLowerCase().trim();

  if (normalized.includes('visa free') || normalized.includes('visa-free') || normalized === 'free') {
    return 'visa-free';
  }
  if (normalized.includes('visa on arrival') || normalized.includes('voa')) {
    return 'visa-on-arrival';
  }
  if (normalized.includes('e-visa') || normalized.includes('evisa') || normalized.includes('electronic visa')) {
    return 'e-visa';
  }
  if (normalized.includes('eta') || normalized.includes('electronic travel')) {
    return 'eta';
  }
  if (normalized.includes('required') || normalized.includes('visa')) {
    return 'visa-required';
  }
  return 'unknown';
}

async function main() {
  console.log('==============================================');
  console.log('  Pro Tier SMART Refresh ($4.99/month)');
  console.log('==============================================');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Rate limit: 1 request/second`);
  console.log(`Max requests this run: ${REQUESTS_PER_RUN}`);
  console.log();

  const data = loadData();

  // Analyze database and generate refresh queue
  console.log('Analyzing database for stale entries...');
  const { queue, stats } = generateRefreshQueue(data);

  console.log();
  console.log('=== Database Age Analysis ===');
  console.log(`Total pairs: ${stats.total.toLocaleString()}`);
  console.log(`Fresh (<${FRESH_THRESHOLD_DAYS} days): ${stats.fresh.toLocaleString()} - SKIPPING`);
  console.log(`Stale (${FRESH_THRESHOLD_DAYS}-${STALE_THRESHOLD_DAYS} days): ${stats.stale.toLocaleString()}`);
  console.log(`Critical (${STALE_THRESHOLD_DAYS}+ days): ${stats.critical.toLocaleString()}`);
  console.log(`Missing (no data): ${stats.missing.toLocaleString()}`);
  console.log();
  console.log(`Entries needing refresh: ${queue.length.toLocaleString()}`);
  console.log(`Will process: ${Math.min(queue.length, REQUESTS_PER_RUN).toLocaleString()} this run`);
  console.log();

  if (queue.length === 0) {
    console.log('All entries are fresh! Nothing to refresh.');
    return;
  }

  // Process the queue
  let requestsThisRun = 0;
  let updated = 0;
  let errors = 0;
  let rateLimited = false;

  const categoriesToProcess = { missing: 0, critical: 0, stale: 0 };
  const pairsToProcess = queue.slice(0, REQUESTS_PER_RUN);

  console.log('Starting refresh...');
  console.log();

  for (let i = 0; i < pairsToProcess.length; i++) {
    if (rateLimited) break;

    const { passport, destination, daysSince, category } = pairsToProcess[i];

    // Progress indicator
    if (i > 0 && i % 100 === 0) {
      const percent = (i / pairsToProcess.length * 100).toFixed(1);
      console.log(`[${percent}%] Processed ${i}/${pairsToProcess.length} (${updated} updated, ${errors} errors)`);
    }

    const result = await checkVisaRequirement(passport, destination);
    requestsThisRun++;

    if (result?.rateLimited) {
      console.log('\n!! Rate limit hit - stopping');
      rateLimited = true;
      break;
    }

    if (result) {
      // Initialize passport if needed
      if (!data.rules[passport]) {
        data.rules[passport] = {};
      }
      data.rules[passport][destination] = result;
      updated++;
      categoriesToProcess[category]++;
      process.stdout.write('.');
    } else {
      errors++;
      process.stdout.write('x');
    }

    // Save periodically
    if (requestsThisRun % SAVE_INTERVAL === 0) {
      saveData(data);
      console.log(`\n  [Saved] ${requestsThisRun} requests, ${updated} updated`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // Final save
  saveData(data);

  // Calculate final stats
  const passportsCovered = Object.keys(data.rules).length;
  const totalRules = Object.values(data.rules).reduce((sum, dests) => sum + Object.keys(dests).length, 0);

  console.log();
  console.log();
  console.log('==============================================');
  console.log('  REFRESH COMPLETE');
  console.log('==============================================');
  console.log();
  console.log('=== This Run ===');
  console.log(`Requests made: ${requestsThisRun}`);
  console.log(`Entries updated: ${updated}`);
  console.log(`Errors: ${errors}`);
  console.log(`Rate limited: ${rateLimited ? 'YES' : 'No'}`);
  console.log();
  console.log('=== Categories Refreshed ===');
  console.log(`Missing (filled gaps): ${categoriesToProcess.missing}`);
  console.log(`Critical (60+ days): ${categoriesToProcess.critical}`);
  console.log(`Stale (30-60 days): ${categoriesToProcess.stale}`);
  console.log();
  console.log('=== Remaining Queue ===');
  const remaining = queue.length - requestsThisRun;
  console.log(`Still need refresh: ${remaining.toLocaleString()} entries`);
  console.log(`Estimated runs to clear: ${Math.ceil(remaining / REQUESTS_PER_RUN)}`);
  console.log();
  console.log('=== Database Status ===');
  console.log(`Passports in DB: ${passportsCovered}`);
  console.log(`Total rules in DB: ${totalRules.toLocaleString()}`);
  console.log();

  // Estimate refresh cycle
  const monthsForFullCycle = Math.ceil(stats.total / REQUESTS_PER_RUN);
  console.log('=== Refresh Cycle Estimate ===');
  console.log(`Full database: ${stats.total.toLocaleString()} pairs`);
  console.log(`Monthly capacity: ${REQUESTS_PER_RUN.toLocaleString()} requests`);
  console.log(`Full cycle time: ~${monthsForFullCycle} months`);
  console.log();

  // Runtime estimate
  const runtimeMinutes = Math.ceil(requestsThisRun * REQUEST_DELAY_MS / 1000 / 60);
  console.log(`This run took: ~${runtimeMinutes} minutes`);
}

main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
