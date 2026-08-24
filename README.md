# Bellhaven Ownership Review

This project compares Bellhaven location data with data in an isolated CRM.
It includes a data pipeline and a local review application.
The pipeline reads all Bellhaven location pages and finds the related CRM accounts.
The application shows evidence for each proposed change.
The system changes CRM data only after a reviewer gives approval.

## Terms

| Term | Meaning |
| --- | --- |
| AR | Outstanding accounts receivable. |
| CHOW | Change of ownership. |
| CRM | The isolated customer relationship management system for this assessment. |
| CRM token | The API credential for the isolated CRM. |
| Current account | The account for the facility with its current parent company. |
| Old account | An account that the billing team must keep because it has protected billing data. |
| Proposal | A record of one proposed CRM change and its evidence. |
| Review state | The local record of scans, proposals, decisions, and application results. |
| State lock | The control that makes sure different processes do not change review state at the same time. |

## Final CRM result

The application corrected the assessment CRM on August 23, 2026.
A new verification and two repeated scans gave these results:

| Check | Result |
| --- | ---: |
| Website directory locations | 34 |
| CRM accounts after correction | 126 |
| Active current Bellhaven accounts | 34 |
| Approved decisions verified | 27 |
| Protected CHOW links | 3 |
| New proposals on repeated run 1 | 0 |
| New proposals on repeated run 2 | 0 |
| Open review items | 0 |

The 27 approved decisions included these changes:

- 13 field or parent corrections
- 3 missing-account creates
- 2 CHOW-safe current-account creates
- 1 link to a current post-divestiture account
- 6 duplicate retirements
- 2 conservative `Needs Review` classifications

The website has a count discrepancy.
The homepage states that Bellhaven has 35 communities.
The directory states that Bellhaven has 34 communities.
The directory also contains 34 community records.
The scraper records both counts.
The application shows the discrepancy.

## Run the application locally

Node.js version 22.13 or later is necessary.

Run these commands in PowerShell:

```powershell
npm ci
$runtimeDir = Join-Path $env:LOCALAPPDATA "BellhavenOwnershipReview"
$configPath = Join-Path $runtimeDir ".env.local"
$statePath = Join-Path $runtimeDir "review-state.json"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$legacyConfig = Join-Path (Get-Location) ".env.local"
if ((Test-Path -LiteralPath $legacyConfig) -and !(Test-Path -LiteralPath $configPath)) {
  Move-Item -LiteralPath $legacyConfig -Destination $configPath
} elseif (!(Test-Path -LiteralPath $configPath)) {
  Copy-Item .env.example $configPath
}
# Keep previous decision history. Do not replace a current state file.
$legacyState = Join-Path (Get-Location) "work\review-state.json"
if ((Test-Path -LiteralPath $legacyState) -and !(Test-Path -LiteralPath $statePath)) {
  Move-Item -LiteralPath $legacyState -Destination $statePath
}
# Put the CRM token in CRM_API_TOKEN in $configPath.
npm run pipeline
npm run dev
```

On Windows, the default runtime directory is `%LOCALAPPDATA%\BellhavenOwnershipReview`.
On Unix, the system first uses `$XDG_DATA_HOME/bellhaven-ownership-review`.
If `XDG_DATA_HOME` has no value, the system uses `~/.local/share/bellhaven-ownership-review`.

The runtime directory contains the CRM token file and the review state.
These items stay outside the source checkout.
You can change their locations with these variables:

- `BELLHAVEN_RUNTIME_DIR`
- `BELLHAVEN_CONFIG_PATH`
- `REVIEW_STATE_PATH`

The system rejects secrets in the source checkout.
For a current installation, move the legacy state to the runtime directory.
Do not replace completed decision history with a new empty state file.

