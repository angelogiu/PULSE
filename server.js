import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import { v4 as uuid } from 'uuid';

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

// Convenience redirects for common URLs
app.get('/hospital.html', (req, res) => res.redirect('/pulsebridge-hospital-dashboard.html'));
app.get('/scanner.html', (req, res) => res.redirect('/pulsebridge-live-scanner.html'));

// ── IN-MEMORY STORE (replace with Cassandra for production) ──
const encounters = new Map();

// ── ROUTES ───────────────────────────────────────────────────

// POST /api/vitals
// Called by the scanner page every time Claude Vision extracts vitals.
// Creates or updates an encounter and broadcasts to hospital dashboard.
app.post('/api/vitals', (req, res) => {
  const { ambulanceId, vitals, severity, recommendations, etaMinutes, patient } = req.body;

  // Find existing active encounter for this ambulance or create new one
  let encounter = [...encounters.values()].find(
    e => e.ambulanceId === ambulanceId && e.status === 'active'
  );

  if (!encounter) {
    encounter = {
      encounterId:      'ENC-' + uuid().slice(0, 6).toUpperCase(),
      ambulanceId:      ambulanceId || 'AMB-01',
      status:           'active',
      createdAt:        new Date().toISOString(),
      acknowledged:     false,
      vitalsHistory:    [],
      patient:          patient || {},
    };
    encounters.set(encounter.encounterId, encounter);
    console.log(`[NEW]     ${encounter.encounterId} created for ${ambulanceId}`);
  }

  // Update encounter with latest scan
  encounter.vitals          = vitals;
  encounter.severity        = severity || 'moderate';
  encounter.recommendations = recommendations || [];
  encounter.etaMinutes      = etaMinutes ?? encounter.etaMinutes ?? 10;
  encounter.updatedAt       = new Date().toISOString();
  encounter.vitalsHistory.push({ ...vitals, timestamp: new Date().toISOString() });
  if (encounter.vitalsHistory.length > 20) encounter.vitalsHistory.shift();

  // Broadcast update to all hospital dashboard clients
  io.emit('patient:update', encounter);
  console.log(`[UPDATE]  ${encounter.encounterId} → ${encounter.severity?.toUpperCase()} | HR:${vitals?.heartRate} SpO2:${vitals?.spo2}`);

  res.json({ ok: true, encounterId: encounter.encounterId });
});

// POST /api/acknowledge/:id
app.post('/api/acknowledge/:id', (req, res) => {
  const enc = encounters.get(req.params.id);
  if (!enc) return res.status(404).json({ error: 'Not found' });
  enc.acknowledged   = true;
  enc.acknowledgedAt = new Date().toISOString();
  enc.acknowledgedBy = req.body.by || 'ER Physician';
  io.emit('patient:acked', { encounterId: enc.encounterId, by: enc.acknowledgedBy });
  console.log(`[ACKED]   ${enc.encounterId} by ${enc.acknowledgedBy}`);
  res.json({ ok: true });
});

// PATCH /api/encounters/:id — update encounter (e.g. assign bay)
app.patch('/api/encounters/:id', (req, res) => {
  const enc = encounters.get(req.params.id);
  if (!enc) return res.status(404).json({ error: 'Not found' });
  if (req.body.bay !== undefined) enc.bay = req.body.bay || null;
  enc.updatedAt = new Date().toISOString();
  io.emit('patient:update', enc);
  console.log(`[BAY]     ${enc.encounterId} → ${enc.bay || 'unassigned'}`);
  res.json({ ok: true, encounter: enc });
});

// DELETE /api/encounters/:id — remove patient from board
app.delete('/api/encounters/:id', (req, res) => {
  const enc = encounters.get(req.params.id);
  if (!enc) return res.status(404).json({ error: 'Not found' });
  encounters.delete(req.params.id);
  io.emit('patient:removed', { encounterId: req.params.id });
  console.log(`[REMOVE]  ${req.params.id} removed`);
  res.json({ ok: true });
});

// GET /api/encounters — initial load for hospital dashboard
app.get('/api/encounters', (req, res) => {
  res.json([...encounters.values()].filter(e => e.status === 'active'));
});

// POST /api/encounters — manually add a patient (from hospital dashboard)
app.post('/api/encounters', (req, res) => {
  const { chiefComplaint, age, sex, severity, etaMinutes, notes } = req.body;
  const encounter = {
    encounterId:      'ENC-' + uuid().slice(0, 6).toUpperCase(),
    ambulanceId:      req.body.ambulanceId || 'AMB-MANUAL',
    status:           'active',
    createdAt:        new Date().toISOString(),
    acknowledged:     false,
    vitalsHistory:    [],
    vitals:           req.body.vitals || {},
    severity:         severity || 'moderate',
    recommendations:  [],
    etaMinutes:       etaMinutes ?? 10,
    patient:          {
      chiefComplaint: chiefComplaint || 'Manual entry',
      age:            age ?? null,
      sex:            sex || null,
      notes:          notes || '',
    },
  };
  encounters.set(encounter.encounterId, encounter);
  io.emit('patient:update', encounter);
  console.log(`[NEW]     ${encounter.encounterId} added manually — ${chiefComplaint || 'Manual entry'}`);
  res.json({ ok: true, encounter });
});

// POST /api/vision — proxy Claude Vision call server-side
// (alternative to calling from browser — avoids exposing API key in frontend)
app.post('/api/vision', async (req, res) => {
  const { imageBase64, imageMime } = req.body;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 700,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: imageMime || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: `You are an ambulance monitor OCR system. Analyze this image and extract any visible patient vitals.

Respond ONLY with this exact JSON, no markdown:
{
  "found": true,
  "heartRate": null,
  "bpSystolic": null,
  "bpDiastolic": null,
  "spo2": null,
  "respiratoryRate": null,
  "temperature": null,
  "gcs": null,
  "rawText": "any numbers or text visible on screen",
  "confidence": {
    "heartRate": "high",
    "bpSystolic": "high",
    "spo2": "high",
    "respiratoryRate": "med",
    "temperature": "med",
    "gcs": "low"
  },
  "notes": "brief description of what you see"
}

Use null for values you cannot find. Confidence: high = clearly visible, med = partially visible, low = guessed.` }
          ]
        }]
      })
    });
    const data = await r.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '{}';
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json(result);
  } catch (e) {
    console.error('[VISION ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── SOCKET.IO ────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Send current state to newly connected dashboard
  socket.emit('initial:load', [...encounters.values()].filter(e => e.status === 'active'));

  socket.on('disconnect', () => console.log(`[WS] Disconnected: ${socket.id}`));
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  PulseBridge running at http://localhost:${PORT}`);
  console.log(`  Scanner:   http://localhost:${PORT}/scanner.html`);
  console.log(`  Hospital:  http://localhost:${PORT}/hospital.html\n`);
});
