/**
 * Update Visa Data Script
 *
 * CONSERVATIVE version - respects strict API rate limits.
 * Processes only a few passports per run and saves progress.
 * Multiple runs will build up the complete dataset over time.
 *
 * Free tier typically allows ~100 requests/day or similar.
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

// All passports we want to support (will process over multiple runs)
const ALL_PASSPORTS = [
  'GB', 'US', 'CA', 'AU', 'NZ', 'IE',
  'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'NO', 'DK', 'FI', 'CH', 'AT', 'BE', 'PT', 'PL',
  'JP', 'KR', 'SG', 'MY', 'IN', 'CN', 'PH', 'TH', 'ID', 'VN',
  'AE', 'SA', 'QA',
  'ZA', 'NG', 'GH', 'KE', 'EG',
  'BR', 'MX', 'AR',
];

// Top destinations
const DESTINATION_COUNTRIES = [
  // Schengen (27)
  'AT', 'BE', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IS', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT',
  'SK', 'SI', 'ES', 'SE', 'CH', 'HR', 'BG', 'RO',
  // Other important (25)
  'GB', 'IE', 'US', 'CA', 'AU', 'NZ', 'JP', 'KR', 'SG', 'TH',
  'VN', 'MY', 'ID', 'PH', 'IN', 'AE', 'QA', 'SA', 'TR', 'EG',
  'MA', 'ZA', 'KE', 'BR', 'MX',
];

// VERY conservative rate limiting
const PASSPORTS_PER_RUN = 2;        // Only process 2 passports per weekly run
const REQUEST_DELAY_MS = 1000;      // 1 second between requests
const BATCH_SIZE = 1;               // One request at a time

async function checkVisaRequirement(passport, destination) {
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
      console.log(`\nRate limited! Stopping to preserve quota.`);
      return { rateLimited: true };
    }

    if (!response.ok) {
      console.warn(`API error for ${passport}->${destination}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return {
      passport,
      destination,
      requirement: normalizeRequirement(data.requirement || data.visa_requirement),
      duration: data.duration || data.stay_duration || data.allowed_stay || null,
      notes: data.notes || data.additional_info || null,
    };
  } catch (error) {
    console.error(`Failed: ${passport}->${destination}: ${error.message}`);
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

function loadExistingData() {
  const outputPath = path.join(__dirname, '..', 'data', 'visa-rules.json');
  try {
    if (fs.existsSync(outputPath)) {
      const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      return data.rules || {};
    }
  } catch (error) {
    console.log('No existing data, starting fresh');
  }
  return {};
}

function loadProgress() {
  const progressPath = path.join(__dirname, '..', 'data', 'progress.json');
  try {
    if (fs.existsSync(progressPath)) {
      return JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    }
  } catch (error) {
    console.log('No progress file, starting from beginning');
  }
  return { lastPassportIndex: 0 };
}

function saveProgress(lastPassportIndex) {
  const progressPath = path.join(__dirname, '..', 'data', 'progress.json');
  fs.writeFileSync(progressPath, JSON.stringify({ lastPassportIndex, updatedAt: new Date().toISOString() }));
}

function saveData(visaRules) {
  const outputPath = path.join(__dirname, '..', 'data', 'visa-rules.json');
  const outputData = {
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
    dataVersion: Date.now(),
    rules: visaRules,
  };
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));

  const versionPath = path.join(__dirname, '..', 'data', 'version.json');
  fs.writeFileSync(versionPath, JSON.stringify({
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
    dataVersion: Date.now(),
  }));
}

async function main() {
  console.log('=== Visa Data Update (Conservative Mode) ===\n');

  const visaRules = loadExistingData();
  const progress = loadProgress();

  // Determine which passports to process this run
  let startIndex = progress.lastPassportIndex % ALL_PASSPORTS.length;
  const passportsToProcess = ALL_PASSPORTS.slice(startIndex, startIndex + PASSPORTS_PER_RUN);

  if (passportsToProcess.length === 0) {
    // Wrap around
    startIndex = 0;
    passportsToProcess.push(...ALL_PASSPORTS.slice(0, PASSPORTS_PER_RUN));
  }

  console.log(`Processing ${passportsToProcess.length} passports: ${passportsToProcess.join(', ')}`);
  console.log(`Destinations: ${DESTINATION_COUNTRIES.length}`);
  console.log(`Start index: ${startIndex}\n`);

  let totalSuccess = 0;
  let totalError = 0;
  let rateLimited = false;

  for (const passport of passportsToProcess) {
    if (rateLimited) break;

    console.log(`\n[${passport}] Processing...`);
    if (!visaRules[passport]) {
      visaRules[passport] = {};
    }

    const destinations = DESTINATION_COUNTRIES.filter(d => d !== passport);
    let passportSuccess = 0;

    for (const destination of destinations) {
      if (rateLimited) break;

      // Skip if we already have this data
      if (visaRules[passport][destination]) {
        process.stdout.write('s');
        continue;
      }

      const result = await checkVisaRequirement(passport, destination);

      if (result?.rateLimited) {
        rateLimited = true;
        console.log('\n!! Rate limit hit - stopping and saving progress');
        break;
      }

      if (result) {
        visaRules[passport][destination] = {
          requirement: result.requirement,
          duration: result.duration,
          notes: result.notes,
        };
        passportSuccess++;
        totalSuccess++;
        process.stdout.write('.');
      } else {
        totalError++;
        process.stdout.write('x');
      }

      // Wait between requests
      await sleep(REQUEST_DELAY_MS);
    }

    console.log(` +${passportSuccess} (total: ${Object.keys(visaRules[passport]).length})`);
  }

  // Save progress for next run
  const nextIndex = rateLimited
    ? startIndex  // Don't advance if rate limited
    : (startIndex + PASSPORTS_PER_RUN) % ALL_PASSPORTS.length;

  saveProgress(nextIndex);
  saveData(visaRules);

  // Summary
  console.log('\n=== Summary ===');
  console.log(`New entries: ${totalSuccess}`);
  console.log(`Errors: ${totalError}`);
  console.log(`Rate limited: ${rateLimited ? 'Yes' : 'No'}`);
  console.log(`Next run starts at index: ${nextIndex} (${ALL_PASSPORTS[nextIndex] || ALL_PASSPORTS[0]})`);

  // Count total coverage
  let totalEntries = 0;
  for (const passport of Object.keys(visaRules)) {
    totalEntries += Object.keys(visaRules[passport]).length;
  }
  console.log(`Total database entries: ${totalEntries}`);
}

main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
