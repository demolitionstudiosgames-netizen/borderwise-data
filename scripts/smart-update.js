/**
 * Smart Visa Data Update Script
 *
 * INTELLIGENT LIFECYCLE TRACKING:
 * - Tracks when each passport/destination pair was last updated
 * - Prioritizes pairs that have NEVER been updated (fill gaps first)
 * - Then updates the OLDEST data (stale refresh)
 * - Skips anything updated within the last 30 days
 * - NEVER overwrites good data with "unknown" or errors
 *
 * With 120 requests/month (30/week), this system will:
 * - First fill all missing data
 * - Then keep everything fresh on a rotation
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

// Configuration
const REQUESTS_PER_RUN = 30;
const REQUEST_DELAY_MS = 3000;
const MAX_RETRIES = 3;
const BACKOFF_MULTIPLIER = 2;
const SKIP_IF_UPDATED_WITHIN_DAYS = 30; // Don't update if updated within 30 days

// Priority passports (most likely to be used by app users)
const PRIORITY_PASSPORTS = ['GB', 'US', 'NG', 'GH', 'IN', 'ZA', 'AU', 'CA', 'DE', 'FR'];

// All destination countries (195 countries)
const ALL_DESTINATIONS = [
  'AF', 'AL', 'DZ', 'AD', 'AO', 'AG', 'AR', 'AM', 'AU', 'AT',
  'AZ', 'BS', 'BH', 'BD', 'BB', 'BY', 'BE', 'BZ', 'BJ', 'BT',
  'BO', 'BA', 'BW', 'BR', 'BN', 'BG', 'BF', 'BI', 'KH', 'CM',
  'CA', 'CV', 'CF', 'TD', 'CL', 'CN', 'CO', 'KM', 'CG', 'CD',
  'CR', 'CI', 'HR', 'CU', 'CY', 'CZ', 'DK', 'DJ', 'DM', 'DO',
  'EC', 'EG', 'SV', 'GQ', 'ER', 'EE', 'SZ', 'ET', 'FJ', 'FI',
  'FR', 'GA', 'GM', 'GE', 'DE', 'GH', 'GR', 'GD', 'GT', 'GN',
  'GW', 'GY', 'HT', 'HN', 'HU', 'IS', 'IN', 'ID', 'IR', 'IQ',
  'IE', 'IL', 'IT', 'JM', 'JP', 'JO', 'KZ', 'KE', 'KI', 'KP',
  'KR', 'KW', 'KG', 'LA', 'LV', 'LB', 'LS', 'LR', 'LY', 'LI',
  'LT', 'LU', 'MG', 'MW', 'MY', 'MV', 'ML', 'MT', 'MH', 'MR',
  'MU', 'MX', 'FM', 'MD', 'MC', 'MN', 'ME', 'MA', 'MZ', 'MM',
  'NA', 'NR', 'NP', 'NL', 'NZ', 'NI', 'NE', 'NG', 'NO', 'OM',
  'PK', 'PW', 'PA', 'PG', 'PY', 'PE', 'PH', 'PL', 'PT', 'QA',
  'RO', 'RU', 'RW', 'KN', 'LC', 'VC', 'WS', 'SM', 'ST', 'SA',
  'SN', 'RS', 'SC', 'SL', 'SG', 'SK', 'SI', 'SB', 'SO', 'ZA',
  'SS', 'ES', 'LK', 'SD', 'SR', 'SE', 'CH', 'SY', 'TW', 'TJ',
  'TZ', 'TH', 'TL', 'TG', 'TO', 'TT', 'TN', 'TR', 'TM', 'TV',
  'UG', 'UA', 'AE', 'GB', 'US', 'UY', 'UZ', 'VU', 'VA', 'VE',
  'VN', 'YE', 'ZM', 'ZW'
];

// File paths
const DATA_PATH = path.join(__dirname, '..', 'data', 'visa-rules.json');
const LIFECYCLE_PATH = path.join(__dirname, '..', 'data', 'lifecycle.json');
const VERSION_PATH = path.join(__dirname, '..', 'data', 'version.json');

/**
 * Load visa rules data
 */
function loadData() {
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
}

/**
 * Load lifecycle tracking data
 */
function loadLifecycle() {
  try {
    if (fs.existsSync(LIFECYCLE_PATH)) {
      return JSON.parse(fs.readFileSync(LIFECYCLE_PATH, 'utf8'));
    }
  } catch (error) {
    console.log('Creating new lifecycle tracking file...');
  }
  return { lastUpdates: {}, stats: { totalPairs: 0, updatedPairs: 0 } };
}

/**
 * Save lifecycle tracking data
 */
function saveLifecycle(lifecycle) {
  fs.writeFileSync(LIFECYCLE_PATH, JSON.stringify(lifecycle, null, 2));
}

/**
 * Save visa rules data
 */
function saveData(data) {
  data.lastUpdated = new Date().toISOString();
  data.dataVersion = Date.now();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

  fs.writeFileSync(VERSION_PATH, JSON.stringify({
    version: data.version,
    lastUpdated: data.lastUpdated,
    dataVersion: data.dataVersion,
  }, null, 2));
}

/**
 * Get pairs that need updating, sorted by priority
 */
