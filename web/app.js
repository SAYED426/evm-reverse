"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  form: $("form"),
  address: $("address"),
  rpcUrl: $("rpcUrl"),
  storage: $("storage"),
  includeProxy: $("includeProxy"),
  llm: $("llm"),
  llmModel: $("llmModel"),
  llmUrl: $("llmUrl"),
  llmApiKey: $("llmApiKey"),
  refreshModels: $("refreshModels"),
  perFunctionMs: $("perFunctionMs"),
  submit: $("submit"),
  cancel: $("cancel"),
  log: $("log"),
  copy: $("copy"),
  download: $("download"),
  healthHeimdall: $("health-heimdall"),
  healthLlm: $("health-llm"),
};

const panes = {
  solidity: $("pane-solidity"),
  abi: $("pane-abi"),
  metadata: $("pane-metadata"),
};

const state = { solidity: "", abi: "", metadata: "", address: "", controller: null };

/* ---------------------------------------------------------------- prefs */

const PREF_KEYS = ["rpcUrl", "storage", "includeProxy", "llm", "llmModel", "llmUrl", "llmApiKey", "perFunctionMs"];

function savePrefs() {
  const prefs = {};
  for (const key of PREF_KEYS) {
    const el = els[key];
    prefs[key] = el.type === "checkbox" ? el.checked : el.value;
  }
  localStorage.setItem("evm-reverse", JSON.stringify(prefs));
}

function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem("evm-reverse") || "{}");
    for (const key of PREF_KEYS) {
      if (prefs[key] === undefined) continue;
      const el = els[key];
      if (el.type === "checkbox") el.checked = Boolean(prefs[key]);
      else el.value = prefs[key];
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------- highlight */

const RE = new RegExp(
  [
    "(\\/\\/[^\\n]*)",
    "(\\/\\*[\\s\\S]*?\\*\\/)",
    "(\"(?:[^\"\\\\]|\\\\.)*\")",
    "('(?:[^'\\\\]|\\\\.)*')",
    "\\b(address|bool|string|bytes\\d*|uint\\d*|int\\d*|bytes)\\b",
    "\\b(function|modifier|contract|interface|library|struct|enum|event|error|mapping|public|private|internal|external|pure|view|payable|constant|immutable|memory|calldata|storage|returns|return|require|assert|revert|emit|new|delete|if|else|for|while|do|break|continue|this|super|constructor|receive|fallback|indexed|unchecked|try|catch|assembly|let|using|is|import|pragma)\\b",
    "\\b(\\d+)\\b",
  ].join("|"),
  "g",
);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function highlight(src) {
  if (src.length > 400_000) return esc(src);
  let out = "";
  let last = 0;
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(src)) !== null) {
    out += esc(src.slice(last, m.index));
    const cls = m[1] || m[2] ? "tok-comment" : m[3] || m[4] ? "tok-string" : m[5] ? "tok-type" : m[6] ? "tok-keyword" : "tok-number";
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(src.slice(last));
  return out;
}

function setPane(name, text, { highlight: doHighlight = false } = {}) {
  const pane = panes[name];
  if (!text) {
    pane.innerHTML = '<span class="placeholder">(empty)</span>';
    return;
  }
  pane.innerHTML = doHighlight ? highlight(text) : esc(text);
}

/* ------------------------------------------------------------------ log */

function appendLog(line) {
  const div = document.createElement("div");
  const cls = line.startsWith("✓") ? "ok" : line.startsWith("!") ? "warn" : line.startsWith("✗") ? "err" : line.startsWith("›") ? "step" : "";
  div.className = cls;
  div.textContent = line;
  els.log.appendChild(div);
  els.log.scrollTop = els.log.scrollHeight;
}

const clearLog = () => {
  els.log.textContent = "";
};

/* --------------------------------------------------------------- health */

async function loadHealth() {
  const params = new URLSearchParams();
  if (els.llmUrl.value.trim()) params.set("url", els.llmUrl.value.trim());
  if (els.llmApiKey.value) params.set("key", els.llmApiKey.value);
  const query = params.toString();

  try {
    const res = await fetch("/api/health" + (query ? "?" + query : ""));
    const data = await res.json();

    els.healthHeimdall.textContent = data.heimdall.ok ? "heimdall ✓" : "heimdall ✗";
    els.healthHeimdall.className = "pill " + (data.heimdall.ok ? "ok" : "bad");
    if (!data.heimdall.ok) els.healthHeimdall.title = data.heimdall.error || "";

    els.healthLlm.textContent = data.llm.ok ? `ollama ✓ (${data.llm.models.length})` : "ollama ✗";
    els.healthLlm.className = "pill " + (data.llm.ok ? "ok" : "bad");
    els.healthLlm.title = data.llm.ok
      ? data.llm.baseUrl + (data.llm.hasKey ? " (authenticated)" : "")
      : (data.llm.error || "") + " — " + data.llm.baseUrl;

    if (data.llm.ok && data.llm.models.length) {
      const saved = els.llmModel.value;
      els.llmModel.innerHTML = "";
      for (const model of data.llm.models) {
        const opt = document.createElement("option");
        opt.value = model;
        opt.textContent = model;
        els.llmModel.appendChild(opt);
      }
      const preferred = saved || data.llm.defaultModel;
      if (preferred && data.llm.models.includes(preferred)) els.llmModel.value = preferred;
      els.llm.disabled = false;
    } else {
      els.llmModel.innerHTML = '<option value="">(endpoint unavailable)</option>';
      els.llm.disabled = true;
    }
  } catch (err) {
    els.healthHeimdall.textContent = "server ✗";
    els.healthHeimdall.className = "pill bad";
  }
}

