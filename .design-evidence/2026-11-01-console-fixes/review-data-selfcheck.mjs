import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Standalone read-only checks. This mocks DOM behavior; it is not browser acceptance.
const root = '/Users/libo/projects/forge';
const source = readFileSync(`${root}/apps/console/public/app.js`, 'utf8');
const fn = name => {
  const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `missing ${name}`);
  return match[0];
};
const method = name => {
  const match = source.match(new RegExp(`^  (?:async )?${name}\\([^)]*\\) \\{[\\s\\S]*?^  \\},?$`, 'm'));
  assert.ok(match, `missing ${name}`);
  return match[0].replace(/,$/, '');
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const tests = [];
const test = (name, check) => tests.push({ name, check });
const el = (value = '') => ({ value, checked: false, disabled: false, hidden: false, isConnected: true, textContent: '' });

function scopeHarness(initial = 'agent', permissions = null) {
  const target = el(), resourceSection = el(), hint = el(), query = el(), manual = el();
  const type = el('resource'), resource = el(initial), retry = el();
  // Simulate native select.value: assigning an absent option clears the selection.
  const select = {
    ...el(), _value: '', _html: '', options: [],
    get value() { return this._value; },
    set value(value) { this._value = this.options.includes(value) ? value : ''; },
    get innerHTML() { return this._html; },
    set innerHTML(value) {
      this._html = value;
      this.options = [...value.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]);
      this._value = this.options[0] ?? '';
    },
  };
  const nodes = {
    '[name=scopeType]': type, '[name=resourceType]': resource, '[name=scopeId]': select,
    '[name=scopeQuery]': query, '[name=scopeManualId]': manual, '[data-scope-hint]': hint,
    '[data-secret-resource]': resourceSection, '[data-secret-target]': target, '[data-scope-retry]': retry,
  };
  const body = { querySelector: selector => nodes[selector] };
  const calls = [], pending = [];
  const api = path => {
    calls.push(path);
    return new Promise((resolve, reject) => pending.push({ path, resolve, reject }));
  };
  const bind = new Function('$', 'canPermission', 'api', 'errorText', `${fn('esc')}\n${fn('secretResourceDirectories')}\n${fn('bindSecretScopePicker')}\nreturn bindSecretScopePicker`)(
    () => body, permission => permissions === null || permissions.includes(permission), api, error => error.message,
  );
  bind();
  return { body, type, resource, select, query, manual, hint, retry, calls, pending };
}

test('scope: an older Agent response cannot replace current MCP options', async () => {
  const h = scopeHarness();
  h.resource.value = 'mcp_server';
  const latest = h.resource.onchange();
  h.pending[1].resolve({ items: [{ id: 'mcp_0000000000000000000000', name: 'MCP B', key: 'erp' }] });
  await latest;
  h.pending[0].resolve({ items: [{ id: 'agt_0000000000000000000000', name: 'Agent A', key: 'agent-a' }] });
  await tick();
  assert.match(h.select.innerHTML, /MCP B/);
  assert.doesNotMatch(h.select.innerHTML, /Agent A/);
});

test('scope: filtering out a selection removes its stale ID hint', async () => {
  const h = scopeHarness('mcp_server');
  h.pending[0].resolve({ items: [{ id: 'mcp_0000000000000000000000', name: 'MCP B', key: 'erp' }] });
  await tick();
  h.select.value = 'mcp_0000000000000000000000';
  h.select.onchange();
  assert.match(h.hint.textContent, /mcp_0000000000000000000000/);
  h.query.value = 'missing';
  h.query.oninput();
  assert.equal(h.select.value, '');
  assert.doesNotMatch(h.hint.textContent, /mcp_0000000000000000000000/);
});

test('scope: apikey.view loads the API App directory', async () => {
  const h = scopeHarness('api_app', ['apikey.view']);
  assert.deepEqual(h.calls, ['/admin/api/apps']);
  h.pending[0].resolve({ items: [] });
  await tick();
  assert.match(h.hint.textContent, /没有可选对象/);
  assert.equal(h.manual.disabled, false);
});

test('scope: denied or failed directory keeps manual fallback and shows a reason', async () => {
  const denied = scopeHarness('api_app', []);
  await tick();
  assert.deepEqual(denied.calls, []);
  assert.match(denied.hint.textContent, /没有读取此目录的权限/);
  assert.equal(denied.manual.disabled, false);
  const failed = scopeHarness('mcp_server');
  failed.pending[0].reject(new Error('temporary failure'));
  await tick();
  assert.match(failed.hint.textContent, /temporary failure/);
  assert.equal(failed.manual.disabled, false);
});

function agentEditorHarness(spec, deferred = false) {
  const details = { open: false };
  const control = value => ({
    ...el(value), listeners: {},
    addEventListener(event, listener) { (this.listeners[event] ??= []).push(listener); },
    fire(event) { for (const listener of this.listeners[event] ?? []) listener(); },
    setCustomValidity(value) { this.customValidity = value; },
    closest() { return details; },
  });
  const raw = control(JSON.stringify(spec));
  const hint = el(), providers = el(), models = el();
  let capabilities = [];
  const directory = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) {
      this._html = value;
      capabilities = [...value.matchAll(/data-capability="([^"]+)" data-key="([^"]+)"/g)].map(match => Object.assign(control(''), { dataset: { capability: match[1], key: match[2] } }));
    },
  };
  const body = {
    querySelector: selector => ({ '[name="spec"]': raw, '#agent-spec-error': hint, '#agent-providers': providers, '#agent-models': models, '[data-agent-capabilities]': directory })[selector],
    querySelectorAll: selector => selector === '[data-spec-path]' ? [] : selector === '[data-capability]' ? capabilities : [],
  };
  const pending = [];
  const api = path => {
    const result = { items: [{ key: 'erp', name: path.includes('/mcp') ? 'ERP MCP' : 'ERP API' }] };
    return deferred ? new Promise(resolve => pending.push(() => resolve(result))) : Promise.resolve(result);
  };
  const bind = new Function('$', 'canPermission', 'api', `${['esc', 'editAgentSpec', 'chooseAgentCapability', 'bindAgentSpecEditor'].map(fn).join('\n')}\nreturn bindAgentSpecEditor`)(
    () => body, permission => ['mcp.view', 'tool.view'].includes(permission), api,
  );
  bind();
  return { raw, hint, pending, capabilities: () => capabilities, spec: () => JSON.parse(raw.value) };
}

