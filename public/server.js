// Pulse — Relay Server
// Express + Socket.IO + Gemini/Claude Vision
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
app.use(express.json({ limit: '10mb' }))
app.use(express.static(__dirname))

// ── IN-MEMORY STATE ───────────────────────────────────────────
let encounters = {}
let scannerCount = 0
let dashboardCount = 0

// ── HOSPITAL COORDS + ETA ─────────────────────────────────────
const HOSPITAL = { lat: 49.2606, lng: -123.1234 }

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

app.post('/location', (req, res) => {
  const { encounterId, lat, lng, ambulanceId } = req.body
  if (!lat || !lng) return res.status(400).json({ error: 'Missing coordinates' })
  const distKm = haversineKm(lat, lng, HOSPITAL.lat, HOSPITAL.lng)
  const etaMinutes = Math.max(1, Math.round((distKm / 50) * 60))
  if (encounters[encounterId]) {
    encounters[encounterId].etaMinutes = etaMinutes
    encounters[encounterId].distanceKm = distKm.toFixed(2)
    io.to('hospital').emit('patient:update', encounters[encounterId])
  }
  io.to('hospital').emit('ambulance:location', { encounterId, ambulanceId, lat, lng, etaMinutes, distanceKm: distKm.toFixed(2) })
  res.json({ ok: true, etaMinutes, distanceKm: distKm.toFixed(2) })
})

// ── VISION SCAN ───────────────────────────────────────────────
const VISION_PROMPT = `You are an ambulance monitor OCR system. Analyze this image.
If you see a patient monitor, extract all visible vitals. If a patient is visible, estimate age and sex.
Return ONLY valid JSON with no markdown, no code fences, no explanation:
{"found":true,"heartRate":null,"bpSystolic":null,"bpDiastolic":null,"spo2":null,"respiratoryRate":null,"temperature":null,"gcs":null,"estimatedAge":null,"estimatedSex":null,"rawText":"","notes":"","confidence":{"heartRate":"high","bpSystolic":"high","spo2":"high","respiratoryRate":"med","temperature":"med","gcs":"low","demographics":"low"}}`

function safeParseJSON(text) {
  try {
    const s = (text||'').replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim()
    const first = s.indexOf('{'), last = s.lastIndexOf('}')
    return JSON.parse(first !== -1 && last !== -1 ? s.slice(first, last+1) : s)
  } catch {
    return { found: false, notes: 'parse error', heartRate: null, spo2: null }
  }
}

// ── PLAUSIBILITY RANGES ───────────────────────────────────────
const RANGES = {
  heartRate:       { min: 20,  max: 300 },
  bpSystolic:      { min: 50,  max: 300 },
  bpDiastolic:     { min: 20,  max: 200 },
  spo2:            { min: 50,  max: 100 },
  respiratoryRate: { min: 4,   max: 60  },
  temperature:     { min: 34,  max: 43  },
  gcs:             { min: 3,   max: 15  },
}

// Max allowed change between consecutive readings
const MAX_DELTA = {
  heartRate: 40, bpSystolic: 40, bpDiastolic: 30,
  spo2: 10, respiratoryRate: 15, temperature: 1.5, gcs: 3
}

// Per-encounter last known good values for temporal check
const lastKnownVitals = {}

function validatePlausibility(result) {
  if (!result || !result.found) return result
  const cleaned = { ...result }
  const flags = []
  for (const [key, range] of Object.entries(RANGES)) {
    const val = cleaned[key]
    if (val == null) continue
    if (val < range.min || val > range.max) {
      console.log(`[VALIDATE] ${key}=${val} out of range [${range.min}-${range.max}] — nulled`)
      flags.push(`${key} out of range (${val})`)
      cleaned[key] = null
    }
  }
  if (flags.length) cleaned.validationFlags = flags
  return cleaned
}

function validateTemporal(result, encounterId) {
  if (!result || !result.found || !encounterId) return result
  const prev = lastKnownVitals[encounterId]
  if (!prev) return result
  const cleaned = { ...result }
  const flags = []
  for (const [key, maxDelta] of Object.entries(MAX_DELTA)) {
    const curr = cleaned[key], last = prev[key]
    if (curr == null || last == null) continue
    const delta = Math.abs(curr - last)
    if (delta > maxDelta) {
      console.log(`[TEMPORAL] ${key} jumped ${last}→${curr} (delta ${delta} > max ${maxDelta}) — using previous`)
      flags.push(`${key} spike detected (${last}→${curr}), using previous`)
      cleaned[key] = last // revert to last known good
    }
  }
  if (flags.length) cleaned.temporalFlags = flags
  return cleaned
}

