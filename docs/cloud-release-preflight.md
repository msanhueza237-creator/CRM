# Cloud release preparation: authentication prerequisite

Date: 2026-10-08. Preparation only. Nothing in this document authorizes changes.

## Verified state

- Hostinger VPS 1762778, 187.77.53.52. Existing SSH access used read-only.
- Server ED25519 fingerprint remains
  `SHA256:FI51pTDQYUa1UEGo1Shfemk4o6Dh5QPmzA8G0o8lgoc`.
- Dokploy v0.29.14, Docker Compose v5.1.4, Traefik v3.6.7.
- CRM application `v8OxI5RagW3PhD2_LmzLc` uses
  `fix/historical-import-cloud`, autodeploy false, status done.
- Backend compose `SaHAMnge3oCj4HNIxCrEc` uses
  `codex/historical-import-app-only`, autodeploy false, status done.
- No running or queued deployments were observed. Do not rely on this snapshot
  as authorization: repeat the read-only checks before an approved change.
- Supabase functions run in the EXISTING container
  `crm-climactiva-supabase-duewf7-supabase-edge-functions`, image
  `supabase/edge-runtime:v1.67.4`. Its main router loads files and forwards
  runtime environment variables to function workers; it has no deploy API.
- WhatsApp commit `550afcc3f69fe9b920eef34310b5141b48864aac` is already applied.
  Verified file hashes:
  - `crm-agent/index.ts`:
    `1e20da6e33640b816cb5b587d70bb37418784fc8d51db389424457b07c1b8c08`
  - `crm-agent/whatsapp-incoming.ts`:
    `77f80116504c5b440749aee6461be0355056357ef8356dafecbcd23bd4317aa6`
- Existing recovery archives were read and their member hashes verified:
  `/root/crm-backups/2026-10-08-whatsapp-replies-550afcc/before.tar.gz` and
  `payload.tar.gz`. No new backup was created. These cover two files, NOT every
  possible future release. A future deployment must verify recovery for its
  complete diff and stop if the existing artifacts do not cover it.
- The older unlinked WhatsApp message has NOT been reassigned. Matching a name
  or latest outgoing message is not sufficient evidence of company identity.

## Actual installed API limits

Inspected source embedded in `/app/dist/server.mjs.map`, plus installed
`@dokploy/server/src/lib/auth.ts`, permission logic and database schema names.
No API keys, environment values or database records containing secrets were read.

- API authentication uses `x-api-key`; validation resolves the key's user and
  organization, and route checks enforce that user's resource/service access.
- `application.deploy` and `compose.deploy` accept their service ID, optional
  title and description. Their installed input schemas do NOT accept an
  immutable commit SHA. They enqueue work using the configured service source.
- `deployment:create` also authorizes stop/start/reload and other operations.
  A general deployment key is therefore not the closed operation contract
  requested by the user. Do not claim it is an exact one-operation capability.
- Giving Cloud direct Dokploy API access does not deploy `crm-agent` files in
  the bind mount. The existing Supabase compose includes other services and
  must not be redeployed wholesale to publish one function.

Primary references checked alongside the installed source:

- https://docs.dokploy.com/docs/api
- https://raw.githubusercontent.com/Dokploy/dokploy/v0.29.14/apps/dokploy/server/api/routers/application.ts
- https://raw.githubusercontent.com/Dokploy/dokploy/v0.29.14/apps/dokploy/server/api/routers/compose.ts
- https://supabase.com/docs/guides/self-hosting/self-hosted-functions
- https://learn.chatgpt.com/docs/environments/cloud-environments

## Blocking prerequisite found in Cloud itself

Cloud chat: `Configurar CRM`, ID `01a11808-a717-779f-8664-928f8df98033`.
That chat performed its own TLS-verified GET of `https://crm.latinchile.cl/`:
HTTP 200. Its configuration draft contained no network secrets. It verified
that it can declare a secret requirement for a host and the user can supply
the value through environment configuration. It did NOT prove substitution in
Bearer, x-api-key or a custom header. An offline request construction does not
prove this behavior. Do not generate a real publishing credential yet.

