# Telegram group scan preparation

Packet 116 follows BACKEND §16, FACTS §3, GO-PLAN §3.3, and shared Guard copy from
037. This workspace prepares parsing, persisted deduplication/caller records,
accepted-grade consumption and mock reply processing. **The transport is disabled.**
There is no bot token, polling loop, listener, webhook registration or enabled
deployment role. `/tg/:secret` returns 403 for invalid secrets and 503 for valid
ones. `grammySend` rejects before invoking an API method. `APP_ROLE=bots` remains
unavailable in the server image.

The grammY adapter accepts a grammY `Api` and an `InputFile` constructor factory;
it is not a substitute Bot API client. grammY 1.x is named by BACKEND §16 but could
not be installed in this sandbox. Actual grammY compatibility and release wiring
remain blocked on an authorized environment with that dependency. No additional
Telegram library or HTTP client has been introduced.

`telegramReadServices` composes the existing task 107 `ScanService` with Guard
negotiated card reads. Task 111 must supply deterministic 1200×675 PNGs matching
those snapshots. Missing cards, missing images and renderer errors get plain text
with explicit unavailable/pending copy; names and source prose never enter replies.
Task 112 must supply accepted 24-hour launch-cohort grades through the `grade`
callback. Missing, provisional, censored, immature, mismatched or incomplete-cohort
evidence does not produce a grade. The bot does not rebuild Guard outcomes or
define cohort membership/thresholds. Record links point to durable scan records.

## Privacy and deduplication

The parser checks bounded contract addresses and `$TICKER` targets. It ignores
attachments, edited messages, sender-chat/anonymous messages and bot messages.
Mixed or multiple targets request one contract address. It forwards only the
extracted target to scans; scan messages/share URLs and token names are never
echoed. Incoming profile fields, group titles, forward/reply envelopes and full
message text are not persisted or logged.

Caller records contain contract, scan ID, message time and HMAC-SHA256 group/caller
keys. The caller hash is scoped to its group; the independently provisioned identity
hashing key must stay in secrets and remain stable across replicas/restarts. These
are pseudonyms, not a claim of anonymity. Raw Telegram chat/user IDs exist only
in memory while preparing a reply. DMs do not create group caller records.
First-caller uniqueness is `(group_key, coin)`. Caller records/grades are append-only
at the database layer. A missing grade contributes to the pending denominator.
Group help displays a neutral caller leaderboard and the `Scanned by EKO` badge
only after a scan has been recorded; it is a usage badge, not a risk endorsement.

An update ID is claimed durably before scanning or sending. Duplicate delivery,
concurrent handlers and restarts do not resend it. A failed/uncertain send retains
only `failed`, never provider error content. A crash after claiming can leave a
`claimed` interaction without a reply. These states deliberately need manual review
before any future replay mechanism: Telegram sends have no exactly-once guarantee.
There is no automatic retry of a potentially delivered message. Reply delivery can fail.

## Future BotFather configuration (manual; not performed)

After dependency, renderer/cohort acceptance and separate release authorization:

1. Configure `/setcommands`: `scan`, `bags`, `alerts`, `help`; turn `/setjoingroups` on.
2. Set `/setprivacy` to **disabled** so pasted contract addresses are delivered in
   groups. Tell admins before adding the bot. Verify effective membership/privacy
   settings in a neutral test group after adding it.
3. Set description/about text to disclose address/ticker parsing, pseudonymous caller
   records, no group message storage, AI-generated analysis and non-affiliation.
   Use the shared DYOR/NFA/AI and Robinhood non-affiliation lines unchanged.
4. Keep the bot token, `TELEGRAM_WEBHOOK_SECRET` and a separate identity hashing key
   in deployment secrets. Do not put any values into the repository. Register
   `https://api.<public-domain>/tg/<secret>` with Telegram's `secret_token` also set
   to the same secret and `allowed_updates` limited to `message`. Both the path
   secret and `X-Telegram-Bot-Api-Secret-Token` must match. Suppress/redact the entire
   webhook URL and header in ingress/proxy/APM logs before exposing that route.
5. Apply server migration `0026_telegram_groups` before integration. Do not enable
   the transport until an accepted grammY installation and release integration are
   verified. No token reads or external send calls are authorized by this runbook.

`/start` and `/help` disclose what is checked/stored, pseudonymous caller records,
pending grading, DYOR/NFA/AI and non-affiliation. `/scan` accepts one address/ticker;
`/bags` and `/alerts` provide web guidance only. No account linking protocol is
implemented here; DM account linking and notification delivery need their own
accepted integration. This packet includes no wallet connect, trade, payment,
Mini App, or approval-button flow.

## Offline reproduction

Run from the worktree with existing dependencies. The sandbox's new workspace
link uses the already installed server dependencies. The lockfile adds only this
workspace's existing dependency declarations; no versions were upgraded.

