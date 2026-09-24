const express = require('express');
const cors = require('cors');
const https = require('https');
const { sequelize, Pipeline, RunLog } = require('./models');
const { runTransform } = require('./sandbox');

const app = express();
const PORT = process.env.PORT || 5000;
// Fail closed: no token, no server. Generate with python agent-os/python/make_token.py
// Roles: viewer < operator < admin. AGENT_OS_TOKEN is always admin; extra
// tokens come from AGENT_OS_TOKENS="tok:role,tok:role".
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };
const TOKENS = new Map();
if (process.env.AGENT_OS_TOKEN) TOKENS.set(process.env.AGENT_OS_TOKEN, 'admin');
for (const part of (process.env.AGENT_OS_TOKENS || '').split(',')) {
  const i = part.indexOf(':');
  if (i > 0 && ROLE_RANK[part.slice(i + 1).trim()]) TOKENS.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
}
if (!TOKENS.size) {
  console.error('FATAL: AGENT_OS_TOKEN is not set. Run: python agent-os/python/make_token.py');
  process.exit(1);
}
function roleOf(req) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  return (m && TOKENS.get(m[1])) || null;
}
// Rate limit: fixed 60s window per token (or IP when anonymous). 429 past RPM.
const RPM = Math.max(1, +(process.env.RATE_LIMIT_RPM || 120));
const _rl = new Map();
function rateLimited(key) {
  const now = Date.now();
  let e = _rl.get(key);
  if (!e || now - e.start >= 60000) { e = { start: now, count: 0 }; _rl.set(key, e); if (_rl.size > 10000) _rl.clear(); }
  e.count++;
  return e.count > RPM ? Math.ceil((60000 - (now - e.start)) / 1000) : 0;
}
// Health stays open for probes (leaks nothing); everything else needs a role:
// GET=viewer, POST/PUT=operator, DELETE=admin.
app.get('/health', (req, res) => res.json({ ok: true, service: 'prompt-studio' }));
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next(); // CORS preflight never carries auth
  const role = roleOf(req);
  if (!role) return res.status(401).json({ error: 'unauthorized: Bearer AGENT_OS_TOKEN required' });
  const retry = rateLimited('tok:' + role + ':' + (req.headers.authorization || '').slice(-8));
  if (retry) return res.status(429).set('Retry-After', String(retry)).json({ error: 'rate limited, retry later' });
  const need = req.method === 'GET' ? 'viewer' : req.method === 'DELETE' ? 'admin' : 'operator';
  if (ROLE_RANK[role] < ROLE_RANK[need]) return res.status(403).json({ error: `forbidden: ${need} role required` });
  next();
});
// agent-os: single LLM gateway (owns ROUTER_KEY + ollama fallback). Direct Gemini below is fallback only.
const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://localhost:20129').replace(/\/+$/, '');

app.use(cors());
app.use(express.json());

// Helper to perform topological sorting
function topologicalSort(nodes, connections) {
  const adj = {};
  const inDegree = {};
  const sorted = [];

  nodes.forEach(node => {
    adj[node.id] = [];
    inDegree[node.id] = 0;
  });

  connections.forEach(conn => {
    // Check if nodes exist in case of dangling connections
    if (adj[conn.fromNodeId] && adj[conn.toNodeId] !== undefined) {
      adj[conn.fromNodeId].push(conn.toNodeId);
      inDegree[conn.toNodeId]++;
    }
  });

  const queue = nodes.filter(node => inDegree[node.id] === 0).map(node => node.id);

  while (queue.length > 0) {
    const u = queue.shift();
    sorted.push(u);

    adj[u].forEach(v => {
      inDegree[v]--;
      if (inDegree[v] === 0) {
        queue.push(v);
      }
    });
  }

  if (sorted.length !== nodes.length) {
    throw new Error('Circular dependency detected in graph! Please remove feedback loops.');
  }

  return sorted;
}

// Helper: Call agent-os gateway (single LLM path). Throws if unreachable.
function callGatewayLLM(prompt, model) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: model || 'gemini-1.5-flash',
      messages: [{ role: 'user', content: prompt }],
    });
    const url = new URL(GATEWAY_URL + '/v1/chat');
    const client = url.protocol === 'https:' ? https : require('http');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (process.env.AGENT_OS_TOKEN) headers['Authorization'] = `Bearer ${process.env.AGENT_OS_TOKEN}`;
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const text = parsed.content;
          if (res.statusCode !== 200 || !text) {
            return reject(new Error(parsed.error || `Gateway error: Status ${res.statusCode}`));
          }
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

