
import 'dotenv/config'

import express, {
  type Request,
  type Response,
  type NextFunction
} from 'express'

import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'

import { createClient, type User } from '@supabase/supabase-js'

import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  S3Upload
} from 'livekit-server-sdk'

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'

// ======================================================
// 1. ENVIRONMENT CONFIGURATION
// ======================================================

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

const PORT = Number(process.env.PORT || 10000)

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be a valid port number')
}

const SUPABASE_URL = requiredEnv('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv(
  'SUPABASE_SERVICE_ROLE_KEY'
)

const LIVEKIT_URL = requiredEnv('LIVEKIT_URL')
const LIVEKIT_API_KEY = requiredEnv('LIVEKIT_API_KEY')
const LIVEKIT_API_SECRET = requiredEnv('LIVEKIT_API_SECRET')

const ROOT_ADMIN_EMAIL = process.env.ROOT_ADMIN_EMAIL
  ?.trim()
  .toLowerCase()

const FRONTEND_ORIGINS = (
  process.env.FRONTEND_ORIGIN || ''
)
  .split(',')
  .map(value => value.trim().replace(/\/+$/, ''))
  .filter(Boolean)

const RECORDING_BUCKET = process.env.RECORDING_BUCKET?.trim()
const RECORDING_ENDPOINT = process.env.RECORDING_ENDPOINT?.trim()
const RECORDING_ACCESS_KEY = process.env.RECORDING_ACCESS_KEY?.trim()
const RECORDING_SECRET_KEY = process.env.RECORDING_SECRET_KEY?.trim()
const RECORDING_REGION =
  process.env.RECORDING_REGION?.trim() || 'auto'

const recordingSettings = [
  RECORDING_BUCKET,
  RECORDING_ENDPOINT,
  RECORDING_ACCESS_KEY,
  RECORDING_SECRET_KEY
]

const RECORDING_CONFIGURED = recordingSettings.every(Boolean)

if (recordingSettings.some(Boolean) && !RECORDING_CONFIGURED) {
  throw new Error(
    'Incomplete recording configuration. Configure RECORDING_BUCKET, RECORDING_ENDPOINT, RECORDING_ACCESS_KEY and RECORDING_SECRET_KEY.'
  )
}

// Validate Supabase URL.

let supabaseOrigin: string

try {
  const parsed = new URL(SUPABASE_URL)

  if (parsed.protocol !== 'https:') {
    throw new Error()
  }

  supabaseOrigin = parsed.origin
} catch {
  throw new Error('SUPABASE_URL must be a valid HTTPS URL')
}

// Validate LiveKit URL.

let livekitParsedUrl: URL

try {
  livekitParsedUrl = new URL(LIVEKIT_URL)

  if (
    livekitParsedUrl.protocol !== 'wss:' &&
    livekitParsedUrl.protocol !== 'ws:'
  ) {
    throw new Error()
  }
} catch {
  throw new Error('LIVEKIT_URL must be a valid wss:// or ws:// URL')
}

// Convert LiveKit WebSocket URL to HTTP for Egress.

