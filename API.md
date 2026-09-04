# Artwork generator API v1

The API returns raw image bytes on success and JSON on errors. The Android client must impose its
own response-size limit, fully decode the image, normalize it to its local artwork rules, and then
store it in app-private storage.

Opening `GET /` in a browser returns a static DIY Walking Challenges service-status page. `HEAD /`
returns the same status and headers without a body. These are informational and are not used by the
Android client.

For people checking the service in a browser, `GET` or `HEAD` requests to `/model` and `/models`
permanently redirect to the canonical versioned catalog at `/v1/models`. Other unknown paths remain
structured JSON `404` responses.

## `GET /v1/models`

No installation identifier is needed. Clients use this response to discover both the enabled models
and the artwork types each model can create.

```json
{
  "apiVersion": 1,
  "defaultAssetKind": "medal",
  "promptLimits": {
    "minCodePoints": 3,
    "maxCodePoints": 50
  },
  "quota": {
    "dailyAttemptLimit": 3,
    "dailyAttemptScope": "installation_model",
    "resets": "utc_day"
  },
  "models": [
    {
      "id": "flux-schnell",
      "name": "Flux Schnell",
      "description": "Fast completion-medal artwork; not available for maps or banners",
      "supportsReference": false,
      "dailyAttemptLimit": 3,
      "baseEstimatedImageNeurons": 58,
      "output": {
        "providerControlled": true
      },
      "assetKinds": [
        {
          "id": "medal",
          "baseEstimatedImageNeurons": 58,
          "output": {
            "providerControlled": true
          },
          "supportsReference": false
        }
      ]
    },
    {
      "id": "flux2-klein-4b",
      "name": "Flux 2 Klein",
      "description": "Modern generation and reference-image editing",
      "supportsReference": true,
      "dailyAttemptLimit": 3,
      "baseEstimatedImageNeurons": 27,
      "output": {
        "width": 512,
        "height": 512,
        "providerControlled": false
      },
      "referenceMaxBytes": 2097152,
      "referenceMaxWidth": 512,
      "referenceMaxHeight": 512,
      "assetKinds": [
        {
          "id": "medal",
          "baseEstimatedImageNeurons": 27,
          "output": {
            "width": 512,
            "height": 512,
            "providerControlled": false
          },
          "supportsReference": true,
          "referenceMaxBytes": 2097152,
          "referenceMaxWidth": 512,
          "referenceMaxHeight": 512
        },
        {
          "id": "milestone_banner",
          "baseEstimatedImageNeurons": 53,
          "output": {
            "width": 1024,
            "height": 512,
            "providerControlled": false
          },
          "supportsReference": true,
          "referenceMaxBytes": 2097152,
          "referenceMaxWidth": 512,
          "referenceMaxHeight": 512
        },
        {
          "id": "route_map",
          "baseEstimatedImageNeurons": 105,
          "output": {
            "width": 1024,
            "height": 768,
            "providerControlled": false
          },
          "supportsReference": true,
          "referenceMaxBytes": 2097152,
          "referenceMaxWidth": 512,
          "referenceMaxHeight": 512
        }
      ]
    }
  ],
  "safety": {
    "model": "@cf/meta/llama-guard-3-8b",
    "estimatedNeuronsVaryByPrompt": true
  }
}
```

Only reviewed, production-enabled models selected by the server are returned. A client must not
hard-code the presence of any particular model or artwork type. `baseEstimatedImageNeurons`
excludes mandatory prompt classification.

The model-level `baseEstimatedImageNeurons`, `output`, `supportsReference`, and reference limit
fields retain their original medal meanings for older clients. New clients should use the matching
entry in `assetKinds`. A catalog without `assetKinds` is a legacy medal-only service.

Schnell's current official Workers AI input schema has no width or height fields, so its dimensions
are provider-controlled and it is advertised only for medals. Klein receives exact server-owned
dimensions for every artwork type.

## `POST /v1/generate`

Required headers:

```http
Content-Type: application/json
X-DIYWC-Installation-ID: 8ba9f618-438f-4caa-a499-dfe73bd0b3ac
```

