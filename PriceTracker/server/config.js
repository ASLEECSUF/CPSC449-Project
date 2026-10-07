const EBAY_ENVIRONMENTS = ['production', 'sandbox']

// ENV Helper Function
// get environment variables based on name given
function read(env, name, fallback = '') {
  const value = env[name]?.trim()
  return value ? value : fallback
}

// Validation Helper Function
// check if HTTP and not HTTPS
function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

// Read Config such as .env. Checks if any are missing and add error handlers
export function parseConfig(env) {
  const errors = []
  const warnings = []

  const port = Number(read(env, 'PORT', '3000'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('PORT must be an integer between 1 and 65535')
  }

  const supabase = {
    url: read(env, 'SUPABASE_URL'),
    anonKey: read(env, 'SUPABASE_ANON_KEY'),
    serviceRoleKey: read(env, 'SUPABASE_SERVICE_ROLE_KEY'),
  }
  const missingSupabase = [
    ['SUPABASE_URL', supabase.url],
    ['SUPABASE_ANON_KEY', supabase.anonKey],
    ['SUPABASE_SERVICE_ROLE_KEY', supabase.serviceRoleKey],
  ].filter(([, value]) => !value).map(([name]) => name)
  for (const name of missingSupabase) {
    errors.push(`${name} is required`)
  }
  if (supabase.url && !isHttpUrl(supabase.url)) {
    errors.push('SUPABASE_URL must be a valid http(s) URL')
  }

  const ebay = {
    clientId: read(env, 'EBAY_CLIENT_ID'),
    clientSecret: read(env, 'EBAY_CLIENT_SECRET'),
    environment: read(env, 'EBAY_ENVIRONMENT', 'production'),
    marketplaceId: read(env, 'EBAY_MARKETPLACE_ID', 'EBAY_US'),
  }
  if (!EBAY_ENVIRONMENTS.includes(ebay.environment)) {
    errors.push(`EBAY_ENVIRONMENT must be one of: ${EBAY_ENVIRONMENTS.join(', ')}`)
  }
  ebay.enabled = Boolean(ebay.clientId && ebay.clientSecret)
  if (!ebay.enabled) {
    warnings.push('EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are not both set; eBay features are disabled')
  }

  const nrp = {
    token: read(env, 'NRP_TOKEN'),
    baseUrl: read(env, 'NRP_BASE_URL', 'https://ellm.nrp-nautilus.io/v1'),
    model: read(env, 'NRP_MODEL', 'gemma3'),
  }
  if (!isHttpUrl(nrp.baseUrl)) {
    errors.push('NRP_BASE_URL must be a valid http(s) URL')
  }
  nrp.enabled = Boolean(nrp.token)
  if (!nrp.enabled) {
    warnings.push('NRP_TOKEN is not set; natural-language search is disabled')
  }

  return {
    config: { port, supabase, ebay, nrp },
    errors,
    warnings,
  }
}


// run config and get all errors/warnings
const { config, errors, warnings } = parseConfig(process.env)

// output errors if any exist
if (errors.length > 0) {
  console.error(`Invalid configuration:\n${errors.map((error) => `  - ${error}`).join('\n')}`)
  console.error('Copy .env.example to .env and fill in the missing values.')
  process.exit(1)
}

// output warnings if any exist
for (const warning of warnings) {
  console.warn(`Warning: ${warning}`)
}

export default config
