/**
 * Hermes WebUI — Zero-dependency HTTP server
 * Run: node server.mjs
 * Open: http://localhost:3000
 */

import { createServer, request } from 'http';
import { execSync } from 'child_process';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { createWriteStream, readdirSync, statSync, readFileSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath, URL } from 'url';
import os from 'os';

// Read API_SERVER_KEY from .env for proxying to Gateway
let API_SERVER_KEY = '';
try {
  const envPath = join(os.homedir(), '.hermes', '.env');
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^API_SERVER_KEY=(.+)$/);
    if (m) { API_SERVER_KEY = m[1].trim(); break; }
  }
} catch {}

// Global error handlers — prevent unhandled rejections from crashing the server
process.on('uncaughtException', (e) => {
  console.error('[FATAL] Uncaught exception:', e.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

const PORT = 3000;
const __filename = fileURLToPath(import.meta.url);
const BASE_DIR = dirname(__filename);
const GATEWAY_URL = 'http://127.0.0.1:8642';
const LLAMA_URL = 'http://localhost:8090';
const COMFYUI_URL = 'http://localhost:8188';

// Upload directory
const UPLOAD_DIR = join(BASE_DIR, 'uploads');
mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
};

// GPU cache
let gpuCache = null;
let gpuCacheTime = 0;
const GPU_CACHE_MS = 800;

// Llama.cpp metrics cache
let llamaMetricsCache = null;
let llamaMetricsCacheTime = 0;
const LLAMA_METRICS_CACHE_MS = 1500;

// Sessions file
const SESSIONS_FILE = join(BASE_DIR, 'sessions.json');

async function loadSessions() {
  try { return JSON.parse(await readFile(SESSIONS_FILE, 'utf-8')); } catch { return []; }
}
async function saveSessions(sessions) {
  await writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
}

function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // --- API endpoints ---

  // GPU monitor
  if (pathname === '/api/gpu' && req.method === 'GET') {
    return handleGPU(req, res);
  }

 // Context usage — read from Hermes state.db via Python
  if (pathname === '/api/context_usage' && req.method === 'GET') {
    return handleContextUsage(req, res);
  }

// Llama.cpp metrics
  if (pathname === '/api/llama-metrics' && req.method === 'GET') {
    return handleLlamaMetrics(req, res);
  }

  // Backend info — model, vision model, ctx size, backend name, server address
   if (pathname === '/api/backend_info' && req.method === 'GET') {
     return handleBackendInfo(req, res);
   }

   // Current profile
   if (pathname === '/api/current_profile' && req.method === 'GET') {
     return handleCurrentProfile(req, res);
   }
  const promptMatch = pathname.match(/^\/api\/profile_system_prompt\/(.+)$/);
  if (promptMatch && req.method === 'GET') {
    return handleProfileSystemPrompt(req, res, promptMatch[1]);
  }

  // Sessions management
  if (pathname === '/api/sessions' && req.method === 'GET') {
    return loadSessions().then(s => sendJSON(res, 200, s)).catch(e => sendJSON(res, 500, { error: e.message }));
  }
  if (pathname === '/api/sessions' && req.method === 'POST') {
    return handleCreateSession(req, res).catch(e => sendJSON(res, 500, { error: e.message }));
  }
  if (/^\/api\/sessions\/(\w+)/.test(pathname) && req.method === 'PUT') {
    const id = pathname.match(/^\/api\/sessions\/(\w+)/)[1];
    handleUpdateSession(req, res, id).catch(e => sendJSON(res, 500, { error: e.message }));
  }
  if (/^\/api\/sessions\/(\w+)/.test(pathname) && req.method === 'DELETE') {
    const id = pathname.match(/^\/api\/sessions\/(\w+)/)[1];
    return loadSessions().then(s => s.filter(s => s.id !== id)).then(saveSessions).then(() => sendJSON(res, 200, { ok: true })).catch(e => sendJSON(res, 500, { error: e.message }));
  }

  // Session chat — proxy to Gateway /api/sessions/{id}/chat/stream (SSE)
  if (pathname === '/api/session_chat' && req.method === 'POST') {
    return handleSessionChat(req, res).catch(e => sendJSON(res, 500, { error: e.message }));
  }

  // Session messages — proxy to Gateway /api/sessions/{id}/messages
  const sessMsgMatch = /^\/api\/session_messages\/(.+)$/.exec(pathname);
  if (sessMsgMatch && req.method === 'GET') {
    const id = sessMsgMatch[1];
    return proxyRequest(req, res, GATEWAY_URL, `/api/sessions/${id}/messages`);
  }

  // Session detail — proxy to Gateway /api/sessions/{id}
  const sessDetailMatch = /^\/api\/session_detail\/(.+)$/.exec(pathname);
  if (sessDetailMatch && req.method === 'GET') {
    const id = sessDetailMatch[1];
    return proxyRequest(req, res, GATEWAY_URL, `/api/sessions/${id}`);
  }

  // Session rename — proxy to Gateway PATCH /api/sessions/{id}
  const sessRenameMatch = /^\/api\/session\/(.+)$/.exec(pathname);
  if (sessRenameMatch && req.method === 'PATCH') {
    const id = sessRenameMatch[1];
    return proxyRequest(req, res, GATEWAY_URL, `/api/sessions/${id}`);
  }

  // Session fork — proxy to Gateway POST /api/sessions/{id}/fork
   const sessForkMatch = /^\/api\/session_fork\/(.+)$/.exec(pathname);
   if (sessForkMatch && req.method === 'POST') {
     const id = sessForkMatch[1];
     return proxyRequest(req, res, GATEWAY_URL, `/api/sessions/${id}/fork`, true);
   }

   // Steer — proxy to Gateway POST /api/sessions/{id}/steer
   const sessSteerMatch = /^\/api\/session_steer\/(.+)$/.exec(pathname);
   if (sessSteerMatch && req.method === 'POST') {
     const id = sessSteerMatch[1];
     return proxyRequest(req, res, GATEWAY_URL, `/api/sessions/${id}/steer`, true);
   }

  // Chat endpoint — proxy to Gateway with SSE streaming
  if (pathname === '/api/chat' && req.method === 'POST') {
    return handleChat(req, res).catch(e => sendJSON(res, 500, { error: e.message }));
  }

  // Upload image/file
  if (pathname === '/api/upload' && req.method === 'POST') {
    return handleUpload(req, res).catch(e => sendJSON(res, 500, { error: e.message }));
  }

  // ComfyUI proxy (/comfyui/* and /api/comfyui/*)
  if (pathname.startsWith('/comfyui/') || pathname.startsWith('/api/comfyui/')) {
    const targetPath = pathname.replace(/^\/(?:api\/)?comfyui\//, '/');
    return proxyRequest(req, res, COMFYUI_URL, targetPath);
  }

  // Proxy to llama.cpp (/llama/*)
  if (pathname.startsWith('/llama/')) {
    const targetPath = pathname.replace(/^\/llama\//, '/');
    return proxyRequest(req, res, LLAMA_URL, targetPath);
  }

  // Run events SSE — special handler for long-lived streams
  const runEventsMatch = /^\/v1\/runs\/([^/]+)\/events/.exec(pathname);
  if (runEventsMatch && req.method === 'GET') {
    return proxySSE(req, res, GATEWAY_URL, pathname);
  }

  // Proxy to Hermes Gateway (/v1/* and /api/*)
  if (pathname.startsWith('/v1/') || pathname.startsWith('/api/')) {
    return proxyRequest(req, res, GATEWAY_URL, pathname);
  }

  // Health check
  if (pathname === '/health') {
    return sendJSON(res, 200, { status: 'ok', gateway: GATEWAY_URL, llama: LLAMA_URL, comfyui: COMFYUI_URL });
  }

  // Uploads serving
  if (pathname.startsWith('/uploads/')) {
    const filename = pathname.replace(/^\/uploads\//, '');
    const filePath = join(UPLOAD_DIR, filename);
    return readFile(filePath).then(data => {
      let mime = MIME[extname(pathname)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    }).catch(() => {
      res.writeHead(404);
      return res.end('Not Found');
    });
  }

 // --- Static file serving ---
  let filePath = null;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = join(BASE_DIR, 'index.html');
  } else if (pathname.startsWith('/static/')) {
    filePath = join(BASE_DIR, 'static', pathname.replace(/^\/static\//, ''));
  } else {
    filePath = join(BASE_DIR, pathname);
  }

  readFile(filePath).then(data => {
    let mime = MIME[extname(pathname)] || 'application/octet-stream';
    if (pathname === '/') mime = 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  }).catch(() => {
    // Last resort: serve index.html (SPA fallback)
    return readFile(join(BASE_DIR, 'index.html')).then(data => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    }).catch(() => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    });
  });
}

// GPU monitoring handler
function handleGPU(req, res) {
  const now = Date.now();
  if (gpuCache && now - gpuCacheTime < GPU_CACHE_MS) {
    return sendJSON(res, 200, gpuCache);
  }

  try {
    const csvLine = execSync(
      'nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
      { timeout: 3000, encoding: 'utf-8' }
    ).trim();
    
    const parts = csvLine.split(',').map(Number);
    gpuCache = {
      temperature: Math.round(parts[0]) || 0,
      utilization: Math.round(parts[1]) || 0,
      memoryUsedMB: Math.round(parts[2]) || 0,
      memoryTotalMB: Math.round(parts[3]) || 32768,
      timestamp: now,
    };
    gpuCacheTime = now;
    return sendJSON(res, 200, gpuCache);
  } catch (e) {
    console.error('GPU query failed:', e.message);
    return sendJSON(res, 500, { error: 'Failed to query GPU' });
  }
}

// Context usage handler — reads input_tokens from Hermes state.db via Python
let ctxUsageCache = null;
let ctxUsageCacheTime = 0;
const CTX_USAGE_CACHE_MS = 2000;

function handleContextUsage(req, res) {
  const now = Date.now();
  if (ctxUsageCache && now - ctxUsageCacheTime < CTX_USAGE_CACHE_MS) {
    return sendJSON(res, 200, ctxUsageCache);
  }

  try {
    const output = execSync(
      'python3 "' + join(BASE_DIR, 'get_context_usage.py') + '"',
      { timeout: 3000, encoding: 'utf-8' }
    ).trim();
    ctxUsageCache = JSON.parse(output);
    ctxUsageCacheTime = now;
    return sendJSON(res, 200, ctxUsageCache);
  } catch (e) {
    console.error('Context usage query failed:', e.message);
    if (ctxUsageCache) return sendJSON(res, 200, ctxUsageCache);
    return sendJSON(res, 500, { error: 'Failed to query context usage' });
  }
}

// Llama.cpp metrics handler — fetches and parses Prometheus-format /metrics from llama.cpp server
function handleLlamaMetrics(req, res) {
  const now = Date.now();
  if (llamaMetricsCache && now - llamaMetricsCacheTime < LLAMA_METRICS_CACHE_MS) {
    return sendJSON(res, 200, llamaMetricsCache);
  }

  // Fetch /metrics from llama.cpp server (use 127.0.0.1 for Windows compatibility)
  const options = {
    hostname: '127.0.0.1',
    port: 8090,
    path: '/metrics',
    method: 'GET',
  };

  request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', d => { body += d; });
    proxyRes.on('end', () => {
      try {
        // Parse Prometheus format into a flat key-value object
        const metrics = parsePrometheusMetrics(body);
        llamaMetricsCache = metrics;
        llamaMetricsCacheTime = now;
        return sendJSON(res, 200, metrics);
      } catch (e) {
        console.error('Failed to parse llama metrics:', e.message);
        return sendJSON(res, 500, { error: 'Failed to parse metrics' });
      }
    });
  }).on('error', (e) => {
    console.error('Llama metrics fetch failed:', e.message);
    // Return cached data if available
    if (llamaMetricsCache) {
      return sendJSON(res, 200, llamaMetricsCache);
    }
    return sendJSON(res, 503, { error: 'Llama.cpp server unavailable' });
  });
}

// Parse Prometheus text format into a flat object with numeric values
function parsePrometheusMetrics(text) {
  const result = {};
  let HELP = {}, TYPE = {};

  for (const line of text.split('\n')) {
    // Skip empty lines
    if (!line.trim()) continue;

    // # HELP key description
    if (line.startsWith('# HELP ')) {
      const parts = line.slice(7).trim().split(/\s+/);
      HELP[parts[0]] = parts.slice(1).join(' ');
      continue;
    }

    // # TYPE key counter|gauge|...
    if (line.startsWith('# TYPE ')) {
      const parts = line.slice(7).trim().split(/\s+/);
      TYPE[parts[0]] = parts[1] || '';
      continue;
    }

    // Data line: key value or key{labels="..."} value
    let match = line.match(/^([a-zA-Z_:][\w:-]*)\{[^}]*\}\s+([\d.]+)$/);
    if (!match) {
      match = line.match(/^([a-zA-Z_:][\w:-]*)\s+([\d.]+)$/);
    }
    if (match) {
      const key = match[1];
      result[key] = parseFloat(match[2]);
    }
  }

  return { metrics: result, help: HELP, type: TYPE };
}

// Backend info handler — fetch model info via Gateway
let backendInfoCache = null;
let backendInfoCacheTime = 0;
const BACKEND_INFO_CACHE_MS = 60000; // Cache for 1 minute

function handleBackendInfo(req, res) {
  const now = Date.now();
  if (backendInfoCache && now - backendInfoCacheTime < BACKEND_INFO_CACHE_MS) {
    return sendJSON(res, 200, backendInfoCache);
  }

  // Fetch model info directly from llama.cpp
     const options = {
       hostname: '127.0.0.1',
       port: 8090,
       path: '/v1/models',
       method: 'GET'
     };

   console.log('[BackendInfo] Requesting', options.hostname, options.port, options.path);

   request(options, (proxyRes) => {
     let body = '';
     proxyRes.on('data', d => { body += d; });
     proxyRes.on('end', () => {
       try {
         const models = JSON.parse(body);
         const modelInfo = models.data?.[0] || {};
         const ctx = modelInfo.meta?.n_ctx || 'N/A';
         const visionModel = modelInfo.capabilities?.includes('multimodal') ? modelInfo.id : 'N/A';
         backendInfoCache = {
           model: modelInfo.id || 'Unknown',
           visionModel: visionModel,
           ctxSize: ctx,
           backend: 'llama.cpp server',
           serverAddress: LLAMA_URL,
         };
         backendInfoCacheTime = now;
         console.log('[BackendInfo] OK:', backendInfoCache.model, 'ctx:', ctx);
         return sendJSON(res, 200, backendInfoCache);
       } catch (e) {
         console.error('[BackendInfo] Parse error:', e.message, 'body:', body.slice(0, 200));
         return sendJSON(res, 500, { error: 'Failed to fetch backend info' });
       }
     });
   }).on('error', (e) => {
     console.error('[BackendInfo] Request error:', e.code, e.message);
     if (backendInfoCache) return sendJSON(res, 200, backendInfoCache);
     return sendJSON(res, 503, { error: 'llama.cpp unavailable' });
   });
}

// Chat handler — proxy to Gateway with SSE passthrough
async function handleChat(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

  const messages = parsed.messages || [];
  if (!messages.length) return sendJSON(res, 400, { error: 'No messages' });

  // Forward to Gateway /v1/chat/completions with streaming
  const apiPayload = {
    model: 'hermes-agent',
    messages: messages,
    stream: true,
  };

  const payloadStr = JSON.stringify(apiPayload);
  
  const options = {
    hostname: '127.0.0.1',
    port: 8642,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payloadStr),
    },
  };

  const proxyReq = request(options, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      console.error('Gateway returned non-200:', proxyRes.statusCode);
      let errBody = '';
      proxyRes.on('data', d => { errBody += d; });
      proxyRes.on('end', () => { sendJSON(res, proxyRes.statusCode, { error: errBody }); });
      return;
    }

    // Set SSE headers and forward the stream via pipe
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    proxyRes.on('error', () => {}); // silence, already piped
     proxyRes.pipe(res);
     proxyRes.on('end', () => clearTimeout(chatTimeout));
     res.on('close', () => { clearTimeout(chatTimeout); proxyReq.destroy(); });
     const chatTimeout = setTimeout(() => {
       proxyReq.destroy();
       if (res.headersSent) res.end();
     }, 300_000);
    });

    proxyReq.on('error', (e) => {
     console.error('Proxy request to Gateway failed:', e.message);
     if (!res.headersSent) {
       sendJSON(res, 502, { error: `Gateway unavailable` });
     }
    });

    proxyReq.write(payloadStr);
    proxyReq.end();
    }

