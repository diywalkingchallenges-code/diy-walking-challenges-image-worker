# DIY Walking Challenges Image Worker

This is the optional, self-hostable image-generation service for **DIY Walking Challenges**. It can
create original completion medals, milestone banners, and decorative route-map backgrounds using
[Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/).

The Android app works without this service. People can always upload their own artwork instead.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/diywalkingchallenges-code/diy-walking-challenges-image-worker)

**This setup is available now.** The button opens Cloudflare's guided deployment screen; it is not
a placeholder or a wait-list. You still need to sign in, choose names, supply two private random
codes, and confirm **Deploy**. Cloudflare handles the repository copy and resource provisioning.

## What the setup button does

Cloudflare copies this public template into **your** GitHub account, creates the resources in **your**
Cloudflare account, and deploys a Worker with its own public HTTPS address. The template asks for two
private random codes during setup. Those codes stay encrypted in Cloudflare and must be different
from one another.

The deployment contains:

- one Cloudflare Worker that validates requests and returns generated images;
- one Workers AI connection for image generation and text safety screening;
- one small D1 database for daily limits, image reports, and privacy-minimal failure diagnostics; and
- three short-window rate limiters to reduce accidental or abusive bursts.

No DIY Walking Challenges account, Firebase project, or payment information is required by this
repository. Cloudflare's current free allowance can cover light personal use, but limits and prices
can change. Review [Cloudflare's current Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
before deploying or changing the budget.

For a screen-by-screen explanation, including what to enter for each private code, see
**[DEPLOY.md](DEPLOY.md)**.

## Connect the Android app

After Cloudflare says the deployment succeeded:

1. Open the Worker in Cloudflare and copy its main `https://…workers.dev` address.
2. Open DIY Walking Challenges on the phone.
3. Go to **Settings → Manage image generation → Connect an existing server**.
4. Give it a name, paste only the main HTTPS address, and choose **Check & save**.

Do not paste a Cloudflare login, API token, account ID, database ID, either private code, or an
address ending in `/model` or `/v1/models` into the app.

## Privacy in plain language

When someone chooses to generate artwork, this service receives:

- their short artwork description;
- the selected model and artwork type;
- a random ID created by that app installation;
- an optional reference image they confirmed they may use; and
- normal connection information available to an internet service, such as IP address and time.

The Worker sends the text description to a Cloudflare-hosted safety model and then sends the fixed
parent prompt and optional reference image to the selected Cloudflare image model. It returns the
result directly. The code does **not** save prompts, reference images, generated images, health data,
route progress, race-room data, account profiles, or advertising data.

The D1 database stores daily usage counters keyed by salted hashes. If a user reports a generated
image, it stores the request ID, hashed installation ID, report reason, optional report details, and
timestamps. Report details are free-form, so clients should warn people not to type personal or
sensitive information there. When Cloudflare image inference fails, D1 stores only the request ID,
model alias, artwork type, normalized provider code/category, and timestamp. It stores no prompt,
network address, installation identifier or hash, provider message, or stack for that diagnostic.
Failure rows are pruned after 30 days on subsequent writes and capped at 5,000 rows. See
[API.md](API.md) for the exact wire contract and
[SECURITY.md](SECURITY.md) for the security model.

## Built-in safeguards

- Only server-approved model aliases can be requested; callers cannot submit arbitrary model IDs.
- User themes are normalized and limited to 3–50 Unicode characters.
- Server-owned prompts request original artwork without words, brands, commercial replicas,
  copyrighted characters, signatures, or watermarks.
- Every accepted prompt is checked by an allowlisted Cloudflare safety model before image inference.
- Reference images require an explicit rights confirmation and strict format, size, and dimension
  checks.
- Generated files are bounded and validated for format and dimensions before being returned.
- Exact daily attempt and conservative compute-budget reservations are stored in D1.
- Provider failures become stable, plain-language API errors; raw upstream errors are never returned.
- Minimal failure diagnostics exclude user content and use bounded D1 retention.
- Browser access is denied by default; wildcard CORS is intentionally unsupported.
- Responses are not cached, and the landing page has a restrictive security policy.

These controls reduce risk; they cannot guarantee that every generated image is appropriate or free
of third-party rights. Operators should provide a reporting process and review enabled model terms
before offering the service broadly.

## Default models and limits

The checked-in production allowlist exposes two inexpensive model adapters:

| App model ID | Cloudflare model | Uses |
|---|---|---|
| `flux-schnell` | `@cf/black-forest-labs/flux-1-schnell` | Medals |
| `flux2-klein-4b` | `@cf/black-forest-labs/flux-2-klein-4b` | Medals, banners, route maps, optional references |

Each app installation gets three attempts per enabled model per UTC day. All artwork types made with
one model share those three attempts. The default `DAILY_GLOBAL_NEURON_BUDGET` is `1000`, which is a
conservative application-level stop below Cloudflare's account-wide allowance. It is not
Cloudflare's authoritative meter or a guaranteed billing cap.

Several additional adapters remain in the source with `productionEnabled: false`. Editing only the
environment variable cannot expose them. Enabling another model requires a code change, tests, and a
fresh review of its current schema, license, availability, output rights, and price.

## Development

Requirements: Node.js 22 or newer and a Cloudflare account for live development.

```console
npm ci
npm run check
npm test
npm run template:check
```

Tests use fake AI, D1, and rate-limiter bindings. They cover nested provider-code normalization,
stable error mapping, bounded minimal diagnostics, and diagnostic-write failure. They do not send prompts or images to Cloudflare
and do not consume Workers AI allowance. `template:check` also performs a local dry-run of the exact
Worker bundle and bindings used by the Deploy to Cloudflare flow; it does not contact Workers AI or
create Cloudflare resources.

For local Worker development, copy `.dev.vars.example` to `.dev.vars`, replace both examples with
different random values of at least 32 characters, and run `npm run dev`. `.dev.vars` is ignored by
Git and must never be committed.

## Repository map

- `src/` — request validation, prompts, model allowlist, quotas, reports, diagnostics, and image validation
- `migrations/` — D1 database tables and indexes
- `test/` — unit and API-contract tests with mocked Cloudflare bindings
- `wrangler.jsonc` — portable, account-free Cloudflare resource declarations
- `API.md` — complete client/server contract
- `DEPLOY.md` — beginner setup and maintenance guide

The Firebase race and route-sharing server is a separate project:
[diy-walking-challenges-firebase-server](https://github.com/diywalkingchallenges-code/diy-walking-challenges-firebase-server).
The Android application source is not part of this repository.

## Contributing and license

Issues and pull requests are welcome. Please do not include production credentials, private user
data, copyrighted commercial artwork, or generated images containing personal information.

The source is licensed under the [Apache License 2.0](LICENSE). The DIY Walking Challenges name and
branding are not granted by that code license; see [TRADEMARKS.md](TRADEMARKS.md).
