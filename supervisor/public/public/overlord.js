// OVERLORD client — server-driven. All pipeline state comes from /api/stream.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const stamp = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const esc = (s) => String(s)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

/* ---------- logs ---------- */
let logs = [], filter = "all";
function addLocal(type, actor, message, time) { logs.push({ time: time || stamp(), type, actor, message }); renderLogs(); }
function renderLogs() {
  const q = $("#logSearch").value.toLowerCase();
  const vis = logs.filter((x) => (filter === "all" || x.type === filter) && (!q || (x.actor + " " + x.message).toLowerCase().includes(q)));
  $("#logs").innerHTML = vis.slice(-40).reverse().map((x) =>
    `<div class="log"><time>${x.time}</time><div class="body"><span class="badge ${x.type}">${esc(x.actor)}</span><p>${esc(x.message)}</p></div></div>`).join("") ||
    '<div style="padding:22px;color:#9ca3af;font-size:10px">No matching events.</div>';
  $("#fullLogs").innerHTML = logs.slice().reverse().map((x) =>
    `<div class="full-log"><time>${x.time}</time><strong>${esc(x.actor)}</strong><span>${esc(x.message)}</span></div>`).join("");
}
$$(".log-tabs button").forEach((b) => (b.onclick = () => {
  $$(".log-tabs button").forEach((x) => x.classList.remove("active"));
  b.classList.add("active"); filter = b.dataset.filter; renderLogs();
}));
$("#logSearch").oninput = renderLogs;
$("#clearLogs").onclick = async () => { await api("DELETE", "/api/logs").catch(() => {}); logs = []; renderLogs(); };
$("#expandLogs").onclick = () => { renderLogs(); $("#overlay").classList.add("open"); };
$("#overlay").onclick = (e) => { if (e.target.id === "overlay") $("#overlay").classList.remove("open"); };
$("#closeModal").onclick = () => $("#overlay").classList.remove("open");
if ($("#exportBtn")) {
  $("#exportBtn").onclick = async () => {
    const d = await api("GET", "/api/logs?limit=1000").catch(() => ({ logs }));
    const blob = new Blob([JSON.stringify(d.logs || d, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "overlord-event-log.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

/* ---------- sessions ---------- */
$$(".session").forEach((s) => (s.onclick = () => { $$(".session").forEach((x) => x.classList.remove("active")); s.classList.add("active"); }));
$("#sessionSearch").oninput = (e) => {
  const q = e.target.value.toLowerCase();
  $$(".session").forEach((s) => (s.style.display = s.innerText.toLowerCase().includes(q) ? "block" : "none"));
};
function clearWorkspace() {
  const thread = $("#conversationThread") || $(".conversation");
  if (thread) thread.innerHTML = "";
  removeThinking();
  ROWS.forEach((_, i) => { setBar(i, 0); setState(i, "", "Ready"); });
  setDesc(0, "Idle"); setDesc(1, "Idle"); setDesc(2, "Idle");
  const el = $("#trace");
  if (el) el.innerHTML = `<span style="color:var(--muted)">Waiting for instructions...</span>`;
}

$("#newSession").onclick = () => {
  const ns = $("#noSessions"); if (ns) ns.remove();
  const s = document.createElement("button");
  s.className = "session active";
  s.innerHTML = '<div class="row"><strong>New agent session</strong><time>Now</time></div><p>Ready for a new task</p>';
  s.onclick = () => { $$(".session").forEach((x) => x.classList.remove("active")); s.classList.add("active"); clearWorkspace(); };
  $("#sessionList").prepend(s);
  clearWorkspace();
};

/* ---------- pipeline rendering (driven by server events) ---------- */
const ROWS = [
  { match: ["research"], bar: "#p1", pct: "#pct1" },
  { match: ["code", "exec"], bar: "#p2", pct: "#pct2" },
  { match: ["review"], bar: "#p3", pct: "#pct3" },
];
const CAPS = ["research", "code", "exec", "review"];
function capOf(agent) {
  if (agent.startsWith("spawn-")) return agent.split("-")[1] || "";
  return { researcher: "research", coder: "code", tools: "exec", critic: "review" }[agent] || "";
}
function rowFor(agent) {
  const c = capOf(agent);
  const i = ROWS.findIndex((r) => r.match.includes(c));
  return i < 0 ? null : { i, ...ROWS[i] };
}
const timers = {};
function ensureTraceCard() {
  let el = $("#trace");
  if (el) return el;
  const thread = $("#conversationThread") || $(".conversation");
  if (!thread) return null;
  thread.insertAdjacentHTML("beforeend", `
    <div class="sup-trace" id="supTraceCard">
      <div class="sup-trace-head"><span class="dot"></span><span>Supervisor thinking</span><span style="margin-left:auto;text-transform:none;letter-spacing:0;font-weight:500">live reasoning</span></div>
      <div class="sup-trace-body" id="trace"></div>
    </div>
  `);
  scrollChat();
  return $("#trace");
}
function trace(line) {
  const el = ensureTraceCard();
  if (el) { el.insertAdjacentHTML("beforeend", `<div class="t-line"><time>${stamp()}</time><span>${esc(line)}</span></div>`); scrollChat(); }
}
function setState(i, cls, label) {
  const s = $$(".assignment .state")[i];
  if (s) { s.innerHTML = "<span class='dot'></span>" + esc(label); s.className = "state " + cls; }
}
function setBar(i, p) { if ($(ROWS[i]?.bar)) { $(ROWS[i].bar).style.width = p + "%"; $(ROWS[i].pct).textContent = p + "%"; } }
function setDesc(i, t) { if ($$(".progress-desc")[i]) $$(".progress-desc")[i].textContent = t; }
function progressStatus() {
  const done = $$(".assignment .state.done").length;
  if ($("#progressStatus")) $("#progressStatus").textContent = done + " of 3 complete";
}
function startBar(i) {
  stopBar(i);
  let p = parseInt($(ROWS[i]?.bar)?.style.width) || 0;
  timers[i] = setInterval(() => { p = Math.min(92, p + 2); setBar(i, p); }, 120);
}
function stopBar(i, done) {
  clearInterval(timers[i]);
  if (done) setBar(i, 100);
}

function scrollChat() {
  const canvas = $(".canvas");
  if (canvas) canvas.scrollTop = canvas.scrollHeight;
}

function showThinking(modelName) {
  removeThinking();
  const thread = $("#conversationThread") || $(".conversation");
  if (!thread) return;
  thread.insertAdjacentHTML("beforeend", `
    <div class="chat-thinking" id="thinkingIndicator">
      <div class="agent-mark" style="width:24px;height:24px;font-size:11px">A</div>
      <div class="thinking-dots"><span></span><span></span><span></span></div>
      <span>Thinking with <strong>${esc(modelName || "AI")}</strong>...</span>
    </div>
  `);
  scrollChat();
}

function removeThinking() {
  const el = $("#thinkingIndicator");
  if (el) el.remove();
}

function formatMsg(str) {
  if (!str) return "";
  let s = esc(str);

  // Check if this message built or referenced an app artifact
  let artifactBanner = "";
  if (str.includes("team-app.html") || str.includes("TeamForge") || (str.includes("<!DOCTYPE") && str.includes("<html"))) {
    artifactBanner = `
      <div class="artifact-card">
        <div class="artifact-head">
          <div class="artifact-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2.5"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
            <span>TeamForge Web Application Artifact</span>
            <span class="badge green" style="font-size:8px;padding:2px 6px">Ready &amp; Deployed</span>
          </div>
          <div class="artifact-actions">
            <button type="button" class="artifact-btn primary" onclick="setWorkspaceMode('split')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="12" y1="3" x2="12" y2="21"></line></svg>
              Open Split Preview
            </button>
            <a href="/team-app.html" target="_blank" class="artifact-btn">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              Full Tab
            </a>
          </div>
        </div>
      </div>
    `;
  }

  // Fenced code blocks ```lang ... ```
  let codeBlockIdx = 0;
  s = s.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gi, (_, lang, code) => {
    codeBlockIdx++;
    const codeId = "code-block-" + Math.floor(Math.random() * 1e8);
    return `
      <div class="code-container">
        <div class="code-bar">
          <span>${lang || "code"}</span>
          <button type="button" onclick="copyCode('${codeId}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            Copy
          </button>
        </div>
        <pre class="code-block" id="${codeId}"><code>${code.trim()}</code></pre>
      </div>
    `;
  });

  // Inline code `...`
  s = s.replace(/`([^`]+)`/g, '<code style="background:rgba(120,120,120,.12);padding:1px 5px;border-radius:4px;font-size:11.5px;font-family:monospace">$1</code>');
  // Bold **...**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Double newlines into paragraphs
  s = s.replace(/\n\n+/g, '</p><p style="margin:8px 0">');
  // Single newlines
  s = s.replace(/\n/g, '<br/>');
  return `<div style="margin:0;line-height:1.6">${artifactBanner}<p style="margin:0">${s}</p></div>`;
}

function setWorkspaceMode(mode) {
  const body = $("#workspaceBody");
  const panel = $("#previewPanel");
  if (!body || !panel) return;
  $$(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  body.classList.toggle("split-mode", mode === "split");
  body.classList.toggle("preview-mode", mode === "preview");
  panel.style.display = mode === "chat" ? "none" : "flex";
  if (mode !== "chat") {
    const frame = $("#appPreviewFrame");
    if (frame && !frame.src.includes("/team-app.html")) frame.src = "/team-app.html";
  }
}
window.setWorkspaceMode = setWorkspaceMode;

window.copyCode = (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(() => {
    const barBtn = el.parentElement ? el.parentElement.querySelector(".code-bar button") : null;
    if (barBtn) {
      const orig = barBtn.innerHTML;
      barBtn.innerHTML = "Copied ✓";
      setTimeout(() => { barBtn.innerHTML = orig; }, 2000);
    }
  }).catch(() => {});
};

if ($("#btnModeChat")) $("#btnModeChat").onclick = () => setWorkspaceMode("chat");
if ($("#btnModeSplit")) $("#btnModeSplit").onclick = () => setWorkspaceMode("split");
if ($("#btnModePreview")) $("#btnModePreview").onclick = () => setWorkspaceMode("preview");
if ($("#btnReloadPreview")) {
  $("#btnReloadPreview").onclick = () => {
    const f = $("#appPreviewFrame");
    if (f) f.src = f.src;
  };
}

function userMsg(text) {
  const thread = $("#conversationThread") || $(".conversation");
  if (!thread) return;
  const oldCard = $("#supTraceCard");
  if (oldCard) oldCard.remove();
  thread.insertAdjacentHTML("beforeend", `
    <div class="chat-msg user">
      <div class="chat-meta"><span>You</span><time>${stamp()}</time></div>
      <div class="chat-bubble"><p style="margin:0;white-space:pre-wrap">${esc(text)}</p></div>
    </div>
  `);
  const activeModel = ($("#model") && $("#model").value) || "Claude 3.7 Sonnet";
  showThinking(activeModel);
  scrollChat();
}

function assistantMsg(content, modelName) {
  removeThinking();
  const thread = $("#conversationThread") || $(".conversation");
  if (!thread) return;
  const activeModel = modelName || ($("#model") && $("#model").value) || "AI";
  thread.insertAdjacentHTML("beforeend", `
    <div class="chat-msg assistant">
      <div class="chat-meta">
        <div style="display:flex;align-items:center;gap:6px">
          <div class="agent-mark" style="width:24px;height:24px;font-size:11px">A</div>
          <strong>OVERLORD</strong>
          <span class="badge blue" style="font-size:8.5px;padding:2px 5px">${esc(activeModel)}</span>
        </div>
        <time>${stamp()}</time>
      </div>
      <div class="chat-bubble">
        ${formatMsg(content)}
      </div>
    </div>
  `);
  scrollChat();
}

function approvalBox(runId, text) {
  const id = "appr-" + runId;
  const thread = $("#conversationThread") || $(".conversation");
  if (!thread) return;
  thread.insertAdjacentHTML("beforeend",
    `<div class="section approval-card" id="${id}" style="margin-top:10px"><div class="section-head"><strong>Approval needed</strong><span>human gate</span></div><div class="plan"><p style="margin:0 0 10px">${esc(text)}</p><button class="ghost" data-ok="1">Approve</button> <button class="ghost" data-ok="0">Reject</button></div></div>`);
  $("#" + CSS.escape(id)).querySelectorAll("button").forEach((b) => (b.onclick = () => {
    api("POST", `/api/runs/${runId}/approve`, { ok: b.dataset.ok === "1" }).catch(() => {});
    $("#" + CSS.escape(id)).remove();
  }));
}

function onEvent(e) {
  if (e.type !== "config") logs.push({ time: e.ts.slice(11, 19), type: tagOf(e), actor: e.source.toUpperCase(), message: labelOf(e) });
  renderLogs();
  const r = e.runId ? rowFor(e.target === "supervisor" ? e.source : e.target) : null;
  switch (e.type) {
    case "user_message": userMsg(e.payload); break;
    case "thinking": trace(e.payload); break;
    case "policy": trace("Guardrails: " + e.payload); break;
    case "task_assign":
      if (r) { setState(r.i, "running", "Running"); setDesc(r.i, e.payload + "..."); startBar(r.i); }
      trace(`→ ${e.target}: ${(e.payload || "").slice(0, 180)}`); break;
    case "task_result":
      if (r) { stopBar(r.i, true); setState(r.i, "done", "Done"); setDesc(r.i, "Complete."); progressStatus(); }
      trace(`✓ ${e.source}: ${(e.payload || "").slice(0, 180)}`); break;
    case "agent_spawned":
      try { const s = JSON.parse(e.payload); trace(`Capability miss — spawned ${s.id} (${s.cap}).`); } catch {} break;
    case "agent_retired": trace(`${e.payload.split(" ")[0]} retired.`); break;
    case "approval_needed": approvalBox(e.runId, e.payload); trace("Waiting for human approval."); break;
    case "approval_denied": trace("Human rejected the final answer."); break;
    case "approval_granted": trace("Human approved."); break;
    case "final_answer":
      assistantMsg(e.payload, e.model);
      trace("Delivered response.");
      break;
  }
}
function tagOf(e) {
  if (e.source === "user") return "user";
  if (e.source === "system") return "system";
  return "agent";
}
function labelOf(e) {
  const m = { user_message: "Request received.", thinking: e.payload.slice(0, 90), policy: "Guardrails: " + e.payload.slice(0, 80),
    task_assign: `Assigned → ${e.target}.`, task_result: e.payload.slice(0, 90), agent_spawned: e.payload.slice(0, 80),
    agent_retired: e.payload.slice(0, 80), approval_needed: "Approval requested.", approval_granted: "Approved by human.",
    approval_denied: "Rejected by human.", final_answer: "Final response delivered.", config: e.payload.slice(0, 80) };
  return m[e.type] || e.payload.slice(0, 90);
}

/* ---------- composer & modern model picker ---------- */
function send() {
  const box = $("#message");
  const text = box.value.trim();
  if (!text) return;
  box.value = ""; box.style.height = "28px";
  const model = $("#model") ? $("#model").value : "Claude 3.7 Sonnet";
  api("POST", "/api/runs", { goal: text, model }).catch(() => trace("Server unreachable."));
}
if ($("#send")) $("#send").onclick = send;
if ($("#message")) {
  $("#message").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  $("#message").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 96) + "px"; });
}

// Model picker
const modelPicker = $("#modelPicker");
const modelTrigger = $("#modelTrigger");
const modelMenu = $("#modelMenu");

function wireModelOptClicks() {
  $$(".model-opt").forEach((opt) => {
    opt.onclick = (e) => {
      e.stopPropagation();
      const model = opt.dataset.model;
      if ($("#model")) $("#model").value = model;
      if ($("#currentModelName")) $("#currentModelName").textContent = model;
      $$(".model-opt").forEach((o) => {
        o.classList.toggle("active", o === opt);
        o.setAttribute("aria-selected", String(o === opt));
      });
      if (modelMenu) modelMenu.style.display = "none";
      if (modelPicker) modelPicker.classList.remove("open");
      if (modelTrigger) modelTrigger.setAttribute("aria-expanded", "false");
      trace(`Orchestrator model set to ${model}`);
    };
  });
}

let modelSearchQuery = "";
function wireModelSearch() {
  const inp = $("#modelSearch");
  if (!inp || inp.dataset.wired) return;
  inp.dataset.wired = "1";
  inp.addEventListener("input", () => {
    modelSearchQuery = inp.value.toLowerCase().trim();
    $$(".model-opt").forEach((opt) => {
      const t = (opt.textContent || "").toLowerCase();
      opt.style.display = t.includes(modelSearchQuery) ? "" : "none";
    });
  });
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("pointerdown", (e) => e.stopPropagation());
  inp.addEventListener("keydown", (e) => e.stopPropagation());
}

function syncComposerModels() {
  if (!CFG || !Array.isArray(CFG.models) || !modelMenu) return;
  const activeModels = CFG.models.filter((m) => m.on);
  if (!activeModels.length) return;
  const curModel = $("#model") ? $("#model").value : "";
  const def = CFG.models.find((m) => m.default) || activeModels[0];
  const activeVal = activeModels.some((m) => m.name === curModel) ? curModel : def.name;
  if ($("#model")) $("#model").value = activeVal;
  if ($("#currentModelName")) $("#currentModelName").textContent = activeVal;

  modelMenu.innerHTML = `<div class="model-menu-head">Active Orchestrator Model</div><div class="model-search"><input id="modelSearch" type="text" placeholder="Search models..." autocomplete="off" spellcheck="false" /></div>` +
    activeModels.map((m) => {
      const isAct = m.name === activeVal;
      const icon = m.provider === "Anthropic" ? "ti-sparkles" : m.provider === "OpenAI" ? "ti-cpu" : m.provider === "DeepSeek" ? "ti-brain" : "ti-code";
      const iconColor = m.provider === "Anthropic" ? "var(--violet)" : m.provider === "OpenAI" ? "var(--blue)" : m.provider === "DeepSeek" ? "var(--green)" : "#d97706";
      return `<button type="button" class="model-opt ${isAct ? "active" : ""}" data-model="${esc(m.name)}" role="option" aria-selected="${isAct}">
        <div class="model-opt-info">
          <span class="model-opt-name"><i class="ti ${icon}" style="color:${iconColor}"></i>${esc(m.name)}</span>
          <span class="model-opt-desc">${esc(m.desc || m.provider)}</span>
        </div>
        <span class="model-tag">${esc(m.tag || "Ready")}</span>
      </button>`;
    }).join("");
  wireModelOptClicks();
  wireModelSearch();
  if (modelSearchQuery) {
    const inp = $("#modelSearch");
    if (inp) {
      inp.value = modelSearchQuery;
      $$(".model-opt").forEach((opt) => {
        const t = (opt.textContent || "").toLowerCase();
        opt.style.display = t.includes(modelSearchQuery) ? "" : "none";
      });
    }
  }
}

if (modelTrigger && modelMenu) {
  modelTrigger.onclick = (e) => {
    e.stopPropagation();
    const isOpen = modelMenu.style.display !== "none";
    modelMenu.style.display = isOpen ? "none" : "flex";
    modelPicker.classList.toggle("open", !isOpen);
    modelTrigger.setAttribute("aria-expanded", String(!isOpen));
  };
  wireModelOptClicks();
  wireModelSearch();
  document.addEventListener("click", (e) => {
    if (modelPicker && !modelPicker.contains(e.target)) {
      modelMenu.style.display = "none";
      modelPicker.classList.remove("open");
      modelTrigger.setAttribute("aria-expanded", "false");
    }
  });
}

/* ---------- collapsible sidebars (Sessions & Logs) ---------- */
const appEl = $(".app");
const SVG_SIDEBAR_LEFT_OPEN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line><polyline points="16 9 13 12 16 15"></polyline></svg>';
const SVG_SIDEBAR_LEFT_EXPAND = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line><polyline points="13 15 16 12 13 9"></polyline></svg>';

const SVG_SIDEBAR_RIGHT_OPEN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="15" y1="3" x2="15" y2="21"></line><polyline points="8 15 11 12 8 9"></polyline></svg>';
const SVG_SIDEBAR_RIGHT_EXPAND = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="15" y1="3" x2="15" y2="21"></line><polyline points="11 9 8 12 11 15"></polyline></svg>';

function toggleLeftSidebar(force) {
  if (!appEl) return;
  const isCollapsed = typeof force === "boolean" ? force : !appEl.classList.contains("left-collapsed");
  appEl.classList.toggle("left-collapsed", isCollapsed);
  if ($("#btnToggleLeft")) {
    $("#btnToggleLeft").classList.toggle("active", isCollapsed);
    $("#btnToggleLeft").title = isCollapsed ? "Expand Sessions sidebar (Alt+1)" : "Collapse Sessions sidebar (Alt+1)";
    $("#btnToggleLeft").innerHTML = isCollapsed ? SVG_SIDEBAR_LEFT_EXPAND : SVG_SIDEBAR_LEFT_OPEN;
  }
  try { localStorage.setItem("overlord_left_col", isCollapsed ? "1" : "0"); } catch {}
}

function toggleRightSidebar(force) {
  if (!appEl) return;
  const isCollapsed = typeof force === "boolean" ? force : !appEl.classList.contains("right-collapsed");
  appEl.classList.toggle("right-collapsed", isCollapsed);
  if ($("#btnToggleRight")) {
    $("#btnToggleRight").classList.toggle("active", isCollapsed);
    $("#btnToggleRight").title = isCollapsed ? "Expand Logs feed (Alt+2)" : "Collapse Logs feed (Alt+2)";
    $("#btnToggleRight").innerHTML = isCollapsed ? SVG_SIDEBAR_RIGHT_EXPAND : SVG_SIDEBAR_RIGHT_OPEN;
  }
  try { localStorage.setItem("overlord_right_col", isCollapsed ? "1" : "0"); } catch {}
}

if ($("#btnToggleLeft")) $("#btnToggleLeft").onclick = () => toggleLeftSidebar();
if ($("#btnToggleRight")) $("#btnToggleRight").onclick = () => toggleRightSidebar();

// Restore saved collapsed states
try {
  if (localStorage.getItem("overlord_left_col") === "1") toggleLeftSidebar(true);
  if (localStorage.getItem("overlord_right_col") === "1") toggleRightSidebar(true);
} catch {}

window.addEventListener("keydown", (e) => {
  if (e.altKey && (e.key === "1" || e.key === "b" || e.key === "B")) {
    e.preventDefault();
    toggleLeftSidebar();
  } else if (e.altKey && (e.key === "2" || e.key === "l" || e.key === "L")) {
    e.preventDefault();
    toggleRightSidebar();
  }
});

/* ---------- settings & views ---------- */
const UI_KEY = "overlord_ui";
let CFG = null;
let curSubpage = "supervisor";

function markTheme() {
  const t = document.documentElement.dataset.theme || "light";
  if ($("#btnThemeLight")) $("#btnThemeLight").style.borderColor = t === "light" ? "#2563eb" : "";
  if ($("#btnThemeDark")) $("#btnThemeDark").style.borderColor = t === "dark" ? "#2563eb" : "";
}
function setTheme(t) {
  document.documentElement.dataset.theme = t === "dark" ? "dark" : "";
  try { localStorage.setItem(UI_KEY, t); } catch {}
  markTheme();
}
try { if (localStorage.getItem(UI_KEY) === "dark") document.documentElement.dataset.theme = "dark"; } catch {}

function showPage(page) {
  const isSet = page === "settings";
  $("#navWorkspace").classList.toggle("active", !isSet);
  $("#navSettings").classList.toggle("active", isSet);
  $("#viewWorkspace").style.display = isSet ? "none" : "flex";
  $("#viewSettings").style.display = isSet ? "flex" : "none";
  $(".app").classList.toggle("settings-mode", isSet);
  if (isSet) {
    if (CFG) renderSubpage(curSubpage);
    openSettings();
  }
}

$("#navWorkspace").onclick = () => showPage("workspace");
$("#navSettings").onclick = () => showPage("settings");
if ($("#btnBackToWorkspace")) $("#btnBackToWorkspace").onclick = () => showPage("workspace");

// Sub-page switching inside Settings
$$(".set-nav-item").forEach((btn) => {
  btn.onclick = () => {
    $$(".set-nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    curSubpage = btn.dataset.sub;
    renderSubpage(curSubpage);
  };
});

function renderSubpage(sub) {
  $$(".sub-pane").forEach((p) => (p.style.display = "none"));
  const pane = $("#pane-" + sub);
  if (pane) pane.style.display = "block";
  if (sub === "supervisor") renderSupervisorPane();
  else if (sub === "agents") renderAgentsPane();
  else if (sub === "models") renderModelsPane();
  else if (sub === "marketplace") renderMarketplacePane();
  else if (sub === "mcps") renderMcpsPane();
  else if (sub === "guardrails") renderGuardrailsPane();
  else if (sub === "appearance") renderAppearancePane();
}

async function openSettings() {
  try {
    CFG = await api("GET", "/api/config");
    normalizeCfg(CFG);
    renderSubpage(curSubpage);
  } catch (err) {
    console.error("Failed to load settings:", err);
  }
}

function normalizeCfg(c) {
  if (!c) return;
  if (!c.supervisor) {
    c.supervisor = {
      skills: ["intent-parsing", "task-decomposition", "synthesis", "conflict-resolution"],
      tools: ["delegate_task", "request_approval", "inspect_context", "agent_spawn"],
      mcps: ["local"],
    };
  }
  if (!Array.isArray(c.supervisor.skills)) c.supervisor.skills = [];
  if (!Array.isArray(c.supervisor.tools)) c.supervisor.tools = [];
  if (!Array.isArray(c.supervisor.mcps)) c.supervisor.mcps = [];
  if (!Array.isArray(c.mcps)) c.mcps = [];
  if (Array.isArray(c.profiles)) {
    c.profiles.forEach((p) => {
      if (!Array.isArray(p.skills) || !p.skills.length) {
        p.skills = p.domain === "software" || p.domain === "code"
          ? ["architecture-review", "code-review", "task-decomposition", "fix-ci", "ponytail", "generate-run-commands"]
          : p.domain === "security"
          ? ["threat-modeling", "security-audit", "adversarial-review", "guardrail-enforcement", "compliance-check"]
          : p.domain === "research"
          ? ["hypothesis-formulation", "source-verification", "fact-checking", "literature-review", "information-synthesis"]
          : ["intent-parsing", "task-decomposition", "synthesis", "conflict-resolution", "policy-enforcement"];
      }
      if (!Array.isArray(p.tools) || !p.tools.length) {
        p.tools = p.domain === "software" || p.domain === "code"
          ? ["delegate_task", "inspect_context", "review_diff", "agent_spawn", "python_repl"]
          : p.domain === "security"
          ? ["delegate_task", "request_approval", "inspect_context", "cancel_run"]
          : ["delegate_task", "request_approval", "inspect_context", "agent_spawn"];
      }
      if (!Array.isArray(p.mcps)) p.mcps = ["local"];
    });
  }
  if (!Array.isArray(c.models) || !c.models.length) {
    c.models = [
      { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", provider: "Anthropic", tag: "Recommended", desc: "Hybrid reasoning & deep code execution", context: "200k", on: true, default: true },
      { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI", tag: "Flagship", desc: "High-bandwidth multimodal intelligence", context: "128k", on: true, default: false },
      { id: "deepseek-r1", name: "DeepSeek R1", provider: "DeepSeek", tag: "Reasoning", desc: "In-depth mathematical reasoning", context: "64k", on: true, default: false },
      { id: "qwen-2-5-coder", name: "Qwen 2.5 Coder", provider: "Alibaba Cloud / Ollama", tag: "Fast", desc: "Fast open-source code generation", context: "32k", on: true, default: false },
    ];
  }
  if (!c.providers) c.providers = { anthropic: "", openai: "", deepseek: "", ollamaUrl: "http://localhost:11434" };
  if (Array.isArray(c.skills)) {
    c.skills.forEach((s) => {
      if (!Array.isArray(s.skills) || !s.skills.length) {
        s.skills = s.cap === "research"
          ? ["web-search", "content-extraction", "summarization", "source-verification"]
          : s.cap === "code"
          ? ["javascript", "python", "refactoring", "fix-ci", "ponytail"]
          : s.cap === "exec"
          ? ["shell-exec", "file-io", "docker", "troubleshoot"]
          : s.cap === "review"
          ? ["security-audit", "diff-review", "validation", "code-review"]
          : ["frontend-design", "web-design-engineer", "ui-ux-pro-max"];
      }
      if (!Array.isArray(s.tools)) s.tools = ["exec"];
      if (!Array.isArray(s.mcps)) s.mcps = ["local"];
    });
  }
}

async function pushCfg(mutator) {
  if (typeof mutator === "function") mutator(CFG);
  normalizeCfg(CFG);
  const tag = $("#setSaveTag");
  if (tag) tag.innerHTML = '<span class="dot" style="background:#f59e0b"></span> Saving...';
  try {
    const updated = await api("PUT", "/api/config", CFG);
    if (updated) CFG = updated;
    normalizeCfg(CFG);
    if (tag) tag.innerHTML = '<i class="ti ti-check"></i> Saved';
    syncAssignmentTable();
    syncComposerModels();
  } catch (err) {
    if (tag) tag.innerHTML = '<i class="ti ti-alert-circle" style="color:#ef4444"></i> Save Failed';
    console.error("pushCfg error:", err);
  }
}

function syncAssignmentTable() {
  if (!CFG || !Array.isArray(CFG.skills)) return;
  const table = $("#assignmentTable");
  if (!table) return;
  const activeSkills = CFG.skills.filter((s) => s.on);
  const rows = activeSkills.map((s) => {
    const iconClass = s.cap === "code" ? "green" : s.cap === "review" ? "violet" : "";
    const icon = s.cap === "research" ? "ti-world" : s.cap === "code" ? "ti-code" : s.cap === "review" ? "ti-chart-dots" : "ti-tool";
    const toolsStr = (s.tools || []).join(", ") || s.cap;
    return `<div><span class="agent-name"><span class="agent-icon ${iconClass}"><i class="ti ${icon}"></i></span>${esc(s.name)}</span></div><div>${esc(toolsStr)}</div><div><span class="state running"><span class="dot"></span>Ready</span></div><div>${esc(s.cap)} v1.0</div>`;
  }).join("");
  table.innerHTML = `<div class="assignment-head">Agent</div><div class="assignment-head">Responsibility / Tools</div><div class="assignment-head">State</div><div class="assignment-head">Model</div>` + rows;
}

/* ---------- 1. Supervisor Sub-page ---------- */
function renderSupervisorPane() {
  if (!CFG) return;
  const prof = CFG.profiles.find((p) => p.id === CFG.active) || CFG.profiles[0] || {};
  const supSkills = Array.isArray(prof.skills) ? prof.skills : (CFG.supervisor.skills || []);
  const supTools = Array.isArray(prof.tools) ? prof.tools : (CFG.supervisor.tools || []);
  const supMcps = Array.isArray(prof.mcps) ? prof.mcps : (CFG.supervisor.mcps || []);

  // Profile select
  const sel = $("#supProfileSelect");
  sel.innerHTML = CFG.profiles.map((p) => `<option value="${p.id}" ${p.id === CFG.active ? "selected" : ""}>${esc(p.name)} (${esc(p.domain)})</option>`).join("");
  sel.onchange = (e) => {
    pushCfg((c) => { c.active = e.target.value; });
    renderSupervisorPane();
  };

  // Profile list
  const pList = $("#supProfileList");
  pList.innerHTML = CFG.profiles.map((p) => `
    <div class="set-row" style="font-size:11px;padding:6px 0">
      <span>
        <strong>${esc(p.name)}</strong>
        <small style="color:var(--muted)">· domain: ${esc(p.domain)} · ${(p.skills || []).length} skills · ${(p.tools || []).length} tools</small>
        ${p.id === CFG.active ? '<span class="active-tag" style="margin-left:6px;font-size:8.5px;padding:1px 6px">Active</span>' : ''}
      </span>
      <span>${CFG.profiles.length > 1 ? `<button class="ghost" data-delprof="${p.id}" style="padding:2px 8px;font-size:10px">del</button>` : `<small style="color:var(--muted)">default</small>`}</span>
    </div>`).join("");

  // Skills
  const sList = $("#supSkillsList");
  sList.innerHTML = supSkills.map((sk) => `
    <span class="badge-item blue">
      <span>${esc(sk)}</span>
      <button class="badge-del" data-delsupskill="${esc(sk)}" title="Remove skill"><i class="ti ti-x"></i></button>
    </span>`).join("") || `<span style="color:var(--muted);font-size:10px">No supervisor skills assigned to ${esc(prof.name)}.</span>`;

  // Tools
  const tList = $("#supToolsList");
  tList.innerHTML = supTools.map((tl) => `
    <span class="badge-item violet">
      <span>${esc(tl)}</span>
      <button class="badge-del" data-delsuptool="${esc(tl)}" title="Remove tool"><i class="ti ti-x"></i></button>
    </span>`).join("") || `<span style="color:var(--muted);font-size:10px">No supervisor tools assigned to ${esc(prof.name)}.</span>`;

  // Attached MCPs Grid
  const mGrid = $("#supMcpsGrid");
  mGrid.innerHTML = CFG.mcps.map((m) => {
    const isChecked = supMcps.includes(m.id);
    return `
      <div class="mcp-check-card ${isChecked ? "checked" : ""}" data-togglesupmcp="${m.id}">
        <div class="mcp-check-head">
          <span><i class="ti ${isChecked ? "ti-checkbox" : "ti-square"}"></i> ${esc(m.name)}</span>
          <small style="color:${m.on ? "var(--green)" : "var(--muted)"}">${m.on ? "Active" : "Disabled"}</small>
        </div>
        <div class="mcp-check-tools">Tools: ${esc((m.tools || []).join(", "))}</div>
      </div>`;
  }).join("") || `<span style="color:var(--muted);font-size:10px">No registered MCP servers found.</span>`;
}

// Supervisor Add Profile
$("#addProfBtn").onclick = () => {
  const n = $("#addProfName").value.trim();
  const d = $("#addProfDomain").value.trim() || "general";
  if (!n) return;
  const id = n.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const initialSkills = d === "software" || d === "code"
    ? ["architecture-review", "code-review", "task-decomposition", "fix-ci", "ponytail", "generate-run-commands"]
    : d === "security"
    ? ["threat-modeling", "security-audit", "adversarial-review", "guardrail-enforcement", "compliance-check"]
    : d === "research"
    ? ["hypothesis-formulation", "source-verification", "fact-checking", "literature-review", "information-synthesis"]
    : ["intent-parsing", "task-decomposition", "synthesis", "conflict-resolution", "policy-enforcement"];
  const initialTools = d === "software" || d === "code"
    ? ["delegate_task", "inspect_context", "review_diff", "agent_spawn", "python_repl"]
    : ["delegate_task", "request_approval", "inspect_context", "agent_spawn"];
  pushCfg((c) => {
    c.profiles.push({ id, name: n, domain: d, skills: initialSkills, tools: initialTools, mcps: ["local"] });
    c.active = id;
  });
  $("#addProfName").value = "";
  $("#addProfDomain").value = "";
  renderSupervisorPane();
};

// Supervisor Add Skill
function addSupSkill(skill) {
  const sk = String(skill || "").trim().toLowerCase();
  if (!sk) return;
  pushCfg((c) => {
    const prof = c.profiles.find((p) => p.id === c.active) || c.profiles[0];
    if (prof) {
      if (!Array.isArray(prof.skills)) prof.skills = [];
      if (!prof.skills.includes(sk)) prof.skills.push(sk);
    }
    if (!c.supervisor.skills.includes(sk)) c.supervisor.skills.push(sk);
  });
  renderSupervisorPane();
}
$("#addSupSkillBtn").onclick = () => {
  addSupSkill($("#addSupSkillInput").value);
  $("#addSupSkillInput").value = "";
};
$("#addSupSkillInput").onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addSupSkill(e.target.value);
    e.target.value = "";
  }
};

// Supervisor Add Tool
function addSupTool(tool) {
  const tl = String(tool || "").trim();
  if (!tl) return;
  pushCfg((c) => {
    const prof = c.profiles.find((p) => p.id === c.active) || c.profiles[0];
    if (prof) {
      if (!Array.isArray(prof.tools)) prof.tools = [];
      if (!prof.tools.includes(tl)) prof.tools.push(tl);
    }
    if (!c.supervisor.tools.includes(tl)) c.supervisor.tools.push(tl);
  });
  renderSupervisorPane();
}
$("#addSupToolBtn").onclick = () => {
  addSupTool($("#addSupToolInput").value);
  $("#addSupToolInput").value = "";
};
$("#addSupToolInput").onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addSupTool(e.target.value);
    e.target.value = "";
  }
};

/* ---------- 2. Worker Agents Sub-page ---------- */
function renderAgentsPane() {
  if (!CFG) return;
  const container = $("#agentsListContainer");
  container.innerHTML = CFG.skills.map((agent) => {
    const skillsHtml = (agent.skills || []).map((sk) => `
      <span class="badge-item blue">
        <span>${esc(sk)}</span>
        <button class="badge-del" data-delagentskill="${agent.id}:${esc(sk)}" title="Remove skill"><i class="ti ti-x"></i></button>
      </span>`).join("") || `<span style="color:var(--muted);font-size:10px">No skills assigned.</span>`;

    const toolsHtml = (agent.tools || []).map((tl) => `
      <span class="badge-item violet">
        <span>${esc(tl)}</span>
        <button class="badge-del" data-delagenttool="${agent.id}:${esc(tl)}" title="Remove tool"><i class="ti ti-x"></i></button>
      </span>`).join("") || `<span style="color:var(--muted);font-size:10px">No tools assigned.</span>`;

    const mcpsHtml = CFG.mcps.map((m) => {
      const active = (agent.mcps || []).includes(m.id);
      return `<button class="mcp-pill ${active ? "active" : ""}" data-toggleagentmcp="${agent.id}:${m.id}">
        <i class="ti ${active ? "ti-check" : "ti-plus"}"></i>${esc(m.name)}
      </button>`;
    }).join("");

    return `
      <div class="agent-config-card">
        <div class="agent-card-head">
          <div style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" data-agenttoggle="${agent.id}" ${agent.on ? "checked" : ""} style="cursor:pointer"/>
            <strong>${esc(agent.name)}</strong>
            <small style="color:var(--muted)">(${esc(agent.id)})</small>
            <select data-agentcap="${agent.id}" style="padding:2px 6px;border:1px solid var(--border);border-radius:4px;font-size:10px;background:var(--surface);color:var(--text)">
              ${CAPS.map((k) => `<option ${k === agent.cap ? "selected" : ""}>${k}</option>`).join("")}
              <option ${agent.cap === "custom" ? "selected" : ""}>custom</option>
            </select>
          </div>
          <div>
            <button class="ghost" data-delagent="${agent.id}" style="color:#ef4444;border-color:#fecaca;padding:2px 8px;font-size:10px"><i class="ti ti-trash"></i> Delete</button>
          </div>
        </div>

        <div>
          <div class="agent-subhead">Agent Skills (${(agent.skills || []).length})</div>
          <div class="badge-wrap">${skillsHtml}</div>
          <div class="add-inline">
            <input class="in-agent-skill" data-agentid="${agent.id}" placeholder="Add skill to ${esc(agent.name)}..." />
            <button class="btn-add-agent-skill" data-agentid="${agent.id}">Add</button>
          </div>
        </div>

        <div style="margin-top:10px">
          <div class="agent-subhead">Agent Tools (${(agent.tools || []).length})</div>
          <div class="badge-wrap">${toolsHtml}</div>
          <div class="add-inline">
            <input class="in-agent-tool" data-agentid="${agent.id}" placeholder="Add tool to ${esc(agent.name)}..." />
            <button class="btn-add-agent-tool" data-agentid="${agent.id}">Add</button>
          </div>
        </div>

        <div style="margin-top:10px">
          <div class="agent-subhead">Attached MCP Servers</div>
          <div class="mcp-pills">${mcpsHtml || `<small style="color:var(--muted)">No MCP servers registered</small>`}</div>
        </div>
      </div>`;
  }).join("");
}

// Toggle New Agent Box
$("#toggleAddAgent").onclick = () => {
  const b = $("#newAgentBox");
  b.style.display = b.style.display === "none" ? "block" : "none";
};
$("#cancelAddAgent").onclick = () => { $("#newAgentBox").style.display = "none"; };

// Create New Agent
$("#saveNewAgentBtn").onclick = () => {
  const name = $("#newAgentName").value.trim();
  if (!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const cap = $("#newAgentCap").value;
  const skills = $("#newAgentSkills").value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const tools = $("#newAgentTools").value.split(",").map((s) => s.trim()).filter(Boolean);
  const newAgent = {
    id,
    name,
    cap,
    skills: skills.length ? skills : [cap],
    tools: tools.length ? tools : ["exec"],
    mcps: ["local"],
    on: true,
  };
  pushCfg((c) => c.skills.push(newAgent));
  $("#newAgentName").value = "";
  $("#newAgentSkills").value = "";
  $("#newAgentTools").value = "";
  $("#newAgentBox").style.display = "none";
  renderAgentsPane();
};

/* ---------- Marketplace & Capability Registry ---------- */
let marketFilter = "all";
let marketQuery = "";

const MARKETPLACE_CATALOG = [
  // --- Skills ---
  {
    id: "ponytail",
    name: "Ponytail (Lazy Senior Dev)",
    type: "skill",
    source: "DietrichGebert/ponytail",
    icon: "ti-code",
    desc: "Enforces YAGNI, standard library first, native platform features before dependencies, minimal working code. Shortest diff wins.",
    tags: ["skill", "code-quality", "yagni", "minimalist"],
    badge: "Verified"
  },
  {
    id: "code-review",
    name: "Automated Code Reviewer",
    type: "skill",
    source: "ecc/common/code-review",
    icon: "ti-file-search",
    desc: "Examines diffs for security vulnerabilities, line length, deep nesting, missing error handling, and test coverage.",
    tags: ["skill", "code-review", "security", "qa"],
    badge: "Official"
  },
  {
    id: "tdd-workflow",
    name: "Test-Driven Development (TDD)",
    type: "skill",
    source: "ecc/common/testing",
    icon: "ti-checkup-list",
    desc: "Enforces strict RED-GREEN-REFACTOR cycle with AAA test naming and mandatory >80% code coverage.",
    tags: ["skill", "tdd", "testing", "coverage"],
    badge: "Official"
  },
  {
    id: "security-guard",
    name: "Security & OWASP Guard",
    type: "skill",
    source: "ecc/common/security",
    icon: "ti-shield-lock",
    desc: "Audits for hardcoded secrets, SQL injection, XSS, insecure deserialization, SSRF, and authentication bypasses.",
    tags: ["skill", "security", "owasp", "audit"],
    badge: "Security"
  },
  {
    id: "web-scraper",
    name: "High-Throughput Web Scraper",
    type: "skill",
    source: "community/web-scraper",
    icon: "ti-spider",
    desc: "Automates article extraction, DOM parsing, structured data synthesis, and pagination handling with resilient retries.",
    tags: ["skill", "scraping", "web", "extraction"],
    badge: "Popular"
  },
  {
    id: "data-analyzer",
    name: "Data Science & Pandas Analysis",
    type: "skill",
    source: "community/data-analyzer",
    icon: "ti-chart-line",
    desc: "Performs statistical summaries, correlation matrices, anomaly detection, CSV/JSON munging, and insights generation.",
    tags: ["skill", "data-science", "pandas", "stats"],
    badge: "Popular"
  },
  {
    id: "react-patterns",
    name: "React 19 & Next.js Architecture",
    type: "skill",
    source: "ecc/react/patterns",
    icon: "ti-brand-react",
    desc: "Enforces Server/Client boundaries, Suspense error handling, custom hook discipline, and render optimization.",
    tags: ["skill", "react", "frontend", "nextjs"],
    badge: "Official"
  },
  {
    id: "fastapi-patterns",
    name: "FastAPI & Async Architecture",
    type: "skill",
    source: "ecc/python/fastapi",
    icon: "ti-brand-python",
    desc: "Pydantic v2 validation, async handlers, dependency injection, and transaction-safe service layers.",
    tags: ["skill", "fastapi", "python", "backend"],
    badge: "Official"
  },
  {
    id: "a11y-architect",
    name: "WCAG 2.2 Accessibility Auditor",
    type: "skill",
    source: "ecc/web/accessibility",
    icon: "ti-eye-check",
    desc: "Audits color contrast, ARIA landmarks, keyboard focus rings, and screen-reader accessibility traits.",
    tags: ["skill", "a11y", "wcag", "inclusive"],
    badge: "Standard"
  },

  // --- Tools ---
  {
    id: "web_search",
    name: "Web Search Engine",
    type: "tool",
    source: "native/search",
    icon: "ti-world-search",
    desc: "Real-time web search and public documentation retriever for live facts and fresh technical docs.",
    tags: ["tool", "search", "web", "docs"],
    badge: "Native"
  },
  {
    id: "python_repl",
    name: "Interactive Python REPL",
    type: "tool",
    source: "native/repl",
    icon: "ti-terminal-2",
    desc: "In-process execution environment for data calculation, mathematical modeling, and script verification.",
    tags: ["tool", "python", "execution", "repl"],
    badge: "Execution"
  },
  {
    id: "bash_exec",
    name: "Sandboxed Terminal Runner",
    type: "tool",
    source: "native/bash",
    icon: "ti-terminal",
    desc: "Runs shell commands, tests, package installs, and builds with timeout protection and standard output capture.",
    tags: ["tool", "shell", "bash", "cli"],
    badge: "System"
  },
  {
    id: "browser_automation",
    name: "Playwright Browser Engine",
    type: "tool",
    source: "native/playwright",
    icon: "ti-app-window",
    desc: "Automates browser navigation, DOM clicks, form entry, screenshot capture, and E2E regression testing.",
    tags: ["tool", "browser", "automation", "e2e"],
    badge: "Popular"
  },
  {
    id: "sql_query",
    name: "Universal SQL Query Runner",
    type: "tool",
    source: "native/db",
    icon: "ti-database",
    desc: "Direct database query engine supporting PostgreSQL, SQLite, MySQL, and Supabase connections.",
    tags: ["tool", "sql", "database", "postgres"],
    badge: "Data"
  },
  {
    id: "git_ops",
    name: "Git VCS Operations",
    type: "tool",
    source: "native/git",
    icon: "ti-git-branch",
    desc: "Commit generation, branching, diff inspections, conflict resolutions, and staging management.",
    tags: ["tool", "git", "vcs", "branch"],
    badge: "Native"
  },

  // --- MCP Servers ---
  {
    id: "github-mcp",
    name: "GitHub MCP Server",
    type: "mcp",
    source: "github/github-mcp-server",
    icon: "ti-brand-github",
    desc: "Connects OVERLORD to GitHub API: manage PRs, file issues, inspect commit diffs, and query repo search.",
    tools: ["pull_request", "issue_read", "commit", "search_code"],
    tags: ["mcp", "github", "vcs", "pr"],
    badge: "Popular"
  },
  {
    id: "filesystem-mcp",
    name: "Secure Filesystem MCP",
    type: "mcp",
    source: "modelcontextprotocol/servers",
    icon: "ti-folder",
    desc: "Provides sandboxed read/write access to project directories with configurable path boundaries.",
    tools: ["read_file", "write_file", "list_dir", "file_search"],
    tags: ["mcp", "fs", "io", "system"],
    badge: "Core"
  },
  {
    id: "postgres-mcp",
    name: "PostgreSQL Database MCP",
    type: "mcp",
    source: "modelcontextprotocol/servers",
    icon: "ti-database",
    desc: "Direct relational database inspection: introspect schemas, query tables, analyze execution plans.",
    tools: ["sql_query", "list_tables", "describe_table"],
    tags: ["mcp", "database", "postgres", "sql"],
    badge: "Popular"
  },
  {
    id: "slack-mcp",
    name: "Slack Collaboration MCP",
    type: "mcp",
    source: "modelcontextprotocol/servers",
    icon: "ti-brand-slack",
    desc: "Send notifications to Slack channels, dispatch alert summaries, and monitor incident discussions.",
    tools: ["post_message", "read_channel", "list_users"],
    tags: ["mcp", "slack", "chat", "alerts"],
    badge: "Integration"
  },
  {
    id: "docker-mcp",
    name: "Docker Container MCP",
    type: "mcp",
    source: "modelcontextprotocol/servers",
    icon: "ti-brand-docker",
    desc: "Inspect active containers, tail service logs, monitor container health, and trigger restarts.",
    tools: ["container_list", "container_logs", "image_inspect"],
    tags: ["mcp", "docker", "devops", "containers"],
    badge: "DevOps"
  },

  // --- Agent Templates ---
  {
    id: "template-fullstack",
    name: "Full-Stack Architect Agent",
    type: "template",
    source: "templates/fullstack",
    icon: "ti-layout-grid",
    desc: "Specialized in end-to-end architecture: frontend components, backend REST/GraphQL APIs, and database migrations.",
    cap: "code",
    skills: ["architecture", "react-patterns", "fastapi-patterns", "tdd-workflow"],
    tools: ["file_editor", "git_ops", "bash_exec"],
    mcps: ["local", "github-mcp", "filesystem-mcp"],
    tags: ["template", "fullstack", "architecture", "agent"],
    badge: "Pack"
  },
  {
    id: "template-security",
    name: "Security & Compliance Auditor",
    type: "template",
    source: "templates/security",
    icon: "ti-shield-bolt",
    desc: "Dedicated to vulnerability auditing, secret scanning, dependency CVE alerts, and OWASP compliance checking.",
    cap: "review",
    skills: ["security-guard", "code-review", "audit"],
    tools: ["file_editor", "bash_exec"],
    mcps: ["local", "filesystem-mcp"],
    tags: ["template", "security", "audit", "agent"],
    badge: "Pack"
  },
  {
    id: "template-analyst",
    name: "Deep Research & Data Analyst",
    type: "template",
    source: "templates/analyst",
    icon: "ti-microscope",
    desc: "Gathers web evidence, analyzes large CSV/JSON datasets, runs statistical models, and produces markdown reports.",
    cap: "research",
    skills: ["web-scraper", "data-analyzer", "synthesis"],
    tools: ["web_search", "python_repl", "browser_automation"],
    mcps: ["local", "filesystem-mcp"],
    tags: ["template", "research", "data", "agent"],
    badge: "Pack"
  },
  {
    id: "template-devops",
    name: "DevOps & Infrastructure Lead",
    type: "template",
    source: "templates/devops",
    icon: "ti-cloud-computing",
    desc: "Specialized in CI/CD pipeline automation, Docker builds, Kubernetes manifests, and container observability.",
    cap: "exec",
    skills: ["devops", "docker", "ci-cd", "bash_exec"],
    tools: ["bash_exec", "git_ops"],
    mcps: ["local", "docker-mcp"],
    tags: ["template", "devops", "docker", "cloud"],
    badge: "Pack"
  }
];

function showMarketToast(msg) {
  const t = $("#marketToast");
  const m = $("#marketToastMsg");
  if (!t || !m) return;
  m.textContent = msg;
  t.style.display = "flex";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = "none"; }, 3500);
}

function installCustomPackage(source, type) {
  const src = String(source || "").trim();
  if (!src) return;
  const id = src.split("/").pop().replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  
  if (type === "skill") {
    pushCfg((c) => {
      if (!c.supervisor.skills.includes(id)) c.supervisor.skills.push(id);
    });
    showMarketToast(`Installed skill "${id}" from ${src} into Supervisor.`);
  } else if (type === "tool") {
    pushCfg((c) => {
      if (!c.supervisor.tools.includes(id)) c.supervisor.tools.push(id);
    });
    showMarketToast(`Installed tool "${id}" from ${src} into Supervisor.`);
  } else if (type === "mcp") {
    pushCfg((c) => {
      if (!c.mcps.some((m) => m.id === id)) {
        c.mcps.push({ id, name: src, tools: ["query", "exec"], on: true });
      }
      if (!c.supervisor.mcps.includes(id)) c.supervisor.mcps.push(id);
    });
    showMarketToast(`Registered MCP server "${id}" and attached to Supervisor.`);
  }
  renderMarketplacePane();
}

let LOCAL_SKILLS_LIBRARY = [];
let localSkillsLoading = false;

async function loadSkillsLibrary() {
  if (localSkillsLoading) return;
  localSkillsLoading = true;
  try {
    const res = await api("GET", "/api/skills/library");
    if (res && Array.isArray(res.skills)) {
      LOCAL_SKILLS_LIBRARY = res.skills;
    }
  } catch (err) {
    console.error("Failed to load skills library:", err);
  } finally {
    localSkillsLoading = false;
  }
}

function renderMarketplacePane() {
  if (!CFG) return;
  if (!LOCAL_SKILLS_LIBRARY.length && !localSkillsLoading) {
    loadSkillsLibrary().then(() => renderMarketplacePane());
  }

  const q = marketQuery.trim().toLowerCase();

  // Search input & filter event listeners (idempotent)
  const searchInp = $("#marketSearchInp");
  if (searchInp && !searchInp._bound) {
    searchInp._bound = true;
    searchInp.oninput = (e) => {
      marketQuery = e.target.value;
      renderMarketplacePane();
    };
  }

  $$(".market-filter-btn").forEach((btn) => {
    if (!btn._bound) {
      btn._bound = true;
      btn.onclick = () => {
        $$(".market-filter-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        marketFilter = btn.dataset.marketfilter;
        renderMarketplacePane();
      };
    }
  });

  const isInstalled = (item) => {
    if (item.type === "skill") {
      const inSup = (CFG.profiles || []).some((p) => (p.skills || []).includes(item.id)) ||
                    (CFG.supervisor && (CFG.supervisor.skills || []).includes(item.id));
      const inAgent = (CFG.skills || []).some((a) => (a.skills || []).includes(item.id));
      return inSup || inAgent;
    }
    if (item.type === "tool") {
      const inSup = (CFG.profiles || []).some((p) => (p.tools || []).includes(item.id)) ||
                    (CFG.supervisor && (CFG.supervisor.tools || []).includes(item.id));
      const inAgent = (CFG.skills || []).some((a) => (a.tools || []).includes(item.id));
      return inSup || inAgent;
    }
    if (item.type === "mcp") {
      return CFG.mcps.some((m) => m.id === item.id);
    }
    if (item.type === "template") {
      const bareId = item.id.replace("template-", "");
      return CFG.skills.some((a) => a.id.startsWith(bareId));
    }
    return false;
  };

  // Convert local library skills into market items
  const localItems = LOCAL_SKILLS_LIBRARY.map((s) => ({
    id: s.id,
    name: s.name,
    type: "skill",
    isLocal: true,
    category: s.category,
    source: `.agents/skills/${s.id}`,
    icon: s.icon || "ti-tool",
    color: s.color || "var(--blue)",
    desc: s.description,
    tags: ["skill", "local", s.category.toLowerCase().replace(/[^a-z0-9]+/g, "-")],
    badge: "Local Skill",
  }));

  // Combine local library items with global tools/MCPs, prioritizing local skills
  const allItems = [...localItems, ...MARKETPLACE_CATALOG];

  const filtered = allItems.filter((item) => {
    if (marketFilter === "installed" && !isInstalled(item)) return false;
    if (marketFilter === "local" && !item.isLocal) return false;
    if (marketFilter === "design" && !(item.category && item.category.includes("Design"))) return false;
    if (marketFilter === "engineering" && !(item.category && item.category.includes("Engineering"))) return false;
    if (marketFilter === "git" && !(item.category && item.category.includes("Git"))) return false;
    if (marketFilter === "tool" && item.type !== "tool") return false;
    if (marketFilter === "mcp" && item.type !== "mcp") return false;
    if (q) {
      const matchName = (item.name || "").toLowerCase().includes(q);
      const matchId = (item.id || "").toLowerCase().includes(q);
      const matchDesc = (item.desc || "").toLowerCase().includes(q);
      const matchCategory = (item.category || "").toLowerCase().includes(q);
      const matchTags = (item.tags || []).some((t) => t.toLowerCase().includes(q));
      if (!matchName && !matchId && !matchDesc && !matchCategory && !matchTags) return false;
    }
    return true;
  });

  const badge = $("#marketCountBadge");
  if (badge) badge.textContent = `${filtered.length} of ${allItems.length} items`;

  const container = $("#marketGridContainer");
  if (!container) return;

  if (!filtered.length) {
    container.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:36px 12px;color:var(--muted)">
        <i class="ti ti-mood-empty" style="font-size:32px;display:block;margin-bottom:8px"></i>
        <strong>No items match "${esc(q || marketFilter)}"</strong>
        <p style="font-size:11px;margin-top:4px">Try another search term or install custom repos with the installer above.</p>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map((item) => {
    const installed = isInstalled(item);

    // Compute active assignments
    const assignments = [];
    (CFG.profiles || []).forEach((p) => {
      if (item.type === "skill" && (p.skills || []).includes(item.id)) {
        assignments.push({ type: "supervisor", id: p.id, label: `${p.name} (Supervisor)` });
      } else if (item.type === "tool" && (p.tools || []).includes(item.id)) {
        assignments.push({ type: "supervisor", id: p.id, label: `${p.name} (Supervisor)` });
      }
    });
    (CFG.skills || []).forEach((a) => {
      if (item.type === "skill" && (a.skills || []).includes(item.id)) {
        assignments.push({ type: "agent", id: a.id, label: `${a.name} (Agent)` });
      } else if (item.type === "tool" && (a.tools || []).includes(item.id)) {
        assignments.push({ type: "agent", id: a.id, label: `${a.name} (Agent)` });
      }
    });

    const assignmentsHtml = assignments.length ? `
      <div style="margin-top:8px;padding-top:6px;border-top:1px dashed var(--border)">
        <div style="font-size:9.5px;color:var(--muted);font-weight:600;margin-bottom:4px">Assigned To:</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${assignments.map((r) => `
            <span class="badge-item blue" style="font-size:9.5px;padding:1px 6px">
              <span>${esc(r.label)}</span>
              <button class="badge-del" data-unassignskill="${esc(item.id)}:${esc(r.type)}:${esc(r.id)}" title="Unassign from ${esc(r.label)}">
                <i class="ti ti-x"></i>
              </button>
            </span>
          `).join("")}
        </div>
      </div>
    ` : "";

    let actionHtml = "";

    if (item.type === "skill") {
      actionHtml = `
        <div class="market-btn-group" style="display:flex;align-items:center;gap:6px">
          <select class="market-assign-select" data-assignskill="${esc(item.id)}" style="font-size:10px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-weight:600">
            <option value="">+ Assign to Role...</option>
            <optgroup label="Supervisor Profiles">
              ${(CFG.profiles || []).map((p) => {
                const has = (p.skills || []).includes(item.id);
                return `<option value="supervisor:${p.id}">${has ? "[Installed] " : "+ "}Supervisor: ${esc(p.name)}</option>`;
              }).join("")}
            </optgroup>
            <optgroup label="Worker Agents">
              ${(CFG.skills || []).map((a) => {
                const has = (a.skills || []).includes(item.id);
                return `<option value="agent:${a.id}">${has ? "[Installed] " : "+ "}Agent: ${esc(a.name)}</option>`;
              }).join("")}
            </optgroup>
          </select>
        </div>`;
    } else if (item.type === "tool") {
      const inSup = (CFG.supervisor.tools || []).includes(item.id);
      actionHtml = `
        <div class="market-btn-group" style="display:flex;align-items:center;gap:6px">
          <button class="market-action-btn ${inSup ? "installed" : "primary"}" data-addmarkettool-sup="${item.id}" ${inSup ? "disabled" : ""}>
            <i class="ti ${inSup ? "ti-check" : "ti-crown"}"></i> ${inSup ? "In Supervisor" : "+ Supervisor"}
          </button>
          <select class="market-agent-tool-select" data-markettool="${item.id}" style="font-size:10px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">
            <option value="">+ Assign Agent...</option>
            ${(CFG.skills || []).map((a) => {
              const has = (a.tools || []).includes(item.id);
              return `<option value="${a.id}">${has ? "[Installed] " : "+ "}${esc(a.name)}</option>`;
            }).join("")}
          </select>
        </div>`;
    } else if (item.type === "mcp") {
      actionHtml = `
        <div class="market-btn-group">
          ${installed ? `
            <span class="market-action-btn installed"><i class="ti ti-check"></i> Registered</span>
          ` : `
            <button class="market-action-btn primary" data-installmcp="${item.id}">
              <i class="ti ti-plus"></i> Register &amp; Enable
            </button>
          `}
        </div>`;
    } else if (item.type === "template") {
      actionHtml = `
        <div class="market-btn-group">
          <button class="market-action-btn primary" data-spawntemplate="${item.id}">
            <i class="ti ti-robot"></i> + Instantiate Agent
          </button>
        </div>`;
    }

    return `
      <div class="market-card">
        <div>
          <div class="market-card-head">
            <div class="market-card-title">
              <i class="ti ${item.icon || "ti-box"}" style="color:${item.color || "var(--blue)"};font-size:16px"></i>
              <span>${esc(item.name)}</span>
            </div>
            <span class="market-badge ${item.isLocal ? "skill" : item.type}">${esc(item.badge || item.category || item.type)}</span>
          </div>
          <div class="market-card-source">${esc(item.source)}</div>
          <div class="market-card-desc" style="margin-top:8px">${esc(item.desc)}</div>
          ${assignmentsHtml}
        </div>

        <div>
          <div class="market-card-tags">
            ${(item.tags || []).map((t) => `<span class="market-tag">#${esc(t)}</span>`).join("")}
          </div>
          <div class="market-card-foot">
            <small style="color:${installed ? "var(--green)" : "var(--muted)"};font-size:9px;font-weight:600">
              <i class="ti ${installed ? "ti-circle-check" : "ti-circle"}"></i> ${installed ? "Active in system" : "Available"}
            </small>
            ${actionHtml}
          </div>
        </div>
      </div>`;
  }).join("");
}

/* ---------- Models Sub-page ---------- */
function renderModelsPane() {
  if (!CFG) return;
  const models = CFG.models || [];
  const activeCount = models.filter((m) => m.on).length;

  const countBadge = $("#modelsCountBadge");
  if (countBadge) countBadge.textContent = `${activeCount} Active / ${models.length} Total`;

  // Default model select dropdown
  const defSel = $("#defaultModelSelect");
  if (defSel) {
    defSel.innerHTML = models.filter((m) => m.on).map((m) =>
      `<option value="${esc(m.name)}" ${m.default ? "selected" : ""}>${esc(m.name)} (${esc(m.provider)})</option>`
    ).join("") || `<option value="">No active models</option>`;
  }

  // Registry list
  const list = $("#modelsRegistryList");
  if (list) {
    list.innerHTML = models.map((m) => {
      const icon = m.provider === "Anthropic" ? "ti-sparkles" : m.provider === "OpenAI" ? "ti-cpu" : m.provider === "DeepSeek" ? "ti-brain" : "ti-code";
      const iconColor = m.provider === "Anthropic" ? "var(--violet)" : m.provider === "OpenAI" ? "var(--blue)" : m.provider === "DeepSeek" ? "var(--green)" : "#d97706";
      const tagBg = m.tag === "Recommended" ? "var(--blue-soft)" : m.tag === "Flagship" ? "var(--green-soft)" : m.tag === "Reasoning" ? "var(--violet-soft)" : "#fef3c7";
      const tagColor = m.tag === "Recommended" ? "var(--blue)" : m.tag === "Flagship" ? "var(--green)" : m.tag === "Reasoning" ? "var(--violet)" : "#92400e";

      return `
        <div class="set-row" style="padding:12px 0;border-bottom:1px solid var(--border);align-items:flex-start">
          <div style="display:flex;align-items:flex-start;gap:12px">
            <input type="checkbox" data-modelon="${esc(m.id)}" ${m.on ? "checked" : ""} style="margin-top:3px;cursor:pointer" title="Enable/Disable model"/>
            <div>
              <div style="display:flex;align-items:center;gap:8px">
                <i class="ti ${icon}" style="font-size:14px;color:${iconColor}"></i>
                <strong style="font-size:12.5px">${esc(m.name)}</strong>
                <span class="badge" style="background:${tagBg};color:${tagColor};font-size:8.5px;padding:2px 6px;border-radius:4px">${esc(m.tag || "Model")}</span>
                ${m.default ? '<span class="active-tag" style="font-size:8.5px;padding:2px 6px">Default Orchestrator</span>' : ''}
              </div>
              <div style="font-size:10.5px;color:var(--muted);margin-top:3px">${esc(m.desc || m.provider)} · Context: <strong>${esc(m.context || "128k")}</strong> · Provider: ${esc(m.provider)}</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            ${!m.default && m.on ? `<button class="ghost" data-setdefault="${esc(m.id)}" style="padding:4px 8px;font-size:10px"><i class="ti ti-check"></i> Set Default</button>` : ''}
            ${!m.default ? `<button class="ghost" data-delmodel="${esc(m.id)}" style="padding:4px 8px;font-size:10px;color:#ef4444"><i class="ti ti-trash"></i> Remove</button>` : ''}
          </div>
        </div>`;
    }).join("") || `<div style="color:var(--muted);font-size:11px">No models registered yet.</div>`;
  }

  // Provider credentials
  const prov = CFG.providers || {};
  if ($("#cfg-key-anthropic")) $("#cfg-key-anthropic").value = prov.anthropic || "";
  if ($("#cfg-key-openai")) $("#cfg-key-openai").value = prov.openai || "";
  if ($("#cfg-key-deepseek")) $("#cfg-key-deepseek").value = prov.deepseek || "";
  if ($("#cfg-url-ollama")) $("#cfg-url-ollama").value = prov.ollamaUrl || "http://localhost:11434";
  if ($("#cfg-url-router")) $("#cfg-url-router").value = prov.routerUrl || "http://localhost:20128/v1";
  if ($("#cfg-key-router")) $("#cfg-key-router").value = prov.routerKey || "";
  updateProviderBadges(prov);
}

function updateProviderBadges(prov) {
  const p = prov || (CFG && CFG.providers) || {};
  setKeyBadge("#badge-anthropic", !!p.anthropic);
  setKeyBadge("#badge-openai", !!p.openai);
  setKeyBadge("#badge-deepseek", !!p.deepseek);
  const oBadge = $("#badge-ollama");
  if (oBadge) {
    if (p.ollamaUrl && p.ollamaUrl !== "http://localhost:11434") {
      oBadge.textContent = "Custom URL";
      oBadge.className = "badge blue";
    } else {
      oBadge.textContent = "Local Default";
      oBadge.className = "badge";
    }
  }
  const rBadge = $("#badge-router");
  if (rBadge) {
    const hasRouter = !!(p.routerUrl && p.routerKey);
    rBadge.textContent = hasRouter ? "Configured" : "Not set";
    rBadge.className = hasRouter ? "badge green" : "badge";
  }
}

function setKeyBadge(sel, isConfigured) {
  const b = $(sel);
  if (!b) return;
  b.textContent = isConfigured ? "Configured" : "Not set";
  b.className = isConfigured ? "badge green" : "badge";
}

if ($("#defaultModelSelect")) {
  $("#defaultModelSelect").onchange = (e) => {
    const val = e.target.value;
    pushCfg((c) => {
      (c.models || []).forEach((m) => { m.default = (m.name === val); });
    });
    if ($("#model")) $("#model").value = val;
    if ($("#currentModelName")) $("#currentModelName").textContent = val;
    renderModelsPane();
    syncComposerModels();
  };
}

if ($("#newModelBtn")) {
  $("#newModelBtn").onclick = () => {
    const name = ($("#newModelName").value || "").trim();
    if (!name) return;
    const provider = ($("#newModelProvider").value || "Custom").trim();
    const desc = ($("#newModelDesc").value || `${provider} inference model`).trim();
    const tag = $("#newModelTag") ? $("#newModelTag").value : "General";
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    pushCfg((c) => {
      if (!c.models) c.models = [];
      const exists = c.models.find((m) => m.id === id);
      if (exists) {
        exists.name = name;
        exists.provider = provider;
        exists.desc = desc;
        exists.tag = tag;
        exists.on = true;
      } else {
        c.models.push({ id, name, provider, desc, tag, context: "128k", on: true, default: false });
      }
    });

    $("#newModelName").value = "";
    $("#newModelProvider").value = "";
    $("#newModelDesc").value = "";
    renderModelsPane();
    syncComposerModels();
  };
}

["anthropic", "openai", "deepseek"].forEach((p) => {
  const el = $(`#cfg-key-${p}`);
  if (el) {
    el.onchange = (e) => {
      pushCfg((c) => {
        if (!c.providers) c.providers = {};
        c.providers[p] = e.target.value.trim();
      });
      updateProviderBadges(CFG.providers);
    };
  }
});
if ($("#cfg-url-ollama")) {
  $("#cfg-url-ollama").onchange = (e) => {
    pushCfg((c) => {
      if (!c.providers) c.providers = {};
      c.providers.ollamaUrl = e.target.value.trim();
    });
    updateProviderBadges(CFG.providers);
  };
}
if ($("#cfg-url-router")) {
  $("#cfg-url-router").onchange = (e) => {
    pushCfg((c) => {
      if (!c.providers) c.providers = {};
      c.providers.routerUrl = e.target.value.trim();
    });
    updateProviderBadges(CFG.providers);
  };
}
if ($("#cfg-key-router")) {
  $("#cfg-key-router").onchange = (e) => {
    pushCfg((c) => {
      if (!c.providers) c.providers = {};
      c.providers.routerKey = e.target.value.trim();
    });
    updateProviderBadges(CFG.providers);
  };
}

// Toggle password eye buttons
$$(".btn-toggle-eye").forEach((btn) => {
  btn.onclick = () => {
    const targetId = btn.dataset.target;
    const inp = $(`#${targetId}`);
    if (!inp) return;
    const isPass = inp.type === "password";
    inp.type = isPass ? "text" : "password";
    btn.innerHTML = isPass
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  };
});

// Explicit Save Credentials button
if ($("#btnSaveProviders")) {
  $("#btnSaveProviders").onclick = async () => {
    const anthropic = $("#cfg-key-anthropic") ? $("#cfg-key-anthropic").value.trim() : "";
    const openai = $("#cfg-key-openai") ? $("#cfg-key-openai").value.trim() : "";
    const deepseek = $("#cfg-key-deepseek") ? $("#cfg-key-deepseek").value.trim() : "";
    const ollamaUrl = $("#cfg-url-ollama") ? $("#cfg-url-ollama").value.trim() : "http://localhost:11434";
    const routerUrl = $("#cfg-url-router") ? $("#cfg-url-router").value.trim() : "http://localhost:20128/v1";
    const routerKey = $("#cfg-key-router") ? $("#cfg-key-router").value.trim() : "";
    await pushCfg((c) => {
      c.providers = { anthropic, openai, deepseek, ollamaUrl, routerUrl, routerKey };
    });
    updateProviderBadges(CFG.providers);
    const toast = $("#providerSaveToast");
    if (toast) {
      toast.style.display = "block";
      setTimeout(() => { toast.style.display = "none"; }, 3500);
    }
  };
}

// Test Ollama endpoint
if ($("#btnTestOllama")) {
  $("#btnTestOllama").onclick = async () => {
    const url = $("#cfg-url-ollama") ? $("#cfg-url-ollama").value.trim() : "http://localhost:11434";
    const badge = $("#badge-ollama");
    const btn = $("#btnTestOllama");
    btn.textContent = "Testing...";
    try {
      const res = await api("POST", "/api/providers/test-ollama", { url });
      if (res && res.ok) {
        badge.textContent = `Online (${res.count} models)`;
        badge.className = "badge green";
        btn.textContent = "Connected ✓";
      } else {
        badge.textContent = "Offline";
        badge.className = "badge";
        btn.textContent = "Offline ✗";
      }
    } catch {
      badge.textContent = "Offline";
      badge.className = "badge";
      btn.textContent = "Offline ✗";
    }
    setTimeout(() => { if (btn) btn.textContent = "Test Connection"; }, 3000);
  };
}

// Test Router endpoint
if ($("#btnTestRouter")) {
  $("#btnTestRouter").onclick = async () => {
    const url = $("#cfg-url-router") ? $("#cfg-url-router").value.trim() : "http://localhost:20128/v1";
    const key = $("#cfg-key-router") ? $("#cfg-key-router").value.trim() : "";
    const badge = $("#badge-router");
    const btn = $("#btnTestRouter");
    btn.textContent = "Testing...";
    try {
      const res = await api("POST", "/api/providers/test-router", { url, key });
      if (res && res.ok) {
        badge.textContent = `Online (${res.count} models)`;
        badge.className = "badge green";
        btn.textContent = "Connected ✓";
      } else {
        badge.textContent = "Offline";
        badge.className = "badge";
        btn.textContent = "Offline ✗";
      }
    } catch {
      badge.textContent = "Offline";
      badge.className = "badge";
      btn.textContent = "Offline ✗";
    }
    setTimeout(() => { if (btn) btn.textContent = "Test Connection"; }, 3000);
  };
}

// Sync Router models
if ($("#btnSyncRouterModels")) {
  $("#btnSyncRouterModels").onclick = async () => {
    const url = $("#cfg-url-router") ? $("#cfg-url-router").value.trim() : "http://localhost:20128/v1";
    const key = $("#cfg-key-router") ? $("#cfg-key-router").value.trim() : "";
    const btn = $("#btnSyncRouterModels");
    const orig = btn.innerHTML;
    btn.textContent = "Syncing...";
    try {
      const res = await api("POST", "/api/providers/sync-router-models", { url, key });
      if (res && res.ok) {
        if (res.models) CFG.models = res.models;
        renderModelsPane();
        syncComposerModels();
        btn.textContent = `Synced ${res.added} new (${res.total} total)`;
      } else {
        btn.textContent = "Sync failed ✗";
      }
    } catch {
      btn.textContent = "Sync failed ✗";
    }
    setTimeout(() => { if (btn) btn.innerHTML = orig; }, 3500);
  };
}

/* ---------- 3. MCPs & Tools Sub-page ---------- */
function renderMcpsPane() {
  if (!CFG) return;
  const list = $("#mcpRegistryList");
  list.innerHTML = CFG.mcps.map((m) => `
    <div class="set-row" style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:10px">
        <input type="checkbox" data-mcpon="${m.id}" ${m.on ? "checked" : ""} style="cursor:pointer"/>
        <div>
          <strong style="font-size:12px">${esc(m.name)}</strong> <small style="color:var(--muted)">(${esc(m.id)})</small>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">Tools: ${esc((m.tools || []).join(", "))}</div>
        </div>
      </div>
      <div>
        <button class="ghost" data-delmcp="${m.id}" style="padding:3px 8px;font-size:10px;color:#ef4444">Remove</button>
      </div>
    </div>`).join("") || `<div style="color:var(--muted);font-size:11px">No MCP servers registered yet.</div>`;
}

$("#newMcpBtn").onclick = () => {
  const n = $("#newMcpName").value.trim();
  if (!n) return;
  const id = n.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const tools = $("#newMcpTools").value.split(",").map((s) => s.trim()).filter(Boolean);
  pushCfg((c) => c.mcps.push({ id, name: n, tools: tools.length ? tools : ["read", "write"], on: true }));
  $("#newMcpName").value = "";
  $("#newMcpTools").value = "";
  renderMcpsPane();
};

/* ---------- 4. Guardrails Sub-page ---------- */
function renderGuardrailsPane() {
  if (!CFG) return;
  const g = CFG.guard || { maxSteps: 8, timeoutS: 120, costCap: 5, approval: false };
  $("#set-g-steps").value = g.maxSteps;
  $("#set-g-time").value = g.timeoutS;
  $("#set-g-cost").value = g.costCap;
  $("#set-g-appr").checked = !!g.approval;
}

$("#set-g-steps").onchange = (e) => pushCfg((c) => { c.guard.maxSteps = +e.target.value || 8; });
$("#set-g-time").onchange = (e) => pushCfg((c) => { c.guard.timeoutS = +e.target.value || 120; });
$("#set-g-cost").onchange = (e) => pushCfg((c) => { c.guard.costCap = +e.target.value || 5; });
$("#set-g-appr").onchange = (e) => pushCfg((c) => { c.guard.approval = e.target.checked; });

/* ---------- 5. Appearance Sub-page ---------- */
function renderAppearancePane() {
  markTheme();
}
$("#btnThemeLight").onclick = () => setTheme("light");
$("#btnThemeDark").onclick = () => setTheme("dark");

/* ---------- Global Settings Event Delegation ---------- */
$("#viewSettings").addEventListener("click", (e) => {
  const t = e.target.closest("button") || e.target;

  // Profile deletion
  if (t.matches("[data-delprof]")) {
    const id = t.dataset.delprof;
    pushCfg((c) => {
      c.profiles = c.profiles.filter((p) => p.id !== id);
      if (c.active === id && c.profiles.length) c.active = c.profiles[0].id;
    });
    renderSupervisorPane();
  }
  // Model delete
  else if (t.matches("[data-delmodel]")) {
    const id = t.dataset.delmodel;
    pushCfg((c) => {
      c.models = (c.models || []).filter((m) => m.id !== id);
    });
    renderModelsPane();
    syncComposerModels();
  }
  // Model set default
  else if (t.matches("[data-setdefault]")) {
    const id = t.dataset.setdefault;
    pushCfg((c) => {
      (c.models || []).forEach((m) => { m.default = (m.id === id); });
    });
    const defM = (CFG.models || []).find((m) => m.id === id);
    if (defM) {
      if ($("#model")) $("#model").value = defM.name;
      if ($("#currentModelName")) $("#currentModelName").textContent = defM.name;
    }
    renderModelsPane();
    syncComposerModels();
  }
  // Supervisor skill delete
  else if (t.matches("[data-delsupskill]")) {
    const sk = t.dataset.delsupskill;
    pushCfg((c) => {
      const prof = c.profiles.find((p) => p.id === c.active);
      if (prof && Array.isArray(prof.skills)) {
        prof.skills = prof.skills.filter((s) => s !== sk);
      }
      c.supervisor.skills = (c.supervisor.skills || []).filter((s) => s !== sk);
    });
    renderSupervisorPane();
  }
  // Supervisor tool delete
  else if (t.matches("[data-delsuptool]")) {
    const tl = t.dataset.delsuptool;
    pushCfg((c) => {
      const prof = c.profiles.find((p) => p.id === c.active);
      if (prof && Array.isArray(prof.tools)) {
        prof.tools = prof.tools.filter((x) => x !== tl);
      }
      c.supervisor.tools = (c.supervisor.tools || []).filter((x) => x !== tl);
    });
    renderSupervisorPane();
  }
  // Supervisor skill suggestion chip
  else if (t.matches("[data-supskill]")) {
    addSupSkill(t.dataset.supskill);
  }
  // Supervisor tool suggestion chip
  else if (t.matches("[data-suptool]")) {
    addSupTool(t.dataset.suptool);
  }
  // Supervisor MCP toggle
  else if (t.closest("[data-togglesupmcp]")) {
    const card = t.closest("[data-togglesupmcp]");
    const mcpId = card.dataset.togglesupmcp;
    pushCfg((c) => {
      const prof = c.profiles.find((p) => p.id === c.active);
      if (prof) {
        if (!Array.isArray(prof.mcps)) prof.mcps = [];
        const pIdx = prof.mcps.indexOf(mcpId);
        if (pIdx >= 0) prof.mcps.splice(pIdx, 1);
        else prof.mcps.push(mcpId);
      }
      const idx = c.supervisor.mcps.indexOf(mcpId);
      if (idx >= 0) c.supervisor.mcps.splice(idx, 1);
      else c.supervisor.mcps.push(mcpId);
    });
    renderSupervisorPane();
  }
  // Agent add skill via suggestion chip
  else if (t.matches("[data-addagentskill]")) {
    const [agentId, skill] = t.dataset.addagentskill.split(":");
    if (!agentId || !skill) return;
    pushCfg((c) => {
      const a = c.skills.find((x) => x.id === agentId);
      if (a) {
        if (!Array.isArray(a.skills)) a.skills = [];
        if (!a.skills.includes(skill)) a.skills.push(skill);
      }
    });
    renderAgentsPane();
  }
  // Agent delete
  else if (t.matches("[data-delagent]")) {
    const id = t.dataset.delagent;
    pushCfg((c) => { c.skills = c.skills.filter((a) => a.id !== id); });
    renderAgentsPane();
  }
  // Agent skill delete
  else if (t.matches("[data-delagentskill]")) {
    const [agentId, skill] = t.dataset.delagentskill.split(":");
    pushCfg((c) => {
      const a = c.skills.find((x) => x.id === agentId);
      if (a && a.skills) a.skills = a.skills.filter((s) => s !== skill);
    });
    renderAgentsPane();
  }
  // Agent tool delete
  else if (t.matches("[data-delagenttool]")) {
    const [agentId, tool] = t.dataset.delagenttool.split(":");
    pushCfg((c) => {
      const a = c.skills.find((x) => x.id === agentId);
      if (a && a.tools) a.tools = a.tools.filter((x) => x !== tool);
    });
    renderAgentsPane();
  }
  // Agent add skill button
  else if (t.matches(".btn-add-agent-skill")) {
    const agentId = t.dataset.agentid;
    const inp = $(`input.in-agent-skill[data-agentid="${agentId}"]`);
    if (!inp) return;
    const val = inp.value.trim().toLowerCase();
    if (!val) return;
    pushCfg((c) => {
      const a = c.skills.find((x) => x.id === agentId);
      if (a) {
        if (!a.skills) a.skills = [];
        if (!a.skills.includes(val)) a.skills.push(val);
      }
    });
    inp.value = "";
    renderAgentsPane();
  }
  // Agent add tool button
  else if (t.matches(".btn-add-agent-tool")) {
    const agentId = t.dataset.agentid;
    const inp = $(`input.in-agent-tool[data-agentid="${agentId}"]`);
    if (!inp) return;
    const val = inp.value.trim();
    if (!val) return;
    pushCfg((c) => {
      const a = c.skills.find((x) => x.id === agentId);
      if (a) {
        if (!a.tools) a.tools = [];
        if (!a.tools.includes(val)) a.tools.push(val);
      }
    });
    inp.value = "";
    renderAgentsPane();
  }
  // Agent MCP toggle pill
  else if (t.closest("[data-toggleagentmcp]")) {
    const pill = t.closest("[data-toggleagentmcp]");
    const [agentId, mcpId] = pill.dataset.toggleagentmcp.split(":");
    pushCfg((c) => {
      const a = c.skills.find((x) => x.id === agentId);
      if (a) {
        if (!a.mcps) a.mcps = [];
        const idx = a.mcps.indexOf(mcpId);
        if (idx >= 0) a.mcps.splice(idx, 1);
        else a.mcps.push(mcpId);
      }
    });
    renderAgentsPane();
  }
  // MCP delete in registry
  else if (t.matches("[data-delmcp]")) {
    const mcpId = t.dataset.delmcp;
    pushCfg((c) => {
      c.mcps = c.mcps.filter((m) => m.id !== mcpId);
      c.supervisor.mcps = c.supervisor.mcps.filter((id) => id !== mcpId);
      c.skills.forEach((a) => { if (a.mcps) a.mcps = a.mcps.filter((id) => id !== mcpId); });
    });
    renderMcpsPane();
  }
  // Marketplace quick install chip
  else if (t.matches("[data-quickinstall]")) {
    const [source, type] = t.dataset.quickinstall.split(":");
    installCustomPackage(source, type || "skill");
  }
  // Marketplace custom install button
  else if (t.id === "marketInstallBtn" || t.closest("#marketInstallBtn")) {
    const src = $("#marketCustomSource") ? $("#marketCustomSource").value.trim() : "";
    const typ = $("#marketCustomType") ? $("#marketCustomType").value : "skill";
    if (src) {
      installCustomPackage(src, typ);
      if ($("#marketCustomSource")) $("#marketCustomSource").value = "";
    }
  }
  // Marketplace add skill to supervisor
  else if (t.matches("[data-addmarketskill-sup]")) {
    const sk = t.dataset.addmarketskillSup;
    pushCfg((c) => {
      if (!c.supervisor.skills.includes(sk)) c.supervisor.skills.push(sk);
    });
    showMarketToast(`Added skill "${sk}" to Supervisor.`);
    renderMarketplacePane();
  }
  // Marketplace add tool to supervisor
  else if (t.matches("[data-addmarkettool-sup]")) {
    const tl = t.dataset.addmarkettoolSup;
    pushCfg((c) => {
      if (!c.supervisor.tools.includes(tl)) c.supervisor.tools.push(tl);
    });
    showMarketToast(`Added tool "${tl}" to Supervisor.`);
    renderMarketplacePane();
  }
  // Marketplace install & register MCP
  else if (t.matches("[data-installmcp]")) {
    const mcpId = t.dataset.installmcp;
    const cat = MARKETPLACE_CATALOG.find((x) => x.id === mcpId);
    if (cat) {
      pushCfg((c) => {
        if (!c.mcps.some((m) => m.id === cat.id)) {
          c.mcps.push({ id: cat.id, name: cat.name, tools: cat.tools || ["query"], on: true });
        }
        if (!c.supervisor.mcps.includes(cat.id)) c.supervisor.mcps.push(cat.id);
      });
      showMarketToast(`Registered & enabled MCP server "${cat.name}".`);
      renderMarketplacePane();
    }
  }
  // Marketplace instantiate agent template
  else if (t.matches("[data-spawntemplate]")) {
    const tmplId = t.dataset.spawntemplate;
    const tmpl = MARKETPLACE_CATALOG.find((x) => x.id === tmplId);
    if (tmpl) {
      const bareId = tmpl.id.replace("template-", "");
      const newAgent = {
        id: bareId + "-" + Math.floor(Math.random() * 1000),
        name: tmpl.name.replace(" Agent", ""),
        cap: tmpl.cap || "custom",
        skills: [...(tmpl.skills || [])],
        tools: [...(tmpl.tools || [])],
        mcps: [...(tmpl.mcps || ["local"])],
        on: true,
      };
      pushCfg((c) => c.skills.push(newAgent));
      showMarketToast(`Instantiated new specialized agent "${newAgent.name}".`);
      renderMarketplacePane();
    }
  }
  // Marketplace unassign skill from role
  else if (t.matches("[data-unassignskill]") || t.closest("[data-unassignskill]")) {
    const btn = t.matches("[data-unassignskill]") ? t : t.closest("[data-unassignskill]");
    const parts = (btn.dataset.unassignskill || "").split(":");
    if (parts.length >= 3) {
      const [skillId, targetType, targetId] = parts;
      api("POST", "/api/skills/unassign", { skillId, targetType, targetId }).then((res) => {
        if (res && res.config) {
          CFG = res.config;
          normalizeCfg(CFG);
        }
        showMarketToast(`Removed skill "${skillId}" from ${targetType === "supervisor" ? "Supervisor" : "Agent"}.`);
        renderMarketplacePane();
        renderSupervisorPane();
        renderAgentsPane();
      }).catch(console.error);
    }
  }
});

$("#viewSettings").addEventListener("change", (e) => {
  const t = e.target;
  // Agent capability change
  if (t.matches("[data-agentcap]")) {
    const id = t.dataset.agentcap;
    pushCfg((c) => {
      const a = c.skills.find((x) => x.id === id);
      if (a) a.cap = t.value;
    });
  }
  // Agent toggle on/off
  else if (t.matches("[data-agenttoggle]")) {
    const id = t.dataset.agenttoggle;
    pushCfg((c) => {
      const a = c.skills.find((x) => x.id === id);
      if (a) a.on = t.checked;
    });
  }
  // Model on/off in registry
  else if (t.matches("[data-modelon]")) {
    const id = t.dataset.modelon;
    pushCfg((c) => {
      const m = (c.models || []).find((x) => x.id === id);
      if (m) {
        m.on = t.checked;
        if (!m.on && m.default) {
          const firstOn = (c.models || []).find((x) => x.on && x.id !== id);
          if (firstOn) firstOn.default = true;
          m.default = false;
        }
      }
    });
    renderModelsPane();
    syncComposerModels();
  }
  // MCP on/off in registry
  else if (t.matches("[data-mcpon]")) {
    const id = t.dataset.mcpon;
    pushCfg((c) => {
      const m = c.mcps.find((x) => x.id === id);
      if (m) m.on = t.checked;
    });
  }
  // Marketplace assign skill to role (supervisor or agent)
  else if (t.matches(".market-assign-select")) {
    const skillId = t.dataset.assignskill;
    const val = t.value;
    if (!val || !skillId) return;
    const [targetType, targetId] = val.split(":");
    if (!targetType || !targetId) return;
    api("POST", "/api/skills/assign", { skillId, targetType, targetId }).then((res) => {
      if (res && res.config) {
        CFG = res.config;
        normalizeCfg(CFG);
      }
      const roleName = targetType === "supervisor"
        ? ((CFG.profiles || []).find((p) => p.id === targetId) || {}).name || "Supervisor"
        : ((CFG.skills || []).find((a) => a.id === targetId) || {}).name || "Agent";
      showMarketToast(`Assigned skill "${skillId}" to ${roleName}.`);
      t.value = "";
      renderMarketplacePane();
      renderSupervisorPane();
      renderAgentsPane();
    }).catch(console.error);
  }
  // Marketplace assign skill to agent
  else if (t.matches(".market-agent-select")) {
    const skillId = t.dataset.marketskill;
    const agentId = t.value;
    if (!agentId || !skillId) return;
    pushCfg((c) => {
      const a = c.skills.find((x) => x.id === agentId);
      if (a) {
        if (!a.skills) a.skills = [];
        if (!a.skills.includes(skillId)) a.skills.push(skillId);
      }
    });
    const aObj = CFG.skills.find((x) => x.id === agentId);
    showMarketToast(`Assigned skill "${skillId}" to ${aObj ? aObj.name : agentId}.`);
    t.value = "";
    renderMarketplacePane();
  }
  // Marketplace assign tool to agent
  else if (t.matches(".market-agent-tool-select")) {
    const toolId = t.dataset.markettool;
    const agentId = t.value;
    if (!agentId || !toolId) return;
    pushCfg((c) => {
      const a = c.skills.find((x) => x.id === agentId);
      if (a) {
        if (!a.tools) a.tools = [];
        if (!a.tools.includes(toolId)) a.tools.push(toolId);
      }
    });
    const aObj = CFG.skills.find((x) => x.id === agentId);
    showMarketToast(`Assigned tool "${toolId}" to ${aObj ? aObj.name : agentId}.`);
    t.value = "";
    renderMarketplacePane();
  }
});

/* ---------- boot ---------- */
(async function boot() {
  let d = null, c = null;
  try {
    [d, c] = await Promise.all([
      api("GET", "/api/logs?limit=100"),
      api("GET", "/api/config").catch(() => null),
    ]);
    logs = (d.logs || []).map((e) => ({ time: e.ts.slice(11, 19), type: tagOf(e), actor: e.source.toUpperCase(), message: labelOf(e) }));
    if (c) {
      CFG = c;
      normalizeCfg(CFG);
      syncAssignmentTable();
      syncComposerModels();
    }
  } catch { trace("Server unreachable — start it with: node server.js"); return; }
  renderLogs();

  // Rehydrate recent chat conversation from event log
  if (d && Array.isArray(d.logs)) {
    const thread = $("#conversationThread");
    if (thread) {
      d.logs.slice(-30).forEach((e) => {
        if (e.type === "user_message") {
          thread.insertAdjacentHTML("beforeend", `
            <div class="chat-msg user">
              <div class="chat-meta"><span>You</span><time>${e.ts.slice(11, 16)}</time></div>
              <div class="chat-bubble"><p style="margin:0;white-space:pre-wrap">${esc(e.payload)}</p></div>
            </div>
          `);
        } else if (e.type === "final_answer") {
          thread.insertAdjacentHTML("beforeend", `
            <div class="chat-msg assistant">
              <div class="chat-meta">
                <div style="display:flex;align-items:center;gap:6px">
                  <div class="agent-mark" style="width:24px;height:24px;font-size:11px">A</div>
                  <strong>OVERLORD</strong>
                  <span class="badge blue" style="font-size:8.5px;padding:2px 5px">${esc(e.model || "AI")}</span>
                </div>
                <time>${e.ts.slice(11, 16)}</time>
              </div>
              <div class="chat-bubble">
                ${formatMsg(e.payload)}
              </div>
            </div>
          `);
        }
      });
      scrollChat();
    }
  }

  trace("Console connected · waiting for instructions.");
  const es = new EventSource("/api/stream");
  es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch {} };
})();