// Original zero-dependency Node server, kept for local use: npm run node
// The deployed version is the Cloudflare Worker in src/worker.js.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
// IP geolocation sends the IP to a third party (ipapi.co). Set SURVEY_GEO=0 to stop.
const GEO = process.env.SURVEY_GEO !== '0';

const db = new DatabaseSync(path.join(ROOT, 'survey.db'));
db.exec(`CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submitted_at TEXT NOT NULL,
  answers TEXT NOT NULL,
  comments TEXT,
  ip TEXT,
  mac TEXT,
  location TEXT,
  user_agent TEXT
)`);
// Self-upgrading schema so an existing survey.db keeps working.
const columns = () => db.prepare(`PRAGMA table_info(responses)`).all().map((c) => c.name);
if (!columns().includes('public_ip'))
  db.exec(`ALTER TABLE responses ADD COLUMN public_ip TEXT`);
if (!columns().includes('simulated'))
  db.exec(`ALTER TABLE responses ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0`);
if (!columns().includes('latitude')) {
  db.exec(`ALTER TABLE responses ADD COLUMN latitude REAL`);
  db.exec(`ALTER TABLE responses ADD COLUMN longitude REAL`);
}

// Loopback and RFC1918 addresses identify a machine on this network, not on the
// internet: they have no geolocation, and MAC resolution takes a different path.
const isPrivateIp = (ip) => !ip || ip === '::1' || ip === '127.0.0.1' ||
  /^10\./.test(ip) || /^192\.168\./.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^fe80:/i.test(ip);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const loadSurvey = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'questions.json'), 'utf8'));

function renderQuestions(survey) {
  const scale = Object.keys(survey.scale).sort();
  return survey.questions.map((q, i) => {
    const radios = scale.map((v) =>
      `<label><input type="radio" name="${esc(q.id)}" value="${esc(v)}" required> ` +
      `${esc(v)} &ndash; ${esc(survey.scale[v])}</label>`).join('\n      ');
    return `<fieldset>
      <legend>${i + 1}. ${esc(q.text)}</legend>
      ${radios}
    </fieldset>`;
  }).join('\n');
}

function loadResponses() {
  return db.prepare(`SELECT * FROM responses ORDER BY id DESC`).all()
    .map((r) => ({ ...r, answers: JSON.parse(r.answers) }));
}

function renderSummary(survey, rows) {
  if (!rows.length) return '<p>No responses yet.</p>';
  const head = `<tr><th>Question</th><th>Responses</th><th>Average</th>` +
    Object.keys(survey.scale).sort().map((v) => `<th>${esc(v)}</th>`).join('') + `</tr>`;
  const body = survey.questions.map((q, i) => {
    const vals = rows.map((r) => r.answers[q.id]).filter((v) => typeof v === 'number');
    const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : '&ndash;';
    const counts = Object.keys(survey.scale).sort()
      .map((v) => `<td>${vals.filter((x) => x === Number(v)).length}</td>`).join('');
    return `<tr><td>${i + 1}. ${esc(q.text)}</td><td>${vals.length}</td><td>${avg}</td>${counts}</tr>`;
  }).join('');
  return `<p>${rows.length} response(s).</p><table>${head}${body}</table>`;
}

