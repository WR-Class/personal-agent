// Operator diagnostic: does this provider count reasoning against the caller's max_tokens?
// Explicitly run, never automatic: it sends a handful of small real requests (a few hundred
// output tokens at most) and prints only measurements. The key is read in-process from the
// product's own config and is never printed or written anywhere.
//
//   node scripts/provider-token-budget.cjs
//   node scripts/provider-token-budget.cjs --model deepseek-v4.1-flash --ladder 64,256,1024
//
// Exit codes: 0 measured · 2 no usable credential · 3 account/quota problem (nothing measured).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const HOME = process.env.PERSONAL_AGENT_HOME ?? path.join(__dirname, '..', '.personal-agent');
const CONFIG = path.join(HOME, 'provider-config.json');
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
const LADDER = (arg('ladder') ?? '64,256,1024').split(',').map(Number);
const HARD = arg('prompt') ?? '逐步详细推导：为什么 0.999... 等于 1？请覆盖所有可能的反驳，并逐条说明。';
// A 200 whose body is an account notice is not a measurement; it is the account being out of quota.
const ACCOUNT = /(额度|余额|充值|欠费|credit|quota|insufficient|balance|billing|payment)/i;

function config() {
  if (!fs.existsSync(CONFIG)) { console.error('缺少 ' + CONFIG + '；请先在客户端完成模型配置'); process.exit(2); }
  const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!raw.apiKey || !raw.baseUrl || !raw.model) { console.error('配置缺少 baseUrl/model/apiKey'); process.exit(2); }
  return { url: String(raw.baseUrl).replace(/\/+$/, '') + '/chat/completions', key: raw.apiKey, model: raw.model };
}

async function ask(cfg, model, maxTokens, prompt, thinkingDisabled) {
  const body = { model, max_tokens: maxTokens, stream: false, messages: [{ role: 'user', content: prompt }] };
  if (thinkingDisabled) body.thinking = { type: 'disabled' };
  const started = Date.now();
  const res = await fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(300000) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = undefined; }
  const choice = data?.choices?.[0];
  const message = choice?.message ?? {};
  const usage = data?.usage ?? {};
  const content = String(message.content ?? '');
  const reasoning = String(message.reasoning_content ?? message.reasoning ?? '');
  return {
    status: res.status, ms: Date.now() - started, finish: choice?.finish_reason,
    reasoningChars: reasoning.length, contentChars: content.length,
    completion: usage.completion_tokens ?? null, reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
    account: ACCOUNT.test(content) || ACCOUNT.test(reasoning),
    contentHead: content.slice(0, 40).replace(/\s+/g, ' '),
    detail: data ? '' : text.slice(0, 140).replace(/\s+/g, ' ')
  };
}

(async () => {
  const cfg = config();
  const model = arg('model') ?? cfg.model;
  console.log(`模型 ${model} · 渠道 ${new URL(cfg.url).host} · 阶梯 ${LADDER.join('/')} tokens`);
  const screen = await ask(cfg, model, 64, '只回答一个词：好', false);
  if (screen.status !== 200) { console.error(`预检失败：HTTP ${screen.status} ${screen.detail}`); process.exit(2); }
  if (screen.account) { console.error(`账户/额度问题：HTTP 200 但正文是额度提示（不是模型能力问题，换模型或充值后再测）\n  ${screen.contentHead}`); process.exit(3); }
  console.log(`预检通过：思考 ${screen.reasoningChars} 字 / 正文 ${screen.contentChars} 字，输出 ${screen.completion} tokens（思考 ${screen.reasoningTokens}）`);
  console.log('cap\tfinish\t思考字\t正文字\tcompletion\treasoning_tokens');
  const rows = [];
  for (const cap of LADDER) {
    const r = await ask(cfg, model, cap, HARD, false);
    if (r.status !== 200 || r.account) { console.error(`cap=${cap} 未能测量：HTTP ${r.status} ${r.detail || r.contentHead}`); process.exit(3); }
    rows.push([cap, r]);
    console.log(`${cap}\t${r.finish}\t${r.reasoningChars}\t${r.contentChars}\t${r.completion}\t${r.reasoningTokens}`);
  }
  const control = await ask(cfg, model, LADDER[0], HARD, true);
  console.log(`${LADDER[0]}(关思考)\t${control.finish}\t${control.reasoningChars}\t${control.contentChars}\t${control.completion}\t${control.reasoningTokens}`);
  const capped = rows.filter(([cap, r]) => r.completion === cap && r.reasoningTokens === cap && r.contentChars === 0);
  console.log(capped.length === rows.length && control.contentChars > 0
    ? '结论：思考与正文共享同一个 max_tokens——思考吃满上限时正文为 0、finish_reason=length；关闭思考后同一预算落到正文。'
    : '结论：本渠道不像共享预算（completion 未随上限走满或思考另有独立预算）；请人工核对上表。');
})();
