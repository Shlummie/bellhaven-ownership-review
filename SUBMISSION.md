# Submission

**Repository link:** https://github.com/Shlummie/bellhaven-ownership-review

**Actual time:** Approximately 7 focused hours.
This time includes implementation, live CRM correction, safety corrections, and final verification.

## System summary

The system uses deterministic rules.
It reads the Bellhaven website and compares each location with the isolated CRM.
The system creates a proposal for each necessary change.
The local review application shows the source evidence and the CRM evidence.
It also shows the values before and after each proposed change.
The system writes to the CRM only after a reviewer gives approval.

## Match method

The scraper reads all three directory pages and all facility detail pages.
It reads facility names, addresses, care offerings, administrator names, phone numbers, and source URLs.
It normalizes names, addresses, cities, states, and ZIP codes.

The system ranks CRM candidates by address and facility identity.
An address match alone cannot identify an unrelated business at the same location.
The system makes sure that two source locations do not use the same CRM account.

The system gives each finding one of these classifications:

- Field update
- Parent change
- New account
- CHOW-safe account create or link
- Duplicate account
- Former Bellhaven account that needs review

## CHOW safety

The system checks lifetime revenue and AR before a parent change.
If revenue and AR are more than zero, the system keeps the old account unchanged.
It creates or reuses a current account that has the correct parent.
Then, it sets only `chow_current_account` on the old account.

Before a write, the approval process reads the captured CRM fields again.
If a relevant field changed, the operation stops.
After a successful write, the process reads the account again.
It compares the stored values with the approved values.

Stable proposal fingerprints keep approved and rejected decisions after repeated runs.
Two repeated scans after the corrections created zero new proposals.

## Operation safety

The CRM token and review state stay outside the source checkout.
Both servers use only IPv4 loopback address `127.0.0.1`.
The browser receives a review-session token, not the CRM token.

The API checks the Host header, origin, content type, request size, and session header.
The system limits network response size and retries only safe read requests.
An incomplete CRM page stops the scan.

The state lock makes sure that different processes do not change review state at the same time.
The state file uses atomic replacement and file-system synchronization.
An interrupted approval changes to a failed result that the reviewer can reconcile.

A failed write records whether the attempt made no write or has an uncertain result.
The reviewer cannot reject or remove an uncertain result.
A failed last scan stops all decisions until a new scan is successful.

The repository contains these operation controls:

- CI actions that use full commit SHAs
- Grouped Dependabot updates
- A schedule wrapper with an overlap lock
- A 15-minute scan time limit
- A restrictive file-creation mask
- A failure signal
- A log-retention example

## Acceptance evidence

- The corrected CRM has 34 current Bellhaven facilities.
- The review history has 27 verified approvals.
- The CRM has 3 protected CHOW links.
- The review queue has 0 open items.
- Two repeated scans created 0 new proposals.
- The production build and all 66 deterministic tests pass.
- The strict typecheck and lint checks pass.
- The high-severity dependency audit reports 0 vulnerabilities.
- The public source does not contain the CRM token or review state.
- The public source does not contain build output or local computer data.

For all methods, commands, and verification data, refer to [README.md](README.md).
