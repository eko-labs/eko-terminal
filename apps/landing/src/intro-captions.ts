/**
 * One caption per original chapter, adapted from the original hosted page's scene copy. $GHOST is the original
 * example token; agent and swarm wording is replaced by "readings" because the Swarm is not live.
 */
export const INTRO_CAPTIONS: readonly { eyebrow: string; headline: string; support: string }[] = [
  { eyebrow: "Signal discovery on Elysium", headline: "Every move has a cause.", support: "EKO examines the market behind the price. Follow one example token from activity to a signal." },
  { eyebrow: "One token. More than one explanation.", headline: "Volume is rising. Is participation rising with it?", support: "Example: $GHOST has $412K in eight-hour volume. That tells us what moved. EKO asks why." },
  { eyebrow: "Pass through the price. Follow the activity.", headline: "One move. Five ways to examine it.", support: "Momentum. Liquidity. Holders. Narrative. Risk." },
  { eyebrow: "The activity trace separates into five readings.", headline: "Five readings. One market.", support: "Each reading examines a different part of the same move." },
  { eyebrow: "$GHOST / five independent readings", headline: "Five readings, side by side.", support: "Each one scores the same move on its own evidence." },
  { eyebrow: "Risk / 44 of 100", headline: "The disagreement matters.", support: "Momentum scores 86. Risk scores 44. A strong move can still carry a weak foundation." },
  { eyebrow: "Weighted evidence, visible reasons", headline: "Five readings. One weighted view.", support: "The supporting readings combine. The concerns remain visible." },
  { eyebrow: "Holders / 31% of supply in the top ten wallets", headline: "Large wallets hold 31% of the supply.", support: "Each cell is 1% of the token supply. The highlighted cells explain the concentration concern." },
  { eyebrow: "Five readings converge. Their reasons stay attached.", headline: "A signal forms. Certainty doesn’t.", support: "Momentum and liquidity support the move. Holder concentration keeps it on Monitor." },
  { eyebrow: "$GHOST / the reading you just followed", headline: "72 of 100. Monitor.", support: "The signal has a reason. Now see it on live Elysium launches." },
];
/** Scroll runway in screens. The original 29 screens hid the landing for too long. */
export const INTRO_SCREENS = { desktop: 6, phone: 5 } as const;
/** Set once the visitor has finished or skipped the intro; later visits go straight to the landing. */
export const INTRO_SEEN_KEY = "eko.intro.seen";
