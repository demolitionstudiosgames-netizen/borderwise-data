/**
 * Test Database Load - 100 requests only
 *
 * Purpose: Verify that the workflow properly saves data
 * Uses ~100 of your remaining API quota
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

// Just test with a few passports - 100 requests total
const TEST_PASSPORTS = ['GB', 'NG']; // 2 passports
const TEST_DESTINATIONS = [
  'US', 'CA', 'FR', 'DE', 'IT', 'ES', 'JP', 'AU', 'NZ', 'BR',
  'MX', 'IN', 'CN', 'KR', 'SG', 'TH', 'MY', 'ID', 'PH', 'VN',
  'AE', 'SA', 'EG', 'ZA', 'KE', 'GH', 'MA', 'TN', 'NG', 'ET',
  'TR', 'RU', 'UA', 'PL', 'NL', 'BE', 'CH', 'AT', 'SE', 'NO',
  'DK', 'FI', 'IE', 'PT', 'GR', 'CZ', 'HU', 'RO', 'BG', 'HR'
]; // 50 destinations x 2 passports = 100 requests

const REQUEST_DELAY_MS = 150; // Safe rate

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
      console.log(`  Rate limited on ${passport}->${destination}`);
      return null;
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
      source: 'rapidapi-test',
    };
  } catch (error) {
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
  console.log('=== Test Database Load (100 requests) ===');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Test passports: ${TEST_PASSPORTS.join(', ')}`);
  console.log(`Test destinations: ${TEST_DESTINATIONS.length}`);
  console.log(`Expected requests: ${TEST_PASSPORTS.length * TEST_DESTINATIONS.length}`);
  console.log();

  const data = loadData();
  let updated = 0;
  let errors = 0;
  let requestCount = 0;

  for (const passport of TEST_PASSPORTS) {
    console.log(`Processing ${passport}...`);

    for (const destination of TEST_DESTINATIONS) {
      if (passport === destination) continue;

      const result = await checkVisaRequirement(passport, destination);
      requestCount++;

      if (result) {
        if (!data.rules[passport]) {
          data.rules[passport] = {};
        }
        data.rules[passport][destination] = result;
        updated++;
        process.stdout.write('.');
      } else {
        errors++;
        process.stdout.write('x');
      }

      await sleep(REQUEST_DELAY_MS);
    }
    console.log();
  }

  // Save the data
  saveData(data);

  // Stats
  const passportsCovered = Object.keys(data.rules).length;
  const totalRules = Object.values(data.rules).reduce((sum, dests) => sum + Object.keys(dests).length, 0);

  console.log();
  console.log('=== Test Results ===');
  console.log(`Requests made: ${requestCount}`);
  console.log(`Updated: ${updated}`);
  console.log(`Errors: ${errors}`);
  console.log();
  console.log('=== Database Status ===');
  console.log(`Passports in DB: ${passportsCovered}`);
  console.log(`Total rules in DB: ${totalRules}`);
  console.log();
  console.log('Data saved to visa-rules.json');
  console.log('Workflow should now commit this file.');
}

main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
