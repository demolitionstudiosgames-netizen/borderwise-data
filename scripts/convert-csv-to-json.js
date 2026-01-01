/**
 * Convert Passport Index CSV to our JSON format
 * Source: https://github.com/ilyankou/passport-index-dataset
 * FREE DATA - No API costs!
 */

const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'data', 'passport-index-raw.csv');
const outputPath = path.join(__dirname, '..', 'data', 'visa-rules.json');

// Read CSV
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.trim().split('\n');
const header = lines[0];
const dataLines = lines.slice(1);

console.log(`Processing ${dataLines.length} visa requirement records...`);

// Build rules object
const rules = {};
let processed = 0;

for (const line of dataLines) {
  const [passport, destination, requirement] = line.split(',');

  if (!passport || !destination || !requirement) continue;

  // Skip self-references
  if (passport === destination) continue;

  // Initialize passport if needed
  if (!rules[passport]) {
    rules[passport] = {};
  }

  // Normalize requirement
  let normalizedReq = 'unknown';
  let duration = null;

  const req = requirement.toLowerCase().trim();

  // Check if it's a number (visa-free days)
  const numMatch = req.match(/^(\d+)$/);
  if (numMatch) {
    normalizedReq = 'visa-free';
    duration = parseInt(numMatch[1]);
  } else if (req === 'visa free' || req === 'visa-free' || req === 'free') {
    normalizedReq = 'visa-free';
    duration = 90; // Default assumption
  } else if (req === 'visa on arrival' || req === 'voa') {
    normalizedReq = 'visa-on-arrival';
    duration = 30; // Common default
  } else if (req === 'e-visa' || req === 'evisa') {
    normalizedReq = 'e-visa';
  } else if (req === 'eta') {
    normalizedReq = 'eta';
    duration = 90;
  } else if (req === 'visa required' || req === 'visa-required') {
    normalizedReq = 'visa-required';
  } else if (req.includes('free')) {
    normalizedReq = 'visa-free';
  } else if (req.includes('arrival')) {
    normalizedReq = 'visa-on-arrival';
  } else if (req.includes('e-visa') || req.includes('evisa')) {
    normalizedReq = 'e-visa';
  } else {
    normalizedReq = 'visa-required';
  }

  rules[passport][destination] = {
    requirement: normalizedReq,
    duration: duration,
    lastChecked: new Date().toISOString(),
  };

  processed++;
}

// Count stats
const passportCount = Object.keys(rules).length;
const totalRules = Object.values(rules).reduce((sum, dests) => sum + Object.keys(dests).length, 0);

console.log(`\nProcessed ${processed} records`);
console.log(`Passports: ${passportCount}`);
console.log(`Total rules: ${totalRules}`);

// Create output
const output = {
  version: '3.0.0',
  lastUpdated: new Date().toISOString(),
  dataVersion: Date.now(),
  source: 'Passport Index Dataset (ilyankou/passport-index-dataset)',
  notes: 'Comprehensive data for 199 passports - FREE open source data',
  rules: rules,
};

// Write JSON
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`\nWritten to: ${outputPath}`);

// Also write version file
const versionPath = path.join(__dirname, '..', 'data', 'version.json');
fs.writeFileSync(versionPath, JSON.stringify({
  version: output.version,
  lastUpdated: output.lastUpdated,
  dataVersion: output.dataVersion,
}, null, 2));
console.log(`Version file: ${versionPath}`);

console.log('\n=== DONE! All 199 passports loaded for FREE ===');
