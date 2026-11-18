# Post-launch updates: flags and feature folders

Each feature that ships after launch has a flag (`packages/shared/src/flags.ts`) and its own folders named after it.
Merging its code changes nothing users see; turning its flag on shows it on the site and, in the same step, publishes
its code to the public repository as one commit.

## Where a feature's code goes

| Folder | What goes there |
|---|---|
| `apps/edge/src/features/<flag>/index.ts` | The server side. Default-export `{ register({ app, edge, store, accounts, auth }) }` and add routes under `/v1` or `/v2`. Loaded only while the flag is on. |
| `apps/web/src/features/<flag>/index.ts` | The pages. Default-export a `Feature` (`apps/web/src/features.ts`): its `routes`, its menu entries (`nav`) and any places it fills on the coin page (`coin`: over the chart, under it, next to a wallet; `components/coinSlots.tsx`). Shown only while the flag is on. |
| `apps/edge/test/features/<flag>/`, `apps/web/src/features/<flag>/*.test.ts` | Its tests. |

`<flag>` is the flag's exact name, for example `leaderboards`. Both apps find these folders by themselves, so a feature
never needs an edit to a shared file. **Keep every line of a feature inside its folders.** Until its flag is on, the
public copy leaves those folders out, and the publish stops if any other file refers to one of them. If a feature truly
needs a change to shared code, make that change generic (nothing that names the feature) and merge it on its own.

## Shipping an update

1. Branch from `main`: `git switch -c update/<flag>`.
2. Build it in its folders. To try it locally, set `EKO_FLAGS=<flag>` when starting the edge.
3. Open a pull request into `main` for review. After approval, prepare the reviewed commit locally.
4. Run `npx pnpm@11.5.1 ship` from a clean private checkout. It runs local CI before pushing to private `main`,
   then publishes the mirror, where GitHub runs CI. Railway deploys from private `main`. Use
   `node scripts/verify-edge.mjs --commit <sha>` to check the live commit and trading config. The feature's code stays
   out of the mirror while its flag is off.
5. Double-click **`Turn EKO features on or off.command`**, tick the feature and press Save. The site restarts with it on
   in about a minute. When asked, press **Publish**: the public repo gets one commit, "Update: <feature>", whose diff is
   that feature's code.

To roll back, untick it: no deploy needed. Code that is already public stays public.

Without the pop-up: `railway variables --service eko-edge --set "EKO_FLAGS=leaderboards,referrals"` (`none` for none),
then `node scripts/public/publish.mjs --push --message "Update: Leaderboards"`.

## The post-launch updates

| Update | Flag | Waiting on |
|---|---|---|
| Leaderboards | `leaderboards` | a few weeks of users' trades |
| Referrals | `referrals` | something to share (fees or plans) |
| Paid plans | `tiers_active` | the token decision |
| Loop Lab | `loop_lab` | weeks of Elysium price history, and a backtest service on the edge |
| Research | `deep_research` | a research service on the edge |
| Perps | `perps_panel` | a perps market to connect to |
| Arena | `arena` | design |
| Wallet tags on the chart | `wallet_tags` | nothing: built (dev, snipers, bundles, top 10, fresh; `/v2/coins/:address/tags`) |
| Dev profile | `dev_profile` | review: `/dev/<address>` and `/v2/devs/:address` from the history store (HISTORY_DB) |
| Every launchpad (Robinhood Chain) | `more_launchpads` | nothing: built. Unlike the others it has no feature folder: the Robinhood adapter reads it (`apps/edge/src/chains/robinhood/`), so its code is public before it is on. Set it on `eko-edge-robinhood` (the pop-up writes to `eko-edge`). Demo data: `VITE_MOCKS=1 VITE_FLAGS=more_launchpads pnpm --filter @eko/web dev` adds three example long.xyz coins (quoted in TTWO, WETH and USDG; apps/web/src/mocks/demo/launchpads.ts). docs/robinhood/CHAIN-FACTS.md §9 |
