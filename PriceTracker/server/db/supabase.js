import { createClient } from '@supabase/supabase-js'
import config from '../config.js'

const serverAuthOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
}

export const supabaseAdmin = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  serverAuthOptions,
)

export function createAuthClient() {
  return createClient(config.supabase.url, config.supabase.anonKey, serverAuthOptions)
}
