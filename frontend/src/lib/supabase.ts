
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/* =========================================
   ENVIRONMENT CONFIGURATION
========================================= */

const url = String(import.meta.env.VITE_SUPABASE_URL || '').trim()
const anon = String(import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim()

const apiBase = String(
  import.meta.env.VITE_API_BASE_URL || ''
).trim()

const whatsappGroupUrl = String(
  import.meta.env.VITE_WHATSAPP_GROUP_URL || ''
).trim()

/* =========================================
   SUPABASE CONFIGURATION VALIDATION
========================================= */

export const SUPABASE_CONFIGURED =
  Boolean(
    url &&
    anon &&
    /^https:\/\/[a-zA-Z0-9-]+\.supabase\.co\/?$/.test(url)
  )

if (!SUPABASE_CONFIGURED) {
  console.error(
    'Buruli Development Radio: Supabase is not configured. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
  )
}

/* =========================================
   SUPABASE CLIENT
========================================= */

// Create a client only when real credentials exist.
// The fallback client prevents an invalid placeholder connection.
export const supabase: SupabaseClient | null =
  SUPABASE_CONFIGURED
    ? createClient(url, anon, {
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
      })
    : null

/* =========================================
   BACKEND API CONFIGURATION
========================================= */

// When VITE_API_BASE_URL is empty, API requests use
// the same domain serving the frontend.
//
// Production example:
// https://buduli.onrender.com/api/radio/token

export const API_BASE = apiBase.replace(/\/+$/, '')

/* =========================================
   WHATSAPP COMMUNITY
========================================= */

export const WHATSAPP_URL = whatsappGroupUrl

/* =========================================
   CONFIGURATION STATUS
========================================= */

export const RADIO_CONFIGURATION = {
  supabase: SUPABASE_CONFIGURED,
  backend: true,
  whatsapp: Boolean(WHATSAPP_URL)
}
