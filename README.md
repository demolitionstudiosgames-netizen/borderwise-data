# BorderWise Data

Visa requirement and currency data for the BorderWise app. The app downloads these files from raw GitHub URLs.

```
data/
  visa-rules.json       # rules[passport][destination] = { requirement, duration, notes, source, lastChecked, ... }
  version.json          # version, lastUpdated, dataVersion (the app re-downloads when these change)
  currency-rates.json   # exchange rates (CurrencyBeacon)
  currency-version.json
scripts/
  import-open-sources.js   # weekly visa import from the two open datasets below
  validate-data.js         # gate run before every commit
  update-currency-rates.js # hourly currency update
docs/
  last-import.md           # what the latest import changed, and what needs review
  repair-2026-11-05.md     # the Nov 2026 data repair
```

## Where the visa data comes from (free, open)

| Priority | Source | Licence |
|---|---|---|
| 1 | Our own hand-verified entries (`verified` field). Kept until `validUntil` passes. | ours |
| 2 | [visafreely.com dataset](https://github.com/honru09/visa-requirements-dataset): rows checked against official government sources | CC BY 4.0 |
| 3 | Wikipedia "Visa requirements for X citizens" articles, parsed weekly by [Riedel-David/Visa-requirements](https://github.com/Riedel-David/Visa-requirements) | CC BY-SA 4.0 |
| 4 | visafreely seed rows (Passport Index snapshot, Feb 2026), used only when nothing better exists | MIT / CC BY 4.0 |

Each entry's `source` says which one it came from (`visafreely-official:<date>`, `wikipedia:<revision>`, `visafreely-seed`, or a full citation for our own entries).

## Automation

- **Weekly Visa Data Import** (Tuesdays 06:00 UTC, after the Wikipedia dataset's Monday release). It downloads both datasets, merges them, runs the validation gate, and commits.
  - It refuses to write if more than 3% of pairs would change requirement. The run then fails, and GitHub emails the owner. Review `docs/last-import.md` and run it manually with `--allow-large` if the change is genuine.
  - It warns when an upstream dataset has stopped updating (Wikipedia release older than 21 days, visafreely older than 45 days).
  - It never writes "unknown" and never adds or removes pairs.
- **Update Currency Rates** runs hourly (CurrencyBeacon, `CURRENCYBEACON_API_KEY` secret).

Run an import locally: `node scripts/import-open-sources.js --dry-run`.

## Licence and attribution

`visa-rules.json` contains material from Wikipedia (CC BY-SA 4.0) and visafreely.com (CC BY 4.0), so the visa dataset is published under **CC BY-SA 4.0**. Any app or site that shows it must credit:

> Visa data from Wikipedia contributors (CC BY-SA 4.0) and visafreely.com (CC BY 4.0). Always confirm with official sources before travelling.

The same attribution is stored in `visa-rules.json` under `attribution`.
