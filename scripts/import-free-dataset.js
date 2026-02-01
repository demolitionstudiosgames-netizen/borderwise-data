/**
 * Import Free Passport Index Dataset
 * Source: https://github.com/ilyankou/passport-index-dataset
 *
 * This script imports the FREE visa requirements data to fill gaps.
 * Only updates entries that are missing or "unknown" - never overwrites good data.
 */

const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', 'data', 'passport-index-iso2.csv');
const DATA_PATH = path.join(__dirname, '..', 'data', 'visa-rules.json');
const VERSION_PATH = path.join(__dirname, '..', 'data', 'version.json');

/**
 * Normalize requirement to our format
 */
function normalizeRequirement(req) {
  if (!req) return null;
  const r = req.toLowerCase().trim();

  // Number = visa-free days
  const numMatch = r.match(/^(\d+)$/);
  if (numMatch) {
    return { requirement: 'visa-free', duration: parseInt(numMatch[1]) };
  }

  if (r === 'visa free' || r === 'visa-free' || r === 'free') {
    return { requirement: 'visa-free', duration: 90 };
  }
  if (r === 'visa on arrival' || r === 'voa') {
    return { requirement: 'visa-on-arrival', duration: 30 };
  }
  if (r === 'eta') {
    return { requirement: 'eta', duration: 90 };
  }
  if (r === 'e-visa' || r === 'evisa') {
    return { requirement: 'e-visa', duration: null };
  }
  if (r === 'visa required' || r === 'visa-required') {
    return { requirement: 'visa-required', duration: null };
  }
  if (r === 'no admission' || r === '-1') {
    return null; // Skip these
  }

  // Default
  return { requirement: 'visa-required', duration: null };
}

/**
 * Main import function
 */
function main() {
  console.log('='.repeat(60));
  console.log('IMPORTING FREE PASSPORT INDEX DATASET');
  console.log('='.repeat(60));
  console.log();

  // Check if CSV exists
  if (!fs.existsSync(CSV_PATH)) {
    console.error('ERROR: CSV file not found at', CSV_PATH);
    console.log('Please download it first:');
    console.log('curl -L -o data/passport-index-iso2.csv "https://raw.githubusercontent.com/ilyankou/passport-index-dataset/master/passport-index-tidy-iso2.csv"');
    process.exit(1);
  }

  // Load existing data
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  // Read CSV
  const csvContent = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = csvContent.trim().split('\n');
  const header = lines[0];
  const dataLines = lines.slice(1);

  console.log(`CSV records: ${dataLines.length}`);
  console.log();

  let imported = 0;
  let skipped = 0;
  let preserved = 0;

  for (const line of dataLines) {
    const parts = line.split(',');
    if (parts.length < 3) continue;

    const passport = parts[0].trim().toUpperCase();
    const destination = parts[1].trim().toUpperCase();
    const requirement = parts[2].trim();

    // Skip self-references
    if (passport === destination) continue;

    // Normalize the requirement
    const normalized = normalizeRequirement(requirement);
    if (!normalized) {
      skipped++;
      continue;
    }

    // Initialize passport if needed
    if (!data.rules[passport]) {
      data.rules[passport] = {};
    }

    // Check existing data
    const existing = data.rules[passport][destination];

    // Only import if:
    // 1. No existing data
    // 2. Existing data is "unknown"
    if (!existing || existing.requirement === 'unknown') {
      data.rules[passport][destination] = {
        requirement: normalized.requirement,
        duration: normalized.duration,
        source: 'passport-index',
      };
      imported++;
    } else {
      // Preserve existing good data
      preserved++;
    }
  }

  // Update metadata
  data.lastUpdated = new Date().toISOString();
  data.dataVersion = Date.now();

  // Save
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  fs.writeFileSync(VERSION_PATH, JSON.stringify({
    version: data.version,
    lastUpdated: data.lastUpdated,
    dataVersion: data.dataVersion,
  }, null, 2));

  console.log('='.repeat(60));
  console.log('IMPORT COMPLETE');
  console.log('='.repeat(60));
  console.log(`Imported (new/fixed): ${imported}`);
  console.log(`Preserved (existing good data): ${preserved}`);
  console.log(`Skipped (invalid): ${skipped}`);
  console.log();
  console.log('Data saved to:', DATA_PATH);
}

main();
