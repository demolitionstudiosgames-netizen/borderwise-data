/**
 * Currency Rates Update Script
 *
 * Fetches latest exchange rates from CurrencyBeacon API and writes to data files.
 * Called by GitHub Actions on a cron schedule (every 4 hours).
 *
 * Usage: CURRENCYBEACON_API_KEY=xxx node scripts/update-currency-rates.js
 */

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.CURRENCYBEACON_API_KEY;
const API_URL = `https://api.currencybeacon.com/v1/latest?api_key=${API_KEY}&base=USD`;

const RATES_PATH = path.join(__dirname, '..', 'data', 'currency-rates.json');
const VERSION_PATH = path.join(__dirname, '..', 'data', 'currency-version.json');

// Target currencies — the most-used currencies covering all major travel destinations
const TARGET_CURRENCIES = [
  // Major
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD',
  // Asia
  'CNY', 'HKD', 'SGD', 'KRW', 'INR', 'THB', 'TWD', 'MYR',
  'IDR', 'PHP', 'VND', 'PKR', 'BDT', 'LKR', 'MMK', 'NPR', 'KZT',
  // Middle East
  'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'ILS', 'TRY',
  // Europe (non-EUR)
  'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN',
  'RUB', 'UAH', 'GEL', 'ISK',
  // Africa
  'ZAR', 'NGN', 'EGP', 'GHS', 'KES', 'MAD', 'TND', 'XOF', 'XAF',
  // Americas
  'MXN', 'BRL', 'ARS', 'CLP', 'COP', 'PEN', 'DOP', 'JMD', 'TTD',
  // Oceania
  'FJD',
];

async function main() {
  if (!API_KEY) {
    console.error('CURRENCYBEACON_API_KEY environment variable is required');
    process.exit(1);
  }

  console.log('Fetching latest currency rates from CurrencyBeacon...');

  const response = await fetch(API_URL);
  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();

  if (!data.rates || typeof data.rates !== 'object') {
    throw new Error('Invalid API response: missing rates object');
  }

  // Filter to target currencies only
  const filteredRates = {};
  let found = 0;
  let missing = [];

  for (const code of TARGET_CURRENCIES) {
    if (data.rates[code] !== undefined) {
      filteredRates[code] = Math.round(data.rates[code] * 1000000) / 1000000; // 6 decimal places max
      found++;
    } else {
      missing.push(code);
    }
  }

  if (missing.length > 0) {
    console.warn(`Warning: ${missing.length} currencies not found in API response: ${missing.join(', ')}`);
  }

  if (found < 20) {
    throw new Error(`Too few currencies returned (${found}). API may be having issues.`);
  }

  // Build output files
  const now = new Date().toISOString();
  const dataVersion = Date.now();

  const ratesData = {
    version: '1.0.0',
    lastUpdated: now,
    dataVersion,
    base: 'USD',
    rates: filteredRates,
  };

  const versionData = {
    version: '1.0.0',
    lastUpdated: now,
    dataVersion,
  };

  // Write files
  fs.writeFileSync(RATES_PATH, JSON.stringify(ratesData, null, 2) + '\n');
  fs.writeFileSync(VERSION_PATH, JSON.stringify(versionData, null, 2) + '\n');

  console.log(`Successfully updated ${found} currency rates at ${now}`);
}

main().catch((err) => {
  console.error('Failed to update currency rates:', err.message);
  process.exit(1);
});