// Session chat — proxy to Gateway /api/sessions/{id}/chat/stream (SSE)
async function handleSessionChat(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

  const sessionId = parsed.session_id;
  if (!sessionId) return sendJSON(res, 400, { error: 'Missing session_id' });

  // Build payload for Gateway session chat API
  const gatewayPayload = {
    message: parsed.input,
  };
  if (parsed.instructions) {
    gatewayPayload.instructions = parsed.instructions;
  }

  const payloadStr = JSON.stringify(gatewayPayload);

  const options = {
    hostname: '127.0.0.1',
    port: 8642,
    path: `/api/sessions/${sessionId}/chat/stream`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payloadStr),
    },
  };
  if (API_SERVER_KEY) {
    options.headers['authorization'] = `Bearer ${API_SERVER_KEY}`;
  }

  const proxyReq = request(options, (proxyRes) => {
    if (res.headersSent) return; // Already sent error response
    if (proxyRes.statusCode !== 200) {
      console.error(`[API_SERVER] Gateway chat/stream returned ${proxyRes.statusCode}`);
      let errBody = '';
      proxyRes.on('data', d => { errBody += d; });
      proxyRes.on('end', () => { sendJSON(res, proxyRes.statusCode, { error: errBody }); });
      return;
    }

    // Forward SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    proxyRes.on('error', () => {});
     proxyRes.pipe(res);
     proxyRes.on('end', () => clearTimeout(sessionChatTimeout));
     res.on('close', () => { clearTimeout(sessionChatTimeout); proxyReq.destroy(); });
     const sessionChatTimeout = setTimeout(() => {
       proxyReq.destroy();
       if (res.headersSent) res.end();
     }, 300_000);
    });

    proxyReq.on('error', (e) => {
     console.error('[API_SERVER] Session chat proxy failed:', e.message);
     if (!res.headersSent) {
       sendJSON(res, 502, { error: 'Gateway unavailable' });
     }
    });

    proxyReq.end(payloadStr);
    }