for (const kind of ['mcp', 'openapi']) {
  test(`agent editor: ${kind} off/on preserves every matching group, allow and advanced setting`, async () => {
    const original = {
      model: { provider: 'private', model: 'm1' },
      output: { schema: { type: 'object' } },
      toolsets: [{ [kind]: 'erp', allow: ['read'], metadata: 'kept' }, { builtin: ['echo'] }, { [kind]: 'erp', allow: ['list'] }],
    };
    const h = agentEditorHarness(original);
    await tick();
    const checkbox = h.capabilities().find(item => item.dataset.capability === kind);
    assert.equal(checkbox.checked, true);
    for (let pass = 0; pass < 2; pass++) {
      checkbox.checked = false; checkbox.fire('change');
      assert.equal(h.spec().toolsets.filter(group => group[kind] === 'erp').length, 0);
      checkbox.checked = true; checkbox.fire('change');
      assert.deepEqual(h.spec().toolsets.filter(group => group[kind] === 'erp'), original.toolsets.filter(group => group[kind] === 'erp'));
      assert.deepEqual(h.spec().output, original.output);
    }
    // A later advanced edit becomes the new restore snapshot.
    h.raw.value = JSON.stringify({ ...original, toolsets: [{ [kind]: 'erp', allow: ['new-read'] }] });
    h.raw.fire('input');
    checkbox.checked = false; checkbox.fire('change');
    checkbox.checked = true; checkbox.fire('change');
    assert.deepEqual(h.spec().toolsets, [{ [kind]: 'erp', allow: ['new-read'] }]);
    assert.equal(h.raw.customValidity, '');
  });
}

test('agent editor: directories arriving late read the latest advanced JSON', async () => {
  const h = agentEditorHarness({ model: { provider: 'a', model: 'old' }, toolsets: [{ mcp: 'erp', allow: ['old'] }] }, true);
  const edited = { model: { provider: 'b', model: 'new' }, toolsets: [{ openapi: 'erp', allow: ['new'] }], output: { schema: { type: 'string' } } };
  h.raw.value = JSON.stringify(edited);
  h.raw.fire('input');
  for (const resolve of h.pending) resolve();
  await tick();
  assert.deepEqual(h.spec(), edited);
  assert.equal(h.capabilities().find(item => item.dataset.capability === 'mcp').checked, false);
  assert.equal(h.capabilities().find(item => item.dataset.capability === 'openapi').checked, true);
});

async function agentDetail(spec) {
  const opened = [], toasts = [];
  const deps = {
    state: { navigation: 0 }, api: async () => ({ name: 'Spec', key: 'spec', versions: [{ id: 'v1', version: '1.0.0', status: 'draft', spec_json: spec }] }),
    idSeg: value => value, canPermission: () => false, openModal: (...args) => opened.push(args), $: () => null,
    errorText: error => error.message, toast: (...args) => toasts.push(args), app: {},
  };
  // Include normal helper declarations without replacing the mocked API/UI boundaries.
  const helpers = [...source.matchAll(/^(?:async )?function (\w+)\([\s\S]*?^\}/gm)]
    .filter(match => !Object.hasOwn(deps, match[1])).map(match => match[0]).join('\n');
  const actions = new Function(...Object.keys(deps), `${helpers}\nreturn {${method('openAgentDetail')}}`)(...Object.values(deps));
  await actions.openAgentDetail('agent');
  return { opened, toasts };
}

for (const [label, spec] of [
  ['non-array skills', { skills: {} }],
  ['null toolset', { toolsets: [null] }],
  ['object in skills', { skills: [{ toString: null }] }],
  ['object in builtin names', { toolsets: [{ builtin: [{ toString: null }] }] }],
  ['object MCP key', { toolsets: [{ mcp: { toString: null } }] }],
  ['object provider key', { model: { provider: { toString: null }, model: 'm1' } }],
  ['object budget', { limits: { maxSteps: { toString: null } } }],
]) {
  test(`agent detail: ${label} preserves access to raw JSON`, async () => {
    const result = await agentDetail(spec);
    assert.equal(result.opened.length, 1, JSON.stringify(result.toasts));
    assert.equal(result.toasts.length, 0);
    assert.match(result.opened[0][1], /高级：原始配置与版本记录/);
    assert.doesNotMatch(result.opened[0][1], /\[object Object\]/);
  });
}

let failures = 0;
for (const { name, check } of tests) {
  try { await check(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`); }
}
console.log(JSON.stringify({ checks: tests.length, failures, scope: 'source-extracted Node functions with mocked DOM/API; no browser, server or database' }));
process.exitCode = failures ? 1 : 0;