function getPairsToUpdate(data, lifecycle) {
  const now = Date.now();
  const skipThreshold = SKIP_IF_UPDATED_WITHIN_DAYS * 24 * 60 * 60 * 1000;

  const pairs = [];

  for (const passport of PRIORITY_PASSPORTS) {
    for (const destination of ALL_DESTINATIONS) {
      // Skip same country
      if (passport === destination) continue;

      const lastUpdate = lifecycle.lastUpdates?.[passport]?.[destination];
      const currentData = data.rules?.[passport]?.[destination];

      // Calculate priority score (lower = higher priority)
      let priority;
      let reason;

      if (!currentData || currentData.requirement === 'unknown') {
        // Never updated or has unknown - HIGHEST priority
        priority = 0;
        reason = 'missing/unknown';
      } else if (!lastUpdate) {
        // Has data but no update record - high priority
        priority = 1;
        reason = 'no update record';
      } else {
        const timeSinceUpdate = now - new Date(lastUpdate).getTime();

        if (timeSinceUpdate < skipThreshold) {
          // Recently updated - skip
          continue;
        }

        // Older data = higher priority (lower number)
        priority = 2 + (timeSinceUpdate / (1000 * 60 * 60 * 24)); // Days since update
        reason = `${Math.floor(timeSinceUpdate / (1000 * 60 * 60 * 24))} days old`;
      }

      pairs.push({ passport, destination, priority, reason });
    }
  }

  // Sort by priority (lowest first = highest priority)
  pairs.sort((a, b) => a.priority - b.priority);

  return pairs;
}

/**
 * Normalize visa requirement to standard format
 */
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

/**
 * Sleep helper
 */
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check visa requirement from API
 */
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
        const backoffMs = REQUEST_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retryCount + 1);
        console.log(`  Rate limited, waiting ${backoffMs/1000}s...`);
        await sleep(backoffMs);
        return checkVisaRequirement(passport, destination, retryCount + 1);
      }
      return { rateLimited: true };
    }

    if (!response.ok) {
      console.warn(`  API error: ${response.status}`);
      return null;
    }

    const responseData = await response.json();

    // Check for quota exceeded
    if (responseData.message && (responseData.message.includes('exceeded') || responseData.message.includes('quota'))) {
      console.log(`\n!! QUOTA EXCEEDED - stopping to preserve data`);
      return { quotaExceeded: true };
    }

    const requirement = normalizeRequirement(responseData.requirement || responseData.visa_requirement);

    // NEVER return unknown - it would overwrite good data
    if (requirement === 'unknown') {
      console.log(`  Unrecognized API response:`, JSON.stringify(responseData).substring(0, 100));
      return null;
    }

    return {
      requirement,
      duration: responseData.duration || responseData.stay_duration || responseData.allowed_stay || null,
      notes: responseData.notes || responseData.additional_info || null,
    };
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      const backoffMs = REQUEST_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retryCount);
      console.log(`  Network error, retrying in ${backoffMs/1000}s...`);
      await sleep(backoffMs);
      return checkVisaRequirement(passport, destination, retryCount + 1);
    }
    console.error(`  Failed after ${MAX_RETRIES} retries: ${error.message}`);
    return null;
  }
}

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('SMART VISA DATA UPDATE');
  console.log('='.repeat(60));
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Budget: ${REQUESTS_PER_RUN} requests`);
  console.log(`Skip threshold: ${SKIP_IF_UPDATED_WITHIN_DAYS} days`);
  console.log();

  const data = loadData();
  const lifecycle = loadLifecycle();

  // Get pairs that need updating
  const pairsToUpdate = getPairsToUpdate(data, lifecycle);

  // Statistics
  const totalPossible = PRIORITY_PASSPORTS.length * ALL_DESTINATIONS.length;
  const needsUpdate = pairsToUpdate.length;
  const upToDate = totalPossible - needsUpdate;

  console.log('DATABASE STATUS:');
  console.log(`  Total pairs tracked: ${totalPossible}`);
  console.log(`  Up-to-date (< ${SKIP_IF_UPDATED_WITHIN_DAYS} days): ${upToDate}`);
  console.log(`  Needs update: ${needsUpdate}`);
  console.log();

  if (pairsToUpdate.length === 0) {
    console.log('All data is up-to-date! Nothing to update.');
    return;
  }

  // Show what we're about to update
  const batch = pairsToUpdate.slice(0, REQUESTS_PER_RUN);
  console.log(`UPDATING ${batch.length} pairs:`);
  batch.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.passport}->${p.destination} (${p.reason})`);
  });
  console.log();

  // Process batch
  let updated = 0;
  let skipped = 0;
  let stopped = false;

  for (const pair of batch) {
    if (stopped) break;

    const { passport, destination, reason } = pair;
    process.stdout.write(`[${updated + skipped + 1}/${batch.length}] ${passport}->${destination}: `);

    const result = await checkVisaRequirement(passport, destination);

    if (result?.rateLimited || result?.quotaExceeded) {
      console.log('STOPPED (limit reached)');
      stopped = true;
      break;
    }

    if (result) {
      // Initialize passport if needed
      if (!data.rules[passport]) {
        data.rules[passport] = {};
      }

      // Update data
      data.rules[passport][destination] = result;

      // Update lifecycle tracking
      if (!lifecycle.lastUpdates[passport]) {
        lifecycle.lastUpdates[passport] = {};
      }
      lifecycle.lastUpdates[passport][destination] = new Date().toISOString();

      console.log(`${result.requirement} (${result.duration || '-'} days)`);
      updated++;
    } else {
      console.log('SKIPPED (API error - preserving existing data)');
      skipped++;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // Save only if we made updates
  if (updated > 0) {
    saveData(data);
    saveLifecycle(lifecycle);
    console.log('\nData saved successfully!');
  } else {
    console.log('\nNo updates made - existing data preserved.');
  }

  // Summary
  console.log();
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Stopped early: ${stopped ? 'YES' : 'No'}`);
  console.log();

  // Show remaining work
  const remaining = needsUpdate - updated;
  const weeksToComplete = Math.ceil(remaining / REQUESTS_PER_RUN);
  console.log(`Remaining pairs to update: ${remaining}`);
  console.log(`Estimated weeks to complete: ${weeksToComplete}`);
}

main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