The installation ID must be an app-scoped random identifier. It must not be an Android ID,
advertising ID, email address, account ID, or device serial number.

`assetKind` accepts `medal`, `milestone_banner`, or `route_map`. It is optional and defaults to
`medal`, preserving the original request contract. New clients should omit it for medals so medal
generation also works with older self-hosted Workers. They should send another kind only after the
catalog advertises it for the selected model.

Legacy-compatible medal request:

```json
{
  "model": "flux-schnell",
  "prompt": "Antique fox compass with autumn leaves",
  "seed": 2147483
}
```

Milestone banner request:

```json
{
  "assetKind": "milestone_banner",
  "model": "flux2-klein-4b",
  "prompt": "Moonlit waterfall at a forest overlook"
}
```

Decorative route-map request:

```json
{
  "assetKind": "route_map",
  "model": "flux2-klein-4b",
  "prompt": "Coastal cliffs, pine forest, and a quiet bay"
}
```

Optional user-provided reference image, only when the selected model and artwork capability both
advertise `supportsReference: true`:

```json
{
  "model": "flux2-klein-4b",
  "prompt": "Mountain sunrise using this color palette",
  "reference": {
    "mimeType": "image/png",
    "dataBase64": "iVBORw0KGgo...",
    "rightsConfirmed": true
  }
}
```

The JSON body is limited to 3 MiB. A user-entered artwork theme is limited to 3–50 Unicode code
points. The Worker inserts that theme into a fixed server-owned prompt for the selected artwork
type; clients cannot replace the surrounding instructions. A decoded reference is limited to 2 MiB,
JPEG/PNG/WebP, valid image headers, 64–512 pixels per edge, and at most 512×512 pixels for every
currently enabled reference-capable model.

The client cannot select output dimensions. Klein medals are 512×512, milestone banners are
1024×512, and route maps are 1024×768. The Worker rejects a controlled model response whose decoded
dimensions do not exactly match its advertised capability. Schnell medal dimensions remain
provider-controlled but are bounded by the general image validation rules.

Generated route maps are decorative, non-navigational illustrations. They are not promised to be
geographically accurate, and the fixed prompt excludes route lines, pins, checkpoints, labels, and
other marks that the app adds itself.

Success is `200` with raw image bytes and these headers:

```http
Content-Type: image/png
Content-Length: 123456
Content-Disposition: inline; filename="diywc-milestone-banner-<request-id>.png"
Cache-Control: no-store
X-DIYWC-Request-ID: 73582ff2-4c07-4f17-99a7-38bcf0941e09
X-DIYWC-Report-Token: <opaque server signature>
X-DIYWC-Asset-Kind: milestone_banner
X-DIYWC-Model: flux2-klein-4b
X-DIYWC-SHA256: <64 lowercase hexadecimal characters>
X-DIYWC-Width: 1024
X-DIYWC-Height: 512
X-DIYWC-Model-Attempts-Used: 1
X-DIYWC-Model-Attempts-Remaining: 2
X-DIYWC-Estimated-Neurons: 145
X-DIYWC-Global-Estimated-Neurons-Used: 145
X-DIYWC-Global-Estimated-Neurons-Remaining: 7855
```

Before image inference, the server submits the sanitized user prompt—not the hidden parent prompt—to
the configured, allowlisted Llama Guard classifier. Unsafe prompts return `content_rejected`. An
unavailable, malformed, or misconfigured classifier fails closed with `service_unavailable`; it
never falls through to image generation.

Each installation receives exactly three attempts per model per UTC day. Artwork types share that
model counter: three mixed Klein requests are three Klein attempts, not three attempts per kind. The
backend also makes an exact D1 reservation against a separate global conservative estimated-Neuron
budget. The estimate includes variable Llama Guard headroom and the selected image output/reference
tiles; it is not Cloudflare's authoritative bill. The attempt and global estimate are reserved before
classification/inference and are not refunded after rejection, cancellation, timeout, or upstream
failure.

