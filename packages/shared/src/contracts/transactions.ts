import { z } from 'zod';
import { AddressSchema, HexSchema } from './common.js';
import { CHAIN_ID } from '../chain.js';
// BACKEND §23 CA-7; also used by CA-18 HardKill.
export const UnsignedTxSchema = z.object({
  chainId: z.literal(CHAIN_ID),
  to: AddressSchema,
  data: HexSchema,
  value: z.string(),
});
export type UnsignedTx = z.infer<typeof UnsignedTxSchema>;