// Session creation handler
async function handleCreateSession(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  let parsed = {};
  try { parsed = JSON.parse(body); } catch {}

  // Create session on Gateway - required, no fallback
  let gatewaySessionId = null;
  try {
    const gwResp = await fetch(`${GATEWAY_URL}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_SERVER_KEY}`
      },
      body: JSON.stringify({})
    });
    if (gwResp.ok) {
      const gwData = await gwResp.json();
      gatewaySessionId = gwData.session?.id;
    } else {
      console.error('Gateway session creation failed:', gwResp.status, await gwResp.text());
    }
  } catch (e) {
    console.error('Failed to create Gateway session:', e);
  }

  if (!gatewaySessionId) {
    console.error('Cannot create session: Gateway unavailable');
    sendJSON(res, 503, { error: 'Gateway unavailable, cannot create session' });
    return;
  }

  const sessions = await loadSessions();
  const session = {
    id: gatewaySessionId,
    title: parsed.title || '新对话',
    messages: [],
    hermes_session_id: gatewaySessionId,
  };
  sessions.push(session);
  await saveSessions(sessions);
  sendJSON(res, 201, session);
}

// Session update handler
async function handleUpdateSession(req, res, id) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  let parsed = {};
  try { parsed = JSON.parse(body); } catch {}

  const sessions = await loadSessions();
  const idx = sessions.findIndex(s => s.id === id);
  if (idx === -1) {
    return sendJSON(res, 404, { error: 'Session not found' });
  }

  if (parsed.title !== undefined) sessions[idx].title = parsed.title;
  if (parsed.messages !== undefined) sessions[idx].messages = parsed.messages;

  await saveSessions(sessions);
  sendJSON(res, 200, sessions[idx]);
}

