import { createClient } from '@supabase/supabase-js'

const url = (import.meta.env.VITE_SUPABASE_URL as string || '').trim()
const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string || '').trim()
export const SUPABASE_CONFIGURED = Boolean(url && anon && url.startsWith('https://'))
// Keep the app renderable before environment variables are configured; show a clear setup message in the UI.
export const supabase = createClient(url || 'https://example.supabase.co', anon || 'public-anon-key')
export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string || 'http://localhost:8787').replace(/\/$/, '')
export const WHATSAPP_URL = import.meta.env.VITE_WHATSAPP_GROUP_URL as string || ''
