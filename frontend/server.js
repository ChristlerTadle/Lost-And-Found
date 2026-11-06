const http = require('node:http');
const path = require('node:path');
const { readFile } = require('node:fs/promises');

const publicDirectory = path.resolve(__dirname, 'public');
const sharedStylesheet = path.resolve(__dirname, '..', 'assets', 'app.css');
const port = Number(process.env.FRONTEND_PORT || 5173);
const apiBase = process.env.API_BASE_URL || 'http://localhost:3001/api';
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  let requestPath;
  try {
    requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Invalid path.');
    return;
  }
  const requestedFile = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  if (requestPath === '/assets/app.css') {
    try {
      const stylesheet = await readFile(sharedStylesheet);
      res.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(stylesheet);
    } catch (error) {
      console.error('Unable to serve the shared application stylesheet:', error);
      res.writeHead(500).end('Unable to load the application stylesheet.');
    }
    return;
  }
  const filePath = path.resolve(publicDirectory, requestedFile);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`)) {
    res.writeHead(400).end('Invalid path.');
    return;
  }
  try {
    let content = await readFile(filePath);
    if (path.basename(filePath) === 'index.html') {
      const safeApiBase = JSON.stringify(apiBase).replace(/</g, '\\u003c');
      content = content.toString('utf8').replace('__API_BASE__', safeApiBase);
    }
    res.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      res.writeHead(404).end('Not found.');
      return;
    }
    console.error('Unable to serve frontend file:', error);
    res.writeHead(500).end('Unable to serve the frontend.');
  }
});

server.listen(port, () => {
  console.log(`Frontend running at http://localhost:${port}`);
});