The service does not save generated images. Generation is intentionally non-idempotent: the Android
client should generate only after an explicit tap and must not automatically retry an ambiguous
timeout. Canceling the download does not guarantee that already-started classification or inference
is canceled, and the reserved quota remains consumed.

When image inference fails, the Worker normalizes only Cloudflare's numeric internal error code and
category. It never returns or records the provider's raw message or stack. D1 records only the
request ID, model alias, artwork type, normalized provider code (`unknown` when unavailable),
category, and timestamp. Writes also remove rows older than 30 days and cap the table at 5,000 rows.
The structured console event contains those same fields only; prompts, images, network addresses,
installation identifiers and hashes, and raw provider errors are excluded.

## `POST /v1/report`

This route lets the Android client place a **Report image** action on every generated candidate
without uploading the generated image itself.

```http
Content-Type: application/json
X-DIYWC-Installation-ID: 8ba9f618-438f-4caa-a499-dfe73bd0b3ac
```

```json
{
  "requestId": "73582ff2-4c07-4f17-99a7-38bcf0941e09",
  "reportToken": "<value from X-DIYWC-Report-Token>",
  "reason": "copyright_or_trademark",
  "details": "Looks too close to an existing product"
}
```

Allowed reasons are `unsafe_or_inappropriate`, `copyright_or_trademark`, `personal_information`, and
`other`. Details are optional and limited to 500 Unicode code points. The HMAC report token binds the
generation request to the installation without putting a secret in the APK.

Success is `202`:

```json
{
  "accepted": true,
  "reportId": "c50cc638-3c91-43de-884f-d43c532ecbfc"
}
```

Submitting the same generation/installation pair again updates that report and returns its existing
ID. D1 stores only the request ID, hashed installation ID, reason, optional details, and timestamps—not
the prompt, reference, or generated image.

## Errors

Errors are JSON and always include a correlation ID:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Please wait a minute before generating another image",
    "retryable": true,
    "requestId": "93d22214-d855-4f50-b2d5-4bb286c557a4",
    "retryAfterSeconds": 60
  }
}
```

Expected codes include `invalid_request`, `invalid_prompt`, `model_unavailable`, `content_rejected`,
`model_busy`, `workers_ai_quota_exhausted`, `model_timeout`, `model_configuration_error`,
`model_invalid_output`, `rate_limited`, `model_daily_limit_reached`, `daily_quota_exhausted`,
`invalid_report_token`, and `service_unavailable`. Image-provider failures use these stable results:

| API code | Meaning | Retry behavior |
|---|---|---|
| `content_rejected` | The provider's image filter declined the request. | Reword the description; no automatic retry. |
| `model_busy` | The provider has no current model capacity. | Retryable after 60 seconds. |
| `workers_ai_quota_exhausted` | The hosting account's Workers AI daily allowance is exhausted. | Retryable after the next UTC-day reset. |
| `model_timeout` | Inference timed out or was aborted upstream. | Retryable after 120 seconds, but only after another explicit user action. |
| `model_configuration_error` | The model ID, account access, agreement, plan, or request integration needs operator attention. | Not retryable by the client. |
| `model_invalid_output` | The provider returned bytes or dimensions that failed image validation. | Retryable after 120 seconds. |
| `model_unavailable` | Unknown provider failures retain the generic fallback. | Retryable after 120 seconds. |

The response never contains Cloudflare's internal code, raw error message, or stack. An unsupported
model/artwork pairing also returns `model_unavailable`; an unknown artwork type returns
`invalid_request`. A retryable response includes both `Retry-After` and `retryAfterSeconds` when a
useful wait is known. Short burst limits and the three-attempt per-model limit return `429`; shared
daily shutdowns return `503` so the app can prominently offer its own artwork upload fallback.

The app should permit only one generation request at a time. It must not automatically retry an
ambiguous timeout: inference may have started and its reserved attempt remains consumed.

## Browser access

Native Android requests normally have no `Origin` header. Browser origins are denied unless their
exact origins are listed in `ALLOWED_ORIGINS`. Wildcard CORS is deliberately unsupported.