// File upload handler — zero-dependency multipart parser
async function handleUpload(req, res) {
  return new Promise((resolve) => {
    // Check for multipart content-type and boundary
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      sendJSON(res, 400, { error: 'Not multipart form data' });
      return resolve();
    }

    let boundary = contentType.match(/boundary=(.+)/i)?.[1];
    if (boundary) {
      // Remove quotes from boundary
      boundary = boundary.replace(/^"|"$/g, '');
    } else {
      sendJSON(res, 400, { error: 'No boundary in content-type' });
      return resolve();
    }

    const filesResult = [];
    let buffers = [];
    
    req.on('data', (chunk) => {
      buffers.push(chunk);
    });

    req.on('end', () => {
      try {
        // Simple multipart parser
        const data = Buffer.concat(buffers);
        const parts = data.toString().split(`--${boundary}`);
        
        for (const part of parts) {
          if (!part.includes('\r\n\r\n')) continue;
          
          const [headerPart, contentPart] = part.split('\r\n\r\n');
          
          // Check filename in header
          const filenameMatch = headerPart.match(/filename="?(.+?)"?\r/)?.[1];
          if (!filenameMatch) continue;
          
          // Extract content (remove trailing boundary markers and newlines)
          let contentStr = contentPart;
          // Remove trailing \r\n-- or \r\n
          contentStr = contentStr.replace(/\r\n--?$/s, '');
          
          // Convert to buffer
          const contentBuffer = Buffer.from(contentStr, 'binary');
          
          // Generate safe filename
          const ext = extname(filenameMatch) || '.bin';
          const safeName = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
          const destPath = join(UPLOAD_DIR, safeName);
          
          writeFile(destPath, contentBuffer);
          
          filesResult.push({
            name: filenameMatch,
            filename: safeName,
            url: `/uploads/${safeName}`,
            size: contentBuffer.length,
            type: '',
          });
        }

        sendJSON(res, 200, { files: filesResult });
      } catch (e) {
        console.error('Upload error:', e.message);
        sendJSON(res, 500, { error: 'Upload failed' });
      } finally {
        resolve();
      }
    });
  });
}

