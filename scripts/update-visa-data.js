/**
 * Update Visa Data Script
 *
 * This script fetches visa requirements from the Travel Buddy API
 * and saves them to the data directory.
 *
 * Run via GitHub Actions with the API key stored as a secret.
 */

const fs = require('fs');
const path = require('path');

const API_URL = 'https://visa-requirement.p.rapidapi.com/v2/visa/check';
const API_HOST = 'visa-requirement.p.rapidapi.com';

// Get API key from environment variable (set by GitHub Actions)
const API_KEY = process.env.RAPIDAPI_KEY;

if (!API_KEY) {
  console.error('ERROR: RAPIDAPI_KEY environment variable is not set');
  console.error('Make sure to run this via GitHub Actions with the secret configured');
  process.exit(1);
}

// List of passport countries to check (expand as needed)
const PASSPORT_COUNTRIES = [
  'GB', 'US', 'CA', 'AU', 'NZ', 'DE', 'FR', 'IT', 'ES', 'NL',
  'JP', 'KR', 'SG', 'AE', 'IE', 'SE', 'NO', 'DK', 'FI', 'CH',
  'AT', 'BE', 'PT', 'GR', 'PL', 'CZ', 'HU', 'BR', 'MX', 'AR',
  'IN', 'CN', 'PH', 'NG', 'GH', 'KE', 'ZA', 'EG', 'MA', 'PK'
];

// List of destination countries
const DESTINATION_COUNTRIES = [
  // Schengen
  'AT', 'BE', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IS', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL',
  'PT', 'SK', 'SI', 'ES', 'SE', 'CH', 'HR', 'BG', 'RO',
  // Popular destinations
  'GB', 'US', 'CA', 'AU', 'NZ', 'JP', 'KR', 'SG', 'TH', 'VN',
  'MY', 'ID', 'PH', 'IN', 'AE', 'QA', 'SA', 'TR', 'EG', 'MA',
  'ZA', 'KE', 'GH', 'NG', 'BR', 'MX', 'AR', 'CL', 'CO', 'PE',
  'IE', 'RU', 'UA', 'GE', 'AM', 'RS', 'ME', 'AL', 'MK', 'BA'
];

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
    console.error(`Failed to check ${passport}->${destination}:`, error.message);
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
  if (normalized.includes('e-visa') || normalized.includes('evisa') || normalized.includes('electronic')) {
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

async function main() {
  console.log('Starting visa data update...');
  console.log(`Checking ${PASSPORT_COUNTRIES.length} passports x ${DESTINATION_COUNTRIES.length} destinations`);

  const visaRules = {};

  for (const passport of PASSPORT_COUNTRIES) {
    console.log(`\nProcessing passport: ${passport}`);
    visaRules[passport] = {};

    for (const destination of DESTINATION_COUNTRIES) {
      // Skip same country
      if (passport === destination) continue;

      const result = await checkVisaRequirement(passport, destination);

      if (result) {
        visaRules[passport][destination] = {
          requirement: result.requirement,
          duration: result.duration,
          notes: result.notes,
        };
        process.stdout.write('.');
      } else {
        process.stdout.write('x');
      }

      // Rate limiting - 100ms between requests
      await sleep(100);
    }
    console.log(` Done (${Object.keys(visaRules[passport]).length} destinations)`);
  }

  // Save the data
  const outputPath = path.join(__dirname, '..', 'data', 'visa-rules.json');
  const outputData = {
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
    dataVersion: Date.now(),
    rules: visaRules,
  };

  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`\nSaved visa rules to ${outputPath}`);

  // Update version file
  const versionPath = path.join(__dirname, '..', 'data', 'version.json');
  const versionData = {
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
    dataVersion: Date.now(),
  };

  fs.writeFileSync(versionPath, JSON.stringify(versionData, null, 2));
  console.log(`Updated version file`);

  console.log('\nDone!');
}

main().catch(console.error);
