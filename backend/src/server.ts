
import 'dotenv/config'

import express, {
  type NextFunction,
  type Request,
  type Response
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

import {
  HeadObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'

import { randomUUID } from 'node:crypto'

// ======================================================
// 1. ENVIRONMENT CONFIGURATION
// ======================================================

const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET'
] as const

for (const key of required) {
  if (!process.env[key]?.trim()) {
    throw new Error(`Missing environment variable: ${key}`)
  }
}

const PORT = Number(process.env.PORT || 8787)

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be a valid TCP port.')
}

const FRONTEND_ORIGINS = (
  process.env.FRONTEND_ORIGIN || 'http://localhost:5173'
)
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)

const LIVEKIT_URL = process.env.LIVEKIT_URL!

const livekitHttpUrl = LIVEKIT_URL
  .replace(/^wss:/i, 'https:')
  .replace(/^ws:/i, 'http:')

// ======================================================
// 2. EXPRESS APPLICATION
// ======================================================

const app = express()

app.disable('x-powered-by')
app.set('trust proxy', 1)

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: 'cross-origin'
    }
  })
)

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        FRONTEND_ORIGINS.includes('*') ||
        FRONTEND_ORIGINS.includes(origin)
      ) {
        return callback(null, true)
      }

      return callback(new Error('Origin is not allowed by CORS'))
    },
    credentials: false
  })
)

app.use(express.json({ limit: '30kb' }))

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false
  })
)

// ======================================================
// 3. SUPABASE CONFIGURATION
// ======================================================

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)

// ======================================================
// 4. LIVEKIT CONFIGURATION
// ======================================================

const egress = new EgressClient(
  livekitHttpUrl,
  process.env.LIVEKIT_API_KEY!,
  process.env.LIVEKIT_API_SECRET!
)

// ======================================================
// 5. RECORDING STORAGE CONFIGURATION
// ======================================================

const recordingEndpoint = process.env.RECORDING_ENDPOINT
const recordingAccessKey = process.env.RECORDING_ACCESS_KEY
const recordingSecretKey = process.env.RECORDING_SECRET_KEY

const s3 =
  recordingEndpoint && recordingAccessKey && recordingSecretKey
    ? new S3Client({
        region: process.env.RECORDING_REGION || 'auto',
        endpoint: recordingEndpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: recordingAccessKey,
          secretAccessKey: recordingSecretKey
        }
      })
    : null

// ======================================================
// 6. USER ROLES AND AUTHENTICATION
// ======================================================

type Role =
  | 'listener'
  | 'moderator'
  | 'broadcaster'
  | 'admin'
  | 'root_admin'

type Actor = {
  user: User
  profile: {
    role: Role
    display_name: string
    is_active: boolean
  }
}

async function getActor(req: Request): Promise<Actor | null> {
  const header = req.headers.authorization || ''

  if (!header.startsWith('Bearer ')) {
    return null
  }

  const token = header.slice(7).trim()

  if (!token) return null

  const { data, error } = await supabase.auth.getUser(token)

  if (error || !data.user) {
    return null
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role,display_name,is_active')
    .eq('id', data.user.id)
    .maybeSingle()

  if (
    profileError ||
    !profile ||
    !profile.is_active
  ) {
    return null
  }

  return {
    user: data.user,
    profile: profile as Actor['profile']
  }
}

// ======================================================
// 7. ROLE PROTECTION MIDDLEWARE
// ======================================================

function guard(roles: Role[]) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const actor = await getActor(req)

      if (!actor) {
        return res.status(401).json({
          error: 'A verified, active account is required.'
        })
      }

      if (!roles.includes(actor.profile.role)) {
        return res.status(403).json({
          error: 'You do not have permission to perform this action.'
        })
      }

      res.locals.actor = actor

      return next()

    } catch (error) {
      console.error('Authentication error:', error)

      return res.status(500).json({
        error: 'Could not verify account permissions.'
      })
    }
  }
}

