# Facto receivables connector

Backend-only worker for the controlled Facto receivables synchronization.

The worker always follows this order:

1. Read issued document headers from the documented Facto API.
2. Open `Documentos Impagos` in an ephemeral, read-only browser session.
3. Normalize and compare both sources.
4. Stage an auditable preview in Supabase.
5. Stop. A permitted CRM user must review and apply the preview separately.

Applying a preview updates Facto's reported operational balance only. It does not
create bank transactions, reconciliations, payments, or journal entries.

## Local commands

Copy `.env.example` to a private environment source and configure the values in a
local secret manager. Do not commit a populated `.env` file.

```powershell
npm run typecheck:facto-connector
npm run test:facto-connector
npm run facto:receivables:phase4 -- --from 2026-01-01 --to 2026-09-07
npm run facto:receivables:once
```

The Phase 4 command is an isolated diagnostic. It reads the official API and
writes a redacted local report under `.facto-evidence`; it never contacts the CRM.
Add `--with-browser` only after configuring the verified account URL, unpaid
documents URL and private web credentials. Even in that mode, Facto and CRM write
counts remain zero.

`facto:receivables:watch` is reserved for a later scheduled-operation phase.
For the controlled local test, `FACTO_BROWSER_CHANNEL=chrome` can use the
installed Chrome. A future server worker must install a compatible Playwright
Chromium image before scheduling the connector.

## Safety

- Credentials are loaded only by the worker process.
- Browser contexts are ephemeral and no storage state is persisted.
- Mutating web requests are blocked after login.
- Incomplete pagination, a changed page, CAPTCHA/MFA, or an empty unverified page
  aborts safely and leaves current CRM balances unchanged.
- Browser evidence is local and ignored by Git.