```sh
pnpm_config_verify_deps_before_run=false pnpm_config_update_notifier=false pnpm --filter @eko/bots test
pnpm_config_verify_deps_before_run=false pnpm_config_update_notifier=false pnpm --filter @eko/server test test/harness-migrations.test.ts
```

The environment flags prevent pnpm 11's automatic dependency repair and update
notification from invoking network/install operations during fixture checks.
They do not change application behavior or test assertions. Dependencies must be
installed normally in an accepted clean-checkout environment before release.

## X summon and burn posting preparation (packet 126)

BACKEND §16 and GO-PLAN §§3.2, 8, 11.5: `XSummonBot.poll()` prepares a single
scheduled tick through an injected transport. No scheduler, listener, OAuth client,
credential reads, network requests or account changes are installed. Both flags
default off. `disabledXTransport` rejects every operation even if flags are enabled;
`APP_ROLE=bots` remains unavailable. Fake transports are solely fixture evidence.

Apply server migration `0040_x_bot_dark` before integrating the core. The supplied
flag callback must consume the existing runtime flags; there is no independent flag
store. `summon_x` gates each mention read, scan, upload and reply. `burn_board` gates
the separately prepared `XBurnPoster`; it does not require `summon_x`. No D0 burn
collector, confirmation policy, scheduled Census or buyback posts are implemented.
A future accepted collector must supply confirmed burn stats and both transaction
hashes. Burn posts have a unique `(platform, burn_tx)` claim and contain no links.

### Durable state and conservative quotas

Polling reserves a bounded page before platform access, with a minimum 30-second
cadence. A five-minute durable lease serializes workers; an expired worker is fenced
before later sends or cursor writes. After a crash, another tick may resume once that
lease expires. `since_id`, pending pagination token and the high-water tweet ID survive
restarts. The cursor advances only when the complete paginated window is processed.
Tweet IDs remain decimal strings, bounded to the existing signed-bigint interaction
schema, and never pass through a JavaScript Number.

Targets are one bounded contract address or explicit `scan $TICKER`. Ambiguous input
is ignored. Input text, profile fields, raw author IDs and scan prose are neither
stored nor echoed. Author IDs are HMAC-SHA256 hashed with a separate stable identity
key for rolling-hour quotas. Only tweet IDs, author hashes, reservation timestamps,
protocol cursors, fixed interaction states and aggregate usage are stored.

The shared Guard 037 adapter supplies labels/modes and deterministic reason copy.
The renderer is consumed through `OgRenderer.render(card, 'reply')`: 1200×675 PNG,
required disclosures, no source names or links. Text omits evidence paths and share
URLs, and stays within 280 characters. Missing/invalid cards, target mismatches,
renderer failures or uncertain sends produce no fallback post and no automatic
retry. A durable claim permits at most one attempt per interaction, not a delivery
guarantee. A crash after claiming may leave a claim requiring manual review.

Quota reservations and claims serialize in database transactions across workers.
Three summons per author per rolling hour; `X_DAILY_REPLY_CAP` defaults to 300;
`X_MONTHLY_BUDGET_USD` defaults to and cannot exceed 400. Read ceilings are 100,000
per UTC day and 3,000,000 per UTC month. The daily ceiling conservatively distributes
the specified monthly read ceiling across 30 days. Spend uses integer microdollars:
read 5,000, reply 10,000, burn post 15,000. The full page is reserved before reading;
a validated response refunds unused reads, charging at least one for an empty poll.
Uncertain operations retain reservations. Reply counts and author quotas count
reserved attempts, including unavailable results or failed sends. UTC period changes
reset aggregate buckets while the author window remains rolling. Burn posts share
the monthly spend cap. Actual provider billing must be verified before acceptance:
the spec's approximate prices do not define empty-poll/media charges.

401/403 must be normalized by any future API adapter to `XPlatformError`. They set a
persistent stop for both interfaces. Restarting or toggling flags never clears it.
There is deliberately no automatic recovery/reset API. After diagnosing account
access externally, an explicit future operator procedure would be needed to resume.
Already started platform operations cannot be recalled when a flag changes.

### External readiness (not performed)

Before separate D0 release authorization, account operators must set the automated
label to the managing main account, approve account biographies/disclosures, arrange
required account access and payment, create the read/write application, and place
`X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` and
`X_BOT_USER_ID` in deployment secrets. Configure the platform's $400 monthly cap
and 50%/80% alerts, code-side reply/read caps, and an independently provisioned stable
identity hashing key. Reconcile accepted read/reply/post/media pricing and quota
reservations before enabling anything. No credential values, account identifiers,
purchase, payment, account mutation or external posting occurred in this packet.
Real PNG rasterization belongs to the parallel renderer task; these tests use only
header fixtures. Platform compatibility, real raster output and delivery remain
external acceptance evidence.

Offline reproduction:

```sh
pnpm --filter @eko/bots test test/x.test.ts
pnpm --filter @eko/bots typecheck
pnpm --filter @eko/server test test/harness-migrations.test.ts
```
