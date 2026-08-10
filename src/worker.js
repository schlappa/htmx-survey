// Multi-user form builder on Cloudflare Workers + D1.
//
//   /                    → login, or the form list when signed in
//   /forms               → the signed-in user's forms
//   /forms/new           → create a form
//   /forms/:id           → edit: sections, questions, settings
//   /forms/:id/results   → summary + raw responses (owner only)
//   /forms/:id/export    → .xlsx download (owner only)
//   /f/:slug             → the public form; POST submits it
//
// Forms, sections and questions all live in D1: nothing is read from disk.
import {
  hashPassword, verifyPassword, createSession, sessionCookie, clearCookie,
  currentUser, destroySession,
} from './auth.js';
import {
  esc, page, renderForm, renderSummary, renderResponses, scaleValues,
} from './render.js';
import { buildXlsx } from './xlsx.js';

const HTML = 'text/html; charset=utf-8';
const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'Content-Type': HTML, ...headers } });
const redirect = (location, headers = {}) =>
  new Response(null, { status: 303, headers: { Location: location, ...headers } });

const DEFAULT_SCALE = {
  5: 'Muy bueno', 4: 'Bueno', 3: 'Regular', 2: 'Malo', 1: 'Muy malo',
};

const slug = () => [...crypto.getRandomValues(new Uint8Array(9))]
  .map((b) => 'abcdefghijkmnopqrstuvwxyz23456789'[b % 33]).join('');

// --- data access ------------------------------------------------------------

// A form plus its sections, each with its questions, in display order.
async function loadForm(env, where, value) {
  const form = await env.DB.prepare(
    `SELECT * FROM forms WHERE ${where} = ?`).bind(value).first();
  if (!form) return null;
  const { results: sections } = await env.DB.prepare(
    `SELECT * FROM sections WHERE form_id = ? ORDER BY position, id`)
    .bind(form.id).all();
  const { results: questions } = await env.DB.prepare(
    `SELECT q.* FROM questions q JOIN sections s ON s.id = q.section_id
      WHERE s.form_id = ? ORDER BY q.position, q.id`).bind(form.id).all();
  for (const s of sections) s.questions = questions.filter((q) => q.section_id === s.id);
  return { form, sections };
}

// Responses with their answers attached, newest first.
async function loadResponses(env, formId) {
  const { results: responses } = await env.DB.prepare(
    `SELECT * FROM responses WHERE form_id = ? ORDER BY id DESC`).bind(formId).all();
  if (!responses.length) return [];
  const { results: answers } = await env.DB.prepare(
    `SELECT a.* FROM answers a JOIN responses r ON r.id = a.response_id
      WHERE r.form_id = ?`).bind(formId).all();
  for (const r of responses) r.answers = answers.filter((a) => a.response_id === r.id);
  return responses;
}

// Ownership check. Admins can reach any form; everyone else only their own.
async function ownedForm(env, user, id) {
  const loaded = await loadForm(env, 'id', id);
  if (!loaded) return null;
  if (loaded.form.owner_id !== user.id && !user.isAdmin) {
    console.warn(`[authz] user ${user.id} tried to reach form ${id} owned by ${loaded.form.owner_id}`);
    return null;
  }
  return loaded;
}

// --- pages ------------------------------------------------------------------

const loginPage = (error) => page('Entrar', `
<h1>Entrar</h1>
${error ? `<p><strong>${esc(error)}</strong></p>` : ''}
<form method="post" action="/login">
  <p><label>Correo <input type="email" name="email" required autofocus></label></p>
  <p><label>Contraseña <input type="password" name="password" required></label></p>
  <p><button type="submit">Entrar</button></p>
</form>`);

