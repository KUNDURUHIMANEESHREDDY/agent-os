import React, { useState, useEffect } from 'react';
import Canvas from './components/Canvas';
import LogsConsole from './components/LogsConsole';
import { 
  fetchPipelines, 
  fetchPipeline, 
  savePipeline, 
  deletePipeline, 
  runPipeline 
} from './api';
import { 
  Play, 
  Save, 
  Trash2, 
  Key, 
  Layers, 
  FileText, 
  Cpu, 
  Globe, 
  Brackets, 
  Terminal,
  Activity,
  Plus,
  Sun,
  Moon
} from 'lucide-react';

const NODE_TEMPLATES = [
  { type: 'input', name: 'Text Input', desc: 'Static text input or variable values', icon: FileText, colorClass: 'icon-box-input' },
  { type: 'llm_prompt', name: 'LLM Prompt', desc: 'Template block invoking Gemini 1.5 Flash', icon: Cpu, colorClass: 'icon-box-prompt' },
  { type: 'api_fetch', name: 'API Fetch', desc: 'Performs external REST request', icon: Globe, colorClass: 'icon-box-fetch' },
  { type: 'js_transform', name: 'JS Transform', desc: 'Evaluates javascript variables', icon: Brackets, colorClass: 'icon-box-transform' },
  { type: 'output', name: 'Output Terminal', desc: 'Renders the final text result', icon: Terminal, colorClass: 'icon-box-output' }
];