const staff = guard([
  'root_admin',
  'admin',
  'broadcaster'
])

const administrators = guard([
  'root_admin',
  'admin'
])

const dashboardStaff = guard([
  'root_admin',
  'admin',
  'broadcaster',
  'moderator'
])

const rootOnly = guard([
  'root_admin'
])

// ======================================================
// 8. AUDIT LOGGING
// ======================================================

async function audit(
  actorId: string,
  action: string,
  targetType?: string,
  targetId?: string,
  details: Record<string, unknown> = {}
) {
  const { error } = await supabase
    .from('radio_audit_log')
    .insert({
      actor_id: actorId,
      action,
      target_type: targetType || null,
      target_id: targetId || null,
      details
    })

  if (error) {
    console.error('Audit logging failed:', error.message)
  }
}

// ======================================================
// 9. HEALTH CHECK
// ======================================================

app.get('/health', (_req, res) => {
  return res.json({
    ok: true,
    service: 'Buruli Development Radio API',
    timestamp: new Date().toISOString()
  })
})

// ======================================================
// 10. LIVE RADIO CONNECTION TOKEN
// ======================================================

// Listeners receive subscribe-only tokens.
// Approved speakers and authorized staff may publish audio.

app.post('/api/radio/token', async (req, res) => {
  try {
    const programmeId = String(
      req.body?.programmeId || ''
    ).trim()

    const canPublish = req.body?.canPublish === true

    if (!programmeId) {
      return res.status(400).json({
        error: 'programmeId is required.'
      })
    }

    const { data: programme, error } = await supabase
      .from('programmes')
      .select('id,room_name,is_live,status')
      .eq('id', programmeId)
      .maybeSingle()

    if (
      error ||
      !programme ||
      !programme.is_live ||
      programme.status === 'ended'
    ) {
      return res.status(404).json({
        error: 'This programme is not live.'
      })
    }

    const actor = await getActor(req)

    let publish = false
    let displayName = 'Guest listener'

    if (canPublish) {
      if (!actor) {
        return res.status(401).json({
          error: 'Sign in with an active account and request permission to speak.'
        })
      }

      const privileged = [
        'root_admin',
        'admin',
        'broadcaster'
      ].includes(actor.profile.role)

      const { data: speakerRequest, error: requestError } =
        await supabase
          .from('speaker_requests')
          .select('status')
          .eq('programme_id', programmeId)
          .eq('user_id', actor.user.id)
          .maybeSingle()

      if (requestError) {
        return res.status(500).json({
          error: 'Could not verify speaker approval.'
        })
      }

      if (
        !privileged &&
        speakerRequest?.status !== 'approved'
      ) {
        return res.status(403).json({
          error: 'A moderator must approve your speaker request first.'
        })
      }

      publish = true

      displayName =
        actor.profile.display_name ||
        actor.user.email ||
        'Speaker'

    } else if (actor) {
      displayName =
        actor.profile.display_name ||
        actor.user.email ||
        'Listener'
    }

    const identity =
      actor?.user.id || `guest-${randomUUID()}`

    const access = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      {
        identity,
        name: displayName.slice(0, 80),
        ttl: '2h'
      }
    )

    access.addGrant({
      roomJoin: true,
      room: programme.room_name,
      canSubscribe: true,
      canPublish: publish,
      canPublishData: false
    })

    return res.json({
      token: await access.toJwt(),
      url: LIVEKIT_URL,
      canPublish: publish
    })

  } catch (error) {
    console.error('LiveKit token error:', error)

    return res.status(500).json({
      error: 'Could not create a radio connection token.'
    })
  }
})

// ======================================================
// 11. ADMIN DASHBOARD OVERVIEW
// ======================================================

