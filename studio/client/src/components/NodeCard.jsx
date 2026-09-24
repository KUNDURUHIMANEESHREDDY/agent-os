import React from 'react';
import { X, Play, AlertCircle, CheckCircle } from 'lucide-react';

function NodeCard({ 
  node, 
  status, 
  onDragStart, 
  onPortMouseDown, 
  onPortMouseUp, 
  onDelete, 
  onDataChange 
}) {
  const { id, type, title, x, y, data = {} } = node;

  const getStatusClass = () => {
    if (status === 'RUNNING') return 'executing';
    if (status === 'SUCCESS') return 'success';
    if (status === 'FAILED') return 'failed';
    return '';
  };

  const getHeaderColorClass = () => {
    return `node-header node-${type}`;
  };

  // Node Input/Output Ports Rendering Configuration
  // Input: has output port only
  // Output: has input port only
  // Prompt/Fetch/Transform: has both input and output ports
  const hasInputPort = type !== 'input';
  const hasOutputPort = type !== 'output';

  return (
    <div 
      className={`node-card ${getStatusClass()}`}
      style={{ left: `${x}px`, top: `${y}px` }}
      onMouseDown={onDragStart}
    >
      {/* Node Drag Handle Header */}
      <header className={getHeaderColorClass()}>
        <span className="node-header-title">
          {status === 'RUNNING' && <Play size={12} className="anim-pulse" style={{ color: 'var(--accent-amber)' }} />}
          {status === 'SUCCESS' && <CheckCircle size={12} style={{ color: 'var(--accent-green)' }} />}
          {status === 'FAILED' && <AlertCircle size={12} style={{ color: 'var(--accent-rose)' }} />}
          {title}
        </span>
        <button className="node-delete-btn flex-center" onClick={onDelete}>
          <X size={12} />
        </button>
      </header>

      {/* Node Body with Forms */}
      <div className="node-body">
        {/* Left Input Port */}
        {hasInputPort && (
          <div 
            id={`port-in-${id}`}
            className="port input-port"
            onMouseDown={(e) => onPortMouseDown(e, id, 'input', 'text')}
            onMouseUp={(e) => onPortMouseUp(e, id, 'input', 'text')}
            title="Link source outputs to this input"
          ></div>
        )}

        {/* Right Output Port */}
        {hasOutputPort && (
          <div 
            id={`port-out-${id}`}
            className="port output-port"
            onMouseDown={(e) => onPortMouseDown(e, id, 'output', 'out')}
            onMouseUp={(e) => onPortMouseUp(e, id, 'output', 'out')}
            title="Link this output to target inputs"
          ></div>
        )}

        {/* Dynamic Form Controls */}
        {type === 'input' && (
          <div className="node-form-group">
            <label className="node-label">Static Value</label>
            <textarea 
              value={data.value || ''} 
              onChange={(e) => onDataChange('value', e.target.value)}
              placeholder="Type initial string..."
              rows={2}
              className="node-textarea"
            />
          </div>
        )}

        {type === 'llm_prompt' && (
          <div className="node-form-group">
            <label className="node-label">Prompt Template (use {`{text}`})</label>
            <textarea 
              value={data.promptTemplate || ''} 
              onChange={(e) => onDataChange('promptTemplate', e.target.value)}
              placeholder="e.g. Write a summary of {text}"
              rows={3}
              className="node-textarea"
            />
            <label className="node-label" style={{ marginTop: '4px' }}>Model</label>
            <select 
              className="node-select" 
              value={data.model || 'gemini-1.5-flash'}
              onChange={(e) => onDataChange('model', e.target.value)}
            >
              <option value="gemini-1.5-flash">gemini-1.5-flash</option>
              <option value="gemini-1.5-pro">gemini-1.5-pro</option>
              <option value="gemini-2.5-flash">gemini-2.5-flash</option>
            </select>
          </div>
        )}

        {type === 'api_fetch' && (
          <div className="node-form-group">
            <label className="node-label">REST API URL</label>
            <input 
              type="text" 
              value={data.url || ''} 
              onChange={(e) => onDataChange('url', e.target.value)}
              placeholder="e.g. https://api.com/data"
              className="node-input-text"
            />
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '4px' }}>
              <div>
                <label className="node-label">Method</label>
                <select 
                  value={data.method || 'GET'} 
                  onChange={(e) => onDataChange('method', e.target.value)}
                  className="node-select"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {type === 'js_transform' && (
          <div className="node-form-group">
            <label className="node-label">JS Transform Snippet</label>
            <textarea 
              value={data.code || ''} 
              onChange={(e) => onDataChange('code', e.target.value)}
              placeholder="return inputs.text.trim();"
              rows={4}
              className="node-textarea"
              style={{ fontFamily: 'JetBrains Mono', fontSize: '10px' }}
            />
          </div>
        )}

        {type === 'output' && (
          <div className="node-form-group" style={{ textAlign: 'center', padding: '8px 0' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              Linked output stream will print to console.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default NodeCard;