function formsPage(user, forms, origin) {
  const rows = forms.length ? forms.map((f) => `<tr>
    <td><a href="/forms/${f.id}">${esc(f.title)}</a></td>
    <td>${f.is_open ? 'abierta' : 'cerrada'}</td>
    <td>${f.response_count}</td>
    <td><a href="${origin}/f/${esc(f.slug)}">${origin}/f/${esc(f.slug)}</a></td>
    <td><a href="/forms/${f.id}/results">Resultados</a></td>
  </tr>`).join('') : `<tr><td colspan="5">Todavía no hay formularios.</td></tr>`;

  return page('Mis formularios', `
<h1>Mis formularios</h1>
<table>
<tr><th>Título</th><th>Estado</th><th>Respuestas</th><th>Enlace público</th><th></th></tr>
${rows}
</table>
<h2>Nuevo formulario</h2>
<form method="post" action="/forms/new">
  <p><label>Título <input name="title" required size="60"></label></p>
  <p><button type="submit">Crear</button></p>
</form>`, user);
}

function editPage(user, form, sections, origin) {
  const sectionBlocks = sections.map((s, i) => `
<fieldset>
  <legend>${i + 1}. ${esc(s.title)} (${s.kind === 'matrix' ? 'escala' : 'texto libre'})</legend>
  ${s.kind === 'matrix' ? `<ol>${s.questions.map((q) => `<li>${esc(q.text)}
      <form method="post" action="/questions/${q.id}/delete" style="display:inline">
        <button type="submit">Eliminar</button></form></li>`).join('')}</ol>
  <form method="post" action="/sections/${s.id}/questions">
    <input name="text" required size="60" placeholder="Nueva pregunta">
    <button type="submit">Añadir pregunta</button>
  </form>` : '<p>Una casilla de texto libre.</p>'}
  <form method="post" action="/sections/${s.id}/delete">
    <button type="submit">Eliminar sección</button>
  </form>
</fieldset>`).join('');

  return page(`Editar: ${form.title}`, `
<h1>${esc(form.title)}</h1>
<p>Enlace público: <a href="${origin}/f/${esc(form.slug)}">${origin}/f/${esc(form.slug)}</a>
   | <a href="/forms/${form.id}/results">Resultados</a></p>

<h2>Encabezado</h2>
<form method="post" action="/forms/${form.id}">
  <p><label>Título<br><input name="title" value="${esc(form.title)}" required size="70"></label></p>
  <p><label>Subtítulo (una línea por renglón)<br>
     <textarea name="subtitle" rows="3" cols="70">${esc(form.subtitle)}</textarea></label></p>
  <p><label>Objetivo<br>
     <textarea name="objective" rows="4" cols="70">${esc(form.objective)}</textarea></label></p>
  <p><label>Instrucciones<br>
     <textarea name="instructions" rows="4" cols="70">${esc(form.instructions)}</textarea></label></p>
  <p><label><input type="checkbox" name="scale_desc" ${form.scale_desc ? 'checked' : ''}>
     Mostrar la escala de 5 a 1</label></p>
  <p><label><input type="checkbox" name="require_comment" ${form.require_comment ? 'checked' : ''}>
     Exigir comentario si se califica con el valor más bajo</label></p>
  <p><label><input type="checkbox" name="track_metadata" ${form.track_metadata ? 'checked' : ''}>
     Registrar IP y ubicación (desactivado = anónima)</label></p>
  <p><label><input type="checkbox" name="is_open" ${form.is_open ? 'checked' : ''}>
     Abierta a respuestas</label></p>
  <p><button type="submit">Guardar</button></p>
</form>

<h2>Secciones</h2>
${sectionBlocks || '<p>Todavía no hay secciones.</p>'}

<form method="post" action="/forms/${form.id}/sections">
  <p><input name="title" required size="60" placeholder="Título de la sección">
  <select name="kind">
    <option value="matrix">Escala (matriz)</option>
    <option value="text">Texto libre</option>
  </select>
  <button type="submit">Añadir sección</button></p>
</form>`, user);
}

// --- submission -------------------------------------------------------------

