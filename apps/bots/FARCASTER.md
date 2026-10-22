# Farcaster summon preparation — Oct 16 readiness, D0 activation separate

Packet 127 follows BACKEND §16 and GO-PLAN §§3.4, 11.5. The prepared handler
accepts authenticated `cast.created` mentions of the configured bot FID only.
Both the HTTP webhook and Neynar provider adapter remain disabled. No credentials
are read, accounts created, keys signed, webhooks registered, assets uploaded or
casts sent. The server's existing unavailable `APP_ROLE=bots` stays unavailable.

The route `/farcaster/mentions` preserves raw JSON bytes in its own Fastify scope.
It verifies `X-Neynar-Signature` as hexadecimal HMAC-SHA512 over those bytes before
parsing. Invalid signatures return 403, invalid authenticated events 422, oversized
bodies 413, and valid events 503 `transport_disabled`. A handler invoked with
fixture dependencies also requires `summon_x`; missing/error flags default off.
The flag is checked again before reply delivery. The provider adapter independently
checks it and refuses transport even if the flag is on.

Only an explicit mentioned-profile FID qualifies; names and text mentions do not.
Self-casts, unsupported events, prose without a target, commands other than scan,
and multiple targets receive no reply. Only the extracted address or ticker goes
to the existing scan service. Profiles, custody addresses, source links, embeds,
full cast text and provider errors are never persisted or echoed. Fixture profile
fields use neutral sample values.

Claims are unique on `(bot_fid, cast_hash)`; hashes normalize to lowercase. A
separate stable identity hashing key makes bot-scoped author rate keys. Three
attempts per author in a rolling hour are enforced transactionally across replicas.
Failed, uncertain and interrupted attempts retain their claim and consume quota.
Rate-limited interactions are also deduplicated. Crashes can leave `claimed`
without a reply; automatic retries are intentionally absent. Manual reconciliation
is required before any later replay feature. This is at-most-one attempt, not a
delivery guarantee. Signer UUIDs, raw author FIDs and reply payloads are not stored.

The injected managed-signer lookup must return `approved`, the configured UUID,
and the bot FID. Pending/revoked/missing/mismatched or failed signers get no reply.
No custody key or local signing API exists. Responses must contain a ready scan
with a negotiated V2 card and matching coin, valid record ID and deterministic
1200×675 image. Missing/pending/ambiguous results and renderer failures remain
unavailable. Guard labels, shadow/candidate state, gaps and disclosures use 037's
shared adapters; this bot owns no Guard logic. Names and symbols are omitted.

`farcasterImages(renderer)` consumes the structural `OgRenderer.render` interface,
always with `reply` format. It checks PNG header dimensions and image hash; it does
not decode PNGs or accept their visual layout. Production satori/resvg rendering
and visual acceptance belong to the parallel renderer work. `neynarCastRequest`
prepares a parent-bound payload with a deterministic 16-character idempotency key,
one exact image URL and one canonical scan record URL. Future asset storage must
host the exact rendered bytes, preferably addressed by their image hash. This
packet provides no asset-storage/upload implementation. No invented public image
endpoint is advertised. The disabled adapter never calls its asset/provider hooks.

## Oct 16 checklist — prepared only; every external item remains unchecked

- [ ] Register the bot account under separate authorization. Hold FID custody on
  hardware wallet #5, with its own seed; no custody key/seed on a server.
- [ ] Verify the configured bot FID and public custody address against on-chain
  ownership. Record evidence in the deployment process; use no personal names or
  account identifiers in this repository.
- [ ] Disclose that the account is a bot and identify its main operator account,
  never a person. Prepare the shared DYOR/NFA/AI-generated and non-affiliation
  disclosures. Publish public custody address and managed signer public key per
  GO-PLAN §5. Do not mark account disclosure complete before it is visible.
- [ ] Provision the Neynar app and managed signer with the same API credential.
  The bot's hardware-held FID owner approves it; Neynar holds the signer key.
  Check managed status `approved`, UUID, FID and cast permission. Confirm the
  hardware-held owner can revoke it. Perform no signing in this packet.
- [ ] Provision `NEYNAR_API_KEY`, `NEYNAR_SIGNER_UUID`, `FARCASTER_BOT_FID`, a separate
  `NEYNAR_WEBHOOK_SECRET`, and a stable independently generated identity hashing
  key through deployment secrets. These are configuration names only, not values.
  Never add a custody/private key variable. No current environment loader is wired.
- [ ] Apply reserved server migration `0041_farcaster_summons` after merging the
  migration journal/snapshot chain with other packets. Preserve Telegram tables.
- [ ] Accept the real renderer output and a public HTTPS asset store serving the
  exact PNG; verify dimensions, disclosures, snapshot correspondence and hashes.
- [ ] Register only `cast.created` events filtered to mentions of the bot FID,
  with a shared webhook secret and signature header. Test authentic payloads in
  an authorized environment; redact bodies, secrets and provider errors in ingress,
  proxy and APM logs. No provider payload should be copied into repository fixtures.
- [ ] Validate live managed-signer failures, revocation, replay, concurrent quotas,
  flag-off zero sends, account disclosure and asset embeds under separate test
  authorization. Fixtures are not provider compatibility or live evidence.
- [ ] At readiness review, retain `summon_x=false`, disabled transport and unavailable
  bot deployment role. Readiness does not authorize D0 activation.

## D0 activation — separate release work and approval

Accept renderer/asset hosting, credential provisioning, account disclosures,
provider integration, operational quotas/budget and redaction first. Wire the
existing scan/Guard readers, renderer, managed-signer lookup and parent-only
provider adapter into an accepted bots role. Keep runtime `summon_x` as the stop
for both summon bots and verify no unsolicited casts or retry jobs exist. Complete
the required checks and obtain separate activation authorization before enabling
transport. Neither a calendar date nor `FLAGS=D0` removes this packet's hard stop.

## Protocol references and fixture reproduction

Read-only protocol documentation was consulted; no Neynar API request was made:

- [Webhook signatures](https://docs.neynar.com/docs/how-to-verify-the-incoming-webhooks-using-signatures)
- [Webhook event envelope](https://docs.neynar.com/docs/how-to-setup-webhooks-from-the-dashboard)
- [Managed signer status](https://docs.neynar.com/reference/lookup-signer)
- [Parent-bound cast requests and idempotency](https://docs.neynar.com/reference/publish-cast)

Run with the existing installed dependencies from the worktree root:

```sh
pnpm_config_verify_deps_before_run=false pnpm --filter @eko/bots test test/farcaster.test.ts
pnpm_config_verify_deps_before_run=false pnpm --filter @eko/server test test/harness-migrations.test.ts
```

The process-local pnpm flag avoids automatic dependency repair in the offline
sandbox. It does not modify application flags, test assertions or timeouts.
No new dependency or workspace declaration is required.
