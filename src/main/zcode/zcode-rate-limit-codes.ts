/** Terminal rate-limit discriminators from the reference failure-policy vocabulary. */
export const ZCODE_RATE_LIMIT_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'exceeded_current_quota_error',
  'rate_limit_reached_error',
  'rate_limit_error',
  '1005',
  '1302',
  '1303',
  '1304',
  '1305',
  '1308',
  '1310',
  '1313',
  '1321',
  '2056',
  '20097'
])
