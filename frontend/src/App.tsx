import { useCallback, useEffect, useState } from 'react'
import { LiveKitRoom, RoomAudioRenderer, useConnectionState, useLocalParticipant } from '@livekit/components-react'
import { ConnectionState } from 'livekit-client'
import { supabase, API_BASE, WHATSAPP_URL, SUPABASE_CONFIGURED } from './lib/supabase'
import {
  Radio, Headphones, CalendarDays, MessageCircle, Mic, MicOff, Send, Users, ExternalLink,
  LogIn, LogOut, RadioTower, ShieldCheck, Play, Square, Clock3, Share2, Settings,
  UsersRound, Megaphone, Activity, RefreshCw, Trash2, Bell, FileAudio, UserCog
} from 'lucide-react'

type Role = 'listener' | 'moderator' | 'broadcaster' | 'admin' | 'root_admin'
type Profile = { id: string; display_name: string; role: Role; is_active: boolean }
type Programme = { id: string; title: string; description: string | null; starts_at: string; room_name: string; is_live: boolean; status?: string; created_by: string; ended_at?: string | null }
type Message = { id: string; body: string; created_at: string; profiles?: { display_name: string } | null }
type SpeakerRequest = { id: string; user_id: string; status: string; profiles?: { display_name: string } | null }
type AdminUser = { id: string; email: string; display_name: string; role: Role; is_active: boolean; emailConfirmed: boolean; lastSignInAt: string | null; created_at: string }
type Announcement = { id: string; title: string; body: string; is_published: boolean; published_at: string | null; created_at: string }