app.get(
  '/api/admin/overview',
  dashboardStaff,
  async (_req, res) => {
    try {
      const [
        users,
        programmes,
        live,
        requests,
        recordings,
        announcements
      ] = await Promise.all([
        supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true }),

        supabase
          .from('programmes')
          .select('id', { count: 'exact', head: true }),

        supabase
          .from('programmes')
          .select('id', { count: 'exact', head: true })
          .eq('is_live', true),

        supabase
          .from('speaker_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),

        supabase
          .from('radio_recordings')
          .select('id', { count: 'exact', head: true }),

        supabase
          .from('radio_announcements')
          .select('id', { count: 'exact', head: true })
      ])

      const errors = [
        users.error,
        programmes.error,
        live.error,
        requests.error,
        recordings.error,
        announcements.error
      ].filter(Boolean)

      if (errors.length) {
        throw errors[0]
      }

      return res.json({
        users: users.count || 0,
        programmes: programmes.count || 0,
        liveProgrammes: live.count || 0,
        pendingSpeakerRequests: requests.count || 0,
        recordings: recordings.count || 0,
        announcements: announcements.count || 0
      })

    } catch (error) {
      console.error('Dashboard overview error:', error)

      return res.status(500).json({
        error: 'Could not load dashboard statistics.'
      })
    }
  }
)

// ======================================================
// 12. ADMIN USER MANAGEMENT
// ======================================================

app.get(
  '/api/admin/users',
  administrators,
  async (req, res) => {
    try {
      const page = Math.max(
        1,
        Number(req.query.page || 1)
      )

      const perPage = Math.min(
        100,
        Math.max(1, Number(req.query.perPage || 50))
      )

      if (
        !Number.isSafeInteger(page) ||
        !Number.isSafeInteger(perPage)
      ) {
        return res.status(400).json({
          error: 'Invalid pagination parameters.'
        })
      }

      const { data: authData, error: authError } =
        await supabase.auth.admin.listUsers({
          page,
          perPage
        })

      if (authError) throw authError

      const ids = authData.users.map(user => user.id)

      let profiles: any[] = []

      if (ids.length) {
        const { data, error } = await supabase
          .from('profiles')
          .select('id,display_name,role,is_active,created_at')
          .in('id', ids)

        if (error) throw error

        profiles = data || []
      }

      const profileMap = new Map(
        profiles.map(profile => [
          profile.id,
          profile
        ])
      )

      const rows = authData.users.map(user => ({
        id: user.id,
        email: user.email,
        emailConfirmed: Boolean(user.email_confirmed_at),
        lastSignInAt: user.last_sign_in_at || null,

        ...(profileMap.get(user.id) || {
          display_name: 'Community member',
          role: 'listener',
          is_active: false,
          created_at: user.created_at
        })
      }))

      return res.json({
        users: rows,
        page,
        perPage,
        total: authData.total ?? rows.length
      })

    } catch (error) {
      console.error('Admin users error:', error)

      return res.status(500).json({
        error: 'Could not load user accounts.'
      })
    }
  }
)

// ======================================================
// 13. CHANGE USER ROLE
// ======================================================

app.patch(
  '/api/admin/users/:id/role',
  administrators,
  async (req, res) => {
    const actor = res.locals.actor as Actor
    const userId = String(req.params.id)

    const role = String(
      req.body?.role || ''
    ) as Role

    const allowed: Role[] = [
      'listener',
      'moderator',
      'broadcaster',
      'admin'
    ]

    if (!allowed.includes(role)) {
      return res.status(400).json({
        error: 'Unsupported role. Root Admin cannot be assigned from this screen.'
      })
    }

    try {
      const { data: target, error: targetError } =
        await supabase
          .from('profiles')
          .select('id,role')
          .eq('id', userId)
          .single()

      if (targetError || !target) {
        return res.status(404).json({
          error: 'User account not found.'
        })
      }

      if (target.role === 'root_admin') {
        return res.status(403).json({
          error: 'The Root Super Admin account is protected.'
        })
      }

      if (
        actor.profile.role === 'admin' &&
        (role === 'admin' || target.role === 'admin')
      ) {
        return res.status(403).json({
          error: 'Only the Root Super Admin can appoint or change administrators.'
        })
      }

      const { error } = await supabase
        .from('profiles')
        .update({ role })
        .eq('id', userId)

      if (error) throw error

      await audit(
        actor.user.id,
        'user.role_changed',
        'profile',
        userId,
        {
          from: target.role,
          to: role
        }
      )

      return res.json({
        ok: true,
        userId,
        role
      })

    } catch (error) {
      console.error('Role update error:', error)

      return res.status(500).json({
        error: 'Could not update user role.'
      })
    }
  }
)

