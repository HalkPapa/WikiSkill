#!/usr/bin/env node
// A minimal MCP server (stdio, newline-delimited JSON-RPC) with one tool, `lookup`, standing in for a benchmark
// environment such as a search API. Use it to check that --agent-mcp-config works; replace it with a real adapter.
import { createInterface } from 'node:readline';

const TABLE = { alpha: 'K-731', beta: 'Q-208', gamma: 'Z-064' };
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.id === undefined) return; // notifications need no reply
  switch (req.method) {
    case 'initialize':
      return send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lookup-env', version: '0.1.0' } } });
    case 'tools/list':
      return send({ id: req.id, result: { tools: [{ name: 'lookup', description: 'Look up the code stored under a key (alpha, beta or gamma).', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }] } });
    case 'tools/call': {
      const key = req.params?.arguments?.key;
      const value = TABLE[key];
      return send({ id: req.id, result: { content: [{ type: 'text', text: value ?? `no entry for ${key}` }], isError: value === undefined } });
    }
    default:
      return send({ id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
  }
});