function collect(formData, sections) {
  const ratings = [], texts = [];
  for (const s of sections) {
    if (s.kind === 'text') {
      const value = (formData.get(`s${s.id}`) || '').trim();
      if (value) texts.push({ section_id: s.id, text: value });
      continue;
    }
    for (const q of s.questions) {
      const raw = formData.get(`q${q.id}`);
      if (raw) ratings.push({ section_id: s.id, question_id: q.id, rating: Number(raw) });
    }
  }
  return { ratings, texts };
}

function validate(form, sections, { ratings, texts }) {
  for (const s of sections) {
    if (!s.required) continue;
    if (s.kind === 'text') {
      if (!texts.some((t) => t.section_id === s.id))
        return `La sección "${s.title}" es obligatoria.`;
    } else if (s.questions.some((q) => !ratings.some((r) => r.question_id === q.id))) {
      return `Falta responder alguna pregunta de "${s.title}".`;
    }
  }
  // The original rule, generalised: the lowest point on the scale demands a comment.
  if (form.require_comment) {
    const lowest = Math.min(...scaleValues(form));
    const hasLowest = ratings.some((r) => r.rating === lowest);
    const hasText = texts.some((t) => t.text);
    const textSections = sections.filter((s) => s.kind === 'text');
    if (hasLowest && textSections.length && !hasText)
      return `Calificó con ${lowest}: por favor explique el motivo en los comentarios.`;
  }
  return null;
}

async function saveResponse(request, env, form, collected, simulated = false) {
  const cf = request.cf || {};
  const track = !!form.track_metadata;
  const meta = track ? {
    ip: request.headers.get('CF-Connecting-IP') || null,
    latitude: cf.latitude != null ? Number(cf.latitude) : null,
    longitude: cf.longitude != null ? Number(cf.longitude) : null,
    location: [cf.city, cf.region, cf.country].filter(Boolean).join(', ') || null,
    ua: request.headers.get('User-Agent') || null,
  } : { ip: null, latitude: null, longitude: null, location: null, ua: null };
  if (track && meta.latitude === null)
    console.warn('[geo] no edge coordinates on a tracked form (local dev?)');

  const inserted = await env.DB.prepare(
    `INSERT INTO responses (form_id, submitted_at, ip, latitude, longitude,
       location, user_agent, simulated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`)
    .bind(form.id, new Date().toISOString(), meta.ip, meta.latitude, meta.longitude,
      meta.location, meta.ua, simulated ? 1 : 0).first();

  const stmt = env.DB.prepare(
    `INSERT INTO answers (response_id, question_id, section_id, rating, text)
     VALUES (?, ?, ?, ?, ?)`);
  const batch = [
    ...collected.ratings.map((r) =>
      stmt.bind(inserted.id, r.question_id, r.section_id, r.rating, null)),
    ...collected.texts.map((t) =>
      stmt.bind(inserted.id, null, t.section_id, null, t.text)),
  ];
  if (batch.length) await env.DB.batch(batch);
  return inserted.id;
}

