// HTML rendering. No CSS by project convention: structure only.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Preserves author line breaks in free-text blocks without allowing markup.
const paragraphs = (text) => String(text || '').split(/\n{2,}/)
  .filter((p) => p.trim())
  .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

export function page(title, body, user) {
  const nav = user
    ? `<p><a href="/forms">My forms</a> | ${esc(user.name)} ` +
      `<form method="post" action="/logout" style="display:inline">` +
      `<button type="submit">Log out</button></form></p><hr>`
    : '';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
</head>
<body>
${nav}${body}
</body>
</html>`;
}

// The scale is stored as {"5":"Muy bueno", …}. Column order follows the form's
// scale_desc flag: the Univalle layout runs 5 → 1, the original survey 1 → 5.
export function scaleValues(form) {
  const keys = Object.keys(JSON.parse(form.scale)).map(Number).sort((a, b) => a - b);
  return form.scale_desc ? keys.reverse() : keys;
}

// --- public form ------------------------------------------------------------

export function renderForm(form, sections, { error } = {}) {
  const scale = JSON.parse(form.scale);
  const values = scaleValues(form);

  const header = `<h1>${esc(form.title)}</h1>` +
    (form.subtitle ? paragraphs(form.subtitle) : '') +
    (form.objective ? paragraphs(form.objective) : '') +
    (form.instructions ? paragraphs(form.instructions) : '');

  const blocks = sections.map((section, i) => {
    const n = i + 1;
    const label = `${n}. ${esc(section.title)}${section.required ? ' *' : ''}`;

    if (section.kind === 'text') {
      return `<section>
  <h2>${label}</h2>
  <textarea name="s${section.id}" rows="5" cols="60"
    ${section.required ? 'required' : ''}></textarea>
</section>`;
    }

    // Matrix: scale labels as column headers once, one row per question.
    const head = `<tr><th scope="col">${esc(section.title)}</th>` +
      values.map((v) => `<th scope="col">${v}<br><small>${esc(scale[v])}</small></th>`)
        .join('') + `</tr>`;
    const rows = section.questions.map((q, qi) => {
      const cells = values.map((v) =>
        `<td><input type="radio" name="q${q.id}" value="${v}"` +
        `${section.required ? ' required' : ''}` +
        ` aria-label="${esc(q.text)} — ${v} ${esc(scale[v])}"></td>`).join('');
      return `<tr><th scope="row">${qi + 1}. ${esc(q.text)}</th>${cells}</tr>`;
    }).join('');

    return `<section>
  <h2>${label}</h2>
  <table>${head}${rows}</table>
</section>`;
  }).join('\n');

  const notice = error ? `<p><strong>${esc(error)}</strong></p>` : '';
  const lowest = Math.min(...values);
  const rule = form.require_comment
    ? `<p><small>Si califica alguna pregunta con ${lowest}, el comentario es obligatorio.</small></p>`
    : '';

  return `${header}
${notice}
<form method="post" action="/f/${esc(form.slug)}">
${blocks}
${rule}
<p><button type="submit">Enviar</button></p>
</form>`;
}

// --- results ----------------------------------------------------------------

export function renderSummary(form, sections, responses) {
  if (!responses.length) return '<p>Sin respuestas todavía.</p>';
  const values = scaleValues(form);
  const out = [`<p>${responses.length} respuesta(s).</p>`];

  for (const section of sections) {
    if (section.kind === 'text') {
      const texts = responses
        .map((r) => r.answers.find((a) => a.section_id === section.id)?.text)
        .filter(Boolean);
      out.push(`<h3>${esc(section.title)}</h3>` + (texts.length
        ? `<ul>${texts.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
        : '<p>Sin comentarios.</p>'));
      continue;
    }

    const head = `<tr><th>Pregunta</th><th>N</th><th>Promedio</th>` +
      values.map((v) => `<th>${v}</th>`).join('') + `</tr>`;
    const rows = section.questions.map((q, i) => {
      const ratings = responses
        .map((r) => r.answers.find((a) => a.question_id === q.id)?.rating)
        .filter((v) => typeof v === 'number');
      const avg = ratings.length
        ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : '&ndash;';
      const counts = values
        .map((v) => `<td>${ratings.filter((x) => x === v).length}</td>`).join('');
      return `<tr><th scope="row">${i + 1}. ${esc(q.text)}</th>` +
        `<td>${ratings.length}</td><td>${avg}</td>${counts}</tr>`;
    }).join('');
    out.push(`<h3>${esc(section.title)}</h3><table>${head}${rows}</table>`);
  }
  return out.join('\n');
}

export function renderResponses(form, sections, responses) {
  if (!responses.length) return '<p>Sin respuestas todavía.</p>';
  const questions = sections.flatMap((s) => s.questions.map((q) => ({ ...q, section: s })));
  const textSections = sections.filter((s) => s.kind === 'text');

  const head = `<tr><th>#</th><th>Fecha</th>` +
    questions.map((q, i) => `<th title="${esc(q.text)}">P${i + 1}</th>`).join('') +
    textSections.map((s) => `<th>${esc(s.title)}</th>`).join('') +
    (form.track_metadata ? `<th>IP</th><th>Lat</th><th>Lon</th><th>User agent</th>` : '') +
    `<th>Origen</th></tr>`;

  const body = responses.map((r) => {
    const cell = (v) => `<td>${v ? esc(v) : '&ndash;'}</td>`;
    const ratings = questions.map((q) =>
      `<td>${r.answers.find((a) => a.question_id === q.id)?.rating ?? '&ndash;'}</td>`).join('');
    const texts = textSections.map((s) =>
      cell(r.answers.find((a) => a.section_id === s.id && !a.question_id)?.text)).join('');
    const meta = form.track_metadata
      ? cell(r.ip) + cell(r.latitude) + cell(r.longitude) + cell(r.user_agent) : '';
    return `<tr><td>${r.id}</td><td>${esc(r.submitted_at)}</td>${ratings}${texts}${meta}` +
      `<td>${r.simulated ? 'simulada' : 'real'}</td></tr>`;
  }).join('');

  return `<table>${head}${body}</table>`;
}
