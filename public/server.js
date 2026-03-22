// PulseBridge Relay Server
// Express + Socket.IO — real-time bridge between scanner and hospital dashboard
// Run: node server.js

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

// ── VISION SCAN ENDPOINT ─────────────────────────────────────
// Scanner POSTs a base64 image here — server calls Claude Vision
// using the ANTHROPIC_API_KEY from .env and returns extracted vitals
app.post('/scan', async (req, res) => {
  const { imageBase64, imageMime } = req.body
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in environment' })

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: imageMime || 'image/jpeg', data: imageBase64 }
            },
            {
              type: 'text',
              text: `You are an ambulance monitor OCR and patient assessment system. Analyze this image.

TASK 1 — VITALS: If you see a patient monitor or medical screen with numbers, extract all visible values.
TASK 2 — DEMOGRAPHICS: If a patient is visible, estimate age (single number e.g. 45) and sex (Male/Female). If no patient visible, return null.

Respond ONLY with this JSON, no markdown:
{"found":true,"heartRate":null,"bpSystolic":null,"bpDiastolic":null,"spo2":null,"respiratoryRate":null,"temperature":null,"gcs":null,"estimatedAge":null,"estimatedSex":null,"rawText":"","notes":"brief description","confidence":{"heartRate":"high","bpSystolic":"high","spo2":"high","respiratoryRate":"med","temperature":"med","gcs":"low","demographics":"low"}}`
            }
          ]
        }]
      })
    })

    const data = await response.json()
    const text = data.content?.find(b => b.type === 'text')?.text || '{}'
    const result = JSON.parse(text.replace(/```json|```/g, '').trim())
    res.json(result)
  } catch (e) {
    console.error('[SCAN]', e)
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