/* ------------------------------------------------------------------ run */

function setRunning(running) {
  els.submit.disabled = running;
  els.submit.textContent = running ? "Working…" : "Reverse";
  els.cancel.hidden = !running;
}

function buildPayload() {
  const payload = { address: els.address.value.trim() };
  if (els.rpcUrl.value.trim()) payload.rpcUrl = els.rpcUrl.value.trim();
  if (els.storage.checked) payload.storage = true;
  if (els.includeProxy.checked) payload.includeProxy = true;
  if (els.llm.checked) payload.llm = true;
  if (els.llm.checked && els.llmModel.value) payload.llmModel = els.llmModel.value;
  if (els.llm.checked && els.llmUrl.value.trim()) payload.llmUrl = els.llmUrl.value.trim();
  if (els.llm.checked && els.llmApiKey.value) payload.llmApiKey = els.llmApiKey.value;
  const per = Number(els.perFunctionMs.value);
  if (per > 0) payload.perFunctionMs = per;
  return payload;
}

function handleEvent(evt) {
  if (evt.type === "log") {
    appendLog(evt.line);
    return;
  }
  if (evt.type === "error") {
    appendLog("✗ " + evt.message);
    return;
  }
  if (evt.type === "result") {
    state.solidity = evt.solidity || "";
    state.metadata = JSON.stringify(evt.metadata, null, 2);
    state.address = evt.metadata?.address || "";
    setPane("solidity", state.solidity, { highlight: true });
    setPane("metadata", state.metadata);
    setPane("abi", evt.abi || "");
    showTab("solidity");
  }
}

async function run(event) {
  event.preventDefault();
  const payload = buildPayload();
  if (!payload.address) return;

  savePrefs();
  clearLog();
  setRunning(true);
  state.controller = new AbortController();

  try {
    const res = await fetch("/api/reverse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: state.controller.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      appendLog("✗ request failed: " + res.status + " " + text);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          appendLog(line);
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") appendLog("! cancelled");
    else appendLog("✗ " + (err.message || String(err)));
  } finally {
    setRunning(false);
    state.controller = null;
  }
}

/* --------------------------------------------------------------- tabs */

function showTab(name) {
  for (const btn of document.querySelectorAll(".tab")) btn.classList.toggle("active", btn.dataset.tab === name);
  for (const [key, pane] of Object.entries(panes)) pane.classList.toggle("active", key === name);
}

/* -------------------------------------------------------- copy/download */

let currentTab = "solidity";

function activeText() {
  if (currentTab === "solidity") return state.solidity;
  if (currentTab === "abi") return panes.abi.textContent || "";
  return state.metadata;
}

async function copyActive() {
  const text = activeText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    els.copy.textContent = "Copied";
  } catch {
    els.copy.textContent = "Copy failed";
  }
  setTimeout(() => (els.copy.textContent = "Copy"), 1200);
}

function downloadActive() {
  const text = activeText();
  if (!text) return;
  const ext = currentTab === "solidity" ? "sol" : currentTab === "abi" ? "json" : "json";
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `decompiled-${(state.address || "contract").slice(0, 10)}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ----------------------------------------------------------------- init */

loadPrefs();
setPane("solidity", "");
setPane("abi", "");
setPane("metadata", "");
loadHealth();

els.form.addEventListener("submit", run);
els.cancel.addEventListener("click", () => state.controller?.abort());
els.copy.addEventListener("click", copyActive);
els.download.addEventListener("click", downloadActive);
for (const key of PREF_KEYS) els[key].addEventListener("change", savePrefs);

// Re-query the LLM endpoint when its URL or key changes, or on demand.
els.refreshModels.addEventListener("click", loadHealth);
els.llmUrl.addEventListener("change", () => {
  savePrefs();
  loadHealth();
});
els.llmApiKey.addEventListener("change", () => {
  savePrefs();
  loadHealth();
});

for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => {
    currentTab = btn.dataset.tab;
    showTab(currentTab);
  });
}
