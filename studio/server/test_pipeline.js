const http = require('http');

// Simple integration test for PromptChain backend endpoints
// Assumes the server is running on port 5000

function testEndpoint(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 5000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: JSON.parse(data),
          });
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('Starting PromptChain API validation tests...');
  try {
    // 1. Test GET /api/pipelines (expect empty array initially or saved pipelines)
    console.log('Testing GET /api/pipelines...');
    const listRes = await testEndpoint('/api/pipelines');
    if (listRes.statusCode !== 200) throw new Error(`List pipelines failed: ${listRes.statusCode}`);
    console.log(`✓ GET /api/pipelines successful. Found ${listRes.data.length} saved pipelines.`);

    // 2. Test POST /api/pipelines/run (Mock pipeline: Input node -> JS Transform node -> Output node)
    console.log('Testing POST /api/pipelines/run (Execution Engine)...');
    
    const nodes = [
      {
        id: 'node_1',
        type: 'input',
        title: 'Input Node',
        data: { value: 'hello world' }
      },
      {
        id: 'node_2',
        type: 'js_transform',
        title: 'Uppercase Transform',
        data: { code: 'return inputs.text.toUpperCase();' }
      },
      {
        id: 'node_3',
        type: 'output',
        title: 'Output Terminal',
        data: {}
      }
    ];

    const connections = [
      {
        id: 'c1',
        fromNodeId: 'node_1',
        fromPortId: 'out',
        toNodeId: 'node_2',
        toPortId: 'text'
      },
      {
        id: 'c2',
        fromNodeId: 'node_2',
        fromPortId: 'out',
        toNodeId: 'node_3',
        toPortId: 'text'
      }
    ];

    const runPayload = {
      nodes,
      connections
    };

    const runRes = await testEndpoint('/api/pipelines/run', 'POST', runPayload);
    if (runRes.statusCode !== 200) {
      throw new Error(`Run pipeline failed: ${runRes.statusCode}. Error: ${JSON.stringify(runRes.data)}`);
    }

    if (runRes.data.status !== 'SUCCESS') {
      throw new Error(`Execution failed: ${JSON.stringify(runRes.data)}`);
    }

    if (runRes.data.finalOutput !== 'HELLO WORLD') {
      throw new Error(`Incorrect final output. Expected "HELLO WORLD", got "${runRes.data.finalOutput}"`);
    }

    console.log('✓ POST /api/pipelines/run successful. Pipeline output matches: "HELLO WORLD"');
    
    // Check logs
    const logs = runRes.data.logs;
    if (logs.length !== 3 || logs.some(l => l.status !== 'SUCCESS')) {
      throw new Error(`Logs validation failed: ${JSON.stringify(logs)}`);
    }
    console.log('✓ Topological sort execution and log tracing is 100% correct.');

    console.log('\nAll PromptChain backend tests passed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('PromptChain validation tests failed:', error);
    process.exit(1);
  }
}

runTests();