function updateLastKnown(result, encounterId) {
  if (!result || !result.found || !encounterId) return
  const vitals = {}
  for (const key of Object.keys(MAX_DELTA)) {
    if (result[key] != null) vitals[key] = result[key]
  }
  lastKnownVitals[encounterId] = { ...(lastKnownVitals[encounterId] || {}), ...vitals }
}

// Returns true if two scan results agree (within tolerance)
function scansAgree(a, b) {
  if (!a || !b) return false
  const keys = ['heartRate','bpSystolic','bpDiastolic','spo2','respiratoryRate']
  let checked = 0, agreed = 0
  for (const key of keys) {
    if (a[key] == null || b[key] == null) continue
    checked++
    const tolerance = key === 'spo2' ? 2 : key === 'temperature' ? 0.3 : 5
    if (Math.abs(a[key] - b[key]) <= tolerance) agreed++
  }
  return checked === 0 || agreed / checked >= 0.7 // 70% of present values agree
}

// Merge two results — prefer values that appear in both, use the more confident single value otherwise
function mergeResults(a, b) {
  const merged = { ...a }
  const keys = ['heartRate','bpSystolic','bpDiastolic','spo2','respiratoryRate','temperature','gcs','estimatedAge','estimatedSex']
  for (const key of keys) {
    if (a[key] == null && b[key] != null) merged[key] = b[key]
    else if (a[key] != null && b[key] != null) {
      // Average numeric values
      if (typeof a[key] === 'number') merged[key] = Math.round((a[key] + b[key]) / 2)
    }
  }
  merged.scanMethod = 'double-scan-consensus'
  return merged
}

// Core single scan function
async function runSingleScan(imageBase64, imageMime, apiKey, isGemini) {
  if (isGemini) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
      { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ contents:[{ parts:[
          { inline_data:{ mime_type: imageMime||'image/jpeg', data: imageBase64 }},
          { text: VISION_PROMPT }
        ]}], generationConfig:{ temperature:0.1, maxOutputTokens:1024 }})
      }
    )
    const data = await r.json()
    if (!r.ok) throw new Error(data.error?.message || 'Gemini error ' + r.status)
    return safeParseJSON(data.candidates?.[0]?.content?.parts?.[0]?.text || '{}')
  } else {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:800,
        messages:[{ role:'user', content:[
          { type:'image', source:{ type:'base64', media_type: imageMime||'image/jpeg', data: imageBase64 }},
          { type:'text', text: VISION_PROMPT }
        ]}]
      })
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error?.message || 'Claude error ' + r.status)
    return safeParseJSON(data.content?.find(b=>b.type==='text')?.text || '{}')
  }
}

