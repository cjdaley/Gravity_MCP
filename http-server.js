#!/usr/bin/env node

import { spawn } from 'child_process';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const port = parseInt(process.env.PORT) || 8000;

// Spawn the stdio MCP server
const child = spawn('node', ['src/index.js'], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env
});

// Create HTTP server that proxies to stdio MCP
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/mcp') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      // Send request to stdio server
      child.stdin.write(body + '\n');
      
      // Get response from stdio server
      let response = '';
      const listener = (data) => {
        response += data.toString();
        try {
          const json = JSON.parse(response);
          child.stdout.removeListener('data', listener);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        } catch (e) {
          // Response not complete yet
        }
      };
      
      child.stdout.on('data', listener);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Gravity MCP HTTP Server running on port ${port}`);
  console.log(`📡 MCP Endpoint: http://0.0.0.0:${port}/mcp`);
});

process.on('SIGTERM', () => {
  child.kill();
  server.close();
});
