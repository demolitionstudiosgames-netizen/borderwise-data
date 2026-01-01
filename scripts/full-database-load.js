/**
 * Full Database Load Script - Ultra Tier ($14.99/month)
 *
 * STRATEGY:
 * - 30,000 requests/month available
 * - 10 requests/second rate limit
 * - 199 passports × 199 destinations = 39,601 total pairs
 * - Will complete in ~2 runs (or one month if running continuously)
 *
 * Features:
 * - Progress tracking for resumable runs
 * - Respects rate limits (100ms between requests = 10/sec)
 * - Exponential backoff on errors
 * - Saves progress every 100 requests
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_URL = 'https://visa-requirement.p.rapidapi.com/v2/visa/check';
const API_HOST = 'visa-requirement.p.rapidapi.com';
const API_KEY = process.env.RAPIDAPI_KEY;

if (!API_KEY) {
  console.error('ERROR: RAPIDAPI_KEY environment variable is not set');
  process.exit(1);
}

// All 199 country codes from the app
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

// Priority passports - most likely user passports (do these first)
const PRIORITY_PASSPORTS = [
  'GB', 'US', 'CA', 'AU', 'NZ', 'IE',  // English-speaking developed
  'NG', 'GH', 'KE', 'ZA', 'JM', 'TT',  // African/Caribbean diaspora
  'IN', 'PK', 'BD', 'LK', 'NP',        // South Asian
  'PH', 'VN', 'TH', 'MY', 'SG', 'ID',  // Southeast Asian
  'DE', 'FR', 'IT', 'ES', 'NL', 'PT',  // European
  'BR', 'MX', 'CO', 'AR', 'CL', 'PE',  // Latin American
  'CN', 'JP', 'KR', 'TW', 'HK',        // East Asian
  'AE', 'SA', 'QA', 'KW', 'BH',        // Gulf states
  'EG', 'MA', 'TN', 'DZ',              // North African
  'TR', 'IL', 'RU', 'UA', 'PL',        // Other significant
];

// Configuration
const REQUEST_DELAY_MS = 120; // 120ms = ~8 requests/sec (safe margin under 10/sec)
const SAVE_INTERVAL = 100;   // Save progress every 100 requests
const GIT_COMMIT_INTERVAL = 500; // Commit to git every 500 requests - NEVER LOSE MORE THAN 500
const MAX_RETRIES = 3;
const BACKOFF_MULTIPLIER = 2;
const REQUESTS_PER_RUN = 28000; // Leave some buffer under 30k

/**
 * Commit progress to git - called from within the script
 * This ensures data is pushed even if the job is killed
 */
function gitCommitProgress(requestCount) {
  try {
    console.log(`\n  [GIT] Committing ${requestCount} requests to repository...`);
    execSync('git add data/', { stdio: 'pipe' });

    // Check if there are changes to commit
    try {
      execSync('git diff --staged --quiet', { stdio: 'pipe' });
      console.log('  [GIT] No changes to commit');
      return;
    } catch {
      // There are changes (diff returns non-zero when there are diffs)
    }

    const commitMsg = `Progress: ${requestCount} requests - ${new Date().toISOString()}`;
    execSync(`git commit -m "${commitMsg}"`, { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('  [GIT] Committed and pushed successfully!\n');
  } catch (error) {
    console.error('  [GIT] Failed to commit:', error.message);
  }
}

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
        const backoffMs = 1000 * Math.pow(BACKOFF_MULTIPLIER, retryCount + 1);
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
    };
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      const backoffMs = 500 * Math.pow(BACKOFF_MULTIPLIER, retryCount);
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
      source: 'Travel Buddy API',
      rules: {},
    };
  }
}

function loadProgress() {
  const progressPath = path.join(__dirname, '..', 'data', 'full-load-progress.json');
  try {
    if (fs.existsSync(progressPath)) {
      return JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    }
  } catch {}
  return {
    completedPairs: [],
    lastPassport: null,
    lastDestination: null,
    totalRequests: 0,
    startedAt: new Date().toISOString(),
  };
}

