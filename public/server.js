// PulseBridge Relay Server
// Express + Socket.IO — real-time bridge between scanner and hospital dashboard
// Run: node server.js

import 'dotenv/config'
import express from 'express'
import http from 'http'
import { Server as SocketIO } from 'socket.io'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const httpServer = http.createServer(app)

const io = new SocketIO(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
})

app.use(cors())
app.use(express.json({ limit: '5mb' }))

// Serve all HTML files as static
app.use(express.static(__dirname))

// ── IN-MEMORY STATE ──────────────────────────────────────────
// Keeps the latest encounter so the dashboard gets current state on connect
let encounters = {}   // encounterId → encounter object
let scannerCount = 0
let dashboardCount = 0

// ── GPS LOCATION + ETA ───────────────────────────────────────
// Hospital coordinates — update to your actual hospital location
const HOSPITAL = { lat: 49.2606, lng: -123.1234, name: 'Vancouver General Hospital' }
const AVG_SPEED_KMH = 50 // average urban ambulance speed

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

app.post('/location', (req, res) => {
  const { encounterId, lat, lng, ambulanceId } = req.body
  if (!lat || !lng) return res.status(400).json({ error: 'Missing coordinates' })

  const distKm = haversineKm(lat, lng, HOSPITAL.lat, HOSPITAL.lng)
  const etaMinutes = Math.max(1, Math.round((distKm / AVG_SPEED_KMH) * 60))

  // Update encounter ETA
  if (encounters[encounterId]) {
    encounters[encounterId].etaMinutes = etaMinutes
    encounters[encounterId].location = { lat, lng, updatedAt: new Date().toISOString() }
    encounters[encounterId].distanceKm = distKm.toFixed(2)
    io.to('hospital').emit('patient:update', encounters[encounterId])
  }

  // Also broadcast a dedicated location event
  io.to('hospital').emit('ambulance:location', {
    encounterId, ambulanceId, lat, lng, etaMinutes,
    distanceKm: distKm.toFixed(2)
  })

  console.log(`[GPS] ${ambulanceId || encounterId} — ${distKm.toFixed(1)}km away → ETA ${etaMinutes} min`)
  res.json({ ok: true, etaMinutes, distanceKm: distKm.toFixed(2) })
})
// ── VISION SCAN ENDPOINT ─────────────────────────────────────
// Supports both Gemini and Claude — set GEMINI_API_KEY or ANTHROPIC_API_KEY in Railway variables
// Gemini takes priority if both are set
const VISION_PROMPT = `You are an ambulance monitor OCR and patient assessment system. Analyze this image.
TASK 1 — VITALS: If you see a patient monitor or medical screen with numbers, extract all visible values.
TASK 2 — DEMOGRAPHICS: If a patient is visible, estimate age (single number e.g. 45) and sex (Male/Female). If no patient visible, return null.
Respond ONLY with this JSON, no markdown, no explanation:
{"found":true,"heartRate":null,"bpSystolic":null,"bpDiastolic":null,"spo2":null,"respiratoryRate":null,"temperature":null,"gcs":null,"estimatedAge":null,"estimatedSex":null,"rawText":"","notes":"brief description","confidence":{"heartRate":"high","bpSystolic":"high","spo2":"high","respiratoryRate":"med","temperature":"med","gcs":"low","demographics":"low"}}`