// Helper: Call Gemini API directly (DEPRECATED fallback — gateway is the single path)
function callGeminiAPI(prompt, model, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }]
    });

    const modelName = model || 'gemini-1.5-flash';

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1/models/${modelName}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode !== 200) {
            return reject(new Error(parsed.error?.message || `Gemini API error: Status ${res.statusCode}`));
          }
          const textResponse = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!textResponse) {
            return reject(new Error('Empty response from Gemini API'));
          }
          resolve(textResponse);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

// Helper: Call External REST API
function callExternalAPI(url, method, bodyContent) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : require('http');

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'PromptChain-Backend'
        }
      };

      let reqBody = '';
      if (bodyContent && (method === 'POST' || method === 'PUT')) {
        reqBody = typeof bodyContent === 'string' ? bodyContent : JSON.stringify(bodyContent);
        options.headers['Content-Length'] = Buffer.byteLength(reqBody);
      }

      const req = client.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => responseData += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`API responded with status code ${res.statusCode}`));
          } else {
            resolve(responseData);
          }
        });
      });

      req.on('error', (err) => reject(err));
      if (reqBody) req.write(reqBody);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Endpoint: Run Graph Runner
app.post('/api/pipelines/run', async (req, res) => {
  const { nodes = [], connections = [], geminiApiKey, pipelineId } = req.body;

  if (nodes.length === 0) {
    return res.status(400).json({ error: 'Graph has no nodes to execute.' });
  }

  // Create running DB log entry if saving history
  let dbLog = null;
  if (pipelineId) {
    try {
      dbLog = await RunLog.create({
        status: 'RUNNING',
        pipelineId,
        logs: [],
        output: '',
      });
    } catch (err) {
      console.error('Failed to create run log:', err);
    }
  }

  const nodeExecutionOrder = [];
  const logs = [];
  const outputs = {}; // Maps node ID to its output text value

  try {
    // 1. Sort nodes topologically
    const sortedIds = topologicalSort(nodes, connections);
    
    // Sort nodes array based on sorted ids
    const sortedNodes = sortedIds.map(id => nodes.find(n => n.id === id));

    // Helper: get inputs for a specific node
    const getNodeInputs = (nodeId) => {
      const inputs = {};
      connections.forEach(conn => {
        if (conn.toNodeId === nodeId) {
          const value = outputs[conn.fromNodeId] || '';
          inputs[conn.toPortId] = value;
        }
      });
      return inputs;
    };

    // 2. Execute nodes sequentially
    for (const node of sortedNodes) {
      const startTime = Date.now();
      logs.push({
        nodeId: node.id,
        title: node.title || node.type,
        status: 'RUNNING',
        logText: `Starting execution of ${node.type} node...`,
      });

      let nodeOutput = '';
      try {
        const inputs = getNodeInputs(node.id);

        if (node.type === 'input') {
          nodeOutput = node.data?.value || '';
        } 
        
        else if (node.type === 'api_fetch') {
          let fetchUrl = node.data?.url || '';
          // Substitute variables in URL, e.g. {text}
          Object.entries(inputs).forEach(([key, val]) => {
            fetchUrl = fetchUrl.replace(new RegExp(`{${key}}`, 'g'), val);
          });

          if (!fetchUrl) throw new Error('API fetch URL is undefined');

          logs[logs.length - 1].logText += `\nFetching URL: ${fetchUrl}`;
          const rawResponse = await callExternalAPI(fetchUrl, node.data?.method, node.data?.body);
          nodeOutput = rawResponse;
        } 
        
        else if (node.type === 'llm_prompt') {
          let promptText = node.data?.promptTemplate || '';
          // Substitute input variables in template
          Object.entries(inputs).forEach(([key, val]) => {
            promptText = promptText.replace(new RegExp(`{${key}}`, 'g'), val);
          });

          const modelName = node.data?.model || 'gemini-1.5-flash';
          logs[logs.length - 1].logText += `\nSubmitting prompt via agent-os gateway (${modelName})...`;
          let responseText;
          try {
            responseText = await callGatewayLLM(promptText, modelName);
          } catch (gwErr) {
            if (!geminiApiKey) {
              throw new Error(`Gateway unreachable (${gwErr.message}) and no Gemini API key configured. Start agent-os gateway or set key in settings.`);
            }
            logs[logs.length - 1].logText += `\nGateway unreachable, falling back to direct Gemini API...`;
            responseText = await callGeminiAPI(promptText, modelName, geminiApiKey);
          }
          nodeOutput = responseText;
        } 
        
        else if (node.type === 'js_transform') {
          // Default OFF: executing pipeline-authored JS is code execution as a
          // service. Set STUDIO_ALLOW_JS=1 only on an isolated host. Even then
          // vm is not a true boundary (see sandbox.js header).
          if (process.env.STUDIO_ALLOW_JS !== '1') {
            throw new Error('js_transform disabled: set STUDIO_ALLOW_JS=1 on an isolated host to enable.');
          }
          const transformCode = node.data?.code || 'result = inputs.input;';
          logs[logs.length - 1].logText += `\nEvaluating JS transform in sandbox (2s timeout)...`;

          // Sandboxed: vm with frozen context, no require/process (see sandbox.js).
          const result = runTransform(transformCode, inputs);
          nodeOutput = result;
        } 
        
        else if (node.type === 'output') {
          // Output node simply relays its single connection input
          nodeOutput = Object.values(inputs)[0] || '';
        }

        // Execution success
        outputs[node.id] = nodeOutput;
        const duration = Date.now() - startTime;
        
        logs[logs.length - 1] = {
          nodeId: node.id,
          title: node.title || node.type,
          status: 'SUCCESS',
          output: nodeOutput,
          logText: logs[logs.length - 1].logText + `\nCompleted in ${duration}ms.\nOutput size: ${nodeOutput.length} characters.`,
        };
      } catch (nodeErr) {
        // Node failed
        const duration = Date.now() - startTime;
        logs[logs.length - 1] = {
          nodeId: node.id,
          title: node.title || node.type,
          status: 'FAILED',
          error: nodeErr.message,
          logText: logs[logs.length - 1].logText + `\nExecution failed: ${nodeErr.message} (took ${duration}ms)`,
        };
        throw nodeErr; // Stop execution on node failure
      }
    }

    // Final result output
    const outputNodes = nodes.filter(n => n.type === 'output');
    const finalOutput = outputNodes.map(n => outputs[n.id]).join('\n\n') || 'Pipeline ran successfully with no outputs.';

    if (dbLog) {
      dbLog.status = 'SUCCESS';
      dbLog.logs = logs;
      dbLog.output = finalOutput;
      await dbLog.save();
    }

    res.json({ status: 'SUCCESS', finalOutput, logs });
  } catch (error) {
    if (dbLog) {
      dbLog.status = 'FAILED';
      dbLog.logs = logs;
      dbLog.output = error.message;
      await dbLog.save();
    }
    res.status(500).json({ status: 'FAILED', error: error.message, logs });
  }
});

