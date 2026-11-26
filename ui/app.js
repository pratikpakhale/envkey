const list = document.getElementById('list');
const detail = document.getElementById('detail');
const search = document.getElementById('search');
const count = document.getElementById('count');

let paths = [];
let groups = {};
let selected = null;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

const secretUrl = (name, path) => `/api/${name}?path=${encodeURIComponent(path)}`;
const folderOf = (path) => path.split('/').slice(0, -1).join('/');
const nameOf = (path) => path.split('/').pop();

function renderList() {
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = paths.filter((path) => words.every((word) => path.toLowerCase().includes(word)));
  count.textContent = shown.length === paths.length ? `${paths.length} secrets` : `${shown.length} of ${paths.length}`;

  const folders = Map.groupBy(shown, folderOf);
  list.replaceChildren(
    ...[...folders].map(([folder, members]) =>
      el(
        'details',
        { open: true },
        el('summary', {}, folder || '(top level)', el('span', {}, String(members.length))),
        ...members.map((path) => {
          const group = groups[path];
          const row = el(
            'button',
            { type: 'button', title: group ? `${path}: same value as the other =${group} entries` : path, onclick: () => showSecret(path) },
            el('span', { className: 'name' }, nameOf(path)),
            group ? el('span', { className: 'group' }, `=${group}`) : null,
          );
          if (path === selected) row.setAttribute('aria-current', 'true');
          return row;
        }),
      ),
    ),
  );
  if (!shown.length) list.append(el('p', { className: 'empty none' }, 'Nothing matches.'));
}

async function refresh() {
  ({ paths, groups } = await api('GET', '/api/secrets'));
  renderList();
}

function statusLine() {
  const line = el('p', { className: 'status' });
  line.say = (text, isError = false) => {
    line.textContent = text;
    line.classList.toggle('error', isError);
  };
  line.run = async (work) => {
    try {
      await work();
    } catch (error) {
      line.say(error.message, true);
    }
  };
  return line;
}

async function showSecret(path) {
  selected = path;
  renderList();
  const status = statusLine();
  const meta = el('dl');
  const related = el('div');
  const valueBox = el('pre', {}, '••••••••••••');
  let revealed = false;

  const fetchValue = async () => (await api('GET', secretUrl('value', path))).value;

  const reveal = el('button', {
    type: 'button',
    onclick: () =>
      status.run(async () => {
        revealed = !revealed;
        valueBox.textContent = revealed ? await fetchValue() : '••••••••••••';
        reveal.textContent = revealed ? 'Hide' : 'Reveal';
      }),
  }, 'Reveal');

  const copy = el('button', {
    type: 'button',
    className: 'primary',
    onclick: () =>
      status.run(async () => {
        await navigator.clipboard.writeText(await fetchValue());
        status.say('Copied to the clipboard.');
      }),
  }, 'Copy value');

  const edit = el('button', { type: 'button', onclick: () => status.run(async () => showForm(path, await fetchValue())) }, 'Edit');

  const remove = el('button', {
    type: 'button',
    className: 'danger',
    onclick: () =>
      status.run(async () => {
        if (!confirm(`Delete ${path}?`)) return;
        await api('DELETE', secretUrl('secrets', path));
        selected = null;
        await refresh();
        showEmpty(`Deleted ${path}.`);
      }),
  }, 'Delete');

  detail.replaceChildren(
    el('h2', {}, nameOf(path)),
    el('p', { className: 'folder' }, folderOf(path)),
    meta,
    valueBox,
    el('div', { className: 'actions' }, copy, reveal, edit, remove),
    status,
    related,
  );

  await status.run(async () => {
    const info = await api('GET', secretUrl('info', path));
    if (selected !== path) return;
    const rows = [
      ['Length', `${info.length} characters`],
      ['Starts and ends', info.shape],
      ['Fingerprint', info.fingerprint],
      ['Last changed', info.changed && new Date(info.changed).toLocaleString()],
    ];
    meta.replaceChildren(...rows.filter(([, value]) => value).flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, value)]));
    related.replaceChildren(
      relatedList('Same value', info.sameValue, 'No other secret holds this value.'),
      relatedList('Same name, different value', info.sameNameDifferentValue, null),
    );
  });
}

function relatedList(title, members, whenEmpty) {
  if (!members.length && !whenEmpty) return '';
  return el(
    'section',
    { className: 'related' },
    el('h3', {}, members.length ? `${title} (${members.length})` : title),
    members.length
      ? el('ul', {}, ...members.map((member) => el('li', {}, el('button', { type: 'button', className: 'link', onclick: () => showSecret(member) }, member))))
      : el('p', { className: 'empty' }, whenEmpty),
  );
}

function showForm(path = '', value = '') {
  const editing = Boolean(path);
  const status = statusLine();
  const pathInput = el('input', { id: 'path', value: path || (selected ? `${folderOf(selected)}/` : ''), readOnly: editing, spellcheck: false, autocomplete: 'off' });
  const valueInput = el('textarea', { id: 'value', value, spellcheck: false });

  const save = async (generate) => {
    const target = pathInput.value.trim();
    if (generate) await api('POST', '/api/generate', { path: target });
    else await api('PUT', '/api/secrets', { path: target, value: valueInput.value });
    await refresh();
    await showSecret(target);
  };

  detail.replaceChildren(
    el('h2', {}, editing ? `Edit ${nameOf(path)}` : 'New secret'),
    el('p', { className: 'folder' }, editing ? folderOf(path) : 'Paths read scope/project-or-host/environment/NAME'),
    el('label', { htmlFor: 'path' }, 'Path'),
    pathInput,
    el('label', { htmlFor: 'value' }, 'Value'),
    valueInput,
    el(
      'div',
      { className: 'actions' },
      el('button', { type: 'button', className: 'primary', onclick: () => status.run(() => save(false)) }, 'Save'),
      editing ? null : el('button', { type: 'button', onclick: () => status.run(() => save(true)) }, 'Generate a random value'),
      el('button', { type: 'button', onclick: () => (editing ? showSecret(path) : showEmpty()) }, 'Cancel'),
    ),
    status,
  );
  (editing ? valueInput : pathInput).focus();
}

function showEmpty(message = 'Pick a secret on the left, or add a new one.') {
  detail.replaceChildren(el('p', { className: 'empty' }, message));
}

search.addEventListener('input', renderList);
document.getElementById('new').addEventListener('click', () => showForm());

showEmpty();
refresh().catch((error) => showEmpty(error.message));
