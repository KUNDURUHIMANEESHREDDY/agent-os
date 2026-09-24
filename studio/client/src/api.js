const API_BASE_URL = 'http://localhost:5000/api';

// Bearer token for the studio server (AGENT_OS_TOKEN from agent-os/.env).
// Stored in sessionStorage so a page reload re-prompts instead of persisting.
function token() {
  let t = sessionStorage.getItem('agent_os_token') || '';
  if (!t) {
    // window.prompt throws in embedded/automated/sandboxed contexts. Never let
    // that rejection escape: it used to break every request and silently empty
    // the UI. Fall back to an explicit, actionable error instead.
    let entered = null;
    try {
      entered = window.prompt('agent-os token (AGENT_OS_TOKEN from agent-os/.env):');
    } catch {
      entered = null;
    }
    t = (entered || '').trim();
    if (t) {
      sessionStorage.setItem('agent_os_token', t);
    } else {
      throw new Error(
        'AGENT_OS_TOKEN required. window.prompt is unavailable here — set it manually via ' +
        "sessionStorage.setItem('agent_os_token', '<token>') in the console, or use the token field."
      );
    }
  }
  return t;
}

async function req(path, opts = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    sessionStorage.removeItem('agent_os_token');
    throw new Error('Unauthorized (401): wrong AGENT_OS_TOKEN — reload and retry');
  }
  return res;
}

export async function fetchPipelines() {
  const res = await req('/pipelines');
  if (!res.ok) throw new Error('Failed to fetch pipelines');
  return res.json();
}

export async function fetchPipeline(id) {
  const res = await req(`/pipelines/${id}`);
  if (!res.ok) throw new Error('Failed to fetch pipeline details');
  return res.json();
}

export async function savePipeline(pipelineData) {
  const res = await req('/pipelines', {
    method: 'POST',
    body: JSON.stringify(pipelineData)
  });
  if (!res.ok) throw new Error('Failed to save pipeline');
  return res.json();
}

export async function deletePipeline(id) {
  const res = await req(`/pipelines/${id}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error('Failed to delete pipeline');
  return res.json();
}

export async function runPipeline(runData) {
  const res = await req('/pipelines/run', {
    method: 'POST',
    body: JSON.stringify(runData)
  });
  // Note: run endpoint can return 500 on execution error,
  // but it returns logs in the response, so we still parse it as JSON
  const data = await res.json();
  return data;
}