// GET /api/pipelines - List all pipelines
app.get('/api/pipelines', async (req, res) => {
  try {
    const pipelines = await Pipeline.findAll({ order: [['updatedAt', 'DESC']] });
    res.json(pipelines);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/pipelines/:id - Fetch single pipeline with RunLogs
app.get('/api/pipelines/:id', async (req, res) => {
  try {
    const pipeline = await Pipeline.findByPk(req.params.id, {
      include: [{ model: RunLog, as: 'logs', limit: 10, order: [['createdAt', 'DESC']] }]
    });
    if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
    res.json(pipeline);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/pipelines - Save/Create/Update pipeline
app.post('/api/pipelines', async (req, res) => {
  try {
    const { id, name, description, graphData } = req.body;
    if (!name) return res.status(400).json({ error: 'Pipeline Name is required.' });

    let pipeline;
    if (id) {
      pipeline = await Pipeline.findByPk(id);
      if (pipeline) {
        pipeline.name = name;
        pipeline.description = description || '';
        pipeline.graphData = graphData || pipeline.graphData;
        await pipeline.save();
      }
    }

    if (!pipeline) {
      pipeline = await Pipeline.create({
        name,
        description: description || '',
        graphData: graphData || { nodes: [], connections: [] }
      });
    }

    res.status(201).json(pipeline);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/pipelines/:id - Delete pipeline
app.delete('/api/pipelines/:id', async (req, res) => {
  try {
    const pipeline = await Pipeline.findByPk(req.params.id);
    if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });

    await pipeline.destroy();
    res.json({ message: 'Pipeline deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sync database and start Express (TLS opt-in like the other servers)
sequelize.sync().then(() => {
  const cert = process.env.TLS_CERT || '', key = process.env.TLS_KEY || '';
  const start = () => console.log(`Server is running on ${cert && key ? 'https' : 'http'}://localhost:${PORT}`);
  if (cert && key) {
    require('https').createServer({ cert: require('fs').readFileSync(cert), key: require('fs').readFileSync(key) }, app).listen(PORT, start);
  } else {
    app.listen(PORT, start);
  }
}).catch(err => {
  console.error('Unable to connect to SQLite database:', err);
});
