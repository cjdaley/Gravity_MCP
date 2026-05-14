#!/usr/bin/env node

import { spawn } from 'child_process';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 8080;

// Spawn stdio MCP server
const child = spawn('node', ['src/index.js'], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe']
});

let responseBuffer = '';
const pendingRequests = {};

child.stdout.on('data', (data) => {
  responseBuffer += data.toString();
  const lines = responseBuffer.split('\n');
  responseBuffer = lines[lines.length - 1];
  
  for (let i = 0; i < lines.length - 1; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      if (msg.id && pendingRequests[msg.id]) {
        const cb = pendingRequests[msg.id];
        delete pendingRequests[msg.id];
        cb(msg);
      }
    } catch (e) {}
  }
});

child.stderr.on('data', (data) => {
  console.error('[MCP]', data.toString().trim());
});

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || (req.url !== '/mcp' && req.url !== '/')) {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  
  req.on('end', () => {
    try {
      const msg = JSON.parse(body);
      msg.id = msg.id || Math.random();
      
      child.stdin.write(JSON.stringify(msg) + '\n');
      
      const timeout = setTimeout(() => {
        if (pendingRequests[msg.id]) {
          delete pendingRequests[msg.id];
          res.writeHead(408);
          res.end(JSON.stringify({error:'timeout'}));
        }
      }, 29000);
      
      pendingRequests[msg.id] = (response) => {
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      };
      
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({error:'invalid json'}));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Gravity MCP HTTP Server running on port ${PORT}`);
  console.log(`📡 MCP Endpoint: https://gravitymcp-production.up.railway.app/mcp`);
});