export default function App() {
  const [session, setSession] = useState<any>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [programmes, setProgrammes] = useState<Programme[]>([])
  const [current, setCurrent] = useState<Programme | null>(null)
  const [token, setToken] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [connected, setConnected] = useState(false)
  const [isSpeaker, setIsSpeaker] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [messages, setMessages] = useState<Message[]>([])
  const [requests, setRequests] = useState<SpeakerRequest[]>([])
  const [message, setMessage] = useState('')
  const [programmeTitle, setProgrammeTitle] = useState('')
  const [programmeDescription, setProgrammeDescription] = useState('')
  const [programmeTime, setProgrammeTime] = useState('')
  const [notice, setNotice] = useState('')
  const [showAdmin, setShowAdmin] = useState(false)
  const [requestStatus, setRequestStatus] = useState('')
  const [mySpeakerStatus, setMySpeakerStatus] = useState('')
  const [adminTab, setAdminTab] = useState<'overview' | 'broadcast' | 'users' | 'announcements' | 'settings' | 'audit'>('overview')
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([])
  const [adminStats, setAdminStats] = useState<Record<string, number>>({})
  const [recordings, setRecordings] = useState<any[]>([])
  const [publicRecordings, setPublicRecordings] = useState<any[]>([])
  const [auditEvents, setAuditEvents] = useState<any[]>([])
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [announcementTitle, setAnnouncementTitle] = useState('')
  const [announcementBody, setAnnouncementBody] = useState('')
  const [radioSettings, setRadioSettings] = useState<Record<string, any>>({})

  const isRootAdmin = profile?.role === 'root_admin'
  const isAdmin = ['root_admin', 'admin', 'broadcaster'].includes(profile?.role || '')
  const canModerate = ['root_admin', 'admin', 'broadcaster', 'moderator'].includes(profile?.role || '')
  const chatEnabled = radioSettings.allow_listener_chat !== false
  const speakerRequestsEnabled = radioSettings.allow_speaker_requests !== false

  const headers = useCallback(async () => ({
    'Content-Type': 'application/json',
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {})
  }), [session?.access_token])

  const adminRequest = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: await headers(),
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Administrative request failed')
    return data
  }, [headers])

  const loadProgrammes = useCallback(async () => {
    const { data, error } = await supabase.from('programmes').select('*').order('starts_at', { ascending: true })
    if (!error && data) {
      setProgrammes(data as Programme[])
      setCurrent((data as Programme[]).find(p => p.is_live) || null)
    }
  }, [])

  const loadAdminData = useCallback(async () => {
    if (!canModerate || !session) return
    try {
      const stats = await adminRequest('/api/admin/overview')
      setAdminStats(stats)
      if (isRootAdmin || profile?.role === 'admin') {
        const users = await adminRequest('/api/admin/users')
        setAdminUsers(users.users || [])
      }
      const { data: ann } = await supabase.from('radio_announcements').select('*').order('created_at', { ascending: false }).limit(50)
      setAnnouncements((ann || []) as Announcement[])
      const { data: recordingRows } = await supabase.from('radio_recordings').select('id,programme_id,object_path,status,started_at,ended_at,public_url,programmes(title)').order('started_at', { ascending: false }).limit(50)
      setRecordings(recordingRows || [])
      const { data: settings } = await supabase.from('radio_settings').select('key,value')
      setRadioSettings(Object.fromEntries((settings || []).map((item: any) => [item.key, item.value])))
      if (isRootAdmin) {
        const audit = await adminRequest('/api/admin/audit')
        setAuditEvents(audit.events || [])
      }
    } catch (error: any) { setNotice(error.message) }
  }, [adminRequest, canModerate, isAdmin, isRootAdmin, profile?.role, session])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let active = true
    if (!session?.user) { setProfile(null); return }
    supabase.from('profiles').select('id,display_name,role,is_active').eq('id', session.user.id).single()
      .then(({ data }) => { if (active) setProfile(data as Profile | null) })
    return () => { active = false }
  }, [session])

  useEffect(() => {
    void loadProgrammes()
    const channel = supabase.channel('radio-programmes').on('postgres_changes', { event: '*', schema: 'public', table: 'programmes' }, loadProgrammes).subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [loadProgrammes])

  useEffect(() => {
    supabase.from('radio_settings').select('key,value').then(({ data }) => { if (data) setRadioSettings(Object.fromEntries(data.map((item: any) => [item.key, item.value]))) })
  }, [])

  useEffect(() => {
    const load = async () => { const { data } = await supabase.from('radio_recordings').select('id,programme_id,object_path,public_url,started_at,programmes(title)').eq('status','ready').not('public_url','is',null).order('started_at',{ascending:false}).limit(30); setPublicRecordings(data || []) }
    void load()
    const channel = supabase.channel('radio-recording-archive').on('postgres_changes',{event:'*',schema:'public',table:'radio_recordings'},load).subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [])

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from('radio_announcements').select('*').eq('is_published', true).order('published_at', { ascending: false }).limit(10)
      setAnnouncements((data || []) as Announcement[])
    }
    void load()
    const channel = supabase.channel('radio-announcements').on('postgres_changes', { event: '*', schema: 'public', table: 'radio_announcements' }, load).subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [])

  useEffect(() => {
    if (!current) { setMessages([]); setMySpeakerStatus(''); return }
    const load = async () => {
      const { data } = await supabase.from('radio_messages').select('id,body,created_at,profiles(display_name)').eq('programme_id', current.id).order('created_at').limit(100)
      setMessages((data || []) as any)
    }
    void load()
    const channel = supabase.channel(`radio-chat-${current.id}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'radio_messages', filter: `programme_id=eq.${current.id}` }, load).subscribe()
    let requestChannel: ReturnType<typeof supabase.channel> | null = null
    const loadMyRequest = async () => {
      if (!session?.user) { setMySpeakerStatus(''); return }
      const { data } = await supabase.from('speaker_requests').select('status').eq('programme_id', current.id).eq('user_id', session.user.id).maybeSingle()
      setMySpeakerStatus(data?.status || '')
    }
    if (session?.user) {
      void loadMyRequest()
      requestChannel = supabase.channel(`radio-my-request-${current.id}-${session.user.id}`).on('postgres_changes', { event: '*', schema: 'public', table: 'speaker_requests', filter: `programme_id=eq.${current.id}` }, loadMyRequest).subscribe()
    }
    return () => { void supabase.removeChannel(channel); if (requestChannel) void supabase.removeChannel(requestChannel) }
  }, [current?.id, session?.user?.id])

  useEffect(() => {
    if (!current || !canModerate) { setRequests([]); return }
    const load = async () => {
      const { data } = await supabase.from('speaker_requests').select('id,user_id,status,profiles(display_name)').eq('programme_id', current.id).eq('status', 'pending').order('created_at')
      setRequests((data || []) as any)
    }
    void load()
    const channel = supabase.channel(`radio-requests-${current.id}`).on('postgres_changes', { event: '*', schema: 'public', table: 'speaker_requests', filter: `programme_id=eq.${current.id}` }, load).subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [current?.id, canModerate])

  useEffect(() => { if (showAdmin) void loadAdminData() }, [showAdmin, loadAdminData])

  const live = programmes.find(p => p.is_live)
  const upcoming = programmes.filter(p => !p.is_live && p.status !== 'cancelled' && new Date(p.starts_at).getTime() >= Date.now())
  const dateLabel = (value: string) => new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

  const joinLive = async (speaker = false) => {
    if (!live) { setNotice('There is no programme live at the moment.'); return }
    try {
      const res = await fetch(`${API_BASE}/api/radio/token`, { method: 'POST', headers: await headers(), body: JSON.stringify({ programmeId: live.id, canPublish: speaker }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not join radio')
      setCurrent(live); setToken(data.token); setServerUrl(data.url); setIsSpeaker(speaker); setConnected(true)
      setNotice(speaker ? 'Connecting your microphone to the live programme.' : 'Connecting to live radio.')
    } catch (error: any) { setNotice(error.message) }
  }
  const leave = () => { setConnected(false); setToken(''); setIsSpeaker(false) }
  const auth = async () => {
    setNotice('')
    if (!email.trim() || !password) { setNotice('Enter your email address and password.'); return }
    if (authMode === 'signup') {
      if (!displayName.trim()) { setNotice('Enter your display name.'); return }
      const { error } = await supabase.auth.signUp({ email: email.trim(), password, options: { data: { display_name: displayName.trim() } } })
      setNotice(error ? error.message : 'Account created. Check your inbox and confirm your email before signing in.')
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (error) setNotice(error.message)
    }
  }
  const signOut = async () => { await supabase.auth.signOut(); leave() }
  const sendMessage = async () => {
    if (!session || !current || !message.trim()) return
    const { error } = await supabase.from('radio_messages').insert({ programme_id: current.id, user_id: session.user.id, body: message.trim() })
    if (error) setNotice(error.message)
    setMessage('')
  }
  const askToSpeak = async () => {
    if (!session || !current) { setNotice('Sign in to request to speak.'); return }
    const { data: existing } = await supabase.from('speaker_requests').select('id,status').eq('programme_id', current.id).eq('user_id', session.user.id).maybeSingle()
    const result = existing
      ? await supabase.from('speaker_requests').update({ status: 'pending', reviewed_by: null }).eq('id', existing.id)
      : await supabase.from('speaker_requests').insert({ programme_id: current.id, user_id: session.user.id, status: 'pending' })
    setRequestStatus(result.error ? result.error.message : 'Your request has been sent to the moderator.')
    if (!result.error) setMySpeakerStatus('pending')
  }
  const moderate = async (id: string, status: 'approved' | 'declined') => {
    const { error } = await supabase.from('speaker_requests').update({ status, reviewed_by: session.user.id }).eq('id', id)
    if (error) setNotice(error.message)
    else setRequests(items => items.filter(item => item.id !== id))
  }
  const createProgramme = async () => {
    if (!session || !programmeTitle.trim() || !programmeTime) { setNotice('Enter a programme title and start date/time.'); return }
    const { error } = await supabase.from('programmes').insert({ title: programmeTitle.trim(), description: programmeDescription.trim(), starts_at: new Date(programmeTime).toISOString(), room_name: `buruli-${crypto.randomUUID()}`, created_by: session.user.id, status: 'scheduled' })
    if (error) setNotice(error.message)
    else { setProgrammeTitle(''); setProgrammeDescription(''); setProgrammeTime(''); setNotice('Programme scheduled.'); await loadProgrammes() }
  }
  const controlLive = async (start: boolean, programme: Programme) => {
    const { error } = await supabase.from('programmes').update({ is_live: start, status: start ? 'live' : 'ended', ended_at: start ? null : new Date().toISOString() }).eq('id', programme.id)
    if (error) { setNotice(error.message); return }
    if (start) setNotice('Programme is marked ON AIR. Join as presenter to begin broadcasting audio.')
    else {
      try { await fetch(`${API_BASE}/api/radio/recordings/stop`, { method: 'POST', headers: await headers(), body: JSON.stringify({ programmeId: programme.id }) }) } catch { /* recording stop is best effort */ }
      if (connected) leave()
      setNotice('Programme ended.')
    }
    await loadProgrammes()
  }
  const refreshAdmin = async () => { await loadAdminData(); setNotice('Control centre refreshed.') }
  const refreshRecordings = async () => { try { const result = await adminRequest('/api/radio/recordings/refresh', 'POST', {}); await loadAdminData(); setNotice(`Recording check complete: ${result.ready} recording(s) ready.`) } catch (error: any) { setNotice(error.message) } }
  const changeUserRole = async (id: string, role: string) => {
    try { await adminRequest(`/api/admin/users/${id}/role`, 'PATCH', { role }); await loadAdminData(); setNotice('User role updated.') }
    catch (error: any) { setNotice(error.message) }
  }
  const changeUserStatus = async (id: string, active: boolean) => {
    try { await adminRequest(`/api/admin/users/${id}/status`, 'PATCH', { active }); await loadAdminData(); setNotice(active ? 'Account activated.' : 'Account deactivated.') }
    catch (error: any) { setNotice(error.message) }
  }
  const publishAnnouncement = async () => {
    if (!session || !announcementTitle.trim() || !announcementBody.trim()) return
    const { error } = await supabase.from('radio_announcements').insert({ title: announcementTitle.trim(), body: announcementBody.trim(), created_by: session.user.id, is_published: true, published_at: new Date().toISOString() })
    if (error) setNotice(error.message)
    else { setAnnouncementTitle(''); setAnnouncementBody(''); setNotice('Announcement published.'); await loadAdminData() }
  }
  const toggleAnnouncement = async (item: Announcement) => {
    const { error } = await supabase.from('radio_announcements').update({ is_published: !item.is_published, published_at: !item.is_published ? new Date().toISOString() : null }).eq('id', item.id)
    if (error) setNotice(error.message); else await loadAdminData()
  }
  const deleteAnnouncement = async (id: string) => {
    if (!window.confirm('Delete this announcement?')) return
    const { error } = await supabase.from('radio_announcements').delete().eq('id', id)
    if (error) setNotice(error.message); else await loadAdminData()
  }
  const saveRadioSettings = async () => {
    if (!isRootAdmin) return
    for (const [key, value] of Object.entries(radioSettings)) {
      const { error } = await supabase.from('radio_settings').upsert({ key, value, updated_by: session.user.id, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (error) { setNotice(error.message); return }
    }
    setNotice('Station settings saved.')
  }
  const deleteChatMessage = async (id: string) => {
    const { error } = await supabase.from('radio_messages').delete().eq('id', id)
    if (error) setNotice(error.message); else setMessages(items => items.filter(item => item.id !== id))
  }
  const shareText = encodeURIComponent(`Listen to Buruli Development Radio — ${live?.title || 'Our Community. Our Voice. Our Future.'} ${window.location.origin}`)
  const whatsappShare = `https://wa.me/?text=${shareText}`

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top"><span className="brand-mark"><RadioTower size={25} /></span><span><b>{radioSettings.station_name || 'BURULI DEVELOPMENT RADIO'}</b><small>{radioSettings.station_tagline || 'OUR COMMUNITY. OUR VOICE. OUR FUTURE.'}</small></span></a>
      <nav><a href="#listen">Listen</a><a href="#programmes">Programmes</a><a href="#community">Community</a>{canModerate && <button className="nav-admin" onClick={() => setShowAdmin(value => !value)}><ShieldCheck size={16} />{isRootAdmin ? 'Super Admin Portal' : 'Control centre'}</button>}</nav>
      <div className="account">{session ? <><span className="user-label">{profile?.display_name || session.user.email}</span><button className="icon-btn" title="Sign out" onClick={signOut}><LogOut size={18} /></button></> : <a className="login-link" href="#account"><LogIn size={16} /> Sign in</a>}</div>
    </header>
    <main id="top">
      <section className="hero"><div className="hero-copy"><span className="eyebrow"><span className="pulse" /> COMMUNITY BROADCASTING PLATFORM</span><h1>One community.<br /><em>One voice.</em><br />A better future.</h1><p>A space for Buruli to discuss real challenges, share ideas, learn from one another and turn conversations into practical action.</p><div className="hero-actions"><a className="primary-btn" href="#listen"><Headphones size={18} /> Listen to the radio</a>{WHATSAPP_URL && <a className="secondary-btn" href={WHATSAPP_URL} target="_blank" rel="noreferrer"><MessageCircle size={18} /> Join WhatsApp group</a>}</div><div className="motto">UNITY CREATES STRENGTH <i /> ACTION CREATES CHANGE</div></div><div className="hero-visual"><div className="signal signal-one" /><div className="signal signal-two" /><div className="radio-disc"><Radio size={74} /><span>BURULI<br />ON AIR</span></div><div className="floating-note"><span className="pulse" />{live ? 'LIVE BROADCAST' : 'COMMUNITY RADIO'}<small>{live ? live.title : 'Ideas. Dialogue. Action.'}</small></div></div></section>
      {radioSettings.maintenance_mode === true && <div className="notice" role="status">Buruli Development Radio is in scheduled maintenance. Live listening may remain available while community features are temporarily paused.</div>}
      {!SUPABASE_CONFIGURED && <div className="notice" role="alert">Supabase is not configured yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to the frontend environment before deployment.</div>}
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')}>×</button></div>}

      <section className="live-section" id="listen"><div className="section-heading"><div><span className="eyebrow">TUNE IN</span><h2>Listen live</h2><p>Join the conversation wherever you are.</p></div><span className={`live-pill ${live ? 'active' : ''}`}><i />{live ? 'ON AIR' : 'OFF AIR'}</span></div>
        <div className="live-card"><div className="live-art"><div className="equalizer"><i /><i /><i /><i /><i /><i /><i /></div><span>BURULI<br />DEVELOPMENT<br />RADIO</span></div><div className="live-info"><span className="eyebrow">{live ? 'NOW BROADCASTING' : 'NEXT COMMUNITY BROADCAST'}</span><h3>{live?.title || 'The community microphone'}</h3><p>{live?.description || 'When a programme goes live, it will appear here. Listen in and take part in building a stronger Buruli.'}</p>{live && <small><Clock3 size={14} /> Started / scheduled: {dateLabel(live.starts_at)}</small>}<div className="live-buttons">{connected ? <button className="primary-btn" onClick={leave}><Square size={16} /> Leave radio</button> : <button className="primary-btn" disabled={!live} onClick={() => joinLive(false)}><Play size={17} /> Listen live</button>}{session && live && speakerRequestsEnabled && <button className="secondary-btn" onClick={askToSpeak}><Mic size={16} /> Request to speak</button>}{mySpeakerStatus === 'approved' && live && <button className="secondary-btn" onClick={() => joinLive(true)}><Mic size={16} /> Join as speaker</button>}{isAdmin && live && <button className="primary-btn" onClick={() => joinLive(true)}><Mic size={16} /> Join as presenter</button>}<a className="share-btn" href={whatsappShare} target="_blank" rel="noreferrer"><Share2 size={16} /> Share</a></div>{requestStatus && <small className="hint">{requestStatus}</small>}</div></div>
        {connected && token && <LiveKitRoom serverUrl={serverUrl} token={token} connect audio={isSpeaker} video={false} onDisconnected={leave} onError={(error) => { setNotice(`Live audio connection error: ${error.message}`); leave() }} onConnected={() => { if (isSpeaker && current) adminRequest('/api/radio/recordings/start', 'POST', { programmeId: current.id }).then(() => setNotice('Live audio connected. Recording started.')).catch((error: any) => setNotice(`Live audio is connected, but recording is unavailable: ${error.message}`)) }}><RoomAudioRenderer /><AudioControls speaker={isSpeaker} /></LiveKitRoom>}
      </section>

      {showAdmin && canModerate && <section className="admin-panel control-portal"><div className="section-heading"><div><span className="eyebrow">SECURE ADMINISTRATION</span><h2>{isRootAdmin ? 'Root Super Admin Control Portal' : 'Radio Control Centre'}</h2><p>{isRootAdmin ? 'Full station governance, access control, security and operations.' : 'Manage broadcasts, programmes, announcements and speaker moderation.'}</p></div><div className="portal-actions"><span className="admin-tag"><ShieldCheck size={15} />{isRootAdmin ? 'ROOT SUPER ADMIN' : 'AUTHORISED STAFF'}</span><button className="icon-btn" title="Refresh control centre" onClick={refreshAdmin}><RefreshCw size={17} /></button></div></div>
        <div className="portal-stats">{[
          ['Registered users', adminStats.users ?? 0, UsersRound], ['Programmes', adminStats.programmes ?? 0, CalendarDays], ['Live now', adminStats.liveProgrammes ?? 0, Activity], ['Pending speakers', adminStats.pendingSpeakerRequests ?? 0, Mic], ['Recordings', adminStats.recordings ?? 0, FileAudio], ['Announcements', adminStats.announcements ?? 0, Megaphone]
        ].map(([label, value, Icon]: any) => <div className="portal-stat" key={label}><Icon size={19} /><b>{value}</b><span>{label}</span></div>)}</div>
        <div className="portal-tabs">{((isRootAdmin ? ['overview', 'broadcast', 'users', 'announcements', 'settings', 'audit'] : profile?.role === 'admin' ? ['overview', 'broadcast', 'users', 'announcements', 'settings'] : profile?.role === 'broadcaster' ? ['overview', 'broadcast', 'announcements'] : ['overview', 'announcements']) as string[]).map(tab => <button key={tab} className={adminTab === tab ? 'active' : ''} onClick={() => setAdminTab(tab as any)}>{tab === 'overview' ? 'Overview' : tab === 'broadcast' ? 'Broadcasts' : tab === 'users' ? 'User access' : tab === 'announcements' ? 'Announcements' : tab === 'settings' ? 'Station settings' : 'Audit history'}</button>)}</div>
        {adminTab === 'overview' && <div className="admin-grid"><div className="admin-box"><h3>Station operations</h3><p className="muted">Public listening is open to everyone. Only authenticated and authorised staff can broadcast or administer the station.</p><div className="manage-row"><b>Broadcast status</b><span className={live ? 'status-live' : 'muted'}>{live ? 'ON AIR' : 'OFF AIR'}</span></div><div className="manage-row"><b>Signed-in account</b><span>{profile?.display_name || session?.user?.email}</span></div><div className="manage-row"><b>Access level</b><span>{profile?.role}</span></div></div><div className="admin-box"><h3>Pending speaker requests <span className="count">{requests.length}</span></h3>{requests.length ? requests.map(item => <div className="manage-row" key={item.id}><b>{item.profiles?.display_name || 'Community member'}</b><div className="decision"><button onClick={() => moderate(item.id, 'approved')}>Approve</button><button onClick={() => moderate(item.id, 'declined')}>Decline</button></div></div>) : <p className="muted">No pending requests.</p>}</div></div>}
        {adminTab === 'broadcast' && <div className="admin-grid"><div className="admin-box"><h3>Schedule a programme</h3><label>Programme title<input value={programmeTitle} onChange={e => setProgrammeTitle(e.target.value)} placeholder="e.g. Buruli Development: From Talk to Action" /></label><label>Description<textarea value={programmeDescription} onChange={e => setProgrammeDescription(e.target.value)} placeholder="What will the discussion cover?" /></label><label>Start date and time<input type="datetime-local" value={programmeTime} onChange={e => setProgrammeTime(e.target.value)} /></label><button className="primary-btn" onClick={createProgramme}><CalendarDays size={16} /> Schedule programme</button></div><div className="admin-box"><h3>Broadcast management</h3>{programmes.slice(0, 12).map(programme => <div className="manage-row" key={programme.id}><div><b>{programme.title}</b><small>{dateLabel(programme.starts_at)}</small></div>{programme.is_live ? <button className="stop-btn" onClick={() => controlLive(false, programme)}><Square size={14} /> End</button> : (programme.status === 'scheduled' || !programme.status) ? <button className="start-btn" onClick={() => controlLive(true, programme)}><Play size={14} /> Go live</button> : <span className="muted">{programme.status || 'ended'}</span>}</div>)}</div><div className="admin-box"><div className="box-heading"><h3><FileAudio size={17}/> Programme recordings</h3><button className="secondary-btn" onClick={refreshRecordings}><RefreshCw size={14}/> Check storage</button></div>{recordings.length ? recordings.map(item => <div className="manage-row" key={item.id}><div><b>{item.programmes?.title || 'Radio programme'}</b><small>{item.status} · {new Date(item.started_at).toLocaleString()}</small></div>{item.status === 'ready' && item.public_url ? <a href={item.public_url} target="_blank" rel="noreferrer">Open recording</a> : <span className="muted">{item.status}</span>}</div>) : <p className="muted">No recordings have been created yet.</p>}</div></div>}
        {adminTab === 'users' && (isRootAdmin || profile?.role === 'admin') && <div className="admin-box"><div className="box-heading"><h3><UserCog size={18} /> User accounts & permissions</h3><button className="secondary-btn" onClick={() => void loadAdminData()}><RefreshCw size={14} /> Refresh</button></div><p className="muted">Root Super Admin accounts are protected. Only Root Super Admin can appoint or change administrators. Verify accounts before granting elevated access.</p><div className="user-table-wrap"><table className="user-table"><thead><tr><th>Member</th><th>Email verification</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Action</th></tr></thead><tbody>{adminUsers.map(user => <tr key={user.id}><td><b>{user.display_name}</b><small>{user.email}</small></td><td>{user.emailConfirmed ? 'Verified' : 'Not verified'}</td><td><select value={user.role} disabled={user.role === 'root_admin' || (profile?.role === 'admin' && user.role === 'admin')} onChange={e => changeUserRole(user.id, e.target.value)}><option value="listener">Listener</option><option value="moderator">Moderator</option><option value="broadcaster">Broadcaster</option>{isRootAdmin && <option value="admin">Administrator</option>}</select></td><td><span className={user.is_active ? 'status-live' : 'status-off'}>{user.is_active ? 'Active' : 'Disabled'}</span></td><td>{user.lastSignInAt ? new Date(user.lastSignInAt).toLocaleDateString() : 'Never'}</td><td>{user.role !== 'root_admin' && user.id !== session.user.id && <button className={user.is_active ? 'stop-btn' : 'start-btn'} onClick={() => changeUserStatus(user.id, !user.is_active)}>{user.is_active ? 'Disable' : 'Enable'}</button>}</td></tr>)}</tbody></table></div></div>}
        {adminTab === 'announcements' && <div className="admin-grid"><div className="admin-box"><h3><Megaphone size={18} /> Publish community announcement</h3><label>Headline<input value={announcementTitle} onChange={e => setAnnouncementTitle(e.target.value)} placeholder="Announcement title" /></label><label>Message<textarea value={announcementBody} onChange={e => setAnnouncementBody(e.target.value)} placeholder="Write a clear community notice..." /></label><button className="primary-btn" onClick={publishAnnouncement}><Bell size={16} /> Publish announcement</button></div><div className="admin-box"><h3>Manage announcements</h3>{announcements.map(item => <div className="manage-row" key={item.id}><div><b>{item.title}</b><small>{item.is_published ? 'Published' : 'Draft'} · {new Date(item.created_at).toLocaleDateString()}</small></div><div className="decision"><button onClick={() => toggleAnnouncement(item)}>{item.is_published ? 'Unpublish' : 'Publish'}</button>{(isRootAdmin || profile?.role === 'admin') && <button onClick={() => deleteAnnouncement(item.id)}><Trash2 size={13} /></button>}</div></div>)}</div></div>}
        {adminTab === 'settings' && <div className="admin-box"><h3><Settings size={18} /> Station settings</h3>{isRootAdmin ? <><label>Station name<input value={radioSettings.station_name ?? 'Buruli Development Radio'} onChange={e => setRadioSettings(value => ({ ...value, station_name: e.target.value }))} /></label><label>Station tagline<input value={radioSettings.station_tagline ?? 'Our Community. Our Voice. Our Future.'} onChange={e => setRadioSettings(value => ({ ...value, station_tagline: e.target.value }))} /></label>{[['maintenance_mode', 'Maintenance mode'], ['allow_listener_chat', 'Allow listener chat'], ['allow_speaker_requests', 'Allow requests to speak']].map(([key, label]) => <label className="setting-toggle" key={key}><input type="checkbox" checked={Boolean(radioSettings[key])} onChange={e => setRadioSettings(value => ({ ...value, [key]: e.target.checked }))} />{label}</label>)}<button className="primary-btn" onClick={saveRadioSettings}><Settings size={15} /> Save station settings</button></> : <p className="muted">Only the Root Super Admin can change station-wide settings.</p>}</div>}
        {adminTab === 'audit' && isRootAdmin && <div className="admin-box"><h3><Activity size={18} /> Security and administration audit</h3>{auditEvents.length ? auditEvents.map(event => <div className="manage-row" key={event.id}><div><b>{event.action}</b><small>{event.target_type || 'system'} · {event.target_id || '—'} · {new Date(event.created_at).toLocaleString()}</small></div><span className="muted">{event.actor_id}</span></div>) : <p className="muted">No recorded administrative changes yet.</p>}</div>}
      </section>}

      {announcements.some(item => item.is_published) && <section className="programmes-section announcement-section"><div className="section-heading"><div><span className="eyebrow">COMMUNITY BULLETINS</span><h2>Latest announcements</h2><p>Official notices and important community updates.</p></div><Megaphone size={28} /></div><div className="announcement-grid">{announcements.filter(item => item.is_published).slice(0, 3).map(item => <article className="announcement-card" key={item.id}><span className="date-chip">{new Date(item.published_at || item.created_at).toLocaleDateString()}</span><h3>{item.title}</h3><p>{item.body}</p></article>)}</div></section>}

      {publicRecordings.length > 0 && <section className="programmes-section archive-section"><div className="section-heading"><div><span className="eyebrow">LISTEN AGAIN</span><h2>Past broadcasts & audio archive</h2><p>Catch up on recorded community discussions.</p></div><FileAudio size={28}/></div><div className="archive-grid">{publicRecordings.map(item => <article className="archive-card" key={item.id}><div className="archive-icon"><Radio size={25}/></div><div><h3>{item.programmes?.title || 'Buruli Development Radio broadcast'}</h3><small>{new Date(item.started_at).toLocaleDateString()}</small><audio controls preload="none" src={item.public_url}>Your browser does not support audio playback.</audio></div></article>)}</div></section>}

      <section className="programmes-section" id="programmes"><div className="section-heading"><div><span className="eyebrow">WHAT'S COMING UP</span><h2>Programmes & discussions</h2><p>Stay informed and make time for conversations that matter.</p></div><CalendarDays size={30} /></div>{upcoming.length ? <div className="programme-grid">{upcoming.map(programme => <article className="programme-card" key={programme.id}><span className="date-chip">{dateLabel(programme.starts_at)}</span><h3>{programme.title}</h3><p>{programme.description || 'A Buruli Development Radio community programme.'}</p><a href={whatsappShare} target="_blank" rel="noreferrer">Share programme <ExternalLink size={14} /></a></article>)}</div> : <div className="empty-state"><CalendarDays size={28} /><b>No upcoming programmes published yet</b><span>Check back soon or follow the WhatsApp group for announcements.</span></div>}</section>

      <section className="community-section" id="community"><div><span className="eyebrow">STAY CONNECTED</span><h2>The radio is our microphone.<br /><em>The community is our strength.</em></h2><p>Use the radio for live discussions and use our WhatsApp group for everyday messages, updates, coordination and continued interaction.</p><div className="community-actions">{WHATSAPP_URL ? <a className="whatsapp-btn" href={WHATSAPP_URL} target="_blank" rel="noreferrer"><MessageCircle size={18} /> Open Buruli Development WhatsApp group</a> : <span className="hint">WhatsApp group link will appear here once configured.</span>}<a className="secondary-btn" href={whatsappShare} target="_blank" rel="noreferrer"><Share2 size={17} /> Share this radio</a></div></div><div className="community-icon"><Users size={70} /><span>TOGETHER<br />WE MOVE FORWARD</span></div></section>

      <section className="account-section" id="account"><div><span className="eyebrow">TAKE PART</span><h2>Be part of the conversation</h2><p>Create an account to join the live chat and request to speak during programmes. Listening does not require registration.</p></div><div className="auth-card">{session ? <><h3>You are signed in</h3><p>{session.user.email}</p><p className="muted">Account role: {profile?.role || 'loading'} · {profile?.is_active ? 'Active' : 'Check account status'}</p><button className="secondary-btn" onClick={signOut}>Sign out</button></> : <><div className="auth-tabs"><button className={authMode === 'login' ? 'selected' : ''} onClick={() => setAuthMode('login')}>Sign in</button><button className={authMode === 'signup' ? 'selected' : ''} onClick={() => setAuthMode('signup')}>Create account</button></div>{authMode === 'signup' && <label>Your display name<input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="How should listeners identify you?" /></label>}<label>Email address<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" /></label><button className="primary-btn full" onClick={auth}>{authMode === 'login' ? 'Sign in' : 'Create account'}</button>{authMode === 'login' && <button className="text-link" onClick={async () => { if (!email.trim()) { setNotice('Enter your email address first.'); return } const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin }); setNotice(error ? error.message : 'Password reset instructions have been sent if the account exists.') }}>Forgot password?</button>}</>}</div></section>

      <section className="chat-section"><div className="chat-title"><MessageCircle size={22} /><div><h3>Live discussion chat</h3><p>{current ? `Messages for ${current.title}` : 'Chat becomes available during a live programme'}</p></div></div><div className="chat-list">{messages.length ? messages.map(item => <div className="chat-message" key={item.id}><b>{item.profiles?.display_name || 'Community member'}</b><span>{item.body}</span><small>{new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{canModerate && <button className="chat-delete" title="Remove message" onClick={() => deleteChatMessage(item.id)}><Trash2 size={12} /></button>}</small></div>) : <div className="empty-chat">No messages yet.</div>}</div><div className="chat-compose"><input value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendMessage()} placeholder={!chatEnabled ? 'Community chat is temporarily disabled' : session ? 'Share a constructive contribution...' : 'Sign in to join the chat'} disabled={!session || !current || !chatEnabled} /><button onClick={sendMessage} disabled={!session || !current || !chatEnabled || !message.trim()}><Send size={17} /></button></div></section>
    </main>
    <footer><div className="footer-brand"><RadioTower size={24} /><b>{radioSettings.station_name || 'BURULI DEVELOPMENT RADIO'}</b></div><p>{radioSettings.station_tagline || 'Our Community. Our Voice. Our Future.'}</p><small>© {new Date().getFullYear()} Buruli Development Radio. Built for community dialogue and development.</small></footer>
  </div>
}

function AudioControls({ speaker }: { speaker: boolean }) {
  const { localParticipant } = useLocalParticipant()
  const state = useConnectionState()
  const [muted, setMuted] = useState(false)
  useEffect(() => { if (speaker) void localParticipant.setMicrophoneEnabled(true).catch(() => setMuted(true)) }, [speaker, localParticipant])
  if (!speaker) return <div className="audio-status"><Headphones size={16} /> Connected — listening live <span>{state === ConnectionState.Connected ? '● Connected' : 'Connecting…'}</span></div>
  return <div className="audio-status"><button className="mic-toggle" onClick={() => { const next = !muted; setMuted(next); void localParticipant.setMicrophoneEnabled(!next) }}>{muted ? <MicOff size={16} /> : <Mic size={16} />}{muted ? 'Unmute microphone' : 'Mute microphone'}</button><span>Live presenter microphone · {state === ConnectionState.Connected ? 'Connected' : 'Connecting'}</span></div>
}
