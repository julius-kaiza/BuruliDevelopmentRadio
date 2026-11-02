import { createClient } from '@supabase/supabase-js'

const url = (import.meta.env.VITE_SUPABASE_URL || '').trim()
const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim()

export const SUPABASE_CONFIGURED =
  Boolean(url && anon && url.startsWith('https://'))

// Keep the application renderable while configuration is being completed.
// These placeholders do not provide a working Supabase connection.
export const supabase = createClient(
  url || 'https://example.supabase.co',
  anon || 'public-anon-key'
)

// Empty API base means use the same Render domain.
// Example: https://buduli.onrender.com/api/radio/token
export const API_BASE = (
  import.meta.env.VITE_API_BASE_URL || ''
).replace(/\/$/, '')

export const WHATSAPP_URL = (
  import.meta.env.VITE_WHATSAPP_GROUP_URL || ''
).trim()
