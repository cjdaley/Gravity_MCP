#!/usr/bin/env node

import http from 'http';

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  console.log('Request:', req.method, req.url);
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', port: PORT }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
