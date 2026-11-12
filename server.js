import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'node:http';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

// Configure Wisp server
logging.set_level(logging.NONE);
try {
  Object.assign(wisp.options, {
    allow_udp_streams: false,
    dns_servers: ['1.1.1.3', '1.0.0.3']
  });
} catch (e) {}

app.use(express.json());

// Set required headers for service workers, wasm, and iframe embedding
app.use((req, res, next) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Configure custom mime types
express.static.mime.define({
  'application/wasm': ['wasm'],
  'text/javascript': ['mjs', 'js']
});

// Scramjet, BareMux, Libcurl, and Epoxy transport assets
const scramDist = path.join(__dirname, 'node_modules/@mercuryworkshop/scramjet/dist');
const libcurlDist = path.join(__dirname, 'node_modules/@mercuryworkshop/libcurl-transport/dist');
const bareMuxDist = path.join(__dirname, 'node_modules/@mercuryworkshop/bare-mux/dist');
const epoxyDist = path.join(__dirname, 'node_modules/@mercuryworkshop/epoxy-transport/dist');
const uvDist = path.join(__dirname, 'node_modules/@titaniumnetwork-dev/ultraviolet/dist');

app.use('/scram', express.static(scramDist));
app.use('/libcurl', express.static(libcurlDist));
app.use('/baremux', express.static(bareMuxDist));
app.use('/epoxy', express.static(epoxyDist));

// Ultraviolet custom config endpoints
app.get(['/uv.config.js', '/uv/uv.config.js'], (req, res) => {
  res.setHeader('Content-Type', 'text/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'uv.config.js'));
});

// Ultraviolet dist assets (available both under /uv/ and root for injected scripts)
app.use('/uv', express.static(uvDist));
app.get(['/uv.bundle.js', '/uv.client.js', '/uv.handler.js', '/uv.sw.js'], (req, res) => {
  const filename = path.basename(req.path);
  res.sendFile(path.join(uvDist, filename));
});
app.use(express.static(uvDist));

// Service worker endpoint
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'text/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

// Fallback proxy endpoint for web unblocking
app.get('/api/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target || typeof target !== 'string') return res.status(400).send('Missing url');
  try {
    const fetchRes = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const ctype = fetchRes.headers.get('content-type') || 'text/html';
    res.setHeader('Content-Type', ctype);
    if (ctype.includes('text/html')) {
      let html = await fetchRes.text();
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${target}">`);
      return res.send(html);
    }
    const buf = await fetchRes.arrayBuffer();
    return res.send(Buffer.from(buf));
  } catch (err) {
    return res.status(502).send(`Proxy error: ${err.message}`);
  }
});

// AI Study helper endpoint for /ai/index.html & /ai.html
app.post('/api/ai', async (req, res) => {
  try {
    const { messages, provider, model } = req.body || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages are required' });
    }

    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const userPrompt = lastUserMsg ? lastUserMsg.content : 'Hello';

    // 1. Google Gemini via @google/genai if requested or GEMINI_API_KEY is available
    const geminiKey = process.env.GEMINI_API_KEY;
    if ((provider === 'gemini' || provider === 'backend') && geminiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const systemMsg = messages.find(m => m.role === 'system');
        const systemInstruction = systemMsg ? systemMsg.content : 'You are an educational study helper for school subjects, past-paper revision, and exam prep. Keep answers clear and step-by-step.';
        
        const response = await ai.models.generateContent({
          model: model || 'gemini-2.5-flash',
          contents: userPrompt,
          config: {
            systemInstruction
          }
        });
        const replyText = response.text || 'I could not generate an answer right now.';
        return res.json({ reply: replyText, left: 1500, provider: 'Google AI Studio (Gemini)' });
      } catch (geminiError) {
        console.warn('Gemini API call failed, falling back to Pollinations:', geminiError);
      }
    }

    // 2. Groq API if requested or GROQ_API_KEY is available
    const groqKey = process.env.GROQ_API_KEY;
    if ((provider === 'groq' || (!geminiKey && groqKey)) && groqKey) {
      try {
        const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${groqKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model || 'llama-3.1-8b-instant',
            messages: messages.slice(-10),
            temperature: 0.6,
            max_tokens: 1500
          })
        });
        if (groqResp.ok) {
          const data = await groqResp.json();
          const reply = data?.choices?.[0]?.message?.content;
          if (reply) {
            return res.json({ reply, left: 14400, provider: 'Groq (Llama 3)' });
          }
        }
      } catch (groqError) {
        console.warn('Groq call failed, falling back to Pollinations:', groqError);
      }
    }

    // 3. Pollinations.ai (Keyless, instant, zero setup)
    try {
      const pollinationsResp = await fetch('https://text.pollinations.ai/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages.slice(-10),
          model: model || 'openai',
          temperature: 0.6,
          seed: 42
        })
      });

      if (pollinationsResp.ok) {
        const text = await pollinationsResp.text();
        if (text && text.trim()) {
          return res.json({ reply: text.trim(), left: 9999, provider: 'Pollinations.ai' });
        }
      }
    } catch (pollinationsError) {
      console.warn('Pollinations call failed, falling back to local tutor:', pollinationsError);
    }

    // 4. Guaranteed offline fallback study response
    return res.json({
      reply: `### Study Guide: ${userPrompt}\n\n1. **Core Concept**:\nFocus on the fundamental rules and definitions for this topic.\n\n2. **Step-by-Step Approach**:\n- Identify given variables and what is being asked.\n- Apply the relevant formula or revision framework.\n- Verify units, sign conventions, and reasoning.\n\n3. **Exam Tip**:\nAlways show working out clearly for method marks. Practice past paper exam questions under timed conditions to test recall.`,
      left: 100,
      provider: 'Local Study Helper'
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Failed to process AI request' });
  }
});

// Static assets
app.use(express.static(__dirname, {
  extensions: ['html', 'htm'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Fallback to index.html for root navigation only, 404 for missing static assets
app.get('*', (req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Create HTTP server with Wisp websocket support
const server = createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (req.url && (req.url === '/wisp' || req.url.startsWith('/wisp/') || req.url.startsWith('/wisp?'))) {
    try {
      wisp.routeRequest(req, socket, head);
    } catch (err) {
      console.warn('Wisp upgrade error:', err);
      socket.end();
    }
  } else {
    socket.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`pastpapergenie v3 with Ultraviolet running at http://${HOST}:${PORT}`);
});
