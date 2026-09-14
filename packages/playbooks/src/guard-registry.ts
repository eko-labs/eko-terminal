import { canonicalize } from '@eko/policy';
import { keccak256, stringToHex } from 'viem';
import { CONFIG_GUARD_V2 } from '../config/guard-v2.js';
export * from '../config/guard-v2.js';
export const GUARD_PARAMETERS_HASH = keccak256(stringToHex(canonicalize(CONFIG_GUARD_V2)));
