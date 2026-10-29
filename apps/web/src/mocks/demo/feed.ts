import { FeedItemSchema, type FeedItem } from '@eko/shared';
import profiles from './feed-profiles.json';
import { MOCK_HEAD_BLOCK } from '../head';

/** Frozen visible Strict Mode seed(5150): HALO first; timestamps are offsets from the snapshot clock. */
export const createFeedRows = (now = Date.now()): FeedItem[] => profiles.map((row) => FeedItemSchema.parse({ ...row, ts: now + row.ts, block: MOCK_HEAD_BLOCK }));
export function nextDemoFeed(step: number, now = Date.now()): FeedItem {
  const rows = createFeedRows(now);
  // Replay the oldest rows first, so the first live event never repeats the snapshot's newest row.
  return { ...rows[rows.length - 1 - (step % rows.length)], id: `live-feed-${step}`, ts: now };
}
