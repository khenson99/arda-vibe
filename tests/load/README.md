# Load Tests

Performance load tests for Arda V2, using [k6](https://k6.io/).

## Directory Structure

```
tests/load/
  README.md              <- This file
  thresholds.json        <- Machine-readable SLO thresholds (single source of truth)
  helpers/
    tags.js              <- Tag helper: maps requests to api_category/workflow/service tags
  scenarios/             <- k6 scenario scripts (created by load-harness ticket)
    (*.js)
  reports/               <- CI artifact output (gitignored)
    (*.json)
```

## Quick Start

```bash
# Install k6 (macOS)
brew install k6

# Run a scenario with thresholds
k6 run --config tests/load/thresholds.json tests/load/scenarios/<scenario>.js

# Run with environment variables
k6 run --config tests/load/thresholds.json \
  -e BASE_URL=http://localhost:3000 \
  -e AUTH_TOKEN=<jwt> \
  tests/load/scenarios/<scenario>.js
```

## Thresholds

All SLO budgets are defined in `thresholds.json`. This is the **single source of truth** -- do not duplicate thresholds in individual scenario files.

The thresholds align with the SLO budgets documented in `docs/ops/slo-budgets.md`.

### Tag System

Every k6 request must be tagged with:

| Tag | Purpose | Example |
|---|---|---|
| `api_category` | SLO category bucket | `read_single`, `write`, `workflow_transition` |
| `workflow` | Functional requirement | `fr01`, `fr02`, `fr03` |
| `service` | Backend service | `catalog`, `kanban`, `orders` |

Use the tag helper (`helpers/tags.js`) to apply consistent tags:

```javascript
import { tagRequest } from '../helpers/tags.js';

// In your scenario:
const params = tagRequest('/api/catalog/parts/123', 'GET');
const res = http.get(`${BASE_URL}/api/catalog/parts/123`, params);
```

## CI Integration

The CI performance gate (Gate 6) reads `thresholds.json` and fails the pipeline if any p95 threshold is breached. See `docs/ops/slo-budgets.md` section 10 for full details.

## Ownership

- **Threshold config**: Platform Team
- **Scenario scripts**: Backend Team (per service)
- **Review cadence**: Monthly (first Monday)