// SSE proxy — specialized for long-lived event streams (e.g., /v1/runs/{id}/events)
function proxySSE(req, res, targetUrl, path) {
  const url = new URL(path, targetUrl);
  const options = {
    hostname: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers },
  };
  delete options.headers.host;
  options.headers['host'] = `${url.hostname}:${options.port}`;
  delete options.headers.origin;
  delete options.headers['referer'];
  
  // Add API key for Gateway requests
  if (API_SERVER_KEY && targetUrl.includes('8642')) {
    options.headers['authorization'] = `Bearer ${API_SERVER_KEY}`;
  }

  const proxyReq = request(options, (proxyRes) => {
    // Force SSE-friendly headers regardless of upstream
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    proxyRes.on('error', () => {});
      proxyRes.pipe(res);
      proxyRes.on('end', () => clearTimeout(sseTimeout));
      res.on('close', () => { clearTimeout(sseTimeout); proxyReq.destroy(); });
      const sseTimeout = setTimeout(() => {
        proxyReq.destroy();
        if (res.headersSent) res.end();
      }, 300_000);
    });

    proxyReq.on('error', (e) => {
      console.error(`SSE proxy error (${targetUrl}${path}):`, e.message);
      if (!res.headersSent) {
        sendJSON(res, 502, { error: `Backend unavailable: ${targetUrl}` });
      }
    });

    proxyReq.end();
    }

