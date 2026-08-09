// Cloudflare Worker port of the Node survey server.
//
// Differences from server.js, all forced by the platform:
//   - Storage is D1 (SQLite) via env.DB, and every query is async.
//   - questions.json is imported at build time rather than read from disk.
//   - The MAC column is gone: it came from the local ARP cache, which needs an OS
//     and a shared network segment. Neither exists here, and it was always null
//     for any respondent off the LAN.
//   - Geolocation comes free from Cloudflare's edge (request.cf) instead of a
//     third-party HTTP call, so it is faster, private, and has no rate limit.
import survey from '../public/questions.json';

const HTML = 'text/html; charset=utf-8';
const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'Content-Type': HTML, ...headers } });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- rendering (unchanged from the Node version) ----------------------------

function renderQuestions() {
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

function renderSummary(rows) {
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

function renderRows(rows) {
  if (!rows.length) return '<p>No responses yet.</p>';
  const head = `<tr><th>#</th><th>Submitted</th>` +
    survey.questions.map((q, i) => `<th title="${esc(q.text)}">Q${i + 1}</th>`).join('') +
    `<th>Comments</th><th>Source</th><th>IP</th><th>Latitude</th><th>Longitude</th>` +
    `<th>User agent</th></tr>`;
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
      cell(r.ip) + coord(r.latitude) + coord(r.longitude) + cell(r.user_agent) + `</tr>`;
  }).join('');
  return `<table>${head}${body}</table>`;
}

// --- storage ----------------------------------------------------------------

async function loadResponses(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM responses ORDER BY id DESC`).all();
  return results.map((r) => ({ ...r, answers: JSON.parse(r.answers) }));
}

// Shared by real submissions and simulated ones, so the two cannot drift apart.
function validate(answers, comments) {
  for (const q of survey.questions)
    if (!answers[q.id]) return 'Every question must be answered. Please go back and complete the survey.';
  if (Object.values(answers).includes(1) && !comments)
    return 'You rated at least one question 1, so a comment explaining it is required.';
  return null;
}

async function saveResponse(request, env, answers, comments, simulated) {
  // Cloudflare resolves the client IP and its geolocation at the edge. request.cf
  // is absent under `wrangler dev` without --remote, hence the guard.
  const cf = request.cf || {};
  const ip = request.headers.get('CF-Connecting-IP') || null;
  const latitude = cf.latitude != null ? Number(cf.latitude) : null;
  const longitude = cf.longitude != null ? Number(cf.longitude) : null;
  const location = [cf.city, cf.region, cf.country].filter(Boolean).join(', ') || null;
  if (latitude === null) console.warn(`[geo] no edge coordinates for ${ip} (local dev?)`);

  await env.DB.prepare(
    `INSERT INTO responses
       (submitted_at, answers, comments, ip, public_ip, latitude, longitude,
        location, user_agent, simulated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(new Date().toISOString(), JSON.stringify(answers), comments || null,
      ip, ip, latitude, longitude, location,
      request.headers.get('User-Agent') || null, simulated ? 1 : 0)
    .run();
}

// --- auth -------------------------------------------------------------------

// Guards the results routes, which expose every respondent's IP and coordinates.
// Set the password with: npx wrangler secret put RESULTS_PASSWORD
function unauthorized() {
  return new Response('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Survey results", charset="UTF-8"' },
  });
}

function authorized(request, env) {
  // Fail closed: an unset secret locks the page rather than opening it.
  if (!env.RESULTS_PASSWORD) {
    console.warn('[auth] RESULTS_PASSWORD is not set — denying access to /results');
    return false;
  }
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  const [, password] = atob(header.slice(6)).split(':');
  return timingSafeEqual(password || '', env.RESULTS_PASSWORD);
}

// Comparison that does not leak the password's length or content through timing.
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = [enc.encode(a), enc.encode(b)];
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual
    ? crypto.subtle.timingSafeEqual(x, y)
    : x.every((v, i) => v === y[i]);
}

// --- routing ----------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'GET' && pathname === '/header')
      return html(`<h1>${esc(survey.title)}</h1><p>${esc(survey.intro)}</p>`);

    if (method === 'GET' && pathname === '/questions')
      return html(renderQuestions());

    if (pathname === '/results' || pathname.startsWith('/results/')) {
      if (!authorized(request, env)) return unauthorized();

      // Ask for "/results", not "/results.html": the asset server strips the .html
      // extension and would answer the latter with a 307 back to the former.
      if (method === 'GET' && pathname === '/results')
        return env.ASSETS.fetch(new Request(new URL('/results', url), { method: 'GET' }));
      if (method === 'GET' && pathname === '/results/summary')
        return html(renderSummary(await loadResponses(env)));
      if (method === 'GET' && pathname === '/results/rows')
        return html(renderRows(await loadResponses(env)));
    }

    if (method === 'POST' && pathname === '/submit') {
      const form = new URLSearchParams(await request.text());
      const answers = {};
      for (const q of survey.questions)
        if (form.get(q.id)) answers[q.id] = Number(form.get(q.id));
      const comments = (form.get('comments') || '').trim();

      // Server-side twin of the client rule: a rating of 1 makes comments mandatory.
      const error = validate(answers, comments);
      if (error) return html(`<div id="app"><p>${esc(error)}</p></div>`);

      await saveResponse(request, env, answers, comments, false);
      return html(`<div id="app"><h1>Thank you</h1><p>Your response has been recorded.</p></div>`);
    }

    // Seeds a canned response so the results page has something to show. Runs
    // through the same validate/save path as a real submit, flagged simulated=1.
    if (method === 'POST' && pathname === '/simulate') {
      if (!authorized(request, env)) return unauthorized();
      const scenario = new URLSearchParams(await request.text()).get('scenario');
      const presets = {
        'all-1': { rating: 1, comments: 'cat1' },
        'all-5': { rating: 5, comments: '' },
      };
      const preset = presets[scenario];
      if (!preset) return html(`<span>Unknown scenario ${esc(scenario)}.</span>`, 400);

      const answers = Object.fromEntries(survey.questions.map((q) => [q.id, preset.rating]));
      const error = validate(answers, preset.comments);
      if (error) return html(`<span>${esc(error)}</span>`);

      await saveResponse(request, env, answers, preset.comments, true);
      // Tells both result tables to reload rather than waiting for the 30s poll.
      return html(`<span>Simulated a response of all ${preset.rating}s.</span>`,
        200, { 'HX-Trigger': 'refresh' });
    }

    // Everything else (/, /index.html, questions.json) is a static asset.
    return env.ASSETS.fetch(request);
  },
};