// ======================================================
// 14. ACTIVATE OR DEACTIVATE USER
// ======================================================

app.patch(
  '/api/admin/users/:id/status',
  administrators,
  async (req, res) => {
    const actor = res.locals.actor as Actor
    const userId = String(req.params.id)

    const active = req.body?.active

    if (typeof active !== 'boolean') {
      return res.status(400).json({
        error: 'active must be true or false.'
      })
    }

    try {
      const { data: target, error: targetError } =
        await supabase
          .from('profiles')
          .select('id,role')
          .eq('id', userId)
          .single()

      if (targetError || !target) {
        return res.status(404).json({
          error: 'User account not found.'
        })
      }

      if (
        target.role === 'root_admin' ||
        userId === actor.user.id
      ) {
        return res.status(403).json({
          error: 'You cannot deactivate the Root Super Admin or your own account.'
        })
      }

      if (
        actor.profile.role === 'admin' &&
        target.role === 'admin'
      ) {
        return res.status(403).json({
          error: 'Only the Root Super Admin can manage another administrator.'
        })
      }

      const { error: authError } =
        await supabase.auth.admin.updateUserById(
          userId,
          {
            ban_duration: active ? 'none' : '876000h'
          }
        )

      if (authError) throw authError

      const { error } = await supabase
        .from('profiles')
        .update({ is_active: active })
        .eq('id', userId)

      if (error) throw error

      await audit(
        actor.user.id,
        active ? 'user.activated' : 'user.deactivated',
        'profile',
        userId
      )

      return res.json({
        ok: true,
        userId,
        active
      })

    } catch (error) {
      console.error('User status error:', error)

      return res.status(500).json({
        error: 'Could not update account status.'
      })
    }
  }
)

// ======================================================
// 15. ROOT ADMIN AUDIT HISTORY
// ======================================================