// Proxy handler for Gateway, llama.cpp, and ComfyUI
function proxyRequest(req, res, targetUrl, path) {
  const url = new URL(path, targetUrl);
  const options = {
    hostname: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers },
  };

  // Fix host header
  delete options.headers.host;
  options.headers['host'] = `${url.hostname}:${options.port}`;
  
  // Remove browser-originating headers that backends reject
  delete options.headers.origin;
  delete options.headers['referer'];
  delete options.headers['x-hermes-session-key'];
  
  // Add API key for Gateway requests
  if (API_SERVER_KEY && targetUrl.includes('8642')) {
    options.headers['authorization'] = `Bearer ${API_SERVER_KEY}`;
  }
  
  if (req.method === 'GET' || req.method === 'HEAD') {
    delete options.headers['content-type'];
    delete options.headers['transfer-encoding'];
  }

  return new Promise((resolve) => {
    const proxyReq = request(options, (proxyRes) => {
      // Clear timeout on response
      clearTimeout(proxyReq._timeout);
      // Preserve original headers except hop-by-hop
      const { connection, keepalive, 'keep-alive': ka, transferEncoding: te, upgrade, ...headers } = proxyRes.headers;
      res.writeHead(proxyRes.statusCode, headers);
      
      if (req.method === 'HEAD') {
        res.end();
        resolve();
      } else {
        proxyRes.pipe(res);
        proxyRes.on('end', () => resolve());
      }
    });

    proxyReq.on('error', (e) => {
      clearTimeout(proxyReq._timeout);
      console.error(`Proxy error (${targetUrl}${path}):`, e.message);
      if (!res.headersSent) {
        sendJSON(res, 502, { error: `Backend unavailable: ${targetUrl}` });
      }
      resolve();
    });

    // 15s timeout — prevent hanging connections from blocking the event loop
    proxyReq._timeout = setTimeout(() => {
      proxyReq.destroy(new Error('Proxy timeout after 15s'));
    }, 15_000);

    if (req.method === 'POST' || req.method === 'PUT') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  });
}