The public docs specify HTTPS/443 substitution but do not define all supported
header formats. A synthetic proxy test is required before selecting a real
authentication format. HMAC signing with the secret in a Cloud process is not
appropriate when the process receives only a substituted placeholder.

## Proposed prerequisite test, not a publisher

Prepared code in this existing CRM repository:

- `ops/cloud-release/proxy_probe.py`
- `ops/cloud-release/test_proxy_probe.py`
- `ops/cloud-release/clima-cloud-proxy-probe.service`
- `ops/cloud-release/traefik-proxy-probe.yml`

This receiver has NO filesystem writes, subprocesses, outbound calls, Docker
socket, CRM database, Supabase credentials or deployment operations. It is a
short-lived standard-library HTTP fixture behind the existing TLS proxy, not
a production application or deployment server. Nothing imports it into the CRM.

Proposed URL: `https://crm.latinchile.cl/__codex_proxy_probe/v1/check`.
Use the existing hostname/certificate, NOT the initially suggested new subdomain.
Certificate verification on the VPS succeeded; its current certificate covers
crm.latinchile.cl and expires on 2026-12-02. No DNS/firewall changes are needed.

Exact proposed VPS additions (not installed):

| File | Owner / mode | Purpose |
| --- | --- | --- |
| `/opt/climactiva-cloud-probe/proxy_probe.py` | root:root / 0644, directory 0755 | Reviewed fixture code |
| `/etc/systemd/system/clima-cloud-proxy-probe.service` | root:root / 0644 | Temporary sandboxed process |
| `/etc/dokploy/traefik/dynamic/clima-cloud-proxy-probe.yml` | root:root / 0644 | Only two exact URL routes |

All three destination names were absent, and TCP 9087 was unused at inspection.
Host Python is 3.12.3; systemd is 255. No packages or images need installation.

Command proposed in the unit:

```sh
/usr/bin/python3 -I -B /opt/climactiva-cloud-probe/proxy_probe.py --bind 172.16.0.1 --port 9087 --peer 172.16.0.2
```

The addresses were read from the existing Traefik bridge. Revalidate them before
starting; do not broaden to 0.0.0.0 if they changed. The receiver admits only
that proxy's peer address. Its port is not published on the VPS public IP.
DynamicUser provides a transient identity, not a persistent SSH user. It has no
sudo/docker membership, an empty capability set, read-only filesystem/home
isolation, maximum four request threads, 64 MiB memory and 10 percent CPU.
It does not auto-start at boot; systemd RuntimeMaxSec stops it after one hour.
Do not restart any existing service, including Traefik; its file watcher loads
only the new route. Validate the unit before starting it.

`/etc/dokploy` is root-owned mode 0777. Code and unit are outside that tree.
The route is data, not an executed script. This does not fix the existing parent
permission risk, and does not justify entrusting it with a production secret.
No global chmod is included. Before a real publisher, its privileged files,
parents, route integrity and recovery must be reviewed separately.

### Test contract

- `GET /__codex_proxy_probe/v1/health`: generic fixture availability only.
- `POST /__codex_proxy_probe/v1/check`: three exact body keys: `mode`,
  `requestId` (canonical UUID), `marker` (`synthetic-only`).
- Modes: `bearer`, `x-api-key`, `custom`; only the respective header is compared.
- `Idempotency-Key` must match requestId for its boolean result to pass;
  `X-Request-Nonce` must be a fresh, different canonical UUID.
- Returns only four booleans: credentialMatched, jsonMatched,
  idempotencyHeaderReceived, nonceHeaderReceived. Never echoes inputs/hashes.
- Duplicate request IDs or nonces: 409. Body over 1024 bytes: 413.
  Global limit: 60 calls/minute. Expired probe: 410. No query-string auth.
