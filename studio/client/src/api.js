const API_BASE_URL = 'http://localhost:5000/api';

export async function fetchPipelines() {
  const res = await fetch(`${API_BASE_URL}/pipelines`);
  if (!res.ok) throw new Error('Failed to fetch pipelines');
  return res.json();
}

export async function fetchPipeline(id) {
  const res = await fetch(`${API_BASE_URL}/pipelines/${id}`);
  if (!res.ok) throw new Error('Failed to fetch pipeline details');
  return res.json();
}

export async function savePipeline(pipelineData) {
  const res = await fetch(`${API_BASE_URL}/pipelines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pipelineData)
  });
  if (!res.ok) throw new Error('Failed to save pipeline');
  return res.json();
}

export async function deletePipeline(id) {
  const res = await fetch(`${API_BASE_URL}/pipelines/${id}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error('Failed to delete pipeline');
  return res.json();
}

export async function runPipeline(runData) {
  const res = await fetch(`${API_BASE_URL}/pipelines/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(runData)
  });
  // Note: run endpoint can return 500 on execution error, 
  // but it returns logs in the response, so we still parse it as JSON
  const data = await res.json();
  return data;
}