const LIVEKIT_HTTP_URL = LIVEKIT_URL
  .replace(/^wss:\/\//i, 'https://')
  .replace(/^ws:\/\//i, 'http://')

// ======================================================
// 2. CLIENTS
// ======================================================

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)

const egressClient = new EgressClient(
  LIVEKIT_HTTP_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET
)

// ======================================================
// 3. FRONTEND FILE CONFIGURATION
// ======================================================

const PUBLIC_DIR = resolve(process.cwd(), 'public')
const INDEX_FILE = join(PUBLIC_DIR, 'index.html')

// ======================================================
// 4. CONTENT SECURITY POLICY
// ======================================================

function getCspServiceOrigins(serviceUrl: string): string[] {
  const parsed = new URL(serviceUrl)
  const sources = [parsed.origin]

  if (parsed.protocol === 'https:') {
    sources.push(`wss://${parsed.host}`)
  }

  if (parsed.protocol === 'http:') {
    sources.push(`ws://${parsed.host}`)
  }

  if (parsed.protocol === 'wss:') {
    sources.push(`https://${parsed.host}`)
  }

  if (parsed.protocol === 'ws:') {
    sources.push(`http://${parsed.host}`)
  }

  return sources
}

const connectSources = [
  "'self'",
  ...getCspServiceOrigins(SUPABASE_URL),
  ...getCspServiceOrigins(LIVEKIT_URL)
]

// Allow the recording storage endpoint when configured.

if (RECORDING_ENDPOINT) {
  try {
    connectSources.push(new URL(RECORDING_ENDPOINT).origin)
  } catch {
    throw new Error('RECORDING_ENDPOINT must be a valid URL')
  }
}

const uniqueConnectSources = [...new Set(connectSources)]

// ======================================================
// 5. EXPRESS APPLICATION
// ======================================================

const app = express()

app.set('trust proxy', 1)
app.disable('x-powered-by')

// CSP explicitly allows the configured external services.
// It does not disable the browser's security policy.

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],

        baseUri: ["'self'"],

        formAction: ["'self'"],

        frameAncestors: ["'self'"],

        objectSrc: ["'none'"],

        scriptSrc: ["'self'"],

        scriptSrcAttr: ["'none'"],

        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com'
        ],

        fontSrc: [
          "'self'",
          'https://fonts.gstatic.com',
          'data:'
        ],

        imgSrc: [
          "'self'",
          'https:',
          'data:',
          'blob:'
        ],

        connectSrc: uniqueConnectSources,

        mediaSrc: [
          "'self'",
          'https:',
          'blob:',
          'data:'
        ],

        workerSrc: [
          "'self'",
          'blob:'
        ]
      }
    }
  })
)

// ======================================================
// 6. CORS CONFIGURATION
// ======================================================

// For a separate frontend service, configure FRONTEND_ORIGIN
// with its exact HTTPS origin in Render.
//
// Same-origin requests do not require CORS permission.

app.use(
  cors((req, callback) => {
    const origin = req.header('Origin')

    if (!origin) {
      return callback(null, { origin: false })
    }

    let normalizedOrigin: string

    try {
      normalizedOrigin = new URL(origin).origin
    } catch {
      return callback(new Error('Invalid request origin'))
    }

    if (FRONTEND_ORIGINS.includes(normalizedOrigin)) {
      return callback(null, {
        origin: normalizedOrigin,
        credentials: true,
        methods: [
          'GET',
          'POST',
          'PUT',
          'PATCH',
          'DELETE',
          'OPTIONS'
        ],
        allowedHeaders: [
          'Content-Type',
          'Authorization',
          'apikey',
          'x-client-info'
        ]
      })
    }

    // Allow the same host when frontend and backend
    // are served by the same application.

    const requestHost = req.get('host')

    if (requestHost) {
      try {
        const requestUrl = new URL(
          `${req.protocol}://${requestHost}`
        )

        if (requestUrl.origin === normalizedOrigin) {
          return callback(null, {
            origin: normalizedOrigin,
            credentials: true
          })
        }
      } catch {
        // Reject invalid request hosts.
      }
    }

    return callback(new Error('Origin not allowed by CORS'))
  })
)

app.use(express.json({ limit: '1mb' }))

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false
  })
)

// ======================================================
// 7. FRONTEND STATIC FILES
// ======================================================

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    fallthrough: true
  })
)

// ======================================================
// 8. GENERAL HELPERS
// ======================================================

function sendError(
  res: Response,
  status: number,
  message: string
) {
  return res.status(status).json({
    success: false,
    error: message
  })
}

function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization

  if (!header || !header.startsWith('Bearer ')) {
    return null
  }

  return header.slice(7).trim() || null
}

// ======================================================
// 9. TYPES AND ROLES
// ======================================================

type UserRole =
  | 'listener'
  | 'moderator'
  | 'broadcaster'
  | 'admin'
  | 'root_admin'

interface Profile {
  id: string
  role: UserRole
  display_name: string | null
  is_active: boolean
  created_at?: string
}

interface Actor {
  user: User
  profile: Profile
}

const VALID_ROLES: UserRole[] = [
  'listener',
  'moderator',
  'broadcaster',
  'admin',
  'root_admin'
]

const ADMIN_ROLES: UserRole[] = [
  'admin',
  'root_admin'
]

const PRIVILEGED_BROADCAST_ROLES: UserRole[] = [
  'broadcaster',
  'moderator',
  'admin',
  'root_admin'
]

function isAdmin(role: UserRole): boolean {
  return ADMIN_ROLES.includes(role)
}

function isPrivilegedBroadcaster(role: UserRole): boolean {
  return PRIVILEGED_BROADCAST_ROLES.includes(role)
}

