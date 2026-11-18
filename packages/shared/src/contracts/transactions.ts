import { z } from 'zod';
import { AddressSchema, HexSchema } from './common.js';
import { ELYSIUM_CHAIN_ID, ROBINHOOD_CHAIN_ID } from '../chain.js';
// BACKEND §23 CA-7; also used by CA-18 HardKill.
export const UnsignedTxSchema = z.object({
  chainId: z.union([z.literal(ROBINHOOD_CHAIN_ID), z.literal(ELYSIUM_CHAIN_ID)]),
  to: AddressSchema,
  data: HexSchema,
  value: z.string(),
});
export type UnsignedTx = z.infer<typeof UnsignedTxSchema>;