app.get(
  '/api/admin/audit',
  rootOnly,
  async (_req, res) => {
    try {
      const { data, error } = await supabase
        .from('radio_audit_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100)

      if (error) throw error

      return res.json({
        events: data || []
      })

    } catch (error) {
      console.error('Audit retrieval error:', error)

      return res.status(500).json({
        error: 'Could not load audit history.'
      })
    }
  }
)

// ======================================================
// 16. START LIVE PROGRAMME RECORDING
// ======================================================

app.post(
  '/api/radio/recordings/start',
  staff,
  async (req, res) => {
    const actor = res.locals.actor as Actor

    try {
      const programmeId = String(
        req.body?.programmeId || ''
      ).trim()

      if (!programmeId) {
        return res.status(400).json({
          error: 'programmeId is required.'
        })
      }

      const { data: programme, error } = await supabase
        .from('programmes')
        .select('id,title,room_name,is_live')
        .eq('id', programmeId)
        .single()

      if (error || !programme || !programme.is_live) {
        return res.status(400).json({
          error: 'Programme must be live before recording.'
        })
      }

      const { data: existing, error: existingError } =
        await supabase
          .from('radio_recordings')
          .select('id,egress_id')
          .eq('programme_id', programmeId)
          .eq('status', 'recording')
          .maybeSingle()

      if (existingError) throw existingError

      if (existing) {
        return res.json({
          ok: true,
          alreadyRecording: true,
          egressId: existing.egress_id
        })
      }

      const requiredStorage = [
        'RECORDING_BUCKET',
        'RECORDING_ACCESS_KEY',
        'RECORDING_SECRET_KEY',
        'RECORDING_ENDPOINT'
      ] as const

      const missing = requiredStorage.find(
        key => !process.env[key]?.trim()
      )

      if (missing) {
        return res.status(503).json({
          error: `Recording storage is not configured (${missing}). Live broadcasting remains available.`
        })
      }

      const safeTitle = programme.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 45) || 'programme'

      const filepath =
        `buruli-radio/${programmeId}/${Date.now()}-${safeTitle}.ogg`

      // IMPORTANT:
      // LiveKit SDK uses a discriminated oneof output.
      // The explicit case/value structure fixes TS2322.

      const output = new EncodedFileOutput({
        filepath,
        output: {
          case: 's3',
          value: new S3Upload({
            accessKey: process.env.RECORDING_ACCESS_KEY!,
            secret: process.env.RECORDING_SECRET_KEY!,
            bucket: process.env.RECORDING_BUCKET!,
            region: process.env.RECORDING_REGION || 'auto',
            endpoint: process.env.RECORDING_ENDPOINT!
          })
        }
      })

      const info = await egress.startRoomCompositeEgress(
        programme.room_name,
        output,
        {
          audioOnly: true
        }
      )

      const { error: insertError } = await supabase
        .from('radio_recordings')
        .insert({
          programme_id: programmeId,
          egress_id: info.egressId,
          object_path: filepath,
          status: 'recording'
        })

      if (insertError) {
        try {
          await egress.stopEgress(info.egressId)
        } catch (cleanupError) {
          console.error('Egress cleanup error:', cleanupError)
        }

        throw insertError
      }

      await audit(
        actor.user.id,
        'recording.started',
        'programme',
        programmeId,
        {
          egressId: info.egressId
        }
      )

      return res.json({
        ok: true,
        egressId: info.egressId,
        objectPath: filepath
      })

    } catch (error) {
      console.error('Recording start error:', error)

      return res.status(500).json({
        error: 'Could not start programme recording.'
      })
    }
  }
)

// ======================================================
// 17. REFRESH RECORDING STATUS
// ======================================================

app.post(
  '/api/radio/recordings/refresh',
  staff,
  async (_req, res) => {
    if (!s3 || !process.env.RECORDING_BUCKET) {
      return res.status(503).json({
        error: 'Recording storage is not configured.'
      })
    }

    try {
      const { data: pending, error } = await supabase
        .from('radio_recordings')
        .select('id,object_path')
        .eq('status', 'processing')
        .limit(50)

      if (error) throw error

      let ready = 0

      for (const item of pending || []) {
        try {
          await s3.send(
            new HeadObjectCommand({
              Bucket: process.env.RECORDING_BUCKET,
              Key: item.object_path
            })
          )

          const publicUrl =
            process.env.RECORDING_PUBLIC_BASE_URL
              ? `${process.env.RECORDING_PUBLIC_BASE_URL.replace(/\/$/, '')}/${item.object_path}`
              : null

          const { error: updateError } = await supabase
            .from('radio_recordings')
            .update({
              status: 'ready',
              public_url: publicUrl
            })
            .eq('id', item.id)

          if (!updateError) {
            ready += 1
          } else {
            console.error(
              'Recording status update error:',
              updateError
            )
          }

        } catch (error: any) {
          if (
            error?.$metadata?.httpStatusCode !== 404 &&
            error?.name !== 'NotFound' &&
            error?.name !== 'NoSuchKey'
          ) {
            console.warn(
              'Recording is not ready yet:',
              error?.message
            )
          }
        }
      }

      return res.json({
        ok: true,
        checked: pending?.length || 0,
        ready
      })

    } catch (error) {
      console.error('Recording refresh error:', error)

      return res.status(500).json({
        error: 'Could not refresh recording statuses.'
      })
    }
  }
)

// ======================================================
// 18. STOP LIVE PROGRAMME RECORDING
// ======================================================