function App() {
  // Pipelines state
  const [pipelinesList, setPipelinesList] = useState([]);
  const [currentPipelineId, setCurrentPipelineId] = useState('');
  const [pipelineName, setPipelineName] = useState('My AI Pipeline');
  const [pipelineDesc, setPipelineDesc] = useState('');
  
  // Graph state
  const [nodes, setNodes] = useState([]);
  const [connections, setConnections] = useState([]);
  
  // Theme state
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  
  // Execution status
  const [geminiApiKey, setGeminiApiKey] = useState(localStorage.getItem('gemini_api_key') || '');
  const [isRunning, setIsRunning] = useState(false);
  const [activeNodeId, setActiveNodeId] = useState(null);
  const [logs, setLogs] = useState([]);
  const [finalOutput, setFinalOutput] = useState('');

  // Sync Theme with DOM
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  // Initial load
  useEffect(() => {
    loadPipelinesList();
  }, []);

  // Save API key
  const handleApiKeyChange = (e) => {
    const key = e.target.value;
    setGeminiApiKey(key);
    localStorage.setItem('gemini_api_key', key);
  };

  const loadPipelinesList = async () => {
    try {
      const data = await fetchPipelines();
      setPipelinesList(data);
    } catch (err) {
      console.error('Failed to load pipelines:', err);
    }
  };

  const handleSelectPipeline = async (e) => {
    const id = e.target.value;
    setCurrentPipelineId(id);
    if (!id) {
      // Clear workspace
      setNodes([]);
      setConnections([]);
      setPipelineName('My AI Pipeline');
      setPipelineDesc('');
      return;
    }

    try {
      const p = await fetchPipeline(id);
      setPipelineName(p.name);
      setPipelineDesc(p.description || '');
      const graph = p.graphData || { nodes: [], connections: [] };
      setNodes(graph.nodes || []);
      setConnections(graph.connections || []);
      setLogs([]);
      setFinalOutput('');
    } catch (err) {
      console.error(err);
    }
  };

  // Add node helper
  const handleAddNode = (type) => {
    const id = `${type}_${Math.random().toString(36).substr(2, 9)}`;
    const defaultPositions = {
      input: { x: 80, y: 150 },
      api_fetch: { x: 120, y: 350 },
      llm_prompt: { x: 400, y: 200 },
      js_transform: { x: 420, y: 450 },
      output: { x: 750, y: 300 }
    };
    const pos = defaultPositions[type] || { x: 200, y: 200 };
    
    // Add offset slightly if matching nodes exist
    const count = nodes.filter(n => n.type === type).length;
    const position = {
      x: pos.x + (count * 25),
      y: pos.y + (count * 20)
    };

    const defaultData = {
      input: { value: 'Enter input text here...' },
      llm_prompt: { promptTemplate: 'Summarize this in one sentence:\n\n{text}' },
      api_fetch: { url: 'https://catfact.ninja/fact', method: 'GET', body: '' },
      js_transform: { code: '// inputs.text contains output from linked node\nreturn inputs.text.toUpperCase();' },
      output: {}
    };

    const newNode = {
      id,
      type,
      title: `${NODE_TEMPLATES.find(t => t.type === type).name} ${count + 1}`,
      x: position.x,
      y: position.y,
      data: defaultData[type]
    };

    setNodes(prev => [...prev, newNode]);
  };

  // Save layout to database
  const handleSavePipeline = async () => {
    if (!pipelineName.trim()) return alert('Please enter a pipeline name.');
    try {
      const payload = {
        id: currentPipelineId || undefined,
        name: pipelineName.trim(),
        description: pipelineDesc,
        graphData: { nodes, connections }
      };
      const saved = await savePipeline(payload);
      setCurrentPipelineId(saved.id);
      loadPipelinesList();
      alert('Pipeline saved successfully!');
    } catch (err) {
      console.error(err);
      alert('Error saving pipeline.');
    }
  };

  // Delete pipeline
  const handleDeletePipeline = async () => {
    if (!currentPipelineId) return;
    if (!window.confirm('Are you sure you want to delete this pipeline?')) return;
    try {
      await deletePipeline(currentPipelineId);
      setCurrentPipelineId('');
      setNodes([]);
      setConnections([]);
      setPipelineName('My AI Pipeline');
      setPipelineDesc('');
      loadPipelinesList();
    } catch (err) {
      console.error(err);
    }
  };

  // Run pipeline
  const handleRunPipeline = async () => {
    if (nodes.length === 0) return alert('Graph must contain nodes to run.');
    
    // Check if Gemini key is present if there are prompt nodes
    const hasPromptNode = nodes.some(n => n.type === 'llm_prompt');
    if (hasPromptNode && !geminiApiKey.trim()) {
      return alert('Your pipeline contains an LLM Prompt node. Please configure your Gemini API Key first.');
    }

    setIsRunning(true);
    setFinalOutput('');
    setLogs([{ status: 'RUNNING', title: 'System', logText: 'Validating connection graph...' }]);

    try {
      const response = await runPipeline({
        nodes,
        connections,
        geminiApiKey,
        pipelineId: currentPipelineId || undefined
      });

      setLogs(response.logs || []);
      if (response.status === 'SUCCESS') {
        setFinalOutput(response.finalOutput || '');
      } else {
        setFinalOutput(`Execution Failed:\n\n${response.error}`);
      }
    } catch (err) {
      console.error(err);
      setFinalOutput(`Server connection error during execution.`);
    } finally {
      setIsRunning(false);
      setActiveNodeId(null);
    }
  };

  return (
    <div className="app-container">
      {/* Topbar Navigation */}
      <header className="topbar glassmorphism">
        <div className="logo-section">
          <div className="logo-badge">
            <Layers size={18} className="logo-icon" />
          </div>
          <span className="logo-text">PromptChain</span>
        </div>

        <div className="pipeline-meta">
          <select 
            value={currentPipelineId} 
            onChange={handleSelectPipeline}
            className="pipeline-select"
          >
            <option value="">-- Create New Pipeline --</option>
            {pipelinesList.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <input 
            type="text" 
            placeholder="Pipeline name..." 
            value={pipelineName}
            onChange={(e) => setPipelineName(e.target.value)}
            className="pipeline-name-input"
          />
        </div>

        <div className="topbar-actions">
          {/* API Key Panel */}
          <div className="api-key-input-wrapper">
            <Key size={14} className="key-icon" />
            <input 
              type="password" 
              placeholder="Gemini API Key..." 
              value={geminiApiKey}
              onChange={handleApiKeyChange}
              className="api-key-input"
            />
          </div>

          {/* Theme Toggler */}
          <button 
            className="btn flex-center" 
            onClick={toggleTheme} 
            style={{ width: '38px', height: '38px', padding: 0, backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}
            title="Toggle Light/Dark Theme"
          >
            {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>

          <button className="btn btn-save" onClick={handleSavePipeline}>
            <Save size={16} />
            <span>Save Graph</span>
          </button>

          {currentPipelineId && (
            <button className="btn btn-delete-pipeline" onClick={handleDeletePipeline}>
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </header>

      {/* Workspace Area */}
      <div className="studio-body">
        {/* Left Library Sidebar */}
        <aside className="library-panel">
          <div>
            <h3 className="panel-title">Node Library</h3>
            <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Click node templates to add them to your canvas.
            </p>
          </div>

          <div className="node-lib-list">
            {NODE_TEMPLATES.map(temp => (
              <button 
                key={temp.type} 
                className="lib-node-item"
                onClick={() => handleAddNode(temp.type)}
              >
                <div className={`lib-icon-box ${temp.colorClass}`}>
                  <temp.icon size={16} />
                </div>
                <div className="lib-node-info">
                  <span className="lib-node-name">{temp.name}</span>
                  <span className="lib-node-desc">{temp.desc}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Center Node Grid Canvas */}
        <Canvas 
          nodes={nodes} 
          setNodes={setNodes} 
          connections={connections} 
          setConnections={setConnections}
          activeNodeId={activeNodeId}
          logs={logs}
        />

        {/* Right Execution & Logs Console Panel */}
        <aside className="ops-panel glassmorphism">
          <div className="ops-panel-section">
            <h3 className="panel-title" style={{ marginBottom: '16px' }}>Controls</h3>
            <div className="run-btn-wrapper">
              <button 
                className="btn btn-run" 
                onClick={handleRunPipeline}
                disabled={isRunning}
              >
                <Play size={16} fill="#fff" />
                <span>{isRunning ? 'Running...' : 'Execute Pipeline'}</span>
              </button>
            </div>
          </div>

          <div className="ops-panel-section">
            <h3 className="panel-title">Logs Output</h3>
            <LogsConsole logs={logs} isRunning={isRunning} />
          </div>

          <div className="ops-panel-section">
            <h3 className="panel-title">Final Output</h3>
            <div className="output-pane-wrapper">
              <textarea 
                readOnly 
                value={finalOutput} 
                placeholder="Final output text renders here..."
                className="output-textarea"
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default App;