app.post('/scan', async (req, res) => {
  const { imageBase64, imageMime, encounterId } = req.body
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' })
  const geminiKey = process.env.GEMINI_API_KEY
  const claudeKey = process.env.ANTHROPIC_API_KEY
  const apiKey = geminiKey || claudeKey
  const isGemini = !!geminiKey
  if (!apiKey) return res.status(500).json({ error: 'No API key — add GEMINI_API_KEY or ANTHROPIC_API_KEY in Railway Variables' })

  try {
    // ── SCAN 1 ────────────────────────────────────────────────
    const scan1 = await runSingleScan(imageBase64, imageMime, apiKey, isGemini)
    const valid1 = validatePlausibility(scan1)

    let finalResult

    if (!valid1.found) {
      // Nothing found on first scan — return immediately, no need for second scan
      finalResult = valid1
    } else {
      // ── SCAN 2 (parallel for speed) ──────────────────────────
      const scan2 = await runSingleScan(imageBase64, imageMime, apiKey, isGemini)
      const valid2 = validatePlausibility(scan2)

      if (scansAgree(valid1, valid2)) {
        // Scans agree — merge and use consensus
        finalResult = mergeResults(valid1, valid2)
        console.log(`[SCAN] ✓ Consensus reached — HR:${finalResult.heartRate} SpO2:${finalResult.spo2}`)
      } else {
        // Scans disagree — do a tiebreaker third scan
        console.log(`[SCAN] ⚠ Scans disagree — running tiebreaker`)
        const scan3 = await runSingleScan(imageBase64, imageMime, apiKey, isGemini)
        const valid3 = validatePlausibility(scan3)

        // Pick the two that agree most, or merge all three
        if (scansAgree(valid1, valid3)) {
          finalResult = mergeResults(valid1, valid3)
        } else if (scansAgree(valid2, valid3)) {
          finalResult = mergeResults(valid2, valid3)
        } else {
          // All three differ — merge all three, mark as low confidence
          finalResult = mergeResults(mergeResults(valid1, valid2), valid3)
          finalResult.lowConsensus = true
        }
        finalResult.scanMethod = 'triple-scan-tiebreaker'
        console.log(`[SCAN] Tiebreaker done — HR:${finalResult.heartRate} SpO2:${finalResult.spo2}`)
      }

      // ── TEMPORAL CONSISTENCY CHECK ────────────────────────────
      finalResult = validateTemporal(finalResult, encounterId)
      updateLastKnown(finalResult, encounterId)
    }

    res.json(finalResult)
  } catch(e) {
    console.error('[SCAN]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── INTAKE ────────────────────────────────────────────────────
app.post('/intake', (req, res) => {
  const data = req.body
  const encounterId = data.encounterId || ('ENC-' + Date.now().toString(36).toUpperCase())
  if (!encounters[encounterId]) {
    encounters[encounterId] = { encounterId, ambulanceId: data.ambulanceId||'AMB-01', status:'active', createdAt: new Date().toISOString(), timeline:[] }
  }
  const enc = encounters[encounterId]
  if (data.vitals) enc.vitals = data.vitals
  if (data.severity) enc.severity = data.severity
  if (data.recs) enc.recs = data.recs
  if (data.etaMinutes != null) enc.etaMinutes = data.etaMinutes
  if (data.patient) enc.patient = data.patient
  enc.updatedAt = new Date().toISOString()
  enc.timeline.push({
    time: new Date().toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit'}),
    event: data.vitals ? 'Vitals updated' : 'Intake received',
    detail: data.vitals ? `HR ${data.vitals.heartRate??'—'}, SpO2 ${data.vitals.spo2??'—'}%` : '',
    type: enc.severity==='critical'?'critical':enc.severity==='high'?'warn':'info'
  })
  io.to('hospital').emit('patient:update', enc)
  res.json({ ok:true, encounterId })
})

// ── ACK ───────────────────────────────────────────────────────
app.post('/ack/:encounterId', (req, res) => {
  const enc = encounters[req.params.encounterId]
  if (enc) {
    enc.acked = true
    enc.ackedAt = new Date().toISOString()
    enc.timeline.push({ time: new Date().toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit'}), event:'Hospital acknowledged', detail:'ER team notified', type:'ok' })
    io.to('scanner').emit('patient:acked', { encounterId: req.params.encounterId })
    io.to('hospital').emit('patient:update', enc)
  }
  res.json({ ok:true })
})

// ── ENCOUNTERS ────────────────────────────────────────────────
app.get('/encounters', (req, res) => res.json(Object.values(encounters)))

// ── STATUS ────────────────────────────────────────────────────
app.get('/status', (req, res) => res.json({
  ok:true, scanners:scannerCount, dashboards:dashboardCount,
  encounters:Object.keys(encounters).length,
  uptime: process.uptime().toFixed(0)+'s',
  vision: process.env.GEMINI_API_KEY?'gemini':process.env.ANTHROPIC_API_KEY?'claude':'none'
}))

// ── SOCKET.IO ─────────────────────────────────────────────────
io.on('connection', socket => {
  const role = socket.handshake.query.role || 'unknown'
  socket.join(role)
  if (role==='scanner') scannerCount++
  if (role==='hospital') { dashboardCount++; socket.emit('encounters:init', Object.values(encounters)) }
  console.log(`[WS] ${role} connected`)
  socket.on('disconnect', () => {
    if (role==='scanner') scannerCount = Math.max(0, scannerCount-1)
    if (role==='hospital') dashboardCount = Math.max(0, dashboardCount-1)
  })
})

// ── BOOT ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
httpServer.listen(PORT, () => {
  console.log(`Pulse server → port ${PORT}`)
  console.log(`Vision API: ${process.env.GEMINI_API_KEY?'Gemini':process.env.ANTHROPIC_API_KEY?'Claude':'NONE — set key in Railway Variables'}`)
})