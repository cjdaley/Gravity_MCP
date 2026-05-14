#!/usr/bin/env node

import http from 'http';

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  
  try {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  } catch (err) {
    console.error('Error handling request:', err);
    try {
      res.writeHead(500);
      res.end('Internal error');
    } catch (e) {
      console.error('Failed to send error response:', e);
    }
  }
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`📍 Endpoint: http://0.0.0.0:${PORT}/`);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