app.post(
  '/api/radio/recordings/stop',
  staff,
  async (req, res) => {
    const actor = res.locals.actor as Actor

    try {
      const programmeId = String(
        req.body?.programmeId || ''
      ).trim()

      if (!programmeId) {
        return res.status(400).json({
          error: 'programmeId is required.'
        })
      }

      const { data: recording, error } = await supabase
        .from('radio_recordings')
        .select('*')
        .eq('programme_id', programmeId)
        .eq('status', 'recording')
        .maybeSingle()

      if (error) throw error

      if (!recording) {
        return res.json({
          ok: true,
          alreadyStopped: true
        })
      }

      await egress.stopEgress(recording.egress_id)

      const publicUrl =
        process.env.RECORDING_PUBLIC_BASE_URL
          ? `${process.env.RECORDING_PUBLIC_BASE_URL.replace(/\/$/, '')}/${recording.object_path}`
          : null

      const { error: updateError } = await supabase
        .from('radio_recordings')
        .update({
          status: 'processing',
          ended_at: new Date().toISOString(),
          public_url: publicUrl
        })
        .eq('id', recording.id)

      if (updateError) throw updateError

      await audit(
        actor.user.id,
        'recording.stopped',
        'programme',
        programmeId,
        {
          egressId: recording.egress_id
        }
      )

      return res.json({
        ok: true,
        status: 'processing',
        publicUrl,
        note: 'Recording is being finalized by LiveKit Egress.'
      })

    } catch (error) {
      console.error('Recording stop error:', error)

      return res.status(500).json({
        error: 'Could not stop programme recording.'
      })
    }
  }
)

// ======================================================
// 19. ROOT SUPER ADMIN BOOTSTRAP
// ======================================================

async function bootstrapRootAdmin() {
  const email = process.env.ROOT_ADMIN_EMAIL
    ?.trim()
    .toLowerCase()

  if (!email) {
    console.warn(
      'ROOT_ADMIN_EMAIL is not set; Root Admin bootstrap skipped.'
    )
    return
  }

  try {
    const { data, error } =
      await supabase.auth.admin.listUsers({
        page: 1,
        perPage: 1000
      })

    if (error) throw error

    const user = data.users.find(
      item => item.email?.toLowerCase() === email
    )

    if (!user) {
      console.warn(
        `Root Admin account ${email} has not registered yet.`
      )
      return
    }

    if (!user.email_confirmed_at) {
      console.warn(
        `Root Admin account ${email} is not email-verified yet.`
      )
      return
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .upsert(
        {
          id: user.id,
          role: 'root_admin',
          is_active: true
        },
        {
          onConflict: 'id'
        }
      )

    if (profileError) {
      console.error(
        'Root Admin promotion failed:',
        profileError.message
      )
      return
    }

    console.log(
      `Configured Root Super Admin verified: ${email}`
    )

  } catch (error) {
    console.error('Root Admin bootstrap error:', error)
  }
}

// ======================================================
// 20. GLOBAL ERROR HANDLER
// ======================================================

app.use((
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  console.error('Unhandled API error:', error)

  if (res.headersSent) {
    return
  }

  return res.status(500).json({
    error: 'An unexpected server error occurred.'
  })
})

// ======================================================
// 21. START SERVER
// ======================================================

const server = app.listen(PORT, () => {
  console.log('========================================')
  console.log(' BURULI DEVELOPMENT RADIO API')
  console.log('========================================')
  console.log(`Server running on port ${PORT}`)
  console.log(`LiveKit: ${LIVEKIT_URL}`)
  console.log(`Recording storage: ${s3 ? 'Configured' : 'Not configured'}`)
  console.log('========================================')

  void bootstrapRootAdmin()
})

// ======================================================
// 22. GRACEFUL SHUTDOWN
// ======================================================

async function shutdown(signal: string) {
  console.log(`${signal} received. Shutting down...`)

  server.close(async () => {
    try {
      s3?.destroy()
      console.log('Buruli Development Radio API stopped.')
      process.exit(0)
    } catch (error) {
      console.error('Shutdown error:', error)
      process.exit(1)
    }
  })
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})

process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