function saveProgress(progress) {
  const progressPath = path.join(__dirname, '..', 'data', 'full-load-progress.json');
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

function generateAllPairs() {
  const pairs = [];

  // Priority passports first (in order)
  for (const passport of PRIORITY_PASSPORTS) {
    for (const destination of ALL_COUNTRIES) {
      if (passport !== destination) {
        pairs.push([passport, destination]);
      }
    }
  }

  // Then remaining passports
  const remainingPassports = ALL_COUNTRIES.filter(c => !PRIORITY_PASSPORTS.includes(c));
  for (const passport of remainingPassports) {
    for (const destination of ALL_COUNTRIES) {
      if (passport !== destination) {
        pairs.push([passport, destination]);
      }
    }
  }

  return pairs;
}

async function main() {
  console.log('=== Full Database Load (Ultra Tier) ===');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Total countries: ${ALL_COUNTRIES.length}`);
  console.log(`Priority passports: ${PRIORITY_PASSPORTS.length}`);
  console.log(`Max requests this run: ${REQUESTS_PER_RUN}`);
  console.log(`Rate: ~${Math.floor(1000 / REQUEST_DELAY_MS)} requests/sec`);
  console.log();

  const data = loadData();
  const progress = loadProgress();
  const allPairs = generateAllPairs();

  const totalPairs = allPairs.length;
  console.log(`Total pairs to check: ${totalPairs}`);

  // Create a Set of completed pairs for fast lookup
  const completedSet = new Set(progress.completedPairs);
  console.log(`Already completed: ${completedSet.size}`);

  // Filter to only unchecked pairs
  const pendingPairs = allPairs.filter(([p, d]) => !completedSet.has(`${p}->${d}`));
  console.log(`Pending pairs: ${pendingPairs.length}`);
  console.log();

  if (pendingPairs.length === 0) {
    console.log('All pairs already checked! Database is complete.');
    return;
  }

  let requestsThisRun = 0;
  let updated = 0;
  let errors = 0;
  let rateLimited = false;

  const pairsToProcess = pendingPairs.slice(0, REQUESTS_PER_RUN);
  console.log(`Processing ${pairsToProcess.length} pairs this run...`);
  console.log();

  for (let i = 0; i < pairsToProcess.length; i++) {
    if (rateLimited) break;

    const [passport, destination] = pairsToProcess[i];

    // Progress indicator every 50 requests
    if (i > 0 && i % 50 === 0) {
      const percent = ((completedSet.size + i) / totalPairs * 100).toFixed(1);
      console.log(`[${percent}%] Processing ${passport}... (${i}/${pairsToProcess.length} this run)`);
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
    } else {
      errors++;
    }

    // Mark as completed
    completedSet.add(`${passport}->${destination}`);

    // Save progress periodically
    if (requestsThisRun % SAVE_INTERVAL === 0) {
      progress.completedPairs = Array.from(completedSet);
      progress.totalRequests += SAVE_INTERVAL;
      progress.lastPassport = passport;
      progress.lastDestination = destination;
      saveProgress(progress);
      saveData(data);
      console.log(`  [Saved] ${requestsThisRun} requests, ${updated} updated`);
    }

    // GIT COMMIT every 500 requests - CRITICAL: prevents data loss
    if (requestsThisRun % GIT_COMMIT_INTERVAL === 0) {
      gitCommitProgress(requestsThisRun);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // Final save
  progress.completedPairs = Array.from(completedSet);
  progress.totalRequests += requestsThisRun % SAVE_INTERVAL;
  saveProgress(progress);
  saveData(data);

  // Final git commit
  gitCommitProgress(requestsThisRun);

  // Calculate stats
  const passportsCovered = new Set(Object.keys(data.rules)).size;
  const totalRules = Object.values(data.rules).reduce((sum, dests) => sum + Object.keys(dests).length, 0);

  console.log();
  console.log('=== Summary ===');
  console.log(`Requests this run: ${requestsThisRun}`);
  console.log(`Updated: ${updated}`);
  console.log(`Errors: ${errors}`);
  console.log(`Rate limited: ${rateLimited ? 'YES' : 'No'}`);
  console.log();
  console.log('=== Database Status ===');
  console.log(`Passports covered: ${passportsCovered}`);
  console.log(`Total rules in DB: ${totalRules}`);
  console.log(`Completion: ${(completedSet.size / totalPairs * 100).toFixed(1)}%`);
  console.log(`Remaining pairs: ${totalPairs - completedSet.size}`);

  if (completedSet.size >= totalPairs) {
    console.log();
    console.log('DATABASE COMPLETE! All passport/destination pairs have been checked.');
  }
}

main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