- The public fixture marker in code is deliberately NOT a credential: it grants
  no privileges or read access. It is the ONLY value to put into the temporary
  Cloud test requirement `CLIMA_PROXY_PROBE_TOKEN`, allowed host
  `crm.latinchile.cl`. Never put a real token into this probe or use this fixture
  marker as the future publishing credential.
- Cloud must use its environment variable/placeholder, NOT insert the known
  marker directly into the request. It must report whether a placeholder was
  delivered, without printing its value, to distinguish proxy substitution
  from a direct environment variable.
- After authorization, the named Cloud chat declares the requirement; the USER
  enters the synthetic marker through its secure configuration UI. Apply the
  environment through the actual available workflow, not an invented setting.
- Cloud runs positive and negative control requests with redirects disabled,
  TLS verification enabled, fresh IDs, and no verbose request logging. It
  compares results, not raw credentials. Passing Bearer becomes the preferred
  format; otherwise use a verified supported format or stop.

### Failure and cleanup limits

Do not start if: path collision, changed proxy address, invalid TLS, occupied
port, invalid unit, code/hash mismatch, unexpected concurrent deployment, or
unexpected permissions. No broad fixes, new backups or fallback open listener.

Stop if the test reflects input, accepts an unrecognized peer, unexpectedly
affects existing health endpoints, or Cloud cannot demonstrate substitution.
Do not create a real credential or install a publishing capability on failure.

Recovery of this prerequisite test touches ONLY its own new files and process:
stop `clima-cloud-proxy-probe.service`; move its matching-hash route outside the
watched directory into `/opt/climactiva-cloud-probe/disabled/`; move its unit
there and reload systemd's unit metadata. Preserve the files for inspection.
Do not delete files, restore databases, restart existing services, change DNS,
modify autodeploy, or recreate app/frontend/workers. If those files no longer
match our hashes, stop rather than overwrite someone else's changes.
Remove the temporary Cloud secret requirement via its own confirmed environment
workflow after testing. No real credential is to be revoked because none exists.

### Local verification

```sh
python -B -m unittest discover -s ops/cloud-release -p test_proxy_probe.py -v
```

13 tests passed with local loopback HTTP and synthetic values. They cover the
three header forms, missing/wrong credentials, no reflection/logs, nonce/request
replay, unsupported paths/operations, body/type limits, rate/expiry and peer
restriction. They do NOT prove Cloud substitution, Linux unit startup, or
Traefik routing; those require the narrowly authorized prerequisite test.

## Publisher design direction, not implemented or approved

After the transport test, prepare ONE installation request for a versioned,
closed release controller within the existing repos/VPS. Keep read/status,
commit promotion and narrowly authorized rollback separate. Pin complete SHA,
repo, branch, service, diff, prior hashes and operation authorization; reject
requester paths, URLs, shell commands and source uploads. Include persistent
replay protection, concurrency, rate limits and sanitized audit.

Do not expose a root shell or raw Docker/Dokploy credential to Cloud. A privileged
host-side helper, if needed, must be root-owned outside `/etc/dokploy`, with a
fixed operation protocol and separately reviewed permission boundary. Publishing
`crm-agent` code inherits its service-role/database and other runtime privileges;
it is NOT low-risk access even with a path allowlist. Releasing that code must
require a specific user approval, not merely possession of an API credential.

Continue Cloud -> GitHub on the current release branches, never main. A PR/push
is not a deployment authorization. Preserve backend overlays, external networks,
variables, workers and both false autodeploy settings. Do not call a generic
compose deploy to replace one function. The two-file existing recovery is not a
blanket rollback guarantee. Do not enable mutation until exact candidate and
recovery checks succeed. Installation, later publication, and historical
WhatsApp message attribution remain separate scopes.

Windows independence is NOT yet achieved. No remote publisher is installed;
existing administration remains available. The prepared test itself can run on
the VPS without Windows once installed, but neither a successful local test nor
Cloud's public HTTPS GET proves authenticated publication or rollback.
