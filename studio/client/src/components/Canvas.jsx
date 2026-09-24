import React, { useState, useRef, useEffect } from 'react';
import NodeCard from './NodeCard';

function Canvas({ nodes, setNodes, connections, setConnections, activeNodeId, logs }) {
  const canvasRef = useRef(null);
  
  // Dragging node state
  const [draggingNode, setDraggingNode] = useState(null); // { id, startX, startY, offsetX, offsetY }
  
  // Drawing connection state
  const [activePort, setActivePort] = useState(null); // { nodeId, portType, portId, x, y }
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  // Update mouse position on canvas when drawing connections
  const handleMouseMove = (e) => {
    if (draggingNode) {
      const rect = canvasRef.current.getBoundingClientRect();
      const scrollLeft = canvasRef.current.scrollLeft;
      const scrollTop = canvasRef.current.scrollTop;
      
      const newX = e.clientX - rect.left - draggingNode.offsetX + scrollLeft;
      const newY = e.clientY - rect.top - draggingNode.offsetY + scrollTop;
      
      // Keep nodes inside canvas boundaries
      const boundedX = Math.max(0, Math.min(newX, 1900));
      const boundedY = Math.max(0, Math.min(newY, 1900));

      setNodes(prev => prev.map(node => {
        if (node.id === draggingNode.id) {
          return { ...node, x: boundedX, y: boundedY };
        }
        return node;
      }));
    } else if (activePort) {
      const rect = canvasRef.current.getBoundingClientRect();
      const scrollLeft = canvasRef.current.scrollLeft;
      const scrollTop = canvasRef.current.scrollTop;
      
      setMousePos({
        x: e.clientX - rect.left + scrollLeft,
        y: e.clientY - rect.top + scrollTop
      });
    }
  };

  const handleMouseUp = () => {
    if (draggingNode) {
      setDraggingNode(null);
    }
    if (activePort) {
      setActivePort(null);
    }
  };

  // Node Drag Start
  const handleNodeDragStart = (e, node) => {
    // Only drag when clicking headers, not input elements
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.closest('.port') || e.target.closest('.node-delete-btn')) {
      return;
    }
    
    const rect = canvasRef.current.getBoundingClientRect();
    const scrollLeft = canvasRef.current.scrollLeft;
    const scrollTop = canvasRef.current.scrollTop;
    
    const mouseX = e.clientX - rect.left + scrollLeft;
    const mouseY = e.clientY - rect.top + scrollTop;

    setDraggingNode({
      id: node.id,
      offsetX: mouseX - node.x,
      offsetY: mouseY - node.y
    });
  };

  // Port connection start
  const handlePortMouseDown = (e, nodeId, portType, portId) => {
    e.stopPropagation();
    e.preventDefault();
    
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const portRect = e.target.getBoundingClientRect();
    
    const x = portRect.left - canvasRect.left + (portRect.width / 2) + canvasRef.current.scrollLeft;
    const y = portRect.top - canvasRect.top + (portRect.height / 2) + canvasRef.current.scrollTop;

    setActivePort({
      nodeId,
      portType,
      portId,
      x,
      y
    });
    setMousePos({ x, y });
  };

  // Port connection drop (complete)
  const handlePortMouseUp = (e, targetNodeId, targetPortType, targetPortId) => {
    e.stopPropagation();
    if (!activePort) return;
    
    const sourceNodeId = activePort.nodeId;
    const sourcePortType = activePort.portType;
    const sourcePortId = activePort.portId;

    // Validation: Output can connect to Input, but not input-to-input or output-to-output
    if (sourcePortType === targetPortType) {
      setActivePort(null);
      return;
    }

    const fromNodeId = sourcePortType === 'output' ? sourceNodeId : targetNodeId;
    const fromPortId = sourcePortType === 'output' ? sourcePortId : targetPortId;
    const toNodeId = sourcePortType === 'input' ? sourceNodeId : targetNodeId;
    const toPortId = sourcePortType === 'input' ? sourcePortId : targetPortId;

    // Validation: Cannot connect node to itself
    if (fromNodeId === toNodeId) {
      setActivePort(null);
      return;
    }

    // Validation: Prevent duplicate connections on same input port
    const duplicate = connections.some(c => c.toNodeId === toNodeId && c.toPortId === toPortId);
    if (duplicate) {
      alert('Input port is already linked to another connection.');
      setActivePort(null);
      return;
    }

    const newConnection = {
      id: `conn_${Math.random().toString(36).substr(2, 9)}`,
      fromNodeId,
      fromPortId,
      toNodeId,
      toPortId
    };

    setConnections(prev => [...prev, newConnection]);
    setActivePort(null);
  };

  // Delete node and its connections
  const handleDeleteNode = (nodeId) => {
    setNodes(prev => prev.filter(n => n.id !== nodeId));
    setConnections(prev => prev.filter(c => c.fromNodeId !== nodeId && c.toNodeId !== nodeId));
  };

  // Delete individual connection
  const handleDeleteConnection = (connId) => {
    setConnections(prev => prev.filter(c => c.id !== connId));
  };

  // Node data changes
  const handleNodeDataChange = (nodeId, key, value) => {
    setNodes(prev => prev.map(node => {
      if (node.id === nodeId) {
        return {
          ...node,
          data: {
            ...node.data,
            [key]: value
          }
        };
      }
      return node;
    }));
  };

  // Compute connections path coordinates dynamically based on node coordinates
  // Nodes have ports: inputs on the left, output on the right
  // We approximate the height of node card types to get exact center points
  const getConnectionCoordinates = (conn) => {
    const fromNode = nodes.find(n => n.id === conn.fromNodeId);
    const toNode = nodes.find(n => n.id === conn.toNodeId);

    if (!fromNode || !toNode) return null;

    // Approximate card heights: input=130, prompt=180, api=230, transform=200, output=100
    const nodeHeights = { input: 110, llm_prompt: 155, api_fetch: 215, js_transform: 185, output: 95 };
    
    const fromHeight = nodeHeights[fromNode.type] || 150;
    const toHeight = nodeHeights[toNode.type] || 150;

    // Output port: middle-right of card
    const x1 = fromNode.x + 280;
    const y1 = fromNode.y + (fromHeight / 2) + 22; // Offset for header title height offset

    // Input port: middle-left of card
    const x2 = toNode.x;
    const y2 = toNode.y + (toHeight / 2) + 22;

    return { x1, y1, x2, y2 };
  };

  // Compute Bezier Curve path between two points
  const getBezierPath = (x1, y1, x2, y2) => {
    const controlOffset = Math.max(Math.abs(x2 - x1) * 0.5, 40);
    return `M ${x1} ${y1} C ${x1 + controlOffset} ${y1}, ${x2 - controlOffset} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div 
      ref={canvasRef}
      className="canvas-container"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <div className="canvas-nodes-wrapper">
        {/* Draw connections */}
        <svg className="svg-connections-layer">
          {connections.map(conn => {
            const coords = getConnectionCoordinates(conn);
            if (!coords) return null;
            
            const path = getBezierPath(coords.x1, coords.y1, coords.x2, coords.y2);
            
            return (
              <g key={conn.id} className="connection-group">
                <path 
                  d={path} 
                  className="connection-path"
                  onClick={() => handleDeleteConnection(conn.id)}
                  style={{ cursor: 'pointer', pointerEvents: 'visibleStroke' }}
                  title="Click connection to delete"
                />
              </g>
            );
          })}

          {/* Active drawing connection line */}
          {activePort && (
            <path 
              d={getBezierPath(activePort.x, activePort.y, mousePos.x, mousePos.y)}
              className="connection-path drawing"
            />
          )}
        </svg>

        {/* Nodes list */}
        {nodes.map(node => {
          // Check execution log status
          const logEntry = logs.find(l => l.nodeId === node.id);
          const status = logEntry ? logEntry.status : '';

          return (
            <NodeCard 
              key={node.id} 
              node={node}
              status={status}
              onDragStart={(e) => handleNodeDragStart(e, node)}
              onPortMouseDown={handlePortMouseDown}
              onPortMouseUp={handlePortMouseUp}
              onDelete={() => handleDeleteNode(node.id)}
              onDataChange={(key, value) => handleNodeDataChange(node.id, key, value)}
            />
          );
        })}
      </div>
    </div>
  );
}

export default Canvas;