// ======================================================
// 10. FRONTEND HOME PAGE
// ======================================================

app.get('/', (_req, res, next) => {
  if (!existsSync(INDEX_FILE)) {
    return res.status(503).send(
      'Buruli Development Radio frontend is not available. Check the frontend build and Docker deployment.'
    )
  }

  res.sendFile(INDEX_FILE, error => {
    if (error) next(error)
  })
})

// ======================================================
// 11. AUTHENTICATION
// ======================================================

async function getActor(
  req: Request,
  res: Response
): Promise<Actor | null> {
  const token = getBearerToken(req)

  if (!token) {
    sendError(res, 401, 'Authentication required')
    return null
  }

  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser(token)

  if (authError || !user) {
    sendError(res, 401, 'Invalid or expired session')
    return null
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, role, display_name, is_active, created_at')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError || !profile) {
    sendError(res, 403, 'User profile not found')
    return null
  }

  if (!profile.is_active) {
    sendError(res, 403, 'Your account has been disabled')
    return null
  }

  if (!VALID_ROLES.includes(profile.role as UserRole)) {
    sendError(res, 403, 'Invalid account role')
    return null
  }

  return {
    user,
    profile: profile as Profile
  }
}

async function getAdmin(
  req: Request,
  res: Response
): Promise<Actor | null> {
  const actor = await getActor(req, res)

  if (!actor) return null

  if (!isAdmin(actor.profile.role)) {
    sendError(res, 403, 'Administrator access required')
    return null
  }

  return actor
}

// ======================================================
// 12. AUDIT LOGGING
// ======================================================

async function writeAuditLog(
  actorId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown> = {}
) {
  const { error } = await supabase
    .from('radio_audit_log')
    .insert({
      actor_id: actorId,
      action,
      target_type: targetType,
      target_id: targetId,
      details
    })

  if (error) {
    console.error('Audit log error:', error.message)
  }
}

// ======================================================
// 13. HEALTH CHECKS
// ======================================================

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    application: 'Buruli Development Radio',
    service: 'API',
    status: 'online',
    timestamp: new Date().toISOString(),
    livekitConfigured: Boolean(LIVEKIT_URL),
    supabaseConfigured: Boolean(SUPABASE_URL),
    recordingConfigured: RECORDING_CONFIGURED,
    frontendAvailable: existsSync(INDEX_FILE)
  })
})

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    status: 'online',
    service: 'Buruli Development Radio API'
  })
})

// ======================================================
// 14. RADIO: GET LIVE PROGRAMME
// ======================================================

async function getLiveProgramme(programmeId?: string) {
  let query = supabase
    .from('programmes')
    .select('id, title, room_name, is_live, status')
    .eq('is_live', true)

  if (programmeId) {
    query = query.eq('id', programmeId)
  }

  const { data, error } = await query.limit(1).maybeSingle()

  if (error) {
    console.error('Live programme lookup error:', error.message)
    throw new Error('Could not retrieve the live programme')
  }

  return data
}

// ======================================================
// 15. RADIO: LIVEKIT ACCESS TOKEN
// ======================================================

app.post('/api/radio/token', async (req, res) => {
  try {
    const programmeId =
      typeof req.body?.programmeId === 'string'
        ? req.body.programmeId
        : undefined

    const programme = await getLiveProgramme(programmeId)

    if (!programme) {
      return sendError(res, 404, 'No live programme is available')
    }

    let identity = `guest-${randomUUID()}`
    let displayName = 'Radio Listener'
    let canPublish = false

    const bearerToken = getBearerToken(req)

    if (bearerToken) {
      const actor = await getActor(req, res)

      if (!actor) return

      identity = actor.user.id

      displayName =
        actor.profile.display_name ||
        actor.user.email ||
        'Radio User'

      if (isPrivilegedBroadcaster(actor.profile.role)) {
        canPublish = true
      } else {
        const { data: speakerRequest, error } = await supabase
          .from('speaker_requests')
          .select('id, status')
          .eq('programme_id', programme.id)
          .eq('user_id', actor.user.id)
          .eq('status', 'approved')
          .limit(1)
          .maybeSingle()

        if (error) {
          console.error(
            'Speaker approval lookup failed:',
            error.message
          )

          return sendError(
            res,
            500,
            'Could not verify speaker permissions'
          )
        }

        canPublish = Boolean(speakerRequest)
      }
    }

    const accessToken = new AccessToken(
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      {
        identity,
        name: displayName,
        ttl: '1h'
      }
    )

    accessToken.addGrant({
      roomJoin: true,
      room: programme.room_name,
      canSubscribe: true,
      canPublish,
      canPublishData: true
    })

    const jwt = await accessToken.toJwt()

    return res.json({
      success: true,
      token: jwt,
      url: LIVEKIT_URL,
      serverUrl: LIVEKIT_URL,
      identity,
      displayName,
      canPublish,
      programme: {
        id: programme.id,
        title: programme.title,
        roomName: programme.room_name
      }
    })
  } catch (error) {
    console.error('Radio token error:', error)

    return sendError(
      res,
      500,
      'Unable to create radio access token'
    )
  }
})

