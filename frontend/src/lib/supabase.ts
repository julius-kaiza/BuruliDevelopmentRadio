
import { createClient } from '@supabase/supabase-js'

const url = String(
  import.meta.env.VITE_SUPABASE_URL || ''
).trim()

const anonKey = String(
  import.meta.env.VITE_SUPABASE_ANON_KEY || ''
).trim()

const apiBase = String(
  import.meta.env.VITE_API_BASE_URL || ''
).trim()

const whatsappUrl = String(
  import.meta.env.VITE_WHATSAPP_GROUP_URL || ''
).trim()

// Validate frontend configuration
export const SUPABASE_CONFIGURED =
  /^https:\/\/[a-zA-Z0-9-]+\.supabase\.co\/?$/.test(url) &&
  anonKey.length > 20

// Always export a non-null client so existing App.tsx
// code compiles without dozens of null checks.
//
// If the real environment variables are missing, this
// fallback is deliberately non-functional. Configure
// the real values in Render before using authentication.
export const supabase = createClient(
  SUPABASE_CONFIGURED
    ? url
    : 'https://example.supabase.co',

  SUPABASE_CONFIGURED
    ? anonKey
    : 'invalid-placeholder-key',

  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: 'pkce'
    },
    global: {
      headers: {
        'X-Application-Name': 'Buruli-Development-Radio'
      }
    }
  }
)

// Empty means the frontend uses the same Render domain
// for backend API requests.
export const API_BASE = apiBase.replace(/\/+$/, '')

export const WHATSAPP_URL = whatsappUrl

export const RADIO_CONFIGURATION = {
  supabase: SUPABASE_CONFIGURED,
  backend: true,
  whatsapp: Boolean(WHATSAPP_URL)
}
