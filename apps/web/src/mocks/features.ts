import type { Flags } from '@eko/shared';
import { FEATURES, type FeatureDemo } from '../features';
import { createConfig } from './responses';

/** The demos (features.ts `demo`) of the features whose flag is on in mock mode (VITE_FLAGS, or `flags`). */
export function featureDemos(flags: Partial<Flags> = createConfig().flags, features = FEATURES): Promise<FeatureDemo[]> {
  return Promise.all(features.filter(f => f.demo && flags[f.flag]).map(f => f.demo!().then(m => m.default)));
}
