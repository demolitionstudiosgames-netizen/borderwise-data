/**
 * Initialize lifecycle tracking file
 * Marks existing good data as "already updated" so the smart script
 * prioritizes filling in unknown/missing data first.
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'visa-rules.json');
const LIFECYCLE_PATH = path.join(__dirname, '..', 'data', 'lifecycle.json');

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

const lifecycle = {
  lastUpdates: {},
  stats: {
    createdAt: new Date().toISOString(),
    description: 'Tracks when each passport/destination pair was last updated'
  }
};

// Initialize with current good data (mark as already updated)
const now = new Date().toISOString();
let goodCount = 0;
let unknownCount = 0;

for (const [passport, destinations] of Object.entries(data.rules || {})) {
  lifecycle.lastUpdates[passport] = {};
  for (const [dest, rule] of Object.entries(destinations)) {
    if (rule.requirement && rule.requirement !== 'unknown') {
      // Mark good data as updated (so it won't be prioritized immediately)
      lifecycle.lastUpdates[passport][dest] = now;
      goodCount++;
    } else {
      unknownCount++;
    }
  }
}

fs.writeFileSync(LIFECYCLE_PATH, JSON.stringify(lifecycle, null, 2));

console.log('Lifecycle tracking file created!');
console.log('');
console.log('Statistics:');
console.log(`  Good entries (marked as updated): ${goodCount}`);
console.log(`  Unknown entries (will be prioritized): ${unknownCount}`);
console.log('');
console.log('The smart update script will now:');
console.log('  1. Fill in all unknown/missing entries first');
console.log('  2. Then refresh data older than 30 days');
console.log('  3. Never overwrite good data with errors');
