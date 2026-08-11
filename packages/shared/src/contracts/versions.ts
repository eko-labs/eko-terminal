// BACKEND §7.4 freezes verdict-1. §21.1 requires versions for all receipt-hashed types.
export const VERDICT_SCHEMA_VERSION = 'verdict-1' as const;
// TODO(spec): fields — explicit version literals for forecast and harness_private are unspecified;
// follow the verdict-1 naming convention until the lead freezes them.
export const FORECAST_SCHEMA_VERSION = 'forecast-1' as const;
export const HARNESS_PRIVATE_SCHEMA_VERSION = 'harness_private-1' as const;
export const RECEIPT_SCHEMA_VERSIONS = {
  verdict: VERDICT_SCHEMA_VERSION,
  forecast: FORECAST_SCHEMA_VERSION,
  harness_private: HARNESS_PRIVATE_SCHEMA_VERSION,
} as const;
