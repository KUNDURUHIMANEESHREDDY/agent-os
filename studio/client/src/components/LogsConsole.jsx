import React, { useEffect, useRef } from 'react';

function LogsConsole({ logs = [], isRunning }) {
  const consoleEndRef = useRef(null);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  return (
    <div className="console-wrapper">
      <div className="console-terminal">
        {logs.length === 0 ? (
          <div className="console-empty-state flex-center" style={{ height: '100%' }}>
            <span>Click "Execute Pipeline" to run your prompt chain.</span>
          </div>
        ) : (
          logs.map((log, idx) => (
            <div key={idx} className="console-entry">
              <header className="console-header-line">
                <span className="console-node-title">{log.title}</span>
                <span className={`console-node-status ${log.status.toLowerCase()}`}>
                  {log.status}
                </span>
              </header>
              {log.logText && (
                <pre className="console-text-body">
                  {log.logText}
                </pre>
              )}
              {log.error && (
                <pre className="console-text-body" style={{ color: 'var(--accent-rose)', borderLeftColor: 'var(--accent-rose)' }}>
                  {log.error}
                </pre>
              )}
            </div>
          ))
        )}
        <div ref={consoleEndRef} />
      </div>
    </div>
  );
}

export default LogsConsole;