// Current profile handler — reads profiles directory and determines active profile
function handleProfileSystemPrompt(req, res, profileName) {
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '/root';
    const soulPath = join(homeDir, '.hermes', 'profiles', profileName, 'SOUL.md');
    let content = '';
    try {
      content = readFileSync(soulPath, 'utf-8');
    } catch {
      return sendJSON(res, 404, { error: 'Profile not found' });
    }
    return sendJSON(res, 200, { profile: profileName, system_prompt: content });
  } catch (e) {
    console.error('Profile system prompt query failed:', e.message);
    return sendJSON(res, 500, { error: 'Failed to query profile system prompt' });
  }
}

function handleCurrentProfile(req, res) {
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '/root';
    const profilesDir = join(homeDir, '.hermes', 'profiles');
    const profiles = [];
    
    try {
      const entries = readdirSync(profilesDir);
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const fullPath = join(profilesDir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          let label = entry;
          try {
            const soulContent = readFileSync(join(fullPath, 'SOUL.md'), 'utf-8');
            const firstLine = soulContent.split('\n')[0];
            // "— 小萌 (Xiao Meng)" or "# 小萌 (Xiao Meng)" or "# Title — 小萌"
            let namePart = firstLine.replace(/^#\s*/, '');
            // Take part after em-dash if present
            if (namePart.includes('—')) namePart = namePart.split('—').pop();
            // Take part before parenthesis
            namePart = namePart.split('(')[0].trim();
            if (namePart) label = namePart;
          } catch {}
          profiles.push({ name: entry, label });
        }
      }
    } catch {}
    
    let activeProfile = process.env.HERMES_PROFILE || '';
    return sendJSON(res, 200, { profile: activeProfile, profiles });
  } catch (e) {
    console.error('Profile query failed:', e.message);
    return sendJSON(res, 500, { error: 'Failed to query profiles' });
  }
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// Create server
const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`\nHermes WebUI running at http://localhost:${PORT}\n`);
  console.log(`Gateway proxy:   /v1/*        -> ${GATEWAY_URL}/v1/*`);
  console.log(`Llama.cpp proxy: /llama/*     -> ${LLAMA_URL}/*`);
  console.log(`ComfyUI proxy:   /comfyui/*   -> ${COMFYUI_URL}/*`);
  console.log(`GPU monitor:     /api/gpu     -> nvidia-smi\n`);
});

// Graceful shutdown on Ctrl+C / SIGTERM
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
