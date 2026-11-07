# Post-launch updates: flags and feature folders

Each feature that ships after launch has a flag (`packages/shared/src/flags.ts`) and its own folders named after it.
Merging its code changes nothing users see; turning its flag on shows it on the site and, in the same step, publishes
its code to the public repository as one commit.

## Where a feature's code goes

| Folder | What goes there |
|---|---|
| `apps/edge/src/features/<flag>/index.ts` | The server side. Default-export `{ register({ app, edge, store, accounts, auth }) }` and add routes under `/v1` or `/v2`. Loaded only while the flag is on. |
| `apps/web/src/features/<flag>/index.ts` | The pages. Default-export a `Feature` (`apps/web/src/features.ts`): its `routes` and its menu entries (`nav`). Shown only while the flag is on. |
| `apps/edge/test/features/<flag>/`, `apps/web/src/features/<flag>/*.test.ts` | Its tests. |

`<flag>` is the flag's exact name, for example `leaderboards`. Both apps find these folders by themselves, so a feature
never needs an edit to a shared file. **Keep every line of a feature inside its folders.** Until its flag is on, the
public copy leaves those folders out, and the publish stops if any other file refers to one of them. If a feature truly
needs a change to shared code, make that change generic (nothing that names the feature) and merge it on its own.

## Shipping an update

1. Branch from `main`: `git switch -c update/<flag>`.
2. Build it in its folders. To try it locally, set `EKO_FLAGS=<flag>` when starting the edge.
3. Open a pull request into `main`; the other developer reviews it; merge when the tests pass.
4. Deploy `main` (`railway up --service eko-edge --detach`). The flag is still off: users see no change, and the code
   is not public.
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
