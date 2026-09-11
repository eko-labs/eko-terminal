import { customType, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
export type Hex = `0x${string}`;
export const bytes = customType<{ data: Hex; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: v => Buffer.from(v.slice(2), 'hex'),
  fromDriver: b => `0x${Buffer.from(b).toString('hex')}`,
});
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const now = () => sql`now()`;
export const binary = (hex: string) => Buffer.from(hex.slice(2), 'hex');
export const hex = (value: Uint8Array): Hex => `0x${Buffer.from(value).toString('hex')}`;