// ======================================================
// 16. ADMIN: OVERVIEW
// ======================================================

app.get('/api/admin/overview', async (req, res) => {
  try {
    const actor = await getAdmin(req, res)

    if (!actor) return

    const [
      profiles,
      programmes,
      announcements,
      recordings
    ] = await Promise.all([
      supabase.from('profiles').select('id', {
        count: 'exact',
        head: true
      }),

      supabase.from('programmes').select('id', {
        count: 'exact',
        head: true
      }),

      supabase.from('radio_announcements').select('id', {
        count: 'exact',
        head: true
      }),

      supabase.from('radio_recordings').select('id', {
        count: 'exact',
        head: true
      })
    ])

    const errors = [
      profiles.error,
      programmes.error,
      announcements.error,
      recordings.error
    ].filter(Boolean)

    if (errors.length) {
      console.error('Admin overview query errors:', errors)
      return sendError(res, 500, 'Unable to load administrator overview')
    }

    return res.json({
      success: true,
      overview: {
        totalUsers: profiles.count ?? 0,
        totalProgrammes: programmes.count ?? 0,
        totalAnnouncements: announcements.count ?? 0,
        totalRecordings: recordings.count ?? 0
      }
    })
  } catch (error) {
    console.error('Admin overview error:', error)
    return sendError(res, 500, 'Unable to load administrator overview')
  }
})

// ======================================================
// 17. ADMIN: LIST USERS
// ======================================================

app.get('/api/admin/users', async (req, res) => {
  try {
    const actor = await getAdmin(req, res)

    if (!actor) return

    const page = Math.max(1, Number(req.query.page) || 1)
    const perPage = Math.min(
      100,
      Math.max(1, Number(req.query.limit) || 50)
    )

    if (
      !Number.isSafeInteger(page) ||
      !Number.isSafeInteger(perPage)
    ) {
      return sendError(res, 400, 'Invalid pagination parameters')
    }

    const {
      data: authData,
      error: authError
    } = await supabase.auth.admin.listUsers({
      page,
      perPage
    })

    if (authError) {
      console.error('List users error:', authError.message)
      return sendError(res, 500, 'Unable to retrieve users')
    }

    const users = authData.users || []
    const userIds = users.map(user => user.id)

    let profiles: Profile[] = []

    if (userIds.length > 0) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, role, display_name, is_active, created_at')
        .in('id', userIds)

      if (error) {
        console.error('Profiles lookup error:', error.message)
        return sendError(res, 500, 'Unable to retrieve user profiles')
      }

      profiles = (data || []) as Profile[]
    }

    const profileMap = new Map(
      profiles.map(profile => [profile.id, profile])
    )

    const result = users.map(user => {
      const profile = profileMap.get(user.id)

      return {
        id: user.id,
        email: user.email,
        phone: user.phone,
        createdAt: user.created_at,
        lastSignInAt: user.last_sign_in_at,
        emailConfirmedAt: user.email_confirmed_at,
        role: profile?.role || 'listener',
        displayName: profile?.display_name || null,
        isActive: profile?.is_active ?? false
      }
    })

    return res.json({
      success: true,
      page,
      limit: perPage,
      users: result
    })
  } catch (error) {
    console.error('List users error:', error)
    return sendError(res, 500, 'Unable to retrieve users')
  }
})

// ======================================================
// 18. ADMIN: CHANGE USER ROLE
// ======================================================