// --- router -----------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, origin } = url;
    const method = request.method;
    const body = method === 'POST'
      ? new URLSearchParams(await request.text()) : new URLSearchParams();
    const user = await currentUser(request, env);

    const requireUser = () => user || redirect('/');
    const seg = pathname.split('/').filter(Boolean);

    // --- public form ---------------------------------------------------------
    if (seg[0] === 'f' && seg[1]) {
      const loaded = await loadForm(env, 'slug', seg[1]);
      if (!loaded) return html(page('No encontrado', '<p>Formulario no encontrado.</p>'), 404);
      const { form, sections } = loaded;

      if (method === 'GET') {
        if (!form.is_open)
          return html(page(form.title, `<h1>${esc(form.title)}</h1><p>Esta encuesta está cerrada.</p>`));
        return html(page(form.title, renderForm(form, sections)));
      }
      if (method === 'POST') {
        if (!form.is_open) return html(page(form.title, '<p>Esta encuesta está cerrada.</p>'), 403);
        const collected = collect(body, sections);
        const error = validate(form, sections, collected);
        if (error) return html(page(form.title, renderForm(form, sections, { error })), 422);
        await saveResponse(request, env, form, collected);
        return html(page('Gracias', '<h1>Gracias</h1><p>Su respuesta fue registrada.</p>'));
      }
    }

    // --- auth ---------------------------------------------------------------
    if (pathname === '/' && method === 'GET')
      return user ? redirect('/forms') : html(loginPage());

    if (pathname === '/login' && method === 'POST') {
      const email = (body.get('email') || '').trim().toLowerCase();
      const row = await env.DB.prepare(
        `SELECT id, password_hash FROM users WHERE email = ?`).bind(email).first();
      // Same message either way, so the page cannot be used to enumerate accounts.
      if (!row || !await verifyPassword(body.get('password') || '', row.password_hash)) {
        console.warn(`[auth] failed login for ${email}`);
        return html(loginPage('Correo o contraseña incorrectos.'), 401);
      }
      const { token, expires } = await createSession(env, row.id);
      return redirect('/forms', { 'Set-Cookie': sessionCookie(token, expires) });
    }

    if (pathname === '/logout' && method === 'POST') {
      await destroySession(request, env);
      return redirect('/', { 'Set-Cookie': clearCookie() });
    }

    // --- everything below needs a session ------------------------------------
    if (!user) return requireUser();

    if (pathname === '/forms' && method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT f.*, (SELECT COUNT(*) FROM responses r WHERE r.form_id = f.id)
                       AS response_count
           FROM forms f WHERE ? OR f.owner_id = ? ORDER BY f.id DESC`)
        .bind(user.isAdmin ? 1 : 0, user.id).all();
      return html(formsPage(user, results, origin));
    }

    if (pathname === '/forms/new' && method === 'POST') {
      const title = (body.get('title') || '').trim();
      if (!title) return html(page('Error', '<p>El título es obligatorio.</p>'), 422);
      const created = await env.DB.prepare(
        `INSERT INTO forms (owner_id, slug, title, subtitle, objective, instructions,
           scale, created_at) VALUES (?, ?, ?, '', '', '', ?, ?) RETURNING id`)
        .bind(user.id, slug(), title, JSON.stringify(DEFAULT_SCALE),
          new Date().toISOString()).first();
      return redirect(`/forms/${created.id}`);
    }

    if (seg[0] === 'forms' && seg[1]) {
      const id = Number(seg[1]);
      const loaded = await ownedForm(env, user, id);
      if (!loaded) return html(page('No encontrado', '<p>No encontrado.</p>'), 404);
      const { form, sections } = loaded;

      if (seg.length === 2 && method === 'GET')
        return html(editPage(user, form, sections, origin));

      if (seg.length === 2 && method === 'POST') {
        await env.DB.prepare(
          `UPDATE forms SET title = ?, subtitle = ?, objective = ?, instructions = ?,
             scale_desc = ?, require_comment = ?, track_metadata = ?, is_open = ?
           WHERE id = ?`)
          .bind((body.get('title') || '').trim() || form.title,
            body.get('subtitle') || '', body.get('objective') || '',
            body.get('instructions') || '',
            body.get('scale_desc') ? 1 : 0, body.get('require_comment') ? 1 : 0,
            body.get('track_metadata') ? 1 : 0, body.get('is_open') ? 1 : 0, id).run();
        return redirect(`/forms/${id}`);
      }

      if (seg[2] === 'sections' && method === 'POST') {
        const kind = body.get('kind') === 'text' ? 'text' : 'matrix';
        await env.DB.prepare(
          `INSERT INTO sections (form_id, title, kind, position)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1
                               FROM sections WHERE form_id = ?))`)
          .bind(id, (body.get('title') || '').trim() || 'Sección', kind, id).run();
        return redirect(`/forms/${id}`);
      }

      if (seg[2] === 'results' && method === 'GET') {
        const responses = await loadResponses(env, id);
        return html(page(`Resultados: ${form.title}`, `