function renderRows(survey, rows) {
  if (!rows.length) return '<p>No responses yet.</p>';
  const head = `<tr><th>#</th><th>Submitted</th>` +
    survey.questions.map((q, i) => `<th title="${esc(q.text)}">Q${i + 1}</th>`).join('') +
    `<th>Comments</th><th>Source</th><th>IP</th><th>Public IP</th><th>MAC</th>` +
    `<th>Latitude</th><th>Longitude</th><th>User agent</th></tr>`;
  const body = rows.map((r) => {
    const answers = survey.questions
      .map((q) => `<td>${r.answers[q.id] ?? '&ndash;'}</td>`).join('');
    const cell = (v) => `<td>${v ? esc(v) : '&ndash;'}</td>`;
    const hasCoords = typeof r.latitude === 'number' && typeof r.longitude === 'number';
    // Title carries the city name, which is what the coordinates actually resolve to.
    const coord = (v) => hasCoords
      ? `<td title="${esc(r.location || '')}"><a target="_blank" rel="noreferrer"` +
        ` href="https://www.openstreetmap.org/?mlat=${r.latitude}&amp;mlon=${r.longitude}` +
        `#map=11/${r.latitude}/${r.longitude}">${v}</a></td>`
      : `<td>&ndash;</td>`;
    return `<tr><td>${r.id}</td><td>${esc(r.submitted_at)}</td>${answers}` +
      cell(r.comments) + `<td>${r.simulated ? 'simulated' : 'real'}</td>` +
      cell(r.ip) + cell(r.public_ip) + cell(r.mac) +
      coord(r.latitude) + coord(r.longitude) + cell(r.user_agent) + `</tr>`;
  }).join('');
  return `<table>${head}${body}</table>`;
}

// The MAC address is only knowable when the client shares an L2 segment with this
// server: it is read from the local ARP cache. Over the internet it is always null.
function lookupMac(ip) {
  return new Promise((resolve) => {
    // The respondent is this very machine, so its own NIC address is the answer.
    if (!ip || ip === '127.0.0.1' || ip === '::1') {
      const nic = Object.values(os.networkInterfaces()).flat()
        .find((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00');
      if (!nic) console.warn('[mac] no external NIC found for loopback client');
      return resolve(nic ? nic.mac : null);
    }
    const args = process.platform === 'win32' ? ['-a', ip] : ['-n', ip];
    execFile('arp', args, { timeout: 2000 }, (err, stdout) => {
      if (err) { console.warn(`[mac] arp failed for ${ip}: ${err.message}`); return resolve(null); }
      const m = String(stdout).match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
      if (!m) console.warn(`[mac] no arp entry for ${ip} (client is not on this LAN)`);
      resolve(m ? m[0] : null);
    });
  });
}

// Returns { latitude, longitude, location, publicIp }. A private client IP has no
// geolocation of its own, so we ask about this server's egress instead — the same
// network the respondent is sitting on, which is accurate to the city either way.
// The coordinates are that city's centroid, not the respondent's actual position.
function lookupLocation(ip) {
  return new Promise((resolve) => {
    const done = (o = {}) => resolve({
      latitude: null, longitude: null, location: null, publicIp: null, ...o });
    if (!GEO) { console.warn('[geo] disabled by SURVEY_GEO=0'); return done(); }
    const url = isPrivateIp(ip) ? 'https://ipapi.co/json/' : `https://ipapi.co/${ip}/json/`;
    const req = https.get(url, { headers: { 'User-Agent': 'htmx-survey' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.error) { console.warn(`[geo] ${url} -> ${j.reason}`); return done(); }
          if (typeof j.latitude !== 'number' || typeof j.longitude !== 'number')
            console.warn(`[geo] no coordinates in response for ${ip}`);
          done({
            latitude: typeof j.latitude === 'number' ? j.latitude : null,
            longitude: typeof j.longitude === 'number' ? j.longitude : null,
            location: [j.city, j.region, j.country_name].filter(Boolean).join(', ') || null,
            publicIp: j.ip || null,
          });
        } catch (e) { console.warn(`[geo] bad response for ${ip}: ${e.message}`); done(); }
      });
    });
    req.on('error', (e) => { console.warn(`[geo] request failed: ${e.message}`); done(); });
    req.setTimeout(4000, () => { console.warn('[geo] timed out'); req.destroy(); done(); });
  });
}

const send = (res, code, type, body, headers = {}) =>
  res.writeHead(code, { 'Content-Type': type, ...headers }).end(body);

// Shared by real submissions and simulated ones, so the two cannot drift apart.
function validate(survey, answers, comments) {
  for (const q of survey.questions)
    if (!answers[q.id]) return 'Every question must be answered. Please go back and complete the survey.';
  if (Object.values(answers).includes(1) && !comments)
    return 'You rated at least one question 1, so a comment explaining it is required.';
  return null;
}

