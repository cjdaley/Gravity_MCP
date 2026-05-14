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

// Track pending requests
const pendingRequests = new Map();
let messageId = 0;

// Listen for responses from stdio server
let buffer = '';
child.stdout.on('data', (data) => {
  buffer += data.toString();
  
  // Process complete messages (separated by newlines)
  const lines = buffer.split('\n');
  buffer = lines.pop(); // Keep incomplete line in buffer
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    try {
      const msg = JSON.parse(line);
      
      // Route response to waiting request
      if (msg.id && pendingRequests.has(msg.id)) {
        const resolve = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        resolve(msg);
      }
    } catch (e) {
      console.error('Failed to parse MCP response:', line);
    }
  }
});

// Create HTTP server
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  
  if (req.url !== '/mcp') {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  
  req.on('end', async () => {
    try {
      const request = JSON.parse(body);
      
      // Add message ID
      request.id = ++messageId;
      
      // Send to stdio server
      child.stdin.write(JSON.stringify(request) + '\n');
      
      // Wait for response with timeout
      const response = await Promise.race([
        new Promise((resolve) => {
          pendingRequests.set(request.id, resolve);
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 25000)
        )
      ]);
      
      res.writeHead(200);
      res.end(JSON.stringify(response));
      
    } catch (error) {
      console.error('Error handling request:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Gravity MCP HTTP Server running on port ${port}`);
  console.log(`📡 MCP Endpoint: http://0.0.0.0:${port}/mcp`);
});

process.on('SIGTERM', () => {
  child.kill();
  server.close();
});
