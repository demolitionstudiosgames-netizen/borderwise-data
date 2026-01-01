/**
 * Pro Tier Refresh Script - $4.99/month
 *
 * STRATEGY:
 * - 3,000 requests/month available
 * - 1 request/second rate limit (STRICT)
 * - Focus on refreshing priority passports (most likely users)
 * - Rotates through destinations each month
 *
 * With 199 destinations per passport and 3,000 requests/month:
 * - Can fully refresh ~15 passports per month
 * - Prioritizes most common user passports
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

// All 199 country codes (destinations)
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

// Priority passports - most likely user passports (ordered by priority)
// These will be refreshed on a rotating basis
const PRIORITY_PASSPORTS = [
  // Tier 1 - Most common users (refresh every month if possible)
  'GB', 'US', 'NG', 'GH', 'IN', 'PK',
  // Tier 2 - Common users
  'CA', 'AU', 'IE', 'NZ', 'ZA', 'KE', 'JM',
  // Tier 3 - Other significant
  'BD', 'PH', 'EG', 'MA', 'TT', 'SL', 'ZM', 'UG',
  // Tier 4 - Additional African/Caribbean diaspora
  'CM', 'SN', 'CI', 'TZ', 'ET', 'RW', 'BB', 'GD',
  // Tier 5 - European/Asian
  'DE', 'FR', 'IT', 'ES', 'NL', 'PL', 'CN', 'JP', 'KR',
];

// Configuration for Pro tier
const REQUEST_DELAY_MS = 1100; // 1.1 seconds (safely under 1 req/sec limit)
const REQUESTS_PER_RUN = 2800; // Leave buffer under 3,000
const SAVE_INTERVAL = 50;      // Save progress every 50 requests
const MAX_RETRIES = 3;
const BACKOFF_MULTIPLIER = 2;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function loadProgress() {
  const progressPath = path.join(__dirname, '..', 'data', 'pro-refresh-progress.json');
  try {
    if (fs.existsSync(progressPath)) {
      return JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    }
  } catch {}
  return {
    lastRefreshMonth: null,
    passportIndex: 0,      // Which passport in PRIORITY_PASSPORTS to start from
    destinationIndex: 0,   // Which destination to start from for current passport
    totalRequestsThisMonth: 0,
  };
}

function saveProgress(progress) {
  const progressPath = path.join(__dirname, '..', 'data', 'pro-refresh-progress.json');
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
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

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  console.log('=== Pro Tier Refresh ($4.99/month) ===');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Rate limit: 1 request/second`);
  console.log(`Max requests this run: ${REQUESTS_PER_RUN}`);
  console.log(`Priority passports: ${PRIORITY_PASSPORTS.length}`);
  console.log();

  const data = loadData();
  const progress = loadProgress();
  const currentMonth = getCurrentMonth();

  // Reset progress if new month
  if (progress.lastRefreshMonth !== currentMonth) {
    console.log(`New month detected (${currentMonth}). Resetting progress.`);
    progress.lastRefreshMonth = currentMonth;
    progress.passportIndex = 0;
    progress.destinationIndex = 0;
    progress.totalRequestsThisMonth = 0;
  }

  console.log(`Starting from passport index: ${progress.passportIndex} (${PRIORITY_PASSPORTS[progress.passportIndex]})`);
  console.log(`Starting from destination index: ${progress.destinationIndex}`);
  console.log(`Requests already made this month: ${progress.totalRequestsThisMonth}`);
  console.log();

  let requestsThisRun = 0;
  let updated = 0;
  let errors = 0;
  let rateLimited = false;

  // Process passports in priority order
  for (let pIdx = progress.passportIndex; pIdx < PRIORITY_PASSPORTS.length; pIdx++) {
    if (rateLimited || requestsThisRun >= REQUESTS_PER_RUN) break;

    const passport = PRIORITY_PASSPORTS[pIdx];
    console.log(`\nProcessing ${passport} (priority ${pIdx + 1}/${PRIORITY_PASSPORTS.length})...`);

    // Initialize passport in data if needed
    if (!data.rules[passport]) {
      data.rules[passport] = {};
    }

    // Start from saved destination index if resuming current passport
    const startDestIdx = (pIdx === progress.passportIndex) ? progress.destinationIndex : 0;

    for (let dIdx = startDestIdx; dIdx < ALL_COUNTRIES.length; dIdx++) {
      if (rateLimited || requestsThisRun >= REQUESTS_PER_RUN) break;

      const destination = ALL_COUNTRIES[dIdx];
      if (passport === destination) continue;

      const result = await checkVisaRequirement(passport, destination);
      requestsThisRun++;
      progress.totalRequestsThisMonth++;

      if (result?.rateLimited) {
        console.log('\n!! Rate limit hit - stopping');
        rateLimited = true;
        break;
      }

      if (result) {
        data.rules[passport][destination] = result;
        updated++;
        process.stdout.write('.');
      } else {
        errors++;
        process.stdout.write('x');
      }

      // Update progress
      progress.passportIndex = pIdx;
      progress.destinationIndex = dIdx + 1;

      // Save periodically
      if (requestsThisRun % SAVE_INTERVAL === 0) {
        saveProgress(progress);
        saveData(data);
        console.log(`\n  [Saved] ${requestsThisRun} requests this run, ${updated} updated`);
      }

      await sleep(REQUEST_DELAY_MS);
    }

    // Completed this passport, move to next
    if (!rateLimited && requestsThisRun < REQUESTS_PER_RUN) {
      progress.passportIndex = pIdx + 1;
      progress.destinationIndex = 0;
      console.log(`\n  Completed ${passport}`);
    }
  }

  // Final save
  saveProgress(progress);
  saveData(data);

  // Calculate stats
  const passportsCovered = Object.keys(data.rules).length;
  const totalRules = Object.values(data.rules).reduce((sum, dests) => sum + Object.keys(dests).length, 0);

  console.log();
  console.log('=== Summary ===');
  console.log(`Requests this run: ${requestsThisRun}`);
  console.log(`Updated: ${updated}`);
  console.log(`Errors: ${errors}`);
  console.log(`Rate limited: ${rateLimited ? 'YES' : 'No'}`);
  console.log();
  console.log('=== Progress ===');
  console.log(`Current month: ${currentMonth}`);
  console.log(`Total requests this month: ${progress.totalRequestsThisMonth}`);
  console.log(`Next passport: ${PRIORITY_PASSPORTS[progress.passportIndex] || 'DONE'}`);
  console.log(`Passports fully refreshed: ${progress.passportIndex}/${PRIORITY_PASSPORTS.length}`);
  console.log();
  console.log('=== Database Status ===');
  console.log(`Passports in DB: ${passportsCovered}`);
  console.log(`Total rules in DB: ${totalRules}`);
  console.log();

  // Estimate time for this run
  const estimatedTime = Math.ceil(requestsThisRun * REQUEST_DELAY_MS / 1000 / 60);
  console.log(`Run time: ~${estimatedTime} minutes`);
}

main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