<h1>Resultados: ${esc(form.title)}</h1>
<p><a href="/forms/${id}">Editar</a> |
   <a href="/forms/${id}/export">Descargar Excel</a></p>
<h2>Resumen</h2>
${renderSummary(form, sections, responses)}
<h2>Respuestas</h2>
${renderResponses(form, sections, responses)}`, user));
      }

      if (seg[2] === 'export' && method === 'GET') {
        const responses = await loadResponses(env, id);
        const questions = sections.flatMap((s) => s.questions);
        const textSections = sections.filter((s) => s.kind === 'text');
        const header = ['#', 'Fecha',
          ...questions.map((q) => q.text),
          ...textSections.map((s) => s.title),
          ...(form.track_metadata ? ['IP', 'Latitud', 'Longitud', 'Ubicación', 'User agent'] : []),
          'Origen'];
        const rows = responses.map((r) => [
          r.id, r.submitted_at,
          ...questions.map((q) => r.answers.find((a) => a.question_id === q.id)?.rating ?? ''),
          ...textSections.map((s) =>
            r.answers.find((a) => a.section_id === s.id && !a.question_id)?.text ?? ''),
          ...(form.track_metadata
            ? [r.ip ?? '', r.latitude ?? '', r.longitude ?? '', r.location ?? '', r.user_agent ?? '']
            : []),
          r.simulated ? 'simulada' : 'real',
        ]);
        const file = buildXlsx([header, ...rows], form.title);
        const name = (form.title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40) || 'respuestas');
        return new Response(file, {
          headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${name}.xlsx"`,
          },
        });
      }
    }

    // Section and question edits verify ownership through the parent form.
    if (seg[0] === 'sections' && seg[1] && method === 'POST') {
      const section = await env.DB.prepare(
        `SELECT s.*, f.owner_id FROM sections s JOIN forms f ON f.id = s.form_id
          WHERE s.id = ?`).bind(Number(seg[1])).first();
      if (!section || (section.owner_id !== user.id && !user.isAdmin))
        return html(page('No encontrado', '<p>No encontrado.</p>'), 404);

      if (seg[2] === 'questions') {
        await env.DB.prepare(
          `INSERT INTO questions (section_id, text, position)
           VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1
                            FROM questions WHERE section_id = ?))`)
          .bind(section.id, (body.get('text') || '').trim(), section.id).run();
      } else if (seg[2] === 'delete') {
        await env.DB.prepare(`DELETE FROM sections WHERE id = ?`).bind(section.id).run();
      }
      return redirect(`/forms/${section.form_id}`);
    }

    if (seg[0] === 'questions' && seg[1] && seg[2] === 'delete' && method === 'POST') {
      const q = await env.DB.prepare(
        `SELECT q.id, s.form_id, f.owner_id FROM questions q
           JOIN sections s ON s.id = q.section_id
           JOIN forms f ON f.id = s.form_id WHERE q.id = ?`).bind(Number(seg[1])).first();
      if (!q || (q.owner_id !== user.id && !user.isAdmin))
        return html(page('No encontrado', '<p>No encontrado.</p>'), 404);
      await env.DB.prepare(`DELETE FROM questions WHERE id = ?`).bind(q.id).run();
      return redirect(`/forms/${q.form_id}`);
    }

    return html(page('No encontrado', '<p>No encontrado.</p>'), 404);
  },
};

// Creates the first account. Run with:
//   npx wrangler d1 execute htmx-survey --remote --command="..."
// is awkward for hashing, so this is exposed as a scheduled-free helper instead:
export { hashPassword };