Open [http://localhost:3000](http://localhost:3000).
The web server uses only IPv4 loopback address `127.0.0.1`.
The default web port is `3000`.
The review API uses the same loopback address.
The default API port is `3100`.
Use `REVIEW_WEB_PORT` and `REVIEW_API_PORT` to change these ports.

The review application provides these functions:

- Evidence inspection
- Proposal filters and search
- Optional reviewer notes
- Decision history
- A manual daily-scan control

Approval and rejection each require confirmation.
Only an approval can start a CRM write.
A rejection stays in terminal audit history for the applicable proposal.

## Source authority

The website is authoritative for current Bellhaven locations and current facility fields.
The CRM is authoritative for billing history and relationship IDs.

## Match method

### 1. Read all source records

The scraper follows all directory pages.
It removes duplicate detail URLs.
It compares the number of detail pages with the directory count.
If the counts are different, the scan stops.

The scraper reads these values from each detail page:

- Facility name
- Street
- City
- State
- ZIP code
- Care offerings
- Administrator
- Phone number
- Source URL

### 2. Normalize the source data

The system normalizes case, punctuation, Unicode marks, ZIP+4 codes, street suffixes, and direction words.
The system keeps the source values unchanged.

The name rules also treat these forms as equivalent:

- `&` and `and`
- `Centre` and `Center`
- `Healthcare` and `Health Care`
- `Rehab` and `Rehabilitation`

### 3. Identify the related CRM account

The system compares the street, ZIP code, city, state, and facility name.
An address match alone cannot identify an unrelated business at the same location.
An exact or near-exact name can recover a PO-box error or ZIP-code error.

The system has a limited fallback for facility name changes.
This fallback requires the city and ZIP code to match.
For example, it can match `Union Square Senior Living` with `Bellhaven at Union Square`.
The system rejects a name-only candidate in a different city or state.

### 4. Record the evidence

Each proposal contains this evidence:

- The source record
- The original CRM snapshot
- The match method and confidence
- The values before and after the proposed change
- The planned API operation
- The decision record
- The application result

### 5. Classify the difference

Each result has one of these classifications:

- Current-field update
- Direct parent change
- CHOW-safe create or link
- New account create
- Duplicate retirement
- Historic successor link
- Former affiliation that has the `Needs Review` status

If a location has multiple care offerings, the proposal keeps all offerings.
The system does not select one CRM `care_type` without sufficient evidence.

If multiple accounts have one address, the system first compares facility identity.
If the identity evidence is equal, it selects an active account that has the correct parent.
AR and lifetime revenue select the safe write path.
They do not select the facility identity.

The system selects one duplicate as the primary account.
It marks the other duplicate as `Inactive`.
It sets `duplicate_of_account` to the primary account ID.
It also adds an explanatory note.

The system does not assume a sale when a Bellhaven child is absent from the website.
Without successor evidence, the system sets the account status to `Needs Review`.

## CHOW safety rule

The system applies the billing standard operating procedure at two times:

- When the system creates a proposal
- Immediately before the system applies an approved change

| Account condition | Approved action |
| --- | --- |
| The parent is wrong. Lifetime revenue and AR are more than zero. | Do not change the old account parent or facility fields. Create or reuse a current account. Set only `chow_current_account` on the old account. |
| The parent is wrong. Revenue history or AR is zero. | Change the parent of the current CRM account. |
| The old account has AR. A current successor is at the same address. | Keep the old account. Link it to the current successor. |

Before a write, the approval process reads each related account again.
It compares the current fields with the proposal snapshot.
If a relevant field changed, the approval process stops.
A new AR value or a different CHOW target is a relevant change.
The reviewer must do a new scan.

Before a create operation, the process looks for an applicable current account.
The account must have the correct name, address, parent, and status.
The process sends a stable proposal idempotency key.
After each successful write, the process reads the account again.
It compares the stored values with the approved values.

The live correction kept these protected account links:

- `001A34WFSUYHCRBLFT` to `001E079DBBE40B33F2` in Marietta
- `001U6RW32TY0WSXZZB` to `0016D2BFD41DCC9514` in Tiffin
- `001SXSF4ELF0Z2LGDM` to `0017JP8Z1UQ763BVK3` in Sandusky

`npm run verify:live` checks each protected old account.
It checks the name, parent, status, address, lifetime revenue, and AR.

## Repeated-run safety

A proposal ID is a SHA-256 fingerprint.
It contains the finding type, source URL, account IDs, and desired operation.
The protected runtime directory contains all decisions.
The repository does not contain these decisions.

The system creates an HMAC signature from the CRM token.
Immediately before approval, the system checks the signature.
A changed JSON application cannot redefine a pending write.

The system applies these repeated-run controls:

- The system keeps an identical approved or rejected decision.
- A patch that already matches the CRM becomes a no-op.
- The system does not create a second completed duplicate relationship.
- The system does not create a second completed CHOW relationship.
- A finding that disappears stays in audit history with the `superseded` status.

A create operation can reuse only one account.
That account must meet all these conditions:

- The name is an exact match.
- The address is an exact match.
- The status is `Active`.
- The parent is correct.
- All desired fields have the approved values.

The state lock controls state changes from different processes.
It uses atomic publication and an authenticated lock witness.
It removes only exact crash artifacts.
It also uses private storage permissions and fsync-backed state replacement.

At startup, an interrupted `applying` decision changes to `failed`.
The reviewer can then reconcile the result and do the approval again.

A failed application records one of two outcomes:

- The current attempt made no write.
- The current attempt has an uncertain write result.

The reviewer cannot reject or discard an uncertain result.
Only an idempotent approval attempt or a new scan can reconcile this result.
A later pre-write failure does not remove the uncertain result.

The system keeps failed scheduled scans in a limited run history.
The last snapshot contains only necessary source evidence and the CRM account count.
A failed last scan stops all decisions.
A successful new scan removes this stop condition.

The sample schedule is in `ops/bellhaven-review.cron`.
The schedule runs each day on protected persistent storage.
The schedule wrapper prevents overlaps and limits each scan to 15 minutes.
It keeps the CRM token and review state in `/var/lib/bellhaven-ownership-review`.

A production system must use a transactional database instead of the JSON state file.
The production system must keep the same fingerprint, signature, and application rules.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run pipeline` | Read the website and CRM. Update the local review queue. Do not write to the CRM. |
| `npm run dev` | Start the review application and the local approval API. |
| `npm run verify:live` | Do a read-only final-state check of the current website and CRM. |
| `npm test` | Make the production build. Run the deterministic safety tests. |
| `npm run typecheck` | Do the strict TypeScript check. |
| `npm run lint` | Do the React, accessibility, and code-quality checks. |

The test suite includes these areas:

- Source normalization and scraper data changes
- Direct parent changes and CHOW parent changes
- Co-location and weak-match rejection
- One source record or CRM account in multiple matches
- Divestiture links
- Field changes before approval
- CRM write readback
- Create-operation idempotency
- Application field lists and signatures
- Interrupted operation recovery
- Uncertain operation recovery
- Decision stops after a failed scan
- CRM pagination and retry time
- Loopback-only server entry points
- Persistence of completed decisions
- Duplicate proposal prevention
- State changes from different processes
- Production HTML output

## Project map

```text
app/                          review application
lib/scraper.mjs               website scraper
lib/http.mjs                  bounded HTTP requests and safe GET retries
lib/normalization.mjs         address and name normalization
lib/matcher.mjs               classification and proposal creation
lib/crm.mjs                   authenticated CRM client
lib/apply.mjs                 approval application controls
lib/state.mjs                 proposal IDs, runs, and audit history
scripts/review-server.mjs     local review and approval API
scripts/run-pipeline.mjs      scheduled pipeline entry point
scripts/verify-final-state.mjs final-state checks
ops/run-pipeline.sh            schedule lock and time limit
ops/bellhaven-review.cron      daily schedule configuration
ops/bellhaven-review.logrotate log-retention example
.github/                       CI and dependency updates
tests/                         deterministic safety and output tests
```

## Security and operation

The CRM token and review state default to a private runtime directory.
This directory is outside the source checkout.
Git also ignores the CRM token and review state files.
But a Git ignore rule does not control file access or cloud synchronization.
Keep the runtime directory private.
If an unauthorized person has the CRM token, replace the CRM token.

The browser never receives the CRM token.
The supervisor removes CRM and state variables from the web process.
A same-origin runtime endpoint gives the browser only a new review-session token.
The endpoint response has a `no-store` cache control.
Thus, a production build cannot contain an old session token.

Both servers use only IPv4 loopback address `127.0.0.1`.
The API checks the Host header and the browser origin.
It also checks the JSON content type, request size, and review-session header.
The user interface prevents framing and sends restrictive browser security headers.

CRM requests require HTTPS and an approved host name.
The system limits response size and checks the response schema.
Safe GET requests use limited retries.
An incomplete CRM page stops the scan.
The system does not automatically retry a write.

The system signs each stored proposal application.
It checks each operation and field against an approved list.
Reviewer notes and reviewer IDs have length limits.

CI uses a locked install, typecheck, lint, tests, build, and high-severity dependency audit.
Each GitHub Action uses a full commit SHA.
Dependabot groups compatible framework updates each week.

The review state contains CRM evidence.
Treat this state as sensitive data.
The repository does not contain the review state.
The runtime does not use an LLM or a paid API.

### Install the persistent schedule

Use the files in `ops/` as deployment examples.
These examples require Linux, `flock`, GNU `timeout`, cron, and logrotate.

Create a dedicated `bellhaven` service account.
Then, create the protected directories and files.
Run these commands:

```sh
install -d -o bellhaven -g bellhaven -m 0700 /var/lib/bellhaven-ownership-review
install -d -o root -g bellhaven -m 0750 /etc/bellhaven-ownership-review
install -o root -g bellhaven -m 0640 .env.example /etc/bellhaven-ownership-review/.env.local
install -o bellhaven -g bellhaven -m 0640 /dev/null /var/log/bellhaven-ownership-review.log
install -o root -g root -m 0644 ops/bellhaven-review.cron /etc/cron.d/bellhaven-review
install -o root -g root -m 0644 ops/bellhaven-review.logrotate /etc/logrotate.d/bellhaven-review
```

Add the CRM token to the protected runtime configuration.
Make sure that `/usr/bin/npm` has the correct location.
Make sure that `/opt/bellhaven-ownership-review` is the correct checkout.
Send the local `root` mail or cron exit status to the monitoring system.

Exit status `75` means that another scheduled scan has the outer lock.
GNU `timeout` gives a different status after the 15-minute time limit.
The application also uses the state lock.
Thus, API and command-line processes cannot overwrite the same review state.
