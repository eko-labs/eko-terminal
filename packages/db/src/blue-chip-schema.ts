import { pgTable, text, timestamp, boolean, bigint, doublePrecision, primaryKey } from 'drizzle-orm/pg-core';
import { bytes } from './types.js';
export const coinListings = pgTable('coin_listings', { coin: bytes('coin').notNull(), source: text('source').notNull(), externalId: text('external_id').notNull(), firstSeen: timestamp('first_seen',{withTimezone:true}).notNull().defaultNow(), lastSeen: timestamp('last_seen',{withTimezone:true}).notNull().defaultNow(), active: boolean('active').notNull().default(true) }, t => [primaryKey({columns:[t.coin,t.source]})]);
export const coinListingSync = pgTable('coin_listing_sync', { source: text('source').primaryKey(), lastSuccess: timestamp('last_success',{withTimezone:true}).notNull() });
export const readBlueChip = pgTable('read_blue_chip', { coin: bytes('coin').primaryKey(), asOfBlock: bigint('as_of_block',{mode:'bigint'}).notNull(), createdAt: timestamp('created_at',{withTimezone:true}).notNull(), realPool: boolean('real_pool').notNull(), liquidityUsd: doublePrecision('liquidity_usd'), holders: bigint('holders',{mode:'number'}) });
export const readBlueChipDanger = pgTable('read_blue_chip_danger', { coin: bytes('coin').primaryKey() });