app.patch('/api/admin/users/:id/role', async (req, res) => {
  try {
    const actor = await getAdmin(req, res)

    if (!actor) return

    const targetId = req.params.id
    const newRole = req.body?.role as UserRole

    if (!targetId || !VALID_ROLES.includes(newRole)) {
      return sendError(res, 400, 'Invalid user ID or role')
    }

    if (targetId === actor.user.id) {
      return sendError(res, 400, 'You cannot change your own role')
    }

    if (
      newRole === 'root_admin' &&
      actor.profile.role !== 'root_admin'
    ) {
      return sendError(
        res,
        403,
        'Only the Root Admin can assign Root Admin'
      )
    }

    const { data: targetProfile, error: lookupError } =
      await supabase
        .from('profiles')
        .select('id, role')
        .eq('id', targetId)
        .maybeSingle()

    if (lookupError || !targetProfile) {
      return sendError(res, 404, 'Target user profile not found')
    }

    if (
      targetProfile.role === 'root_admin' &&
      actor.profile.role !== 'root_admin'
    ) {
      return sendError(
        res,
        403,
        'Only the Root Admin can modify this account'
      )
    }

    const { error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', targetId)

    if (error) {
      console.error('Role update error:', error.message)
      return sendError(res, 500, 'Unable to update user role')
    }

    await writeAuditLog(
      actor.user.id,
      'user_role_updated',
      'profile',
      targetId,
      {
        previousRole: targetProfile.role,
        newRole
      }
    )

    return res.json({
      success: true,
      message: 'User role updated successfully',
      role: newRole
    })
  } catch (error) {
    console.error('Role update error:', error)
    return sendError(res, 500, 'Unable to update user role')
  }
})

// ======================================================
// 19. ADMIN: ENABLE / DISABLE USER
// ======================================================

app.patch('/api/admin/users/:id/status', async (req, res) => {
  try {
    const actor = await getAdmin(req, res)

    if (!actor) return

    const targetId = req.params.id
    const isActive = req.body?.isActive

    if (!targetId || typeof isActive !== 'boolean') {
      return sendError(
        res,
        400,
        'A valid user ID and isActive value are required'
      )
    }

    if (targetId === actor.user.id) {
      return sendError(res, 400, 'You cannot disable your own account')
    }

    const { data: targetProfile, error: lookupError } =
      await supabase
        .from('profiles')
        .select('id, role')
        .eq('id', targetId)
        .maybeSingle()

    if (lookupError || !targetProfile) {
      return sendError(res, 404, 'Target user profile not found')
    }

    if (
      targetProfile.role === 'root_admin' &&
      actor.profile.role !== 'root_admin'
    ) {
      return sendError(
        res,
        403,
        'Only the Root Admin can modify this account'
      )
    }

    const { error } = await supabase
      .from('profiles')
      .update({ is_active: isActive })
      .eq('id', targetId)

    if (error) {
      console.error('Account status update error:', error.message)
      return sendError(res, 500, 'Unable to update account status')
    }

    await writeAuditLog(
      actor.user.id,
      isActive ? 'user_enabled' : 'user_disabled',
      'profile',
      targetId,
      { isActive }
    )

    return res.json({
      success: true,
      message: isActive
        ? 'Account enabled successfully'
        : 'Account disabled successfully',
      isActive
    })
  } catch (error) {
    console.error('Account status error:', error)
    return sendError(res, 500, 'Unable to update account status')
  }
})

// ======================================================
// 20. ADMIN: AUDIT LOG
// ======================================================

app.get('/api/admin/audit', async (req, res) => {
  try {
    const actor = await getAdmin(req, res)

    if (!actor) return

    const limit = Math.min(
      200,
      Math.max(1, Number(req.query.limit) || 100)
    )

    const { data, error } = await supabase
      .from('radio_audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('Audit retrieval error:', error.message)
      return sendError(res, 500, 'Unable to retrieve audit logs')
    }

    return res.json({
      success: true,
      logs: data || []
    })
  } catch (error) {
    console.error('Audit endpoint error:', error)
    return sendError(res, 500, 'Unable to retrieve audit logs')
  }
})

// ======================================================
// 21. RECORDING: START
// ======================================================

app.post('/api/radio/recordings/start', async (req, res) => {
  try {
    const actor = await getAdmin(req, res)

    if (!actor) return

    if (!RECORDING_CONFIGURED) {
      return sendError(
        res,
        503,
        'Recording storage has not been configured'
      )
    }

    const programmeId =
      typeof req.body?.programmeId === 'string'
        ? req.body.programmeId
        : undefined

    const programme = await getLiveProgramme(programmeId)

    if (!programme) {
      return sendError(res, 404, 'No live programme is available')
    }

    const { data: existingRecording, error: existingError } =
      await supabase
        .from('radio_recordings')
        .select('id, egress_id')
        .eq('programme_id', programme.id)
        .eq('status', 'recording')
        .limit(1)
        .maybeSingle()

    if (existingError) {
      console.error('Recording lookup error:', existingError.message)
      return sendError(res, 500, 'Unable to check existing recordings')
    }

    if (existingRecording) {
      return sendError(
        res,
        409,
        'This programme is already being recorded'
      )
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')

    const objectPath =
      `buruli-radio/${programme.id}/${timestamp}-${randomUUID()}.ogg`

    const output = new EncodedFileOutput({
      filepath: objectPath,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: RECORDING_ACCESS_KEY!,
          secret: RECORDING_SECRET_KEY!,
          bucket: RECORDING_BUCKET!,
          region: RECORDING_REGION,
          endpoint: RECORDING_ENDPOINT!
        })
      }
    })

    const egressInfo =
      await egressClient.startRoomCompositeEgress(
        programme.room_name,
        output,
        {
          audioOnly: true
        }
      )

    const egressId = egressInfo.egressId

    if (!egressId) {
      return sendError(res, 500, 'LiveKit did not return a recording ID')
    }

    const { data: recording, error: insertError } =
      await supabase
        .from('radio_recordings')
        .insert({
          programme_id: programme.id,
          egress_id: egressId,
          object_path: objectPath,
          status: 'recording'
        })
        .select('*')
        .single()

    if (insertError) {
      console.error('Recording database error:', insertError.message)

      try {
        await egressClient.stopEgress(egressId)
      } catch (stopError) {
        console.error('Could not stop unregistered recording:', stopError)
      }

      return sendError(res, 500, 'Could not save recording information')
    }

    await writeAuditLog(
      actor.user.id,
      'recording_started',
      'radio_recording',
      recording.id,
      {
        programmeId: programme.id,
        egressId
      }
    )

    return res.json({
      success: true,
      message: 'Radio recording started',
      recording
    })
  } catch (error) {
    console.error('Recording start error:', error)
    return sendError(res, 500, 'Unable to start recording')
  }
})

