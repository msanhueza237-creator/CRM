# USD statement closing balance

## Verified issue (2026-09-15)

The imported `typeDesc (35).xls` has 42 rows, including 17 duplicates and 25
new movements. On 2026-09-11 it records a USD 11000 deposit and a USD 11000
outgoing transfer, leaving USD 0.80. The workbook is reverse chronological.
Picking the largest source-row number on the latest day selected the earlier
USD 11000.80 intermediate balance.

The manual bank-balance form also omitted `exchangeRate`, although the backend
requires it for a non-CLP account. It could not successfully confirm USD balances.

## Changes

- Infer the workbook's chronological direction and validate the latest day's
  running balances. Ambiguous order requires review, never a guessed closing.
- Read all confirmed import rows, including duplicates and legacy uploads;
  do not depend on the subset of new bank transactions.
- Keep original USD cents and the documented conversion separately.
- Show and submit a USD/CLP rate in the balance form; reject invalid amounts.
- Same-day manual corrections use `updated_at` when choosing the latest balance.
- No new payment, bank movement, journal, FX trade or invoice settlement is
  created by these read-model and control-balance corrections.

## Verification

`node --experimental-strip-types --test scripts/test-bank-statement-balance.mjs`

Read-only replay against the 42 production import rows returned closing USD 0.80
and the stored rate 956. The production database was not modified.
Actual BankImportView tested at 390px and 1440px; a mocked submission passed
balance 0.8 and exchangeRate 956, with no CRM requests and no horizontal overflow.

Publication is limited to this bank-balance fix. It does not activate the
separate, still-pending Facto Libro Diario synchronization.