app.post('/scan', async (req, res) => {
  const { imageBase64, imageMime } = req.body
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' })

  const geminiKey = process.env.GEMINI_API_KEY
  const claudeKey = process.env.ANTHROPIC_API_KEY

  if (!geminiKey && !claudeKey) {
    return res.status(500).json({ error: 'No API key found — set GEMINI_API_KEY or ANTHROPIC_API_KEY in Railway Variables' })
  }

  try {
    let result

    if (geminiKey) {
      // ── Gemini 1.5 Flash ────────────────────────────────────
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { inline_data: { mime_type: imageMime || 'image/jpeg', data: imageBase64 } },
              { text: VISION_PROMPT }
            ]}],
            generationConfig: { temperature: 0.1, maxOutputTokens: 800 }
          })
        }
      )
      const data = await r.json()
      if (!r.ok) throw new Error(data.error?.message || 'Gemini error ' + r.status)
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
      result = JSON.parse(text.replace(/```json|```/g, '').trim())
      console.log(`[SCAN] Gemini — HR: ${result.heartRate}, SpO2: ${result.spo2}`)

    } else {
      // ── Claude Vision ───────────────────────────────────────
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 800,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: imageMime || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: VISION_PROMPT }
          ]}]
        })
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error?.message || 'Claude error ' + r.status)
      const text = data.content?.find(b => b.type === 'text')?.text || '{}'
      result = JSON.parse(text.replace(/```json|```/g, '').trim())
      console.log(`[SCAN] Claude — HR: ${result.heartRate}, SpO2: ${result.spo2}`)
    }

    res.json(result)
  } catch (e) {
    console.error('[SCAN]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── REST: SCANNER POSTS VITALS ───────────────────────────────
app.post('/intake', (req, res) => {
  const data = req.body
  const encounterId = data.encounterId || ('ENC-' + Date.now().toString(36).toUpperCase())

  // Merge into existing encounter or create new
  if (!encounters[encounterId]) {
    encounters[encounterId] = {
      encounterId,
      ambulanceId: data.ambulanceId || 'AMB-01',
      status: 'active',
      createdAt: new Date().toISOString(),
      timeline: []
    }
  }

  const enc = encounters[encounterId]
  enc.vitals = data.vitals
  enc.severity = data.severity
  enc.recs = data.recs
  enc.updatedAt = new Date().toISOString()
  if (data.etaMinutes != null) enc.etaMinutes = data.etaMinutes
  if (data.patient) enc.patient = data.patient

  // Add timeline event
  enc.timeline.push({
    time: new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }),
    event: data.vitals ? 'Vitals updated' : 'Intake received',
    detail: data.vitals ? `HR ${data.vitals.heartRate ?? '—'}, SpO2 ${data.vitals.spo2 ?? '—'}%, BP ${data.vitals.bpSystolic ?? '—'}/${data.vitals.bpDiastolic ?? '—'}` : '',
    type: enc.severity === 'critical' ? 'critical' : enc.severity === 'high' ? 'warn' : 'info'
  })

  // Broadcast to all hospital dashboards
  io.to('hospital').emit('patient:update', enc)
  console.log(`[INTAKE] ${encounterId} → severity: ${enc.severity ?? '?'} — pushed to ${dashboardCount} dashboard(s)`)

  res.json({ ok: true, encounterId })
})

// ── REST: HOSPITAL ACKNOWLEDGES ──────────────────────────────
app.post('/ack/:encounterId', (req, res) => {
  const { encounterId } = req.params
  if (encounters[encounterId]) {
    encounters[encounterId].acked = true
    encounters[encounterId].ackedAt = new Date().toISOString()
    encounters[encounterId].timeline.push({
      time: new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }),
      event: 'Hospital acknowledged',
      detail: 'ER team notified',
      type: 'ok'
    })
    io.to('scanner').emit('patient:acked', { encounterId })
    io.to('hospital').emit('patient:update', encounters[encounterId])
  }
  res.json({ ok: true })
})

// ── REST: GET ALL ENCOUNTERS (dashboard initial load) ────────
app.get('/encounters', (req, res) => {
  res.json(Object.values(encounters))
})

// ── SOCKET.IO ────────────────────────────────────────────────
io.on('connection', socket => {
  const role = socket.handshake.query.role || 'unknown'
  socket.join(role)

  if (role === 'scanner') scannerCount++
  if (role === 'hospital') {
    dashboardCount++
    // Send all current encounters immediately on connect
    socket.emit('encounters:init', Object.values(encounters))
  }

  console.log(`[WS] ${role} connected — scanners: ${scannerCount}, dashboards: ${dashboardCount}`)

  socket.on('disconnect', () => {
    if (role === 'scanner') scannerCount = Math.max(0, scannerCount - 1)
    if (role === 'hospital') dashboardCount = Math.max(0, dashboardCount - 1)
    console.log(`[WS] ${role} disconnected`)
  })
})

// ── STATUS PAGE ───────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    scanners: scannerCount,
    dashboards: dashboardCount,
    encounters: Object.keys(encounters).length,
    uptime: process.uptime().toFixed(0) + 's'
  })
})

// ── BOOT ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   PulseBridge Server running         ║
  ║   http://localhost:${PORT}              ║
  ╠══════════════════════════════════════╣
  ║   Scanner  → open pulsebridge-live-scanner.html     ║
  ║   Hospital → open pulsebridge-hospital-dashboard.html ║
  ║   Status   → http://localhost:${PORT}/status          ║
  ╚══════════════════════════════════════╝
  `)
})