async function saveResponse(req, answers, comments, simulated) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress.replace(/^::ffff:/, '');
  const [mac, geo] = await Promise.all([lookupMac(ip), lookupLocation(ip)]);

  db.prepare(`INSERT INTO responses
    (submitted_at, answers, comments, ip, public_ip, mac,
     latitude, longitude, location, user_agent, simulated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    new Date().toISOString(), JSON.stringify(answers), comments || null,
    ip, geo.publicIp, mac, geo.latitude, geo.longitude, geo.location,
    req.headers['user-agent'] || null, simulated ? 1 : 0);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))
    return send(res, 200, 'text/html; charset=utf-8',
      fs.readFileSync(path.join(ROOT, 'index.html')));

  if (req.method === 'GET' && url.pathname === '/header') {
    const s = loadSurvey();
    return send(res, 200, 'text/html; charset=utf-8',
      `<h1>${esc(s.title)}</h1><p>${esc(s.intro)}</p>`);
  }

  if (req.method === 'GET' && url.pathname === '/questions')
    return send(res, 200, 'text/html; charset=utf-8', renderQuestions(loadSurvey()));

  // TODO: no authentication yet — these three routes expose every response,
  // including each respondent's IP, MAC and location, to anyone who can reach them.
  if (req.method === 'GET' && url.pathname === '/results')
    return send(res, 200, 'text/html; charset=utf-8',
      fs.readFileSync(path.join(ROOT, 'results.html')));

  if (req.method === 'GET' && url.pathname === '/results/summary')
    return send(res, 200, 'text/html; charset=utf-8',
      renderSummary(loadSurvey(), loadResponses()));

  if (req.method === 'GET' && url.pathname === '/results/rows')
    return send(res, 200, 'text/html; charset=utf-8',
      renderRows(loadSurvey(), loadResponses()));

  if (req.method === 'POST' && url.pathname === '/submit') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const survey = loadSurvey();

    const answers = {};
    for (const q of survey.questions)
      if (form.get(q.id)) answers[q.id] = Number(form.get(q.id));
    const comments = (form.get('comments') || '').trim();

    // Server-side twin of the client rule: a rating of 1 makes comments mandatory.
    const error = validate(survey, answers, comments);
    if (error) return send(res, 200, 'text/html; charset=utf-8',
      `<div id="app"><p>${esc(error)}</p></div>`);

    await saveResponse(req, answers, comments, false);
    return send(res, 200, 'text/html; charset=utf-8',
      `<div id="app"><h1>Thank you</h1><p>Your response has been recorded.</p></div>`);
  }

  // Seeds a canned response so the results page has something to show. Runs through
  // the same validate/save path as a real submit, and is flagged simulated=1.
  if (req.method === 'POST' && url.pathname === '/simulate') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const scenario = new URLSearchParams(raw).get('scenario');
    const survey = loadSurvey();

    const presets = {
      'all-1': { rating: 1, comments: 'cat1' },
      'all-5': { rating: 5, comments: '' },
    };
    const preset = presets[scenario];
    if (!preset) return send(res, 400, 'text/html; charset=utf-8',
      `<span>Unknown scenario ${esc(scenario)}.</span>`);

    const answers = Object.fromEntries(survey.questions.map((q) => [q.id, preset.rating]));
    const error = validate(survey, answers, preset.comments);
    if (error) return send(res, 200, 'text/html; charset=utf-8', `<span>${esc(error)}</span>`);

    await saveResponse(req, answers, preset.comments, true);
    // Tells both result tables to reload rather than waiting for the 30s poll.
    return send(res, 200, 'text/html; charset=utf-8',
      `<span>Simulated a response of all ${preset.rating}s.</span>`,
      { 'HX-Trigger': 'refresh' });
  }

  send(res, 404, 'text/plain', 'Not found');
});

server.listen(PORT, () => console.log(`Survey on http://localhost:${PORT}`));
