# Security policy

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** button on the repository's Security tab to open a
private security advisory. Do not put a vulnerability, credential, private Worker address, private
user data, or working exploit in a public issue.

Include the affected endpoint or file, the observed impact, reproducible steps that do not target
other people's deployments, and a suggested fix if you have one. You should receive an initial
response within seven days. Please allow time for a fix and coordinated disclosure.

This project does not run a public bug-bounty program and cannot authorize testing against a Worker
you do not own. Test only a local environment or a Cloudflare deployment you control.

## Supported versions

Security fixes are made on the current `main` branch. Self-hosters are responsible for reviewing and
deploying updates to their own Cloudflare account.

## Deployment secrets

The Worker requires two independent secrets of at least 32 characters:

- `RATE_LIMIT_HASH_PEPPER`
- `REPORT_TOKEN_SECRET`

Store them as encrypted Cloudflare secrets. Never place their values in `wrangler.jsonc`, `.dev.vars.example`,
the Android app, a GitHub Actions variable, an issue, or a log. Local `.dev.vars` and `.env*` files are
ignored, but operators should still check staged changes before every commit.

If a secret is exposed, replace it in Cloudflare immediately. Changing the rate-limit pepper resets
the effective per-installation counters; changing the report-token secret invalidates previously
issued report tokens.

## Important limits of the current design

- The app installation ID is pseudonymous rate-limit input, not authentication or device
  attestation. A determined caller can replace or spoof it.
- IP limits are a secondary abuse signal; shared networks may share one IP and attackers may change
  IPs.
- D1 reservations are the authoritative application limits, but the estimated Neuron budget is not
  Cloudflare's billing meter.
- Text safety screening does not inspect reference-image or generated-image pixels.
- CORS controls browser origins; it does not authenticate native apps.
- The Worker does not currently verify Play Integrity or Firebase App Check tokens.
- Image-inference diagnostics contain only a request ID, model alias, artwork type, normalized
  provider code/category, and timestamp. D1 prunes them after 30 days on subsequent writes and caps
  them at 5,000 rows. Prompts, images, IPs, installation IDs/hashes, and raw provider messages or
  stacks must never be added to diagnostics or logs.

Before exposing one deployment to broad public traffic, add properly verified app attestation,
operational alerts, report-review and retention procedures, image-input/output moderation suitable
for the use case, and current model/license/pricing review. Keep user-upload and procedural artwork
fallbacks available when this service refuses or cannot complete a request.
