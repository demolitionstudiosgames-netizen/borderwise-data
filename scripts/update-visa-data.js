/**
 * Update Visa Data Script
 *
 * STRATEGY FOR 120 REQUESTS/MONTH LIMIT:
 * - Weekly runs = 4 runs per month
 * - 30 requests per run maximum
 * - Focus on verifying/updating existing static data
 * - Prioritize most-used passport/destination pairs
 *
 * The app primarily uses comprehensive static data.
 * API calls are for verification and keeping data fresh.
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

// Priority pairs to keep fresh (most used combinations)
// With 30 requests per week, we rotate through these
const PRIORITY_PAIRS = [
  // UK to popular destinations
  ['GB', 'ES'], ['GB', 'FR'], ['GB', 'TH'], ['GB', 'US'], ['GB', 'GR'],
  ['GB', 'PT'], ['GB', 'IT'], ['GB', 'AE'], ['GB', 'JP'], ['GB', 'AU'],
  // US to popular destinations
  ['US', 'GB'], ['US', 'MX'], ['US', 'JP'], ['US', 'FR'], ['US', 'IT'],
  ['US', 'TH'], ['US', 'ES'], ['US', 'DE'], ['US', 'CA'], ['US', 'AU'],
  // Nigeria to common destinations
  ['NG', 'GB'], ['NG', 'US'], ['NG', 'AE'], ['NG', 'GH'], ['NG', 'ZA'],
  // India to common destinations
  ['IN', 'AE'], ['IN', 'SG'], ['IN', 'TH'], ['IN', 'GB'], ['IN', 'US'],
  // Ghana to common destinations
  ['GH', 'GB'], ['GH', 'US'], ['GH', 'NG'], ['GH', 'AE'], ['GH', 'ZA'],
  // South Africa
  ['ZA', 'GB'], ['ZA', 'US'], ['ZA', 'AE'], ['ZA', 'TH'], ['ZA', 'MU'],
  // Other popular pairs
  ['DE', 'US'], ['DE', 'TH'], ['DE', 'JP'],
  ['AU', 'US'], ['AU', 'GB'], ['AU', 'TH'],
  ['JP', 'US'], ['JP', 'GB'], ['JP', 'TH'],
  ['SG', 'US'], ['SG', 'GB'], ['SG', 'AU'],
  ['BR', 'US'], ['BR', 'PT'], ['BR', 'JP'],
  ['MX', 'US'], ['MX', 'ES'], ['MX', 'CA'],
];

const REQUESTS_PER_RUN = 30;
const REQUEST_DELAY_MS = 3000; // 3 seconds between requests (safety margin)
const MAX_RETRIES = 3;
const BACKOFF_MULTIPLIER = 2;

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
      // Rate limited - try exponential backoff before giving up
      if (retryCount < MAX_RETRIES) {
        const backoffMs = REQUEST_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retryCount + 1);
        console.log(`  Rate limited, waiting ${backoffMs/1000}s before retry ${retryCount + 1}/${MAX_RETRIES}...`);
        await sleep(backoffMs);
        return checkVisaRequirement(passport, destination, retryCount + 1);
      }
      console.log(`\n!! Rate limit persists after ${MAX_RETRIES} retries - stopping`);
      return { rateLimited: true };
    }

    if (!response.ok) {
      console.warn(`Error ${passport}->${destination}: ${response.status}`);
      return null;
    }

    const data = await response.json();

    // Check for quota exceeded error
    if (data.message && (data.message.includes('exceeded') || data.message.includes('quota'))) {
      console.log(`\n!! QUOTA EXCEEDED - stopping to preserve existing data`);
      return { quotaExceeded: true };
    }

    const requirement = normalizeRequirement(data.requirement || data.visa_requirement);

    // Don't return "unknown" - it would overwrite good data
    if (requirement === 'unknown') {
      console.log(`  API returned unrecognized format for ${passport}->${destination}:`, JSON.stringify(data));
      return null;
    }

    return {
      requirement,
      duration: data.duration || data.stay_duration || data.allowed_stay || null,
      notes: data.notes || data.additional_info || null,
    };
  } catch (error) {
    // Network errors - retry with backoff
    if (retryCount < MAX_RETRIES) {
      const backoffMs = REQUEST_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retryCount);
      console.log(`  Network error, retrying in ${backoffMs/1000}s (${retryCount + 1}/${MAX_RETRIES})...`);
      await sleep(backoffMs);
      return checkVisaRequirement(passport, destination, retryCount + 1);
    }
    console.error(`Failed ${passport}->${destination} after ${MAX_RETRIES} retries: ${error.message}`);
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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadData() {
  const dataPath = path.join(__dirname, '..', 'data', 'visa-rules.json');
  return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
}

function loadProgress() {
  const progressPath = path.join(__dirname, '..', 'data', 'progress.json');
  try {
    if (fs.existsSync(progressPath)) {
      return JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    }
  } catch (error) {}
  return { lastIndex: 0, lastRun: null };
}

function saveProgress(index) {
  const progressPath = path.join(__dirname, '..', 'data', 'progress.json');
  fs.writeFileSync(progressPath, JSON.stringify({
    lastIndex: index,
    lastRun: new Date().toISOString(),
  }, null, 2));
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

async function main() {
  console.log('=== Visa Data Update ===');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Budget: ${REQUESTS_PER_RUN} requests this run`);
  console.log(`Delay between requests: ${REQUEST_DELAY_MS/1000}s`);
  console.log(`Retry strategy: ${MAX_RETRIES} retries with ${BACKOFF_MULTIPLIER}x backoff`);
  console.log(`Total priority pairs: ${PRIORITY_PAIRS.length}`);
  console.log();

  const data = loadData();
  const progress = loadProgress();

  // Determine which pairs to check this run
  let startIndex = progress.lastIndex % PRIORITY_PAIRS.length;
  const pairsToCheck = PRIORITY_PAIRS.slice(startIndex, startIndex + REQUESTS_PER_RUN);

  // If we don't have enough, wrap around
  if (pairsToCheck.length < REQUESTS_PER_RUN) {
    pairsToCheck.push(...PRIORITY_PAIRS.slice(0, REQUESTS_PER_RUN - pairsToCheck.length));
  }

  console.log(`Checking ${pairsToCheck.length} pairs starting from index ${startIndex}`);
  console.log();

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let rateLimited = false;
  let quotaExceeded = false;
  let actualRequests = 0;

  for (const [passport, destination] of pairsToCheck) {
    if (rateLimited || quotaExceeded) break;

    const result = await checkVisaRequirement(passport, destination);
    actualRequests++;

    if (result?.rateLimited) {
      rateLimited = true;
      break;
    }

    if (result?.quotaExceeded) {
      quotaExceeded = true;
      console.log('!! Stopping to preserve existing data - quota exceeded');
      break;
    }

    if (result) {
      // Initialize passport if needed
      if (!data.rules[passport]) {
        data.rules[passport] = {};
      }

      const existing = data.rules[passport][destination];
      const changed = !existing ||
        existing.requirement !== result.requirement ||
        existing.duration !== result.duration;

      if (changed) {
        data.rules[passport][destination] = result;
        console.log(`[UPDATED] ${passport}->${destination}: ${result.requirement} (${result.duration || '-'} days)`);
        updated++;
      } else {
        console.log(`[OK] ${passport}->${destination}: ${result.requirement}`);
        unchanged++;
      }
    } else {
      // null means API error or unrecognized format - skip, don't overwrite
      console.log(`[SKIPPED] ${passport}->${destination} (API error or unrecognized format)`);
      skipped++;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // Save progress - don't advance if quota exceeded (will retry next run)
  const nextIndex = (rateLimited || quotaExceeded) ? startIndex : (startIndex + actualRequests) % PRIORITY_PAIRS.length;
  saveProgress(nextIndex);

  // Only save data if we actually updated something
  if (updated > 0) {
    saveData(data);
  } else {
    console.log('\nNo updates made - preserving existing data');
  }

  console.log();
  console.log('=== Summary ===');
  console.log(`Requests made: ${actualRequests}`);
  console.log(`Updated: ${updated}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Rate limited: ${rateLimited ? 'YES' : 'No'}`);
  console.log(`Quota exceeded: ${quotaExceeded ? 'YES' : 'No'}`);
  console.log(`Next run starts at index: ${nextIndex}`);
}

main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
