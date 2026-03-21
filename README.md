<<<<<<< HEAD
# PULSE
PULSE is a real-time EMS-to-hospital triage platform that streams patient data from ambulances to emergency departments, enabling early risk assessment and preparation before arrival. Built with Kafka, Spark, and Cassandra, it delivers scalable, low-latency intelligence for pre-hospital care.
=======
# Pulse

Real-time EMS-to-hospital intelligence platform. A webcam reads a patient monitor using Claude Vision, extracts vitals automatically, and streams them live to the hospital dashboard.

## Setup (5 minutes)

### 1. Install Node.js
Download from https://nodejs.org — get the LTS version.

### 2. Open this folder in VS Code
File → Open Folder → select the `pulse` folder.

### 3. Open the VS Code terminal
View → Terminal (or Ctrl+`)

### 4. Install dependencies
```
npm install
```

### 5. Add your API key
- Copy the file `.env.example` and rename the copy to `.env`
- Open `.env` and replace `sk-ant-your-key-here` with your actual key from console.anthropic.com

```
ANTHROPIC_API_KEY=sk-ant-api03-...
PORT=3000
```

### 6. Start the server
```
npm run dev
```

You should see:
```
  Pulse running at http://localhost:3000
  Scanner:   http://localhost:3000/scanner.html
  Hospital:  http://localhost:3000/hospital.html
```

### 7. Open both pages
- Open **http://localhost:3000/hospital.html** in one browser tab
- Open **http://localhost:3000/scanner.html** in another tab (or another device on same network)

### 8. Start scanning
- On the scanner page, click **Start Camera**
- Allow camera access when prompted
- Point your webcam at a monitor screen, a printed vitals page, or any screen showing numbers
- Watch the hospital dashboard update in real time

---

## How the API key works

You have two options:

**Option A — Server key (recommended):**  
Put the key in `.env`. Leave the API key field blank on the scanner page. Calls go through your server.

**Option B — Browser key:**  
Paste your key directly into the scanner page input. Calls go directly from browser to Anthropic. The key is not stored anywhere.

---

## Project structure

```
pulse/
├── server.js          ← Express + Socket.IO backend
├── package.json
├── .env               ← your API key goes here (create from .env.example)
├── .env.example
└── public/
    ├── scanner.html   ← EMS webcam interface  →  http://localhost:3000/scanner.html
    └── hospital.html  ← Hospital dashboard    →  http://localhost:3000/hospital.html
```

## Demo tips

- Open hospital.html on a second monitor or second device for the best demo effect
- Point the scanner at a phone screen showing a vitals monitor image from Google Images
- Scan interval defaults to 8 seconds — you can drop it to 3s for a faster demo
- The scanner auto-pushes every scan to the hospital dashboard without needing to click Transmit

## Troubleshooting

**Camera error in browser:**  
Must be opened via `http://localhost:3000` — not as a local file (`file://`). Make sure `npm run dev` is running first.

**API key not working:**  
Check console.anthropic.com — new accounts may need a small credit top-up ($5 covers weeks of use).

**Port already in use:**  
Change `PORT=3001` in your `.env` file and use `http://localhost:3001`.
>>>>>>> b6bb866 (Pulse Scanner And Hospital Screen with API Vision)
