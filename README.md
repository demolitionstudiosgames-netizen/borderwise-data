# Borderwise Data Repository

This repository hosts visa requirement data for the Borderwise app.

## Structure

```
data/
  visa-rules.json    # Visa requirements by passport/destination
  version.json       # Version tracking for app sync
scripts/
  update-visa-data.js   # Script to fetch latest data from API
.github/workflows/
  update-data.yml    # Weekly automated update
```

## How It Works

1. **GitHub Actions** runs weekly (Sundays at midnight UTC)
2. The script fetches visa requirements from the Travel Buddy API
3. Data is committed and pushed to this repository
4. The Borderwise app fetches from raw GitHub URLs (free, unlimited bandwidth)

## API Key Security

The API key is stored as a **GitHub Secret** (`RAPIDAPI_KEY`). It is:
- Encrypted at rest
- Never exposed in logs
- Only accessible during workflow runs

## Manual Update

To trigger a manual update:
1. Go to **Actions** tab
2. Select **Update Visa Data**
3. Click **Run workflow**

## App Integration

The app fetches data from:
```
https://raw.githubusercontent.com/USERNAME/borderwise-data/main/data/visa-rules.json
https://raw.githubusercontent.com/USERNAME/borderwise-data/main/data/version.json
```

## License

Data is for use with the Borderwise app only.
