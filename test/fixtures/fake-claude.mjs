#!/usr/bin/env node
// Offline stand-in for the `claude` CLI used by the CLI tests (no network, no cost).
// Controls via environment: FAKE_FAIL_INFER=1 makes every task-agent call fail; FAKE_PROPOSAL is the skill proposer's reply.
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('fake-claude 0.0.0');
  process.exit(0);
}
let stdin = '';
process.stdin.on('data', (d) => (stdin += d)).on('end', () => {
  const system = args[args.indexOf('--system-prompt') + 1] ?? '';
  const meta = /Wiki Maintainer|Skill Proposer/.test(system);
  if (process.env.FAKE_FAIL_INFER && !meta) {
    console.error('boom: simulated rate limit');
    process.exit(1);
  }
  let text;
  if (/Wiki Maintainer/.test(system)) text = JSON.stringify({ update_index: '- x', append_log: 'l' });
  else if (/Skill Proposer/.test(system)) text = process.env.FAKE_PROPOSAL ?? JSON.stringify({ action: 'no_action' });
  else text = `<answer>${system.includes('USE-TRICK') ? 'right' : 'wrong'}</answer>`;
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 };
  const cost = Number(process.env.FAKE_COST ?? '0.01');
  if (args.includes('stream-json')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-model-1' }));
    console.log(JSON.stringify({ type: 'result', result: text, total_cost_usd: cost, usage }));
  } else console.log(JSON.stringify({ type: 'result', subtype: 'success', result: text, total_cost_usd: cost, usage }));
});
