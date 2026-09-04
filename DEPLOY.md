# Deploy your own image server

This guide is for people who do not normally work with servers. Cloudflare runs the service; you do
not need to leave a computer turned on.

## Before you begin

You need:

- a free [Cloudflare account](https://dash.cloudflare.com/sign-up);
- a GitHub account, because Cloudflare copies the template there so you own your copy; and
- about ten minutes.

This server is optional. If you decide not to create one, DIY Walking Challenges can still use
uploaded artwork and its built-in non-AI medal design.

## The easiest setup

1. Select the button below.

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/diywalkingchallenges-code/diy-walking-challenges-image-worker)

2. Sign in to Cloudflare and GitHub when those companies ask you to. Cloudflare creates a copy of
   this template in your GitHub account. That copy is normal and lets you inspect or update your own
   server later.

3. Keep the suggested Worker and database names unless you already use them.

4. When Cloudflare asks for `RATE_LIMIT_HASH_PEPPER`, enter a newly generated random value of at
   least 32 characters. A password manager's password generator is suitable. This is the **rate-limit
   private code**.

5. When it asks for `REPORT_TOKEN_SECRET`, generate a different random value of at least 32
   characters. This is the **report private code**. Do not reuse the first value.

6. Keep these cautious defaults:

   - `DAILY_GLOBAL_NEURON_BUDGET`: `1000`
   - `ENABLED_MODELS`: `flux2-klein-4b,flux-schnell`
   - `SAFETY_MODEL`: `@cf/meta/llama-guard-3-8b`
   - `ALLOWED_ORIGINS`: leave empty for the Android app

7. Select **Deploy**. Cloudflare provisions the Worker, Workers AI binding, D1 quota database, rate
   limits, and encrypted secrets. The deploy command also applies the included D1 migration.

8. Wait until Cloudflare reports a successful production deployment. Open the Worker and copy the
   main `https://…workers.dev` address from **Domains & Routes**. Do not use a temporary preview
   address.

9. In DIY Walking Challenges, open **Settings → Manage image generation → Connect an existing
   server**. Enter any friendly name, paste the main address, and select **Check & save**.

Only the public Worker address goes into the Android app. The two private codes, your Cloudflare
login, Cloudflare account ID, D1 database ID, and API tokens must stay out of the app and GitHub.

## What could cost money?

Cloudflare currently documents a daily free Workers AI allowance. On the Free plan, work stops when
the allowance is exhausted instead of automatically creating Workers AI overage charges. A paid
Workers plan can charge for usage above its included allowance, and other Cloudflare products may
have separate pricing.

The template's `1000`-Neuron internal daily budget is deliberately much smaller than the currently
documented account-wide free allowance. It protects against ordinary use and some abuse, but it is
an estimate made before generation—not a contractual spending cap. Cloudflare can change models,
allowances, and pricing. Check the official pages before raising limits or choosing a paid plan:

- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers platform pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/)

Everyone using your server shares its daily budget. Three attempts per model per phone does not mean
that every phone is guaranteed six images; the shared budget may stop sooner.

## Confirm it works

Open these addresses in a browser, replacing the example domain with your own:

- `https://your-worker.example.workers.dev/` — friendly status page
- `https://your-worker.example.workers.dev/health` — should show `{"ok":true,"apiVersion":1}`
- `https://your-worker.example.workers.dev/v1/models` — shows the currently enabled capabilities

Image generation itself is intentionally a `POST` request with app headers, so there is no browser
button that consumes an attempt.

## Update your server

Cloudflare's deploy flow creates a new repository in your GitHub account and normally connects it to
Workers Builds. Review changes from this upstream repository before merging them into your copy.
Do not automatically give unreviewed pull requests access to a production deployment.

If you maintain it from a computer instead, use Node.js 22 or newer:

```console
npm ci
npm run check
npm test
npm run deploy
```

`npm run deploy` applies pending D1 migrations and then deploys the Worker.

## Remove the server

Removing a saved address in DIY Walking Challenges disconnects only that phone. It does not delete
the Worker.

To stop the server for everyone, use Cloudflare's **Workers & Pages** dashboard to disable or delete
the Worker. Review the separate D1 database before deleting it, because database deletion is not
recoverable through this repository. Images previously saved in people's routes remain on their
phones.

## Troubleshooting

### The app says the server is incompatible

Open `/health` and `/v1/models` on the production address. If either is missing, confirm that the
latest production deployment succeeded and that you did not paste a preview URL or a URL ending in
another path.

### Image generation says the daily limit was reached

Wait for the UTC-day reset or upload artwork from the phone. Do not repeatedly retry; failed or
ambiguous attempts are intentionally not refunded.

### Cloudflare reports a missing secret

Open the Worker in Cloudflare, then **Settings → Variables and Secrets**. Add the exact missing name
as an encrypted **Secret**, not a visible text variable. The two required secret names are
`RATE_LIMIT_HASH_PEPPER` and `REPORT_TOKEN_SECRET`; their values must be different random strings of
at least 32 characters.

### The database tables are missing

From the GitHub-connected Cloudflare build settings, confirm the deploy command is `npm run deploy`.
That command applies `migrations/0001_daily_quota.sql` before deploying the Worker.

Never solve a setup error by publishing a private code, Cloudflare API token, database ID, or account
ID in an issue. Use a [private GitHub security advisory](SECURITY.md) if the problem exposes sensitive
information.