// ======================================================
// 22. RECORDING: REFRESH
// ======================================================

app.post('/api/radio/recordings/refresh', async (req, res) => {
  try {
    const actor = await getAdmin(req, res)

    if (!actor) return

    const programmeId =
      typeof req.body?.programmeId === 'string'
        ? req.body.programmeId
        : undefined

    let query = supabase
      .from('radio_recordings')
      .select('*')

    if (programmeId) {
      query = query.eq('programme_id', programmeId)
    }

    const { data, error } = await query.limit(100)

    if (error) {
      console.error('Recording refresh error:', error.message)
      return sendError(res, 500, 'Unable to refresh recordings')
    }

    return res.json({
      success: true,
      recordings: data || []
    })
  } catch (error) {
    console.error('Recording refresh error:', error)
    return sendError(res, 500, 'Unable to refresh recordings')
  }
})

// ======================================================
// 23. RECORDING: STOP
// ======================================================

app.post('/api/radio/recordings/stop', async (req, res) => {
  try {
    const actor = await getAdmin(req, res)

    if (!actor) return

    const recordingId =
      typeof req.body?.recordingId === 'string'
        ? req.body.recordingId
        : undefined

    if (!recordingId) {
      return sendError(res, 400, 'Recording ID is required')
    }

    const { data: recording, error: lookupError } =
      await supabase
        .from('radio_recordings')
        .select('*')
        .eq('id', recordingId)
        .maybeSingle()

    if (lookupError || !recording) {
      return sendError(res, 404, 'Recording not found')
    }

    if (recording.status !== 'recording') {
      return sendError(
        res,
        409,
        'This recording is not currently active'
      )
    }

    await egressClient.stopEgress(recording.egress_id)

    const { data: updatedRecording, error: updateError } =
      await supabase
        .from('radio_recordings')
        .update({
          status: 'completed',
          ended_at: new Date().toISOString()
        })
        .eq('id', recordingId)
        .select('*')
        .single()

    if (updateError) {
      console.error('Recording update error:', updateError.message)

      return sendError(
        res,
        500,
        'Recording stopped but database update failed'
      )
    }

    await writeAuditLog(
      actor.user.id,
      'recording_stopped',
      'radio_recording',
      recordingId,
      {
        programmeId: recording.programme_id,
        egressId: recording.egress_id
      }
    )

    return res.json({
      success: true,
      message: 'Recording stopped successfully',
      recording: updatedRecording
    })
  } catch (error) {
    console.error('Recording stop error:', error)
    return sendError(res, 500, 'Unable to stop recording')
  }
})

