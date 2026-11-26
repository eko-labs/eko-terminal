# Post-launch updates: flags and feature folders

Each feature that ships after launch has a flag (`packages/shared/src/flags.ts`) and its own folders named after it.
Merging its code changes nothing users see; turning its flag on shows it on the site and, in the same step, publishes
its code to the public repository as one commit.

## Where a feature's code goes

| Folder | What goes there |
|---|---|
| `apps/edge/src/features/<flag>/index.ts` | The server side. Default-export `{ register({ app, edge, store, accounts, auth }) }` and add routes under `/v1` or `/v2`. Loaded only while the flag is on. |
| `apps/web/src/features/<flag>/index.ts` | The pages. Default-export a `Feature` (`apps/web/src/features.ts`): its `routes`, its menu entries (`nav`) and any places it fills on the coin page (`coin`: over the chart, under it, next to a wallet; `components/coinSlots.tsx`), elsewhere (`places`, including the top bar; `components/placeSlots.tsx`) and in the trade panel (`trade`). It can also offer its own view of existing pages while a choice it reads at run time says so (`views`: its page for a route, menu entries and shell parts hidden meanwhile; `components/views.tsx`), and run a walkthrough with the shared spotlight (`components/onboarding/Spotlight.tsx`, setting the onboarding store's `guide` while it is in charge). Shown only while the flag is on. |
| `apps/edge/test/features/<flag>/`, `apps/web/src/features/<flag>/*.test.ts` | Its tests. |

`<flag>` is the flag's exact name, for example `leaderboards`. Both apps find these folders by themselves, so a feature
never needs an edit to a shared file. **Keep every line of a feature inside its folders.** Until its flag is on, the
public copy leaves those folders out, and the publish stops if any other file refers to one of them. If a feature truly
needs a change to shared code, make that change generic (nothing that names the feature) and merge it on its own.

## Shipping an update

1. Branch from `main`: `git switch -c update/<flag>`.
2. Build it in its folders. To try it locally, set `EKO_FLAGS=<flag>` when starting the edge. Write its release notes
   in `docs/features/<flag>/UPDATE.md`: `# Title` on the first line, then a plain description of what users get. They
   sit in the flag's features folder, so they stay out of the mirror with the code until the flag is on.
3. Open a pull request into `main` for review. After approval, prepare the reviewed commit locally.
4. Run `npx pnpm@11.5.1 ship` from a clean private checkout. It runs local CI before pushing to private `main`,
   then publishes the mirror, where GitHub runs CI. Railway deploys from private `main`. Use
   `node scripts/verify-edge.mjs --commit <sha>` to check the live commit and trading config. The feature's code stays
   out of the mirror while its flag is off.
5. Double-click **`Turn EKO features on or off.command`**, tick the feature and press Save. The live site
   (`eko-edge-robinhood`) restarts with it on in about a minute, and the feature is published by itself: the public repo
   gets one commit, "Update: <title>" with the release notes as its message, whose diff is that feature's code and notes
   (`scripts/public/release-notes.mjs` writes the message).

To roll back, untick it: no deploy needed. Code that is already public stays public.

Without the pop-up: `railway variables --service eko-edge-robinhood --set "EKO_FLAGS=leaderboards,referrals"` (`none` for
none), then `node scripts/public/publish.mjs --push --flags leaderboards,referrals --message "$(node scripts/public/release-notes.mjs leaderboards)"`.

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
| Size check | `size_check` | nothing: a line under a buy's amount (trade panel `amount` place) |
| Multichart | `multichart` | nothing: up to six coins live side by side, each in its own colour |
| Paper trading | `paper_trading` | nothing: practice trades at real prices beside real trading (trade panel `mode` place) |
| Simple view | `simple_mode` | nothing: a beginner view, the default on a first visit, with a Simple \| Full switch in the top bar (alternate `views` of /radar and /coin/:address, the top bar place, a walkthrough). Demo: `VITE_MOCKS=1 VITE_FLAGS=simple_mode` |
| Dump test | `dump_test` | nothing: per coin, what the price would do if its insiders sold everything now, by group and all together, and what $100 held would then be worth (`/v2/coins/:address/dump`; the all-insiders figure on each Radar row as `extras.dump_test`). A glance tile after the verdict, a section at the top of Overview, a key fact on Simple's coin page, a sortable Dump column in both lists, and "Dump risk rose" alerts for watched and held coins. Demo: `VITE_MOCKS=1 VITE_FLAGS=dump_test,simple_mode` |
