const { test } = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../js/llm.js');

test('LLM request builders: Anthropic browser header, Gemini key header, OpenAI developer role, OpenRouter referer', () => {
  const msg = { system: 'S', messages: [{ role: 'user', content: 'U' }], maxTokens: 100, temperature: 0, json: true };
  const a = llm.buildRequest({ provider: 'anthropic', key: 'k', model: 'claude-haiku-4-5' }, msg);
  assert.equal(a.url, 'https://api.anthropic.com/v1/messages'); assert.equal(a.init.headers['anthropic-dangerous-direct-browser-access'], 'true'); assert.equal(a.init.headers['x-api-key'], 'k');
  const g = llm.buildRequest({ provider: 'gemini', key: 'k', model: 'gemini-2.5-flash' }, msg);
  assert.match(g.url, /models\/gemini-2\.5-flash:generateContent$/); assert.equal(g.init.headers['x-goog-api-key'], 'k'); assert.ok(!g.url.includes('key='));
  assert.equal(JSON.parse(g.init.body).generationConfig.responseMimeType, 'application/json');
  const o = llm.buildRequest({ provider: 'openai', key: 'k', model: 'gpt-5-mini' }, msg);
  const ob = JSON.parse(o.init.body); assert.equal(ob.messages[0].role, 'developer'); assert.deepEqual(ob.response_format, { type: 'json_object' }); assert.equal(o.init.headers.authorization, 'Bearer k');
  const r = llm.buildRequest({ provider: 'compatible', key: 'k', model: 'openai/gpt-5-mini', baseUrl: 'https://openrouter.ai/api/v1' }, msg);
  assert.equal(r.init.headers['HTTP-Referer'], 'https://shaikbasha1437.github.io/askdata-ai/'); assert.equal(r.init.headers['X-Title'], 'AskData AI');
  const ol = llm.buildRequest({ provider: 'compatible', model: 'llama3.2' }, msg);
  assert.equal(ol.url, 'http://localhost:11434/v1/chat/completions'); assert.ok(!ol.init.headers.authorization);
});
test('LLM call parses replies and turns bad keys / network failures into readable errors (mocked fetch)', async () => {
  const reply = (body, status) => async () => ({ ok: (status || 200) < 400, status: status || 200, text: async () => JSON.stringify(body) });
  const r = await llm.call({ provider: 'anthropic', key: 'k' }, { system: 's', messages: [{ role: 'user', content: 'u' }] }, { fetch: reply({ content: [{ type: 'text', text: '{"sql":"SELECT 1"}' }], usage: { input_tokens: 10, output_tokens: 5 } }) });
  assert.equal(r.text, '{"sql":"SELECT 1"}'); assert.equal(r.usage.input, 10); assert.ok(r.cost > 0);
  await assert.rejects(llm.call({ provider: 'gemini', key: 'bad' }, { system: 's', messages: [] }, { fetch: reply({ error: { message: 'API key not valid' } }, 400) }), /key was rejected/);
  await assert.rejects(llm.call({ provider: 'anthropic', key: 'bad' }, { system: 's', messages: [] }, { fetch: reply({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401) }), /key was rejected.*Anthropic 401/);
  await assert.rejects(llm.call({ provider: 'compatible', key: 'bad', baseUrl: 'https://openrouter.ai/api/v1' }, { system: 's', messages: [] }, { fetch: reply({ error: { message: 'No auth credentials found' } }, 401) }), /OpenAI-compatible 401/);
  await assert.rejects(llm.call({ provider: 'openai', key: 'k' }, { system: 's', messages: [] }, { fetch: async () => { throw new TypeError('Failed to fetch'); } }), /OpenAI/);
  await assert.rejects(llm.call({ provider: 'compatible', baseUrl: 'http://localhost:11434/v1' }, { system: 's', messages: [] }, { fetch: async () => { throw new TypeError('Failed to fetch'); } }), /OLLAMA_ORIGINS/);
  await assert.rejects(llm.call({ provider: 'openai' }, { system: 's', messages: [] }, { fetch: reply({}) }), /Add your OpenAI key/);
  await assert.rejects(llm.call({ provider: 'openai', key: 'k' }, { system: 's', messages: [] }, { fetch: reply({ error: { message: 'slow down' } }, 429) }), /Rate limit/);
});