// ======================================================
// 24. ROOT ADMIN BOOTSTRAP
// ======================================================

async function bootstrapRootAdmin() {
  if (!ROOT_ADMIN_EMAIL) {
    console.log('ROOT_ADMIN_EMAIL not configured; skipping bootstrap')
    return
  }

  try {
    const { data, error } =
      await supabase.auth.admin.listUsers({
        page: 1,
        perPage: 1000
      })

    if (error) {
      console.error('Root Admin bootstrap error:', error.message)
      return
    }

    const rootUser = data.users.find(
      user =>
        user.email?.toLowerCase() === ROOT_ADMIN_EMAIL &&
        Boolean(user.email_confirmed_at)
    )

    if (!rootUser) {
      console.log(
        'Root Admin account not found or email not confirmed:',
        ROOT_ADMIN_EMAIL
      )
      return
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .upsert(
        {
          id: rootUser.id,
          role: 'root_admin',
          is_active: true
        },
        {
          onConflict: 'id'
        }
      )

    if (profileError) {
      console.error(
        'Root Admin profile bootstrap error:',
        profileError.message
      )
      return
    }

    console.log('Root Admin verified and configured:', ROOT_ADMIN_EMAIL)
  } catch (error) {
    console.error('Root Admin bootstrap failed:', error)
  }
}

// ======================================================
// 25. SINGLE-PAGE APPLICATION ROUTING
// ======================================================

app.use((req, res, next) => {
  if (
    req.method !== 'GET' ||
    req.path.startsWith('/api/') ||
    req.path === '/health' ||
    req.path === '/api'
  ) {
    return next()
  }

  if (!req.accepts('html')) {
    return next()
  }

  if (!existsSync(INDEX_FILE)) {
    return next()
  }

  res.sendFile(INDEX_FILE, error => {
    if (error) next(error)
  })
})

// ======================================================
// 26. 404 HANDLER
// ======================================================

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    error: 'Resource not found',
    path: req.path
  })
})

// ======================================================
// 27. GLOBAL ERROR HANDLER
// ======================================================

app.use((
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  console.error('Unhandled application error:', error)

  if (res.headersSent) return

  const message =
    error instanceof Error ? error.message : ''

  if (
    message === 'Origin not allowed by CORS' ||
    message === 'Invalid request origin'
  ) {
    return res.status(403).json({
      success: false,
      error: 'This website is not allowed to access the radio API'
    })
  }

  return res.status(500).json({
    success: false,
    error: 'Internal server error'
  })
})

// ======================================================
// 28. START SERVER
// ======================================================

const server = createServer(app)

server.listen(PORT, '0.0.0.0', () => {
  console.log('')
  console.log('========================================')
  console.log(' BURULI DEVELOPMENT RADIO')
  console.log('========================================')
  console.log(`Server running on port: ${PORT}`)
  console.log(`Frontend directory: ${PUBLIC_DIR}`)
  console.log(`Frontend available: ${existsSync(INDEX_FILE)}`)
  console.log(`Supabase: ${supabaseOrigin}`)
  console.log(`LiveKit: ${LIVEKIT_URL}`)
  console.log(
    `Recording storage: ${
      RECORDING_CONFIGURED ? 'Configured' : 'Not configured'
    }`
  )
  console.log('CSP: Supabase and LiveKit connections allowed')
  console.log('========================================')
  console.log('')

  void bootstrapRootAdmin()
})

// ======================================================
// 29. GRACEFUL SHUTDOWN
// ======================================================

function shutdown(signal: string) {
  console.log(`${signal} received. Shutting down...`)

  server.close(() => {
    console.log('Buruli Development Radio stopped')
    process.exit(0)
  })

  setTimeout(() => {
    console.error('Forced shutdown')
    process.exit(1)
  }, 10000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
