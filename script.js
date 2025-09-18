document.addEventListener('DOMContentLoaded', () => {
  let data = [];
  let headers = [];
  let rules = [];

  const csvInput = document.getElementById('csvInput');
  const fileInput = document.getElementById('fileInput');
  const colSelect = document.getElementById('colSelect');
  const dataTypeSelect = document.getElementById('dataTypeSelect');
  const conditionSelect = document.getElementById('conditionSelect');
  const paramInputs = document.getElementById('paramInputs');
  const conditionPreview = document.getElementById('conditionPreview');
  const addRuleBtn = document.getElementById('addRuleBtn');
  const rulesList = document.getElementById('rulesList');
  const runRulesBtn = document.getElementById('runRulesBtn');
  const previewBadBtn = document.getElementById('previewBadBtn');

  const profileBtn = document.getElementById('profileBtn');
  const profilingSection = document.getElementById('profilingSection');
  const profileTabs = document.getElementById('profileTabs');
  const profileChartCanvas = document.getElementById('profileChart');
  const profileStatsEl = document.getElementById('profileStats');
  const tableOverviewEl = document.getElementById('tableOverview');


  const totalRowsEl = document.getElementById('totalRows');
  const badRowsEl = document.getElementById('badRows');
  const goodPercentEl = document.getElementById('goodPercent');

  const dashboardSection = document.querySelector('.dashboard');
  const badDataTableContainer = document.getElementById('badDataTableContainer');
  const badDataTable = document.getElementById('badDataTable');
  const binCountRange = document.getElementById('binCountRange');
  const binCountInput = document.getElementById('binCountInput');
  const binWidthLabel = document.getElementById('binWidthLabel');
  const histControls = document.getElementById('histControls');

  // ===== Uniqueness suggestion thresholds (tune as you like) =====
  const UNIQ_SUGGEST_MIN_RATIO     = 0.90; // suggest if ≥ 90% of non-missing values are unique
  const UNIQ_SUGGEST_MIN_DISTINCT  = 20;   // skip very low-cardinality columns (distinct < 20)
  const UNIQ_SUGGEST_MAX_DUP_RATIO = 0.10; // duplicates must be ≤ 10% of non-missing to call it "near-unique"

  // For strings, normalize before checking uniqueness to avoid cosmetic “duplicates”
  const UNIQ_NORMALIZE_STRING = true;      // trim, collapse spaces, lower-case



  
  // [PROFILING] Chart handle + plugin configuration
  let profileChart = null

  let radarChart, badPieChart;
  

  // [DQ TABS] State & helpers
let lastBadRowsSet = null;
let lastBadRowsByColumn = new Map();
let lastBadRowsByRule = new Map();

// === [SUGGESTION STATE] applied/dismissed per dataset (localStorage) ===
let appliedSuggestionIds  = new Set();
let dismissedSuggestionIds = new Set();

function datasetSignature() {
  try {
    return `${headers.join('|')}__${data.length}`;
  } catch { return 'default'; }
}
function stateKey() { return `dq_sugg_state__${datasetSignature()}`; }


async function loadFromBackendTable(tableName, limit = 1000, offset = 0) {
  try {
    const baseUrl = 'http://localhost:4000'; // move to config if needed
    const resp = await fetch(`${baseUrl}/api/data/table/${encodeURIComponent(tableName)}?limit=${limit}&offset=${offset}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `API error ${resp.status}`);
    }
    const payload = await resp.json(); // { headers, rows }
    // Assign into your app's state
    headers = payload.headers || [];
    data = payload.rows || [];

    // Refresh UI with existing functions you already have
    totalRowsEl.textContent = data.length;
    badRowsEl.textContent = '0';
    goodPercentEl.textContent = '100%';
    updateColumnDropdown();         // rebuild column list
    renderTable(data, document.getElementById('dataTable'));
    profilingSection.style.display = 'none';
    dashboardSection.style.display = 'none';
    badDataTableContainer.style.display = 'none';
    rules = [];
    renderRules();
  } catch (e) {
    alert(`Failed to load from backend: ${e.message}`);
  }
}



function loadSuggestionState() {
  try {
    const raw = localStorage.getItem(stateKey());
    if (!raw) { appliedSuggestionIds = new Set(); dismissedSuggestionIds = new Set(); return; }
    const obj = JSON.parse(raw);
    appliedSuggestionIds   = new Set(Array.isArray(obj.applied)   ? obj.applied   : []);
    dismissedSuggestionIds = new Set(Array.isArray(obj.dismissed) ? obj.dismissed : []);
  } catch { appliedSuggestionIds = new Set(); dismissedSuggestionIds = new Set(); }
}
function saveSuggestionState() {
  try {
    localStorage.setItem(stateKey(), JSON.stringify({
      applied:   Array.from(appliedSuggestionIds),
      dismissed: Array.from(dismissedSuggestionIds)
    }));
  } catch { /* ignore storage errors */ }
}

// Reset suggestion state whenever a new CSV is loaded
// (call this inside loadCSVFromText after you set headers & data)
function resetSuggestionStateForCurrentDataset() {
  appliedSuggestionIds = new Set();
  dismissedSuggestionIds = new Set();
  saveSuggestionState();
}

const dq = {
  section: null,
  tabs: null,
  panels: null,
  dashPanel: null,
  badPanel: null,
  _tabEls: null
};

function ensureDQResultsTabs() {
  if (dq.section) return dq;

  // Create section & containers
  dq.section = document.createElement('section');
  dq.section.id = 'dqResultsSection';
  dq.section.style.display = 'none';

  dq.tabs = document.createElement('div');
  dq.tabs.id = 'dqResultsTabs';
  dq.tabs.className = 'profile-tabs';

  const panels = document.createElement('div');
  panels.id = 'dqResultsPanels';

  dq.dashPanel = document.createElement('div');
  dq.dashPanel.id = 'dqDashboardPanel';
  dq.dashPanel.className = 'dq-panel';

  dq.badPanel = document.createElement('div');
  dq.badPanel.id = 'badDataPanel';
  dq.badPanel.className = 'dq-panel';


  dq.analysisPanel = document.createElement('div');
  dq.analysisPanel.id = 'analysisPanel';
  dq.analysisPanel.className = 'dq-panel';
  panels.appendChild(dq.analysisPanel);


  // Insert the section right before the current dashboard in the DOM
  const dash = dashboardSection; // existing .dashboard element
  const badCont = badDataTableContainer; // existing bad data container
  if (!dash || !dash.parentNode) return dq;
  const parent = dash.parentNode;
  parent.insertBefore(dq.section, dash);

  // Move existing panels under the new section
  dq.section.appendChild(dq.tabs);
  dq.section.appendChild(panels);
  panels.appendChild(dq.dashPanel);
  panels.appendChild(dq.badPanel);
  dq.dashPanel.appendChild(dash);
  dq.badPanel.appendChild(badCont);

  // Hide the old Preview button (now a tab)
  if (previewBadBtn) previewBadBtn.style.display = 'none';

  // Build tabs
  const makeTab = (label, key) => {
    const el = document.createElement('div');
    el.className = 'profile-tab';
    el.textContent = label;
    el.addEventListener('click', () => activateDQTab(key));
    dq.tabs.appendChild(el);
    return el;
  };
  dq._tabEls = {
    dashboard: makeTab('DQ Dashboard', 'dashboard'),
    bad: makeTab('Preview Bad Data', 'bad'),
    analysis: makeTab('Analysis & Suggestions', 'analysis'),
  };

  return dq;
}


// === [DASHBOARD ENHANCEMENTS] ===
let donutChart, badByColumnChart, badByRuleChart;
let prevRunMetrics = null; // to show KPI deltas between runs

function ensureDashboardLayout() {
  // Wrap KPIs into a grid (if not already)
  const dash = dashboardSection; // existing .dashboard container
  if (!dash) return;

  // Ensure KPI wrapper
  let kpiWrap = dash.querySelector('.kpis');
  if (!kpiWrap) {
    kpiWrap = document.createElement('div');
    kpiWrap.className = 'kpis';
    // Assume the KPI cards (Total Rows, Bad Rows, Good %) already exist in DOM
    // If they are not grouped, the wrapper will simply be empty and we leave it.
    // Try to find their parent and move them in (best-effort).
    const kpiCandidates = Array.from(dash.querySelectorAll('.scorecard'));
    if (kpiCandidates.length) {
      const firstKpiParent = kpiCandidates[0].parentNode;
      dash.insertBefore(kpiWrap, firstKpiParent);
      kpiCandidates.forEach(c => kpiWrap.appendChild(c));
    } else {
      // Fall back: just insert wrapper at top of dashboard
      dash.insertBefore(kpiWrap, dash.firstChild);
    }
  }

  // Attach a small delta <span> in each KPI (if not present)
  const ensureDelta = (elId) => {
    const host = document.getElementById(elId);
    if (!host) return null;
    let delta = host.parentElement?.querySelector?.('.delta');
    if (!delta) {
      delta = document.createElement('span');
      delta.className = 'delta flat';
      delta.textContent = 'No change';
      host.parentElement?.appendChild(delta);
    }
    return delta;
  };
  ensureDelta('totalRows');
  ensureDelta('badRows');
  ensureDelta('goodPercent');

  // Ensure charts grid exists
  let charts = dash.querySelector('.charts');
  if (!charts) {
    charts = document.createElement('div');
    charts.className = 'charts';
    dash.appendChild(charts);
  }

  // Helper to build a chart card with a title + canvas
  const ensureChartCard = (title, canvasId) => {
    let card = charts.querySelector(`#card-${canvasId}`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'chart-container';
      card.id = `card-${canvasId}`;

      const h = document.createElement('h4');
      h.textContent = title;

      const cv = document.createElement('canvas');
      cv.id = canvasId;

      card.appendChild(h);
      card.appendChild(cv);
      charts.appendChild(card);
    }
    return card;
  };

  // Existing: you already have #radarChart and #badPieChart in HTML
  // New: Good vs Bad (Donut), Top Bad Columns, Top Failing Rules
  ensureChartCard('Good vs Bad', 'goodBadDonut');
  ensureChartCard('Top Bad Columns (Top 10)', 'badByColumnChart');
  ensureChartCard('Top Failing Rules', 'badByRuleChart');
}

function normalizeForUniq(v) {
  if (v == null) return null;
  let s = String(v);
  if (UNIQ_NORMALIZE_STRING) {
    s = s.trim().replace(/\s{2,}/g, ' ');
    s = s.toLowerCase();
  }
  return s;
}

function setDeltaText(elId, oldVal, newVal, formatter = (x)=>String(x)) {
  const host = document.getElementById(elId);
  if (!host) return;
  const deltaEl = host.parentElement?.querySelector?.('.delta');
  if (!deltaEl || oldVal == null) return;

  const diff = newVal - oldVal;
  if (Math.abs(diff) < 1e-12) {
    deltaEl.className = 'delta flat';
    deltaEl.textContent = 'No change';
    return;
  }
  const sign = diff > 0 ? '+' : '';
  const directionUp = diff > 0;
  deltaEl.className = `delta ${directionUp ? 'up' : 'down'}`;
  deltaEl.textContent = `${sign}${formatter(diff)} vs last run`;
}

// === [RULE EQUALITY/INCLUSION CHECKS] ===
function rulesContains(proposed) {
  return rules.some(r => ruleEquals(r, proposed));
}

function ruleEquals(existing, proposed) {
  if (!existing || !proposed) return false;
  if (existing.column !== proposed.column) return false;
  if (existing.conditionType !== proposed.conditionType) return false;

  const ep = existing.params || {};
  const pp = proposed.params || {};

  switch (existing.conditionType) {
    case 'notEmpty':
    case 'unique':
      return true;

    case 'regexMatch': {
      // Prefer params; fallback to scraping pattern from condition string
      const epat = ep.pattern || extractRegexFromCondition(existing.condition || '');
      const ppat = pp.pattern || '';
      return String(epat) === String(ppat);
    }

    case 'range': {
      const tol = 1e-9;
      return isFinite(ep.min) && isFinite(ep.max) &&
             isFinite(pp.min) && isFinite(pp.max) &&
             Math.abs(Number(ep.min) - Number(pp.min)) < tol &&
             Math.abs(Number(ep.max) - Number(pp.max)) < tol;
    }

    case 'equals':
      return String(ep.value) === String(pp.value);

    case 'greaterThan':
    case 'lessThan':
      return Number(ep.value) === Number(pp.value);

    case 'classMatch': {
      const a = new Set(Array.isArray(ep.values) ? ep.values.map(String) : []);
      const b = new Set(Array.isArray(pp.values) ? pp.values.map(String) : []);
      if (a.size !== b.size) return false;
      for (const v of a) if (!b.has(v)) return false;
      return true;
    }

    case 'dateRange':
    case 'timeRange':
    case 'datetimeRange':
      return String(ep.min) === String(pp.min) && String(ep.max) === String(pp.max);

	case 'freshnessWithin': {
	  return Number(ep.value) === Number(pp.value) && String(ep.unit) === String(pp.unit);
	}
	
	case 'cadenceWithin': {
	  const eTol = Number(ep.tolerance || ep.toleranceMultiplier || 1.5);
	  const pTol = Number(pp.tolerance || pp.toleranceMultiplier || 1.5);
	  return Number(ep.value) === Number(pp.value) &&
	         String(ep.unit) === String(pp.unit) &&
	         Math.abs(eTol - pTol) < 1e-9;
	}

    default:
      // Fallback: loose compare using condition string
      return (existing.condition || '').trim() === (buildConditionFromParams(proposed) || '').trim();
  }
}

function extractRegexFromCondition(condStr) {
  // matches new RegExp("...").test(value) — pulls the pattern
  const m = /RegExp\(\s*(["'])(.*?)\1\s*\)\.test/i.exec(String(condStr));
  return m ? m[2] : '';
}

function isSuggestionImplemented(sug) {
  if (!Array.isArray(sug.proposedRules) || sug.proposedRules.length === 0) return false;
  // Consider the suggestion implemented if ALL its proposed rules are present
  return sug.proposedRules.every(r => rulesContains(r));
}


function pctFormat(x) {
  // Accepts numeric or string like "99.12%"
  const v = typeof x === 'string' ? parseFloat(x) : x;
  return `${(v).toFixed(2)}%`;
}

function activateDQTab(key) {
  ensureDQResultsTabs();

  // Make the tabs section visible
  dq.section.style.display = 'block';

  // Hide all panels
  dq.dashPanel.classList.remove('active');
  dq.badPanel.classList.remove('active');
  dq.analysisPanel.classList.remove('active');

  // Show selected panel
  if (key === 'dashboard') {
    dq.dashPanel.classList.add('active');
  } else if (key === 'bad') {
    dq.badPanel.classList.add('active');
    renderBadDataPanel();
  } else if (key === 'analysis') {
    dq.analysisPanel.classList.add('active');
    renderAnalysisPanel();
  }

  // Tab UI state
  Object.values(dq._tabEls).forEach(el => el.classList.remove('active'));
  dq._tabEls[key].classList.add('active');
}


function renderAnalysisPanel() {
  const panel = dq.analysisPanel;
  panel.innerHTML = '<h4 style="color:#000;">Automated Data Quality Analysis & Suggestions (Local)</h4>';

  if (!lastBadRowsSet) {
    panel.innerHTML += '<div class="chart-empty">Run the data quality check first to generate analysis.</div>';
    return;
  }

  loadSuggestionState(); // load per-dataset applied/dismissed sets

  // ---------- Earlier “bullet” summary ----------
  const fmtPct = (n, d) => !d ? '0.00%' : `${((n/d)*100).toFixed(2)}%`;
  const totalRows = data.length;
  const badRows = lastBadRowsSet.size;
  const goodRows = totalRows - badRows;

  const asArray = (x) => (x && typeof x.entries === 'function') ? Array.from(x.entries()) : [];
  const badColsCounts = asArray(lastBadRowsByColumn).map(([c,set]) => [c,set.size]).sort((a,b)=>b[1]-a[1]);
  const worstCol = badColsCounts[0];

  const badRulesCounts = asArray(lastBadRowsByRule).map(([lab,set]) => [lab,set.size]).sort((a,b)=>b[1]-a[1]);
  const worstRule = badRulesCounts[0];

  const missingCols = headers
    .map(h => {
      const nonEmpty = data.reduce((acc, r) => acc + ((r[h] !== '' && r[h] != null) ? 1 : 0), 0);
      const miss = totalRows - nonEmpty;
      return { h, miss, pct: totalRows ? (miss/totalRows)*100 : 0 };
    })
    .filter(m => m.pct > 10)
    .sort((a,b)=>b.pct - a.pct);

  const colsWithRules = new Set(rules.map(r => r.column));
  const colsWithoutRules = headers.filter(h => !colsWithRules.has(h));

  const bullets = document.createElement('div');
  bullets.style.marginTop = '8px';
  bullets.innerHTML = `
    <ul style="margin-top:10px;">
      <li><b>Overall Data Quality:</b> ${goodRows} out of ${totalRows} rows (${fmtPct(goodRows, totalRows)}) passed all checks.</li>
      ${worstCol && worstCol[1] > 0 ? `
        <li><b>Column with Most Issues:</b>
          <span style="color:#d9534f;font-weight:600;">${worstCol[0]}</span>
          (${worstCol[1]} bad rows).<br>
          <span style="color:#555;">Suggestion:</span> Review rules, source values, and missingness for this column.
        </li>` : ''
      }
      ${worstRule && worstRule[1] > 0 ? `
        <li><b>Most Failing Rule:</b>
          <span style="color:#d9534f;font-weight:600;">${worstRule[0]}</span>
          (${worstRule[1]} bad rows).<br>
          <span style="color:#555;">Suggestion:</span> Validate rule logic and align with data owners.
        </li>` : ''
      }
      ${missingCols.length ? `
        <li><b>Columns with High Missingness:</b>
          ${missingCols.map(m => `<span style="color:#d9534f;">${m.h} (${m.pct.toFixed(1)}%)</span>`).join(', ')}.<br>
          <span style="color:#555;">Suggestion:</span> Make fields mandatory or enrich upstream. Consider safe defaults.
        </li>` : ''
      }
      ${colsWithoutRules.length ? `
        <li><b>Columns with No Data Quality Rules:</b>
          ${colsWithoutRules.map(h => `<span style="color:#005fa3;">${h}</span>`).join(', ')}.<br>
          <span style="color:#555;">Suggestion:</span> Add baseline checks (notEmpty / regex / range / classMatch / unique).
        </li>` : ''
      }
    </ul>
  `;
  panel.appendChild(bullets);

  // ---------- Local Heuristics toolbar ----------
  const bar = document.createElement('div');
  bar.style.cssText = "margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
  const runBtn = document.createElement('button');
  runBtn.textContent = "Run Local Analysis";
  runBtn.style.cssText = "background:#0d6efd;color:#fff;border:none;border-radius:8px;padding:8px 12px;font-weight:700;";
  const note = document.createElement('span');
  note.style.cssText = "color:#555;";
  note.textContent = "No cloud calls. Heuristics only.";

  // Optional: quick reset for dismissed suggestions (current dataset only)
  const resetDismiss = document.createElement('button');
  resetDismiss.textContent = "Reset Dismissed";
  resetDismiss.style.cssText = "background:#94a3b8;color:#fff;border:none;border-radius:8px;padding:6px 10px;";
  resetDismiss.onclick = () => {
    dismissedSuggestionIds = new Set();
    saveSuggestionState();
    renderHeuristics(); // refresh list
  };

  bar.appendChild(runBtn);
  bar.appendChild(note);
  bar.appendChild(resetDismiss);
  panel.appendChild(bar);

  const out = document.createElement('div');
  out.style.cssText = "margin-top:10px;";
  panel.appendChild(out);

  // ---- Renderer with filtering: hide applied/dismissed/already-implemented ----
  const renderHeuristics = () => {
    out.innerHTML = '';
    const res = runLocalHeuristics(); // your existing engine

    // Filter at card-level by applied/dismissed/implemented
    const filtered = res.suggestions.filter(s =>
      !dismissedSuggestionIds.has(s.id) &&
      !appliedSuggestionIds.has(s.id) &&
      !isSuggestionImplemented(s)
    );

    const summary = document.createElement('div');
    summary.style.cssText = "margin:10px 0 12px; font-weight:600; color:#1a2233;";
    summary.textContent = `Local analysis: ${filtered.length} suggestions (hidden: ${res.suggestions.length - filtered.length}).`;
    out.appendChild(summary);

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = 'No suggestions to show.';
      out.appendChild(empty);
      return;
    }

    filtered.forEach(sug => {
      const card = document.createElement('div');
      card.style.cssText = "border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-bottom:10px;background:#fff;";
      card.dataset.suggestionId = sug.id;

      // Header row with Title + Dismiss
      const head = document.createElement('div');
      head.style.cssText = "display:flex;align-items:center;gap:8px;";
      const title = document.createElement('div');
      title.style.cssText = "font-weight:800;color:#0f172a;flex:1;";
      title.textContent = `${sug.title}  [${String(sug.severity||'medium').toUpperCase()} • ${sug.dimension||'—'}]`;
      const dismissBtn = document.createElement('button');
dismissBtn.innerHTML = '&times;'; // or '&#10005;' for a slightly bolder X
dismissBtn.title = "Dismiss this suggestion";
dismissBtn.setAttribute('aria-label', 'Dismiss');
dismissBtn.style.cssText = `
  background: #e11d48;
  color: #fff;
  border: none;
  border-radius: 50%;
  width: 24px;
  height: 24px;
  font-size: 18px;
  line-height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  margin-left: 8px;
  padding: 0;
  transition: background 0.2s;
`;
dismissBtn.onmouseover = () => dismissBtn.style.background = "#be123c";
dismissBtn.onmouseout  = () => dismissBtn.style.background = "#e11d48";
dismissBtn.onclick = () => {
  dismissedSuggestionIds.add(sug.id);
  saveSuggestionState();
  card.remove();
};

      head.appendChild(title);
      head.appendChild(dismissBtn);
      card.appendChild(head);

      if (sug.rationale) {
        const rationale = document.createElement('div');
        rationale.style.cssText = "margin:6px 0 8px;color:#334155;";
        rationale.textContent = sug.rationale || '';
        card.appendChild(rationale);
      }

      if (Number.isFinite(sug.estimatedCoveragePct)) {
        const cov = document.createElement('div');
        cov.style.cssText = "color:#475569;margin-bottom:6px;";
        cov.textContent = `Covers ~${sug.estimatedCoveragePct.toFixed(1)}% of failing rows for the impacted column(s).`;
        card.appendChild(cov);
      }

      if (Array.isArray(sug.transforms) && sug.transforms.length) {
        const hdrT = document.createElement('div');
        hdrT.style.cssText = "font-weight:700;margin:6px 0;color:#0f172a;";
        hdrT.textContent = "Suggested transformations:";
        card.appendChild(hdrT);

        sug.transforms.forEach(t => {
          const line = document.createElement('div');
          line.style.cssText = "color:#334155;margin:2px 0;";
          line.textContent = `${t.column}: ${t.type} — ${t.details}${t.example ? ` (e.g., ${t.example})` : ''}`;
          card.appendChild(line);
        });
      }

      // Proposed rules list (each rule row can be applied; row disappears on apply)
      if (Array.isArray(sug.proposedRules) && sug.proposedRules.length) {
        const hdrR = document.createElement('div');
        hdrR.style.cssText = "font-weight:700;margin:8px 0 4px;color:#0f172a;";
        hdrR.textContent = "Proposed rules:";
        card.appendChild(hdrR);

        sug.proposedRules.forEach(pr => {
          // If this particular rule already exists, skip rendering the row
          if (rulesContains(pr)) return;

          const row = document.createElement('div');
          row.className = 'sug-rule-row';
          row.style.cssText = "display:flex;gap:8px;align-items:center;margin:2px 0;flex-wrap:wrap;";
          row.innerHTML = `<code>[${pr.column}] ${pr.conditionType}</code> <span style="color:#64748b">${pr.previewCondition || ''}</span>`;

          const add = document.createElement('button');
          add.textContent = "Add rule";
          add.style.cssText = "margin-left:auto;background:#38B09D;color:#fff;border:none;border-radius:6px;padding:6px 10px;";
          add.onclick = () => {
            const rule = {
              column: pr.column,
              dataType: pr.dataType || inferDataType(pr.column),
              conditionType: pr.conditionType,
              condition: (typeof buildConditionFromParams === 'function') ? buildConditionFromParams(pr) : '',
              params: pr.params || {}
            };
            if (!rule.condition) { alert('Could not auto-build condition. Please add this rule manually.'); return; }

            // Add rule to your model/UI
            rules.push(rule);
            renderRules();
            lastBadRowsSet = null; // invalidate, so next run reflects it

            // Remove this rule row immediately
            row.remove();

            // If no rule rows remain visible on this card, mark suggestion applied & remove card
            const remaining = card.querySelectorAll('.sug-rule-row');
            if (remaining.length === 0) {
              appliedSuggestionIds.add(sug.id);
              saveSuggestionState();
              card.remove();
            } else {
              // Not fully applied; keep the card visible
              saveSuggestionState();
            }
          };

          row.appendChild(add);
          card.appendChild(row);
        });
      }
if (Array.isArray(sug.tips) && sug.tips.length) {
  const tipsHdr = document.createElement('div');
  tipsHdr.style.cssText = "font-weight:700;margin-top:8px;color:#0f172a;";
  tipsHdr.textContent = "Tips:";
  card.appendChild(tipsHdr);

  const ul = document.createElement('ul');
  ul.style.cssText = "margin:6px 0 0 18px; color:#334155;";
  sug.tips.forEach(t => {
    const li = document.createElement('li');
    li.textContent = t;
    ul.appendChild(li);
  });
  card.appendChild(ul);
}


      out.appendChild(card);
    });
  };

  // First render + wire button
  renderHeuristics();
  runBtn.onclick = renderHeuristics;
}





  const DQ_DIMENSIONS = ['Completeness', 'Accuracy', 'Consistency', 'Timeliness', 'Uniqueness', 'Validity'];

  // Map rule condition to DQ dimension (simple heuristics)
function mapRuleToDimension(rule) {
  const c = rule?.condition || '';
  if (/value\s*\!?==\s*''/.test(c)) return 'Completeness';
  if (/Number\(\s*value\s*\)/.test(c)) return 'Accuracy';
  if (/regex/i.test(c)) return 'Validity';
  if ((/Date\.parse|datetime|time/i.test(c)) || ['date','time','datetime'].includes(rule?.dataType)) return 'Timeliness';
  if (/unique/i.test(c) || rule?.conditionType === 'unique') return 'Uniqueness';
  if (rule?.conditionType === 'classMatch') return 'Consistency';
  if (rule?.conditionType === 'freshnessWithin') return 'Timeliness';
  if (rule?.conditionType === 'cadenceWithin') return 'Timeliness';
  return 'Validity';
}




function ensureDataTypeOptions() {
  if (!dataTypeSelect) return;
  const desired = ['string', 'numeric', 'integer', 'date', 'boolean', 'time', 'datetime'];
  const existing = new Set([...dataTypeSelect.options].map(o => o.value));
  desired.forEach(v => {
    if (!existing.has(v)) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
      dataTypeSelect.appendChild(opt);
    }
  });
}

  function clearParamInputs() {
    paramInputs.innerHTML = '';
  }

  function parseCSV(text) {
    const lines = text.trim().split('\n').filter(l => l.trim() !== '');
    if (lines.length < 1) return {headers: [], data: []};
    const hdrs = lines[0].split(',').map(h => h.trim());
    const rows = lines.slice(1).map(line => {
      const vals = line.split(',');
      const obj = {};
      hdrs.forEach((h,i) => obj[h] = vals[i] !== undefined ? vals[i].trim() : '');
      return obj;
    });
    return {headers: hdrs, data: rows};
  }

// Render the Bad Data panel when the tab is opened
function renderBadDataPanel() {
  ensureDQResultsTabs();

  // Clear any prior inline message
  const oldMsg = dq.badPanel.querySelector('.alert');
  if (oldMsg) oldMsg.remove();

  // If we haven't computed yet, do a run now
  if (!lastBadRowsSet) {
    lastBadRowsSet = runDataQualityChecks();
  }

  // If there are no bad rows, show a friendly inline message
  if (!lastBadRowsSet || lastBadRowsSet.size === 0) {
    badDataTableContainer.style.display = 'none';
    const msg = document.createElement('div');
    msg.className = 'alert';
    msg.textContent = 'No bad data found based on current rules.';
    dq.badPanel.appendChild(msg);
    return;
  }

  // We have bad rows → render the table and show the container
  const badRows = Array.from(lastBadRowsSet).map(i => data[i]);
  renderTable(badRows, badDataTable);
  badDataTableContainer.style.display = 'block';
}


function inferDataType(column) {
  const sampleValues = data.map(row => row[column]).filter(v => v !== '' && v != null);
  const sample = sampleValues.slice(0, 10).map(v => String(v).trim());

  if (sample.length === 0) return 'string';

  // Helpers
  const isAllNumeric = sample.every(v => !isNaN(Number(v)) && v !== '');
  const isAllDate = sample.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v));
  const isAllTime = sample.every(v => /^\d{2}:\d{2}(:\d{2})?$/.test(v)); // HH:MM or HH:MM:SS
  const isAllDateTime = sample.every(v => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(v));
const isAllDateOrDateTime = sample.every(v =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) ||
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(v)
);
if (isAllDateOrDateTime) return 'datetime';

  const normBool = v => {
    const s = v.toLowerCase();
    if (s === 'true' || s === 'false') return true;
    if (s === 'yes' || s === 'no') return true;
    if (s === '0' || s === '1') return true;
    return false;
  };
  const isAllBooleanLike = sample.every(normBool);
  const onlyZeroOne = sample.every(v => ['0', '1'].includes(v));

  // Order mattersâ€”recognize specific types before generic 'numeric'
  if (isAllBooleanLike && !isAllNumeric) return 'boolean';
  // If only 0/1 present, prefer boolean over numeric
  if (isAllBooleanLike && onlyZeroOne) return 'boolean';
  if (isAllTime) return 'time';
  if (isAllDateTime) return 'datetime';
  if (isAllDate) return 'date';
  if (isAllNumeric) return 'numeric';
  return 'string';
}
// ===== Robust outlier helpers =====
function medianOf(sorted) {
  const n = sorted.length;
  if (!n) return NaN;
  const m = (n - 1) / 2;
  return (sorted[Math.floor(m)] + sorted[Math.ceil(m)]) / 2;
}

// Median Absolute Deviation (MAD)
function mad(arr) {
  if (!arr.length) return NaN;
  const x = arr.slice().sort((a,b)=>a-b);
  const med = medianOf(x);
  const dev = x.map(v => Math.abs(v - med)).sort((a,b)=>a-b);
  return medianOf(dev);
}

// Simple skewness proxy from quartiles (Bowley)
function bowleySkew(q1, q2, q3) {
  const denom = (q3 - q1) || 1e-12;
  return ((q3 + q1 - 2*q2) / denom);
}

/**
 * Pick robust bounds for outliers, considering sample size and skew.
 * Returns { lo, hi, method }
 */
function robustOutlierBounds(x) {
  const n = x.length;
  if (!n) return { lo: NaN, hi: NaN, method: 'none' };
  const s = x.slice().sort((a,b)=>a-b);
  const q1 = quantile(s, 0.25);
  const q2 = quantile(s, 0.50);
  const q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  const mc = bowleySkew(q1, q2, q3); // skew proxy
  const _mad = mad(s);
  const sigmaMAD = 1.4826 * _mad; // MAD -> sigma

  // Heuristics to choose method:
  // - small samples: use trimmed percentiles
  // - heavy skew: prefer MAD or wider upper bound
  // - otherwise: classic IQR
  if (n < 80) {
    const lo = quantile(s, 0.05);
    const hi = quantile(s, 0.95);
    return { lo, hi, method: 'p5-95' };
  }

  const skewHeavy = Math.abs(mc) >= 0.4;  // tune if needed
  if (skewHeavy && isFinite(sigmaMAD) && sigmaMAD > 0) {
    // MAD-based symmetric fence around median
    const k = 3.5; // robust "sigma" fence
    const lo = q2 - k * sigmaMAD;
    const hi = q2 + k * sigmaMAD;
    return { lo, hi, method: 'MAD±3.5σ' };
  }

  if (isFinite(iqr) && iqr > 0) {
    const k = 1.5;
    const lo = q1 - k * iqr;
    const hi = q3 + k * iqr;
    return { lo, hi, method: 'IQR±1.5' };
  }

  // Fallback to extreme trimming if data is flat/weird
  return { lo: quantile(s, 0.01), hi: quantile(s, 0.99), method: 'p1-99' };
}

// [PROFILING] Utility: get non-empty values for a column
function getValues(col) {
  return data.map(r => r[col]).filter(v => v !== '' && v != null);
}

// [PROFILING] Detect if a column is numeric via your existing inferDataType
function isNumericColumn(col) {
  const t = inferDataType(col);
  return t === 'numeric' || t === 'integer';
}

// [PROFILING] Robust numeric conversion
function toNumeric(arr) {
  return arr.map(Number).filter(v => Number.isFinite(v));
}
/***** ================= LOCAL HEURISTICS ENGINE (Option A) ================= *****/

// Guard: if buildConditionFromParams was not defined earlier, define it now.
if (typeof buildConditionFromParams !== 'function') {
  function buildConditionFromParams(r) {
    try {
      switch (r.conditionType) {
        case 'notEmpty':       return `value !== '' && value != null`;
        case 'unique':         return `__unique__`;
        case 'regexMatch':     return r.params?.pattern ? `new RegExp(${JSON.stringify(r.params.pattern)}).test(value)` : '';
        case 'range':          return (r.params?.min!=null && r.params?.max!=null) ? `(Number(value) >= ${Number(r.params.min)} && Number(value) <= ${Number(r.params.max)})` : '';
        case 'equals':         return (r.params?.value!=null) ? `value === ${JSON.stringify(r.params.value)}` : '';
        case 'greaterThan':    return (r.params?.value!=null) ? `Number(value) > ${Number(r.params.value)}` : '';
        case 'lessThan':       return (r.params?.value!=null) ? `Number(value) < ${Number(r.params.value)}` : '';
        case 'classMatch':     return Array.isArray(r.params?.values) ? `${JSON.stringify(r.params.values)}.includes(String(value))` : '';
        case 'dateRange':      return (r.params?.min && r.params?.max) ? `(value >= '${r.params.min}' && value <= '${r.params.max}')` : '';
        case 'timeRange':      return (r.params?.min && r.params?.max) ? `(String(value) >= '${r.params.min}' && String(value) <= '${r.params.max}')` : '';
        case 'datetimeRange':  return (r.params?.min && r.params?.max) ? `(Date.parse(String(value).replace(' ','T')) >= Date.parse('${r.params.min}') && Date.parse(String(value).replace(' ','T')) <= Date.parse('${r.params.max}'))` : '';

case 'datetimeRange': return (r.params?.min && r.params?.max)
          ? `(Date.parse(String(value).replace(' ','T')) >= Date.parse('${r.params.min}') && Date.parse(String(value).replace(' ','T')) <= Date.parse('${r.params.max}'))`
          : '';
        
	case 'freshnessWithin': {
	  const v = Number(r.params?.value);
	  const u = r.params?.unit;
	  if (!v || !u) return '';
	  const ms =
	    u === 'minute' ? v * 60e3 :
	    u === 'hour'   ? v * 3600e3 :
	    u === 'day'    ? v * 86400e3 :
	                     v * 7 * 86400e3; // week
	  return `(Date.now() - Date.parse(String(value).replace(' ','T')) <= ${ms})`;
	}
	case 'cadenceWithin': {
	  // dataset-level; handled specially in the engine
	  return '__cadence__';
	}


        default: return '';
      }
    } catch { return ''; }
  }
}

// ---------- Utilities ----------
function onlyFinite(nums) { return nums.filter(Number.isFinite); }
function median(sorted) { const n=sorted.length; if(!n) return NaN; const m=(n-1)/2; return (sorted[Math.floor(m)] + sorted[Math.ceil(m)]) / 2; }
function quant(sorted, p){ if(!sorted.length) return NaN; const i=(sorted.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i), h=i-lo; return lo===hi?sorted[lo]:(sorted[lo]*(1-h)+sorted[hi]*h); }
function IQR(sorted){ return quant(sorted,0.75) - quant(sorted,0.25); }

function toNumCol(col) {
  return data.map(r => Number(r[col])).map(v => (Number.isFinite(v)? v : NaN)).filter(v => Number.isFinite(v));
}
function toStrCol(col) {
  return data.map(r => (r[col]==null? '' : String(r[col])));
}
function nonMissingIdx(col) {
  const idx=[]; for (let i=0;i<data.length;i++){ const v=data[i][col]; if (v!=='' && v!=null) idx.push(i); } return idx;
}
function failingIdxForColumn(col) {
  // Uses shared analysis state from last run (ensure you promoted these to module scope)
  const set = (typeof lastBadRowsByColumn !== 'undefined' && lastBadRowsByColumn.get) ? lastBadRowsByColumn.get(col) : null;
  return set ? new Set(set) : new Set();
}

// Basic trimming / casing checks on string data
function strStats(values) {
  let leading=0, trailing=0, multiSpaces=0, lower=0, upper=0, mixed=0, dashCount=0, underscore=0;
  for (const s of values) {
    if (!s) continue;
    if (/^\s+/.test(s)) leading++;
    if (/\s+$/.test(s)) trailing++;
    if (/\s{2,}/.test(s)) multiSpaces++;
    if (/[a-z]/.test(s) && !/[A-Z]/.test(s)) lower++;
    else if (/[A-Z]/.test(s) && !/[a-z]/.test(s)) upper++;
    else if (/[A-Z]/.test(s) && /[a-z]/.test(s)) mixed++;
    if (s.includes('-')) dashCount++;
    if (s.includes('_')) underscore++;
  }
  return { leading, trailing, multiSpaces, lower, upper, mixed, dashCount, underscore, total: values.length };
}

// Pattern inference (very lightweight)
function inferRegexFromSamples(samples) {
  if (!samples.length) return null;

  // All digits of same length?
  const allDigits = samples.every(s => /^\d+$/.test(s));
  if (allDigits) {
    const lens = new Set(samples.map(s => s.length));
    if (lens.size === 1) return { pattern: `^\\d{${samples[0].length}}$`, description: 'fixed-length digits' };
    const min = Math.min(...samples.map(s=>s.length)), max = Math.max(...samples.map(s=>s.length));
    return { pattern: `^\\d{${min},${max}}$`, description: 'variable-length digits' };
  }

  // Letters+digits blocks split by non-alphanum
  const split = samples.map(s => s.split(/[^A-Za-z0-9]+/));
  const sameBlocks = split.every(a => a.length === split[0].length);
  if (sameBlocks && split[0].length > 1) {
    const groups = [];
    for (let g=0; g<split[0].length; g++) {
      const grp = split.map(a => a[g]);
      const isAllLetters = grp.every(v => /^[A-Za-z]+$/.test(v));
      const isAllUpper   = grp.every(v => /^[A-Z]+$/.test(v));
      const isAllDigits  = grp.every(v => /^\d+$/.test(v));
      const lens = new Set(grp.map(v => v.length));
      if (isAllDigits) { groups.push(lens.size===1? `\\d{${grp[0].length}}` : `\\d+`); }
      else if (isAllUpper) { groups.push(lens.size===1? `[A-Z]{${grp[0].length}}` : `[A-Z]+`); }
      else if (isAllLetters) { groups.push(lens.size===1? `[A-Za-z]{${grp[0].length}}` : `[A-Za-z]+`); }
      else { groups.push(`\\w+`); }
    }
    // reconstruct separators
    const sep = (s) => {
      const m = s.match(/[^A-Za-z0-9]+/g);
      return m || [];
    };
    const seps = sep(samples[0]);
    let pat = '^' + groups[0];
    for (let i=1;i<groups.length;i++){
      pat += (seps[i-1] ? samples[0].match(/[^A-Za-z0-9]+/g)[i-1].replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&') : `[-_\\s]?`) + groups[i];
    }
    pat += '$';
    return { pattern: pat, description: 'alphanumeric blocks with separators' };
  }

  // Fallback by length
  const minL = Math.min(...samples.map(s=>s.length));
  const maxL = Math.max(...samples.map(s=>s.length));
  return { pattern: `^.{${minL},${maxL}}$`, description: 'length range check' };
}

// Impact: % of current failing rows for this column that would be captured by the suggested rule
function estimateCoverageForRule(col, ruleConditionFn) {
  const failingIdx = failingIdxForColumn(col);
  if (!failingIdx.size) return 0;
  let captured = 0;
  for (const i of failingIdx) {
    const value = data[i][col];
    try { if (!ruleConditionFn(value)) captured++; } catch(e){ /* ignore */ }
  }
  return (captured / failingIdx.size) * 100;
}

// ---------- Heuristic Suggestors ----------
function suggestMissingness() {
  const out = [];
  for (const col of headers) {
    const idx = nonMissingIdx(col);
    const missing = data.length - idx.length;
    const missingPct = data.length ? (missing / data.length) * 100 : 0;
    if (missingPct >= 5) {
      out.push({
        id: `missing-${col}`,
        title: `High missingness in [${col}] (${missingPct.toFixed(1)}%)`,
        severity: missingPct >= 20 ? 'high' : 'medium',
        dimension: 'Completeness',
        impactedColumns: [col],
        rationale: `About ${missingPct.toFixed(1)}% of rows are empty/null in [${col}].`,
        estimatedCoveragePct: estimateCoverageForRule(col, v => (v !== '' && v != null)), // of the current failing set
        proposedRules: [{
          column: col, conditionType: 'notEmpty', params: {},
          previewCondition: 'Value must not be empty'
        }],
        transforms: [{ column: col, type: 'map', details: 'Fill null/empty with default or backfill if business-appropriate' }]
      });
    }
  }
  return out;
}

function suggestOutliersSmart() {
  const out = [];
  for (const col of headers) {
    const t = inferDataType(col);
    if (t !== 'numeric' && t !== 'integer') continue;

    const vals = toNumCol(col);
    if (vals.length < 12) continue; // need data to be meaningful

    const { lo, hi, method } = robustOutlierBounds(vals);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) continue;

    const total = vals.length;
    const outCount = vals.reduce((acc, v) => acc + ((v < lo || v > hi) ? 1 : 0), 0);
    const outPct = total ? (outCount / total) * 100 : 0;

    // If almost nothing is outlying, skip the suggestion (tweak threshold)
    if (outPct < 1) continue;

    // Build "range" rule
    const rule = {
      column: col,
      conditionType: 'range',
      params: { min: lo, max: hi },
      previewCondition: `Within robust bounds (${method})`
    };

    // Treatment tips (winsorize/cap, set null, log scale, investigate)
    const transforms = [
      { column: col, type: 'winsorize', details: `Cap values to [${smartNumber(lo)}, ${smartNumber(hi)}]` },
      { column: col, type: 'nullify', details: 'Convert extreme outliers to null for downstream imputation (if acceptable)' },
      { column: col, type: 'log', details: 'Consider log-transform if strictly positive and highly skewed' },
      { column: col, type: 'investigate', details: 'Review source system for data entry or unit errors causing spikes' }
    ];

    out.push({
      id: `outliers-${col}`,
      title: `Outliers detected in [${col}] — propose robust bounds`,
      severity: outPct >= 10 ? 'high' : 'medium',
      dimension: 'Validity',
      impactedColumns: [col],
      rationale: `${outCount} (${outPct.toFixed(1)}%) values fall outside ${method} bounds.`,
      estimatedCoveragePct: outPct, // how much bad you'd catch
      proposedRules: [rule],
      transforms,
      // A little nudge to treat the outliers
      tips: [
        `Treat outliers in [${col}] now (cap/winsorize or null) to stabilize dashboards, then re-run DQ.`,
        `If values represent rates or sensors, consider per-group caps (e.g., by site or product).`
      ]
    });
  }
  return out;
}

function suggestStringPatterns() {
  const out = [];
  for (const col of headers) {
    const type = inferDataType(col);
    if (type !== 'string') continue;

    const idx = nonMissingIdx(col);
    if (idx.length < 8) continue;

    const vals = idx.slice(0, 200).map(i => String(data[i][col])); // sample up to 200
    const stats = strStats(vals);

    const transforms = [];
    if (stats.leading || stats.trailing) transforms.push({ column: col, type: 'trim', details: 'Trim leading/trailing spaces', example: '" ACME " → "ACME"' });
    if (stats.multiSpaces) transforms.push({ column: col, type: 'collapseSpaces', details: 'Replace multiple spaces with single', example: '"AC  ME" → "AC ME"' });

    // Case normalization (if majority is upper or lower)
    const pctUpper = (stats.upper / (stats.total || 1)) * 100;
    const pctLower = (stats.lower / (stats.total || 1)) * 100;
    if (pctUpper >= 70) transforms.push({ column: col, type: 'upper', details: 'Convert to UPPERCASE' });
    else if (pctLower >= 70) transforms.push({ column: col, type: 'lower', details: 'Convert to lowercase' });

    // Regex inference
    const topValues = (() => {
      const freq = new Map(); for (const v of vals) freq.set(v, (freq.get(v)||0)+1);
      return [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 12).map(([v]) => v);
    })();
    const rx = inferRegexFromSamples(topValues);
    if (rx && rx.pattern) {
      const reg = new RegExp(rx.pattern);
      const passFn = (value) => reg.test(String(value || ''));
      out.push({
        id: `regex-${col}`,
        title: `Consistent format detected in [${col}] — propose regex`,
        severity: 'medium',
        dimension: 'Validity',
        impactedColumns: [col],
        rationale: `Inferred pattern from sample values (${rx.description}).`,
        estimatedCoveragePct: estimateCoverageForRule(col, passFn),
        proposedRules: [{
          column: col, conditionType: 'regexMatch',
          params: { pattern: rx.pattern },
          previewCondition: `Matches ${rx.pattern}`
        }],
        transforms
      });
    } else if (transforms.length) {
      // transformations only
      out.push({
        id: `clean-${col}`,
        title: `Formatting inconsistencies in [${col}] — suggest normalization`,
        severity: 'low',
        dimension: 'Consistency',
        impactedColumns: [col],
        rationale: `Spacing/case signs detected in values.`,
        estimatedCoveragePct: estimateCoverageForRule(col, v => String(v||'').trim() !== ''), // heuristic
        proposedRules: [],
        transforms
      });
    }
  }
  return out;
}

function suggestClassEnumerations() {
  const out = [];
  for (const col of headers) {
    const type = inferDataType(col);
    if (type === 'numeric' || type === 'integer' || type === 'date' || type === 'datetime' || type === 'time') continue;

    const vals = toStrCol(col).filter(v => v !== '');
    const total = data.length;
    if (vals.length < 8) continue;

    const freq = new Map(); for (const v of vals) freq.set(v, (freq.get(v)||0)+1);
    const distinct = freq.size;
    if (distinct === 0 || distinct > 20) continue; // keep small controlled lists only

    const sorted = [...freq.entries()].sort((a,b)=>b[1]-a[1]);
    const top = sorted.slice(0, 20);
    const topCoverage = (top.reduce((a,[,c])=>a+c, 0) / (total || 1)) * 100;

    if (topCoverage >= 90) {
      const values = top.map(([v]) => v);
      const passFn = (value) => values.includes(String(value || ''));
      out.push({
        id: `class-${col}`,
        title: `Restricted set detected in [${col}] — propose allowed classes`,
        severity: 'medium',
        dimension: 'Consistency',
        impactedColumns: [col],
        rationale: `Top ${values.length} values cover ${topCoverage.toFixed(1)}% of rows.`,
        estimatedCoveragePct: estimateCoverageForRule(col, passFn),
        proposedRules: [{
          column: col, conditionType: 'classMatch',
          params: { values },
          previewCondition: `Must be one of: ${values.slice(0,8).join(', ')}${values.length>8?'…':''}`
        }]
      });
    }
  }
  return out;
}

function suggestUniquenessAndComposite() {
  const out = [];

  // ---------- Per-column near-unique detection ----------
  for (const col of headers) {
    const type = inferDataType(col);
    // Skip pure temporal types; they’re rarely intended identifiers
    if (['date', 'datetime', 'time'].includes(type)) continue;

    // Normalize values (for strings) and drop missing
    const raw = data.map(r => r[col]);
    const norm = raw.map(normalizeForUniq);
    const nonMissingVals = norm.filter(v => v !== null && v !== '');

    const total = data.length;
    const nonMissing = nonMissingVals.length;
    if (nonMissing === 0) continue;

    const distinct = new Set(nonMissingVals).size;
    const dup      = nonMissing - distinct;
    const uniqRatio = distinct / nonMissing;           // 0..1
    const dupRatio  = dup / nonMissing;                // 0..1

    // Ignore very low-cardinality columns (e.g., booleans, tiny code lists)
    if (distinct < UNIQ_SUGGEST_MIN_DISTINCT) continue;

    // Suggest only if the column is "mostly unique"
    const isNearUnique =
      uniqRatio >= UNIQ_SUGGEST_MIN_RATIO &&
      dupRatio  <= UNIQ_SUGGEST_MAX_DUP_RATIO;

    if (!isNearUnique) continue;

    const severity =
      dup > 0
        ? (dupRatio <= 0.02 ? 'high' : 'medium')  // a few violations of an intended unique key
        : 'medium';                                // clean, but still worth enforcing

    const rationale = [
      `${(uniqRatio * 100).toFixed(1)}% of non-missing values are unique (${distinct}/${nonMissing})`,
      dup > 0 ? `${dup} duplicate ${dup === 1 ? 'row' : 'rows'} suggests a near-unique key with occasional violations` : null
    ].filter(Boolean).join('. ') + '.';

    const transforms = [];
    if (UNIQ_NORMALIZE_STRING && type === 'string') {
      transforms.push({
        column: col,
        type: 'normalize',
        details: 'Trim, collapse spaces, and lower-case prior to uniqueness check'
      });
    }

    out.push({
      id: `uniq-${col}`,
      title: `Near-unique column detected in [${col}] — consider 'unique'`,
      severity,
      dimension: 'Uniqueness',
      impactedColumns: [col],
      rationale,
      // This is the share of rows that would be flagged as duplicates by a Unique rule
      estimatedCoveragePct: dupRatio * 100,
      proposedRules: [{
        column: col,
        conditionType: 'unique',
        params: {},
        previewCondition: 'All non-missing values must be unique'
      }],
      transforms
    });
  }

  // ---------- Composite key (pair) near-unique detection ----------
  // Keep this lightweight: try up to 12 columns that aren't temporal types.
  const candidates = headers.filter(h => !['date','datetime','time'].includes(inferDataType(h))).slice(0, 12);

  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];

      const pairs = data.map(r => `${normalizeForUniq(r[a])}||${normalizeForUniq(r[b])}`);
      // Drop fully missing pairs
      const vals = pairs.filter(k => k !== 'null||null' && !/^(null|\s*)\|\|(null|\s*)$/.test(k));
      if (vals.length < 30) continue; // need some data

      const distinct = new Set(vals).size;
      const dup      = vals.length - distinct;
      const ratio    = distinct / vals.length;      // uniqueness ratio for the pair
      const dupRatio = dup / vals.length;

      // Only suggest if pair is strongly near-unique
      if (ratio >= 0.98 && dupRatio <= 0.02) {
        if (!best || dup < best.dup) best = { a, b, dup, ratio, total: vals.length };
      }
    }
  }

  if (best) {
    out.push({
      id: `uniq-pair-${best.a}+${best.b}`,
      title: `Near-unique composite key [${best.a} + ${best.b}]`,
      severity: best.dup > 0 ? 'high' : 'medium',
      dimension: 'Uniqueness',
      impactedColumns: [best.a, best.b],
      rationale: `${(best.ratio * 100).toFixed(1)}% unique pairs (${best.total - best.dup}/${best.total}).`,
      proposedRules: [] // informational (your rule model is per-column)
    });
  }

  return out;
}


function suggestDateWindowsAndFreshnessSmart() {
  const out = [];
  for (const col of headers) {
    const t = inferDataType(col);
    if (!['date','datetime','time'].includes(t)) continue;

    const rawVals = getValues(col);
    if (rawVals.length < 12) continue;

    // Convert to numeric timeline
    const series = toDateLikeSeries(rawVals, t).slice().sort((a,b)=>a-b);
    if (!series.length) continue;

    // Use trimmed window to avoid weird edges
    const loMs = quantile(series, 0.01);
    const hiMs = quantile(series, 0.99);

    // Decide cadence and build min/max with time preserved
    const { unit } = inferResolution(series)
    const minISO = t === 'date'
      ? fmtDateMs(loMs)                           // date only
      : formatLocalISOMinute(loMs);               // keep HH:MM
    const maxISO = t === 'date'
      ? fmtDateMs(hiMs)
      : formatLocalISOMinute(hiMs);

    // Propose a range rule (keeps time where applicable)
    const ruleType = (t === 'date') ? 'dateRange' : (t === 'datetime' ? 'datetimeRange' : 'timeRange');
    const rule = (t === 'time')
      ? { column: col, conditionType: ruleType, params: { min: '00:00', max: '23:59' }, previewCondition: 'Valid time of day' }
      : { column: col, conditionType: ruleType, params: { min: minISO, max: maxISO }, previewCondition: `Between ${minISO} and ${maxISO}` };

    // Freshness suggestion: latest record should be within ~1.5× cadence of "now"
    
	const diffs = consecutiveDiffs(series).filter(d => d > 0).sort((a,b)=>a-b);
	const medGapMs = medianOf(diffs); // robust cadence
	const now = Date.now();
	const latest = series[series.length - 1];
	const allowance = Number.isFinite(medGapMs) ? 1.5 * medGapMs : 36e5; // fallback 1 hou
	const isStale = (now - latest) > allowance;


	// "Update cadence" -> propose a freshness window that follows the median gap
	const freshnessWithin = (() => {
	if (!Number.isFinite(medGapMs) || medGapMs <= 0) return { value: 1, unit: 'day' };
	if (medGapMs <= 2*60e3)    return { value: Math.max(1, Math.round(medGapMs/60e3)),    unit: 'minute' };
	if (medGapMs <= 2*3600e3)  return { value: Math.max(1, Math.round(medGapMs/3600e3)),  unit: 'hour'   };
	if (medGapMs <= 2*86400e3) return { value: Math.max(1, Math.round(medGapMs/86400e3)), unit: 'day'    };
	return { value: Math.max(1, Math.round(medGapMs/(7*86400e3))), unit: 'week' };
	})();


    const transforms = [
      { column: col, type: 'format', details: `Preserve ${t === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:MM'} format consistently` },
      { column: col, type: 'dedupe', details: 'Remove accidental duplicate timestamps (same minute)' }
    ];

    const suggestion = {
      id: `timewin-${col}`,
      title: `Propose ${t} window for [${col}] and update cadence`,
      severity: isStale ? 'high' : 'medium',
      dimension: 'Timeliness',
      impactedColumns: [col],
      rationale: t === 'time'
        ? `Detected valid times of day.`
        : `Observed timeline spans ${t==='date' ? fmtDateMs(loMs) : formatLocalISOMinute(loMs)} → ${t==='date' ? fmtDateMs(hiMs) : formatLocalISOMinute(hiMs)}. Typical interval ≈ 1 ${unit}. ${isStale ? 'Latest timestamp suggests the feed may be stale.' : ''}`,
      proposedRules: [ rule ],   // the range rule
      transforms,
      tips: [
        isStale
          ? `Feed appears stale. Expect ~every ${unit}; consider alerting if no data within ${freshnessWithin.value} ${freshnessWithin.unit}(s).`
          : `Dataset appears to update roughly every ${unit}.`,
      ]
    };
// --- Tip: recency since now (date/datetime only) ---
if (t !== 'time') {
  const sinceMs = now - latest;
  const sinceTxt = Number.isFinite(sinceMs) ? formatDuration(sinceMs) : '—';
  suggestion.tips = suggestion.tips || [];
  suggestion.tips.push(`Last record was ${sinceTxt} ago.`);
} else {
  // For pure time-of-day columns (no date), show latest time observed instead
  const latestSec = series[series.length - 1]; // seconds since midnight
  const latestHms  = fmtTimeSec(Math.max(0, latestSec)); // HH:MM:SS
  suggestion.tips = suggestion.tips || [];
  suggestion.tips.push(`Latest time-of-day observed: ${latestHms}.`);
}

    // Also propose a dynamic "freshness" rule that checks recency against now
    suggestion.proposedRules.push({
      column: col,
      conditionType: 'freshnessWithin', // new rule type we add below
      params: { value: freshnessWithin.value, unit: freshnessWithin.unit },
      previewCondition: `Timestamp is within last ${freshnessWithin.value} ${freshnessWithin.unit}(s)`
    });

	 // And propose a cadence rule: max gap between records (with 1.5× tolerance)
	 const cadenceWithin = {
	   value: freshnessWithin.unit === 'minute' ? freshnessWithin.value : (
	     medGapMs <= 120000 ? 1 : // ≤2min ⇒ 1 minute
	     freshnessWithin.value
	   ),
	   unit:  freshnessWithin.unit
	 };
	 suggestion.proposedRules.push({
	   column: col,
	   conditionType: 'cadenceWithin',
	   params: { value: cadenceWithin.value, unit: cadenceWithin.unit, tolerance: 1.5 },
	   previewCondition: `Max interval ≤ ${cadenceWithin.value} ${cadenceWithin.unit}(s) (±50%)`
	 });

    out.push(suggestion);
  }
  return out;
}

// --------- Run all local heuristics and produce a result ---------
function runLocalHeuristics() {
  const suggestions = []
    .concat(suggestMissingness())
    .concat(suggestOutliersSmart())
    .concat(suggestStringPatterns())
    .concat(suggestClassEnumerations())
    .concat(suggestUniquenessAndComposite())
    .concat(suggestDateWindowsAndFreshnessSmart())

  // Sort by severity & estimated coverage (descending)
  const sevRank = { critical: 4, high: 3, medium: 2, low: 1 };
  suggestions.sort((a,b) => (sevRank[b.severity] - sevRank[a.severity]) || ((b.estimatedCoveragePct||0) - (a.estimatedCoveragePct||0)));

  const total = data.length;
  const bad = lastBadRowsSet ? lastBadRowsSet.size : 0;
  const summary = `Local analysis: ${suggestions.length} suggestions generated. Current bad rows: ${bad}/${total}.`;

  return { summary, suggestions };
}

// [PROFILING] Quantile with linear interpolation
function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const h = idx - lo;
  return sorted[lo] * (1 - h) + sorted[hi] * h;
}

// [PROFILING] Compute numeric stats
function computeNumericStats(col) {
  const values = getValues(col);
  const x = toNumeric(values);
  const n = x.length;
  const total = data.length;

  const missing = total - values.length;
  const distinct = new Set(values.map(String)).size;

  if (n === 0) {
    return { n: 0, total, missing, distinct };
  }

  x.sort((a,b) => a - b);
  const sum = x.reduce((a,b)=>a+b, 0);
  const mean = sum / n;
  const min = x[0], max = x[n-1];
  const q05 = quantile(x, 0.05);
  const q25 = quantile(x, 0.25);
  const q50 = quantile(x, 0.50);
  const q75 = quantile(x, 0.75);
  const q95 = quantile(x, 0.95);

  // population std (σ)
  const variance = x.reduce((a,b)=> a + (b - mean)*(b - mean), 0) / n;
  const std = Math.sqrt(variance);

  return { n, total, missing, distinct, mean, min, max, std, q05, q25, q50, q75, q95 };
}

// [PROFILING] Histogram (Sturges)
function buildHistogram(x, kOverride) {
  if (!x.length) return { bins: [], counts: [], min: 0, max: 0, width: 0, edges: [] };
  const min = Math.min(...x), max = Math.max(...x);
  if (min === max) {
    return { bins: [min], counts: [x.length], min, max, width: 0, edges: [min, max] };
  }
  const k = Math.max(3, Math.min(200, Number.isFinite(kOverride) ? Math.floor(kOverride) : Math.ceil(Math.log2(x.length) + 1)));
  const width = (max - min) / k;

  const edges = Array.from({ length: k + 1 }, (_, i) => min + i * width);
  const counts = Array(k).fill(0);
  for (const v of x) {
    let b = Math.floor((v - min) / width);
    if (b >= k) b = k - 1; // include exact max
    if (b < 0) b = 0;
    counts[b]++;
  }
  const centers = counts.map((_, i) => (edges[i] + edges[i + 1]) / 2);
  return { bins: centers, counts, min, max, width, edges, k };
}

// [PROFILING] Top-N frequencies for categorical-like columns
function topN(col, N=5) {
  const values = getValues(col).map(String);
  const total = values.length;
  const freq = new Map();
  for (const v of values) freq.set(v, (freq.get(v)||0)+1);
  const sorted = [...freq.entries()].sort((a,b)=> b[1] - a[1]).slice(0, N);
  return { total, items: sorted.map(([val, cnt]) => ({ val, cnt, pct: total ? (cnt/total)*100 : 0 })) };
}


  function renderTable(dataArr, targetTable, badRowsSet = new Set()) {
    targetTable.innerHTML = '';
    if (dataArr.length === 0) return;
    const headerRow = document.createElement('tr');
    Object.keys(dataArr[0]).forEach(h => {
      const th = document.createElement('th');
      th.textContent = h;
      headerRow.appendChild(th);
    });
    targetTable.appendChild(headerRow);

    dataArr.forEach((row, idx) => {
      const tr = document.createElement('tr');
      if (badRowsSet.has(idx)) tr.classList.add('bad');
      Object.values(row).forEach(val => {
        const td = document.createElement('td');
        td.textContent = val;
        tr.appendChild(td);
      });
      targetTable.appendChild(tr);
    });
  }

  function updateColumnDropdown() {
    colSelect.innerHTML = '';
    if (headers.length === 0) {
      colSelect.innerHTML = '<option value="">No columns found</option>';
      colSelect.disabled = true;
      dataTypeSelect.disabled = true;
      conditionSelect.disabled = true;
      addRuleBtn.disabled = true;
      runRulesBtn.disabled = true;
      previewBadBtn.disabled = true;
      return;
    }
    colSelect.disabled = false;
    dataTypeSelect.disabled = false;
    ensureDataTypeOptions();
    conditionSelect.disabled = true; // wait for dataType
    addRuleBtn.disabled = true;
    runRulesBtn.disabled = (data.length === 0 || rules.length === 0);
    previewBadBtn.disabled = true;

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '-- Select Column --';
    colSelect.appendChild(defaultOption);
    headers.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      colSelect.appendChild(opt);
    });
  }

  function loadCSVFromText(text) {
    const parsed = parseCSV(text);
    headers = parsed.headers;
    data = parsed.data;
    resetSuggestionStateForCurrentDataset();

    totalRowsEl.textContent = data.length;
    badRowsEl.textContent = '0';
    goodPercentEl.textContent = '100%';

    updateColumnDropdown();
    renderTable(data, document.getElementById('dataTable'));
    
    // [PROFILING] Reset/enable profiling UI after CSV load
    profilingSection.style.display = 'none';
    profileBtn.disabled = (data.length === 0);
    profileTabs.innerHTML = '';
    profileStatsEl.innerHTML = '';
    if (profileChart) { profileChart.destroy(); profileChart = null; }

    dashboardSection.style.display = 'none';
    badDataTableContainer.style.display = 'none';
    
    // [DQ TABS] Reset cached results & hide results tabs
    lastBadRowsSet = null;
    if (dq.section) dq.section.style.display = 'none';

    rules = [];
    renderRules();
  }

  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      csvInput.value = e.target.result;
      loadCSVFromText(csvInput.value);
    };
    reader.readAsText(file);
  });


// [PROFILING] Click to build profiling UI
profileBtn?.addEventListener('click', () => {
  if (!data?.length || !headers?.length) {
    alert('Load a CSV first.');
    return;
  }
  profilingSection.style.display = 'block';
  renderTableOverview();
  buildColumnTabsAndOpenFirst();
});

  csvInput.addEventListener('blur', () => {
    if (rules.length > 0) {
      const confirmReset = confirm("Reloading CSV will reset all rules. Continue?");
      if (!confirmReset) return;
    }
    loadCSVFromText(csvInput.value);
  });


function populateConditionOptions(dataType) {
  conditionSelect.innerHTML = '';
  conditionSelect.disabled = false;
  let options = [];

  switch (dataType) {
    case 'string':
      options = [
        { val: 'notEmpty', text: 'Not Empty' },
        { val: 'maxLength', text: 'Max Length' },
        { val: 'equals', text: 'Equals' },
        { val: 'regexMatch', text: 'Matches Regex' },
        { val: 'unique', text: 'Is Unique' },
	{ val: 'classMatch', text: 'Belongs to Allowed Classes' },

      ];
      break;

    case 'numeric':
    case 'integer':
      options = [
        { val: 'notEmpty', text: 'Not Empty' },
        { val: 'range', text: 'Range (Min & Max)' },
        { val: 'equals', text: 'Equals' },
        { val: 'greaterThan', text: 'Greater Than' },
        { val: 'lessThan', text: 'Less Than' },
        { val: 'unique', text: 'Is Unique' }
      ];
      break;

    case 'date':
      options = [
        { val: 'notEmpty', text: 'Not Empty' },
        { val: 'dateRange', text: 'Date Range (Min & Max)' },
        { val: 'equals', text: 'Equals (Date)' },
        { val: 'unique', text: 'Is Unique' },
        { val: 'freshnessWithin', text: 'Freshness (within ... of now)' },
	{ val: 'cadenceWithin', text: 'Cadence (max interval between records)' }
      ];
      break;

    case 'boolean':
      options = [
        { val: 'notEmpty', text: 'Not Empty' },
        { val: 'isTrue', text: 'Is True' },
        { val: 'isFalse', text: 'Is False' },
        { val: 'equals', text: 'Equals (True/False)' },
        { val: 'unique', text: 'Is Unique' }
      ];
      break;

    case 'time':
      options = [
        { val: 'notEmpty', text: 'Not Empty' },
        { val: 'equals', text: 'Equals (Time)' },
        { val: 'timeRange', text: 'Time Range (Min & Max)' },
        { val: 'unique', text: 'Is Unique' },
	{ val: 'cadenceWithin', text: 'Cadence (max interval between records)' }
      ];
      break;

    case 'datetime':
      options = [
        { val: 'notEmpty', text: 'Not Empty' },
        { val: 'equals', text: 'Equals (DateTime)' },
        { val: 'datetimeRange', text: 'Datetime Range (Min & Max)' },
        { val: 'unique', text: 'Is Unique' },
        { val: 'freshnessWithin', text: 'Freshness (within ... of now)' },
	{ val: 'cadenceWithin', text: 'Cadence (max interval between records)' }
      ];
      break;

    default:
      conditionSelect.disabled = true;
  }

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = '-- Select Condition --';
  conditionSelect.appendChild(defaultOption);

  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.val;
    opt.textContent = o.text;
    conditionSelect.appendChild(opt);
  });
}


colSelect.addEventListener('change', () => {
  const selectedCol = colSelect.value;
  if (!selectedCol) return;

  // Infer and set data type
  const inferredType = inferDataType(selectedCol);
  dataTypeSelect.value = inferredType;

  // Populate conditions automatically
  populateConditionOptions(inferredType);
  conditionSelect.disabled = false;

  // Reset downstream
  conditionSelect.value = '';
  clearParamInputs();
  conditionPreview.value = '';
  addRuleBtn.disabled = true;
});


  dataTypeSelect.addEventListener('change', () => {
    clearParamInputs();
    conditionPreview.value = '';
    addRuleBtn.disabled = true;
    if (!dataTypeSelect.value) {
      conditionSelect.innerHTML = '';
      conditionSelect.disabled = true;
      return;
    }
    populateConditionOptions(dataTypeSelect.value);
  });

  conditionSelect.addEventListener('change', () => {
    clearParamInputs();
    conditionPreview.value = '';
    addRuleBtn.disabled = true;
    if (!conditionSelect.value) return;

    showParamInputs(dataTypeSelect.value, conditionSelect.value);
  });

// [PROFILING] Overview (default panel)
function renderTableOverview() {
  const cols = headers.length;
  const rows = data.length;

  // type distribution via inferDataType
  const typeCounts = {};
  headers.forEach(h => {
    const t = inferDataType(h);
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  });

  // missing % per column (simple spark of info)
  const missingRows = headers.map(h => {
    const nonEmpty = data.reduce((acc,r)=> acc + ((r[h] !== '' && r[h] != null) ? 1 : 0), 0);
    const miss = rows - nonEmpty;
    return { h, miss, pct: rows ? (miss / rows) * 100 : 0 };
  }).sort((a,b)=> b.pct - a.pct).slice(0, 5);

  const typeLines = Object.entries(typeCounts)
    .map(([t,c]) => `${t}: <b>${c}</b>`).join(' • ');

  const missLines = missingRows
    .map(m => `<li>${m.h}: <b>${m.miss}</b> (${m.pct.toFixed(2)}%)</li>`).join('');

  tableOverviewEl.innerHTML = `
    <div><b>Rows:</b> ${rows} • <b>Columns:</b> ${cols}</div>
    <div style="margin-top:6px;"><b>Type mix:</b> ${typeLines}</div>
    <div style="margin-top:6px;"><b>Most missing (top 5):</b>
      <ul style="margin:6px 0 0 18px;">${missLines || '<li>None</li>'}</ul>
    </div>
  `;
}

// [PROFILING] Build tabs and open first column
function buildColumnTabsAndOpenFirst() {
  profileTabs.innerHTML = '';
  headers.forEach(h => {
    const tab = document.createElement('div');
    tab.className = 'profile-tab';
    tab.textContent = h;
    tab.addEventListener('click', () => openColumnProfile(h, tab));
    profileTabs.appendChild(tab);
  });
  // activate first tab by default
  const first = profileTabs.firstElementChild;
  if (first) first.click();
}

// [PROFILING] Custom plugin to draw vertical lines for mean & quantiles on linear x-scale
const vLinePlugin = {
  id: 'vLinePlugin',
  afterDatasetsDraw(chart, args, pluginOptions) {
    const { ctx, scales: { x, y } } = chart;
    const lines = pluginOptions?.lines || [];
    lines.forEach(l => {
      const xPos = x.getPixelForValue(l.x);
      ctx.save();
      ctx.strokeStyle = l.color || '#d33';
      ctx.lineWidth = 2;
      ctx.setLineDash(l.dash || [6, 4]);
      ctx.beginPath();
      ctx.moveTo(xPos, y.getPixelForValue(y.min));
      ctx.lineTo(xPos, y.getPixelForValue(y.max));
      ctx.stroke();

      if (l.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = l.color || '#d33';
        ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto';
        ctx.textAlign = 'left';
        ctx.fillText(l.label, xPos + 6, y.getPixelForValue(y.max) + 14);
      }
      ctx.restore();
    });
  }

  
};

// Hover tooltips for vertical lines (μ, Q lines)
const lineHoverPlugin = {
  id: 'lineHoverPlugin',
  afterEvent(chart, args) {
    const pluginCfg = chart.options?.plugins?.vLinePlugin;
    const markersIdx = chart._statsMarkerDatasetIndex;
    if (!pluginCfg?.lines || markersIdx == null) return;

    const evt = args.event;
    if (!evt) return;

    const xScale = chart.scales.x;
    const px = evt.x;
    const lines = pluginCfg.lines;
    const tolerancePx = 6; // hover tolerance

    // find nearest line
    let nearest = -1, best = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const lx = xScale.getPixelForValue(lines[i].x);
      const d = Math.abs(px - lx);
      if (d < best) { best = d; nearest = i; }
    }

    if (nearest >= 0 && best <= tolerancePx) {
      chart.setActiveElements([{ datasetIndex: markersIdx, index: nearest }]);
      chart.tooltip.update(true);
    } else {
      // allow normal bar tooltips when not near a line
      chart.setActiveElements([]);
      chart.tooltip.update(true);
    }
  }
};


function smartNumber(x, maxSig = 4) {
  if (!Number.isFinite(x)) return '—';
  const abs = Math.abs(x);
  // choose compact formatting
  if (abs >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 100)  return x.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (abs >= 10)   return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1)    return x.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return x.toLocaleString(undefined, { maximumSignificantDigits: maxSig });
}

function smartRange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '[—, —)';
  const width = Math.abs(b - a);
  let opts;
  if (width === 0) opts = { maximumFractionDigits: 0 };
  else {
    const dec = Math.max(0, Math.min(6, Math.ceil(-Math.log10(width)) + 1));
    opts = { maximumFractionDigits: dec };
  }
  const fa = a.toLocaleString(undefined, opts);
  const fb = b.toLocaleString(undefined, opts);
  return `[${fa}, ${fb})`;
}

// === DATE/TIME HELPERS =======================================================
// Determine the typical cadence (resolution) from a sorted numeric timeline
function inferResolution(sortedMs) {
  if (sortedMs.length < 4) return { unit: 'day', stepMs: 86400e3 }; // default
  const diffs = consecutiveDiffs(sortedMs).filter(d => d > 0).sort((a,b)=>a-b);
  const med = medianOf(diffs);
  if (!Number.isFinite(med) || med <= 0) return { unit: 'day', stepMs: 86400e3 };

  // Pick the nearest human unit
  const minute = 60e3, hour = 3600e3, day = 86400e3, week = 7*day;
  if (med <= 2*minute) return { unit: 'minute', stepMs: minute };
  if (med <= 2*hour)   return { unit: 'hour',   stepMs: hour };
  if (med <= 2*day)    return { unit: 'day',    stepMs: day };
  if (med <= 2*week)   return { unit: 'week',   stepMs: week };
  return { unit: 'month', stepMs: 30*day };
}

function formatLocalISOMinute(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${y}-${m}-${day}T${hh}:${mm}`; // local time, minute precision
}

// Detect date-like columns based on your existing inferDataType()
function isDateLikeColumn(col) {
  const t = inferDataType(col);
  return t === 'date' || t === 'datetime' || t === 'time';
}

// Parse "YYYY-MM-DD" → Date (local, midnight) ; returns ms since epoch
function parseDateToMs(s) {
  // Accept "YYYY-MM-DD"
  // Assumes local timezone; if you prefer UTC, append 'T00:00:00Z'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return NaN;
  const [_, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
  return dt.getTime();
}

// Parse "YYYY-MM-DD[ T]HH:MM(:SS)?" → ms since epoch (local)
function parseDateTimeToMs(s) {
  const str = String(s).trim().replace(' ', 'T'); // allow ' ' or 'T'
  const t = Date.parse(str);
  return Number.isNaN(t) ? NaN : t;
}

// Parse "HH:MM(:SS)?" → seconds since midnight
function parseTimeToSec(s) {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
  if (!m) return NaN;
  const h = Number(m[1]), mi = Number(m[2]), se = Number(m[3] ?? 0);
  return h * 3600 + mi * 60 + se;
}

// Unified getter → number timeline
//  - 'date'     → ms
//  - 'datetime' → ms
//  - 'time'     → seconds (0..86399)
function toDateLikeSeries(values, type) {
  if (type === 'date')     return values.map(parseDateToMs).filter(Number.isFinite);
  if (type === 'datetime') return values.map(parseDateTimeToMs).filter(Number.isFinite);
  if (type === 'time')     return values.map(parseTimeToSec).filter(Number.isFinite);
  return [];
}

// Pretty date/time formatters (local)
function fmtDateMs(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmtDateTimeMs(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}
function fmtTimeSec(sec) {
  const s = Math.max(0, Math.floor(sec % 60));
  const mi = Math.max(0, Math.floor((sec / 60) % 60));
  const h = Math.max(0, Math.floor(sec / 3600));
  return `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// Duration pretty print (ms → human)
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hrs  = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const sec  = s % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hrs)  parts.push(`${hrs}h`);
  if (mins) parts.push(`${mins}m`);
  if (!parts.length) parts.push(`${sec}s`);
  return parts.join(' ');
}

// Choose bucket unit for date/datetime timelines based on span (ms)
function chooseDateBucketUnit(spanMs) {
  const day = 86400e3;
  const wk  = 7 * day;
  const mo  = 30 * day;
  const yr  = 365 * day;
  if (spanMs <= 90 * day)   return 'day';
  if (spanMs <= 730 * day)  return 'week';
  if (spanMs <= 5 * yr)     return 'month';
  return 'year';
}

// Aggregate date/datetime (ms) into counts per bucket label
function bucketDateTimes(msList) {
  if (!msList.length) return { labels: [], counts: [] };
  const min = Math.min(...msList);
  const max = Math.max(...msList);
  const unit = chooseDateBucketUnit(max - min);

  const map = new Map();
  const inc = (label) => map.set(label, (map.get(label) || 0) + 1);

  for (const t of msList) {
    const d = new Date(t);
    let label = '';
    if (unit === 'day')   label = fmtDateMs(t);
    else if (unit === 'week') {
      // ISO week label: YYYY-Www
      const tmp = new Date(d);
      // Thursday of current week
      tmp.setDate(d.getDate() + 4 - (d.getDay() || 7));
      const yearStart = new Date(tmp.getFullYear(), 0, 1);
      const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
      label = `${tmp.getFullYear()}-W${String(weekNo).padStart(2,'0')}`;
    }
    else if (unit === 'month') label = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    else if (unit === 'year')  label = `${d.getFullYear()}`;
    inc(label);
  }

  const labels = [...map.keys()];
  labels.sort((a,b) => a.localeCompare(b, 'en', { numeric: true })); // natural order
  const counts = labels.map(l => map.get(l));
  return { labels, counts, unit };
}

// Aggregate time-of-day (seconds) into hour buckets (0..23)
function bucketTimesOfDay(secList) {
  if (!secList.length) return { labels: [], counts: [] };
  const counts = Array(24).fill(0);
  secList.forEach(s => counts[Math.floor(s / 3600)]++);
  const labels = Array.from({length: 24}, (_,h) => `${String(h).padStart(2,'0')}:00`);
  return { labels, counts };
}

// Compute intervals (sorted timeline)
//  - for date/datetime: ms diffs between consecutive timestamps
//  - for time-of-day: seconds diffs (no wrap-around)
function consecutiveDiffs(sortedNums) {
  const out = [];
  for (let i = 1; i < sortedNums.length; i++) {
    const d = sortedNums[i] - sortedNums[i-1];
    if (Number.isFinite(d) && d >= 0) out.push(d);
  }
  return out;
}

// Stats for intervals: median, mode (rough), IQR
function intervalSummary(diffs, isTimeOfDay=false) {
  if (!diffs.length) return { n: 0 };
  const arr = diffs.slice().sort((a,b)=>a-b);
  const n = arr.length;
  const q = (p) => arr[Math.floor((n-1)*p)];
  const median = q(0.5);
  const iqr = q(0.75) - q(0.25);

  // crude mode via rounding to a sensible unit
  const unit = isTimeOfDay ? chooseTimeUnit(arr[arr.length-1]) : chooseDurationUnit(arr[arr.length-1]);
  const rounded = arr.map(v => Math.round(v / unit.step) * unit.step);
  const freq = new Map();
  rounded.forEach(v => freq.set(v, (freq.get(v)||0)+1));
  let modeVal = rounded[0], modeCnt = 0;
  freq.forEach((c, k) => { if (c > modeCnt) { modeCnt = c; modeVal = k; } });

  return { n, median, iqr, mode: modeVal, unit };
}

// Choose a duration unit (for date/datetime intervals which are in ms)
function chooseDurationUnit(maxMs) {
  const day = 86400e3, hr = 3600e3, min = 60e3, sec = 1000;
  if (maxMs >= day) return { label: 'day', step: day, fmt: (v)=>`${(v/day).toFixed(2)} d` };
  if (maxMs >= hr)  return { label: 'hour', step: hr, fmt: (v)=>`${(v/hr).toFixed(2)} h` };
  if (maxMs >= min) return { label: 'minute', step: min, fmt: (v)=>`${(v/min).toFixed(2)} m` };
  return { label: 'second', step: sec, fmt: (v)=>`${(v/sec).toFixed(2)} s` };
}

// Choose a time unit (for time-of-day intervals which are in seconds)
function chooseTimeUnit(maxSec) {
  if (maxSec >= 3600) return { label: 'hour', step: 3600, fmt: (v)=>`${(v/3600).toFixed(2)} h` };
  if (maxSec >= 60)   return { label: 'minute', step: 60,   fmt: (v)=>`${(v/60).toFixed(2)} m` };
  return { label: 'second', step: 1, fmt: (v)=>`${v.toFixed(0)} s` };
}


// [PROFILING] Main renderer for a column
function openColumnProfile(col, tabEl) {
  // set active tab
  [...profileTabs.children].forEach(el => el.classList.remove('active'));
  tabEl.classList.add('active');

  // destroy prior chart
  if (profileChart) { profileChart.destroy(); profileChart = null; }
  profileStatsEl.innerHTML = '';

if (isNumericColumn(col)) {
  const values = toNumeric(getValues(col));
  const stats = computeNumericStats(col);

  // Show numeric-only controls
  histControls.style.display = 'flex';

  if (values.length >= 1) {
    // Default bin count (Sturges), clamp to slider range
    const defaultK = Math.max(3, Math.min(60, Math.ceil(Math.log2(values.length) + 1)));

    // Initialize controls (sync range and number)
    binCountRange.value = String(defaultK);
    binCountInput.value = String(defaultK);

    // A function to render chart with a chosen bin count
    const renderHistogram = (k) => {
      const { bins, counts, min, max, width, edges, k: kk } = buildHistogram(values, k);
      const maxCount = counts.length ? Math.max(...counts) : 0;

      // Update UI label for bin width
      binWidthLabel.textContent = width > 0 ? `bin width ≈ ${smartNumber(width, 4)}` : '';

      // Safety: destroy any existing chart
      if (typeof Chart !== 'undefined' && Chart.getChart(profileChartCanvas)) {
        Chart.getChart(profileChartCanvas).destroy();
      }

      // Build the main histogram dataset (attach _from/_to to each bar for range display)
      const barData = bins.map((x, i) => ({ x, y: counts[i], _from: edges[i], _to: edges[i + 1] }));

      // Invisible scatter dataset used to show tooltips on hover for μ / Q lines
      const markerPoints = [
        { x: stats.q05, y: maxCount, _label: 'Q₀.₀₅' },
        { x: stats.mean, y: maxCount, _label: 'μ' },
        { x: stats.q95, y: maxCount, _label: 'Q₀.₉₅' },
      ];

      profileChart = new Chart(profileChartCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          datasets: [
            {
              label: 'Frequency',
              data: barData,
              parsing: false,
              backgroundColor: 'rgba(0, 122, 204, 0.35)',
              borderColor: 'rgba(0, 122, 204, 0.9)',
              borderWidth: 1,
              borderSkipped: false
            },
            {
              type: 'scatter',
              label: 'Stats markers',
              data: markerPoints,
              parsing: false,
              pointRadius: 0,
              pointHoverRadius: 0,
              pointHitRadius: 12,     // easier to hover near the vertical line
              backgroundColor: 'rgba(0,0,0,0)',
              borderColor: 'rgba(0,0,0,0)',
              showLine: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          layout: { padding: { top: 4, right: 8, bottom: 4, left: 8 } },
          plugins: {
            legend: { display: false },
            vLinePlugin: {
              lines: [
                { x: stats.q05,  color: '#FF9F40', dash:[4,4], label: 'Q₀.₀₅' },
                { x: stats.mean, color: '#2ECC71', dash:[1,0], label: 'μ' },
                { x: stats.q95,  color: '#FF9F40', dash:[4,4], label: 'Q₀.₉₅' },
              ]
            },
            tooltip: {
              callbacks: {
                // Bars: show bin range + count + percent of non-missing
                label: (ctx) => {
                  if (ctx.datasetIndex === 0) {
                    const raw = ctx.raw || {};
                    const rangeTxt = smartRange(raw._from, raw._to);
                    const pct = values.length ? ((ctx.parsed.y / values.length) * 100).toFixed(2) + '%' : '0.00%';
                    return `${rangeTxt}: ${ctx.parsed.y} (${pct})`;
                  }
                  // Markers: μ / Q lines
                  if (ctx.datasetIndex === 1) {
                    const r = ctx.raw || {};
                    return `${r._label}: ${smartNumber(r.x, 5)}`;
                  }
                  return '';
                }
              }
            }
          },
          scales: {
            x: {
              type: 'linear',
              min: Math.min(min, stats.q05, stats.mean, stats.q95),
              max: Math.max(max, stats.q05, stats.mean, stats.q95),
              title: { display: true, text: col },
              ticks: {
                callback: (v) => smartNumber(v, 4)
              }
            },
            y: {
              beginAtZero: true,
              suggestedMax: Math.max(5, maxCount),
              title: { display: true, text: 'Frequency' }
            }
          }
        },
        plugins: [vLinePlugin, lineHoverPlugin]
      });

      // Record which dataset index holds marker points for the hover plugin
      profileChart._statsMarkerDatasetIndex = 1;
    };

    // Initial render
    renderHistogram(Number(binCountRange.value));

    // Wire controls (sync slider <-> number, then re-render)
    const clamp = (v) => Math.max(3, Math.min(60, Math.floor(Number(v) || 10)));
    const syncAndRender = (srcEl) => {
      const k = clamp(srcEl.value);
      binCountRange.value = String(k);
      binCountInput.value = String(k);
      renderHistogram(k);
    };
    binCountRange.oninput = () => syncAndRender(binCountRange);
    binCountInput.onchange = () => syncAndRender(binCountInput);

} else if (isDateLikeColumn(col)) {
  // ──────────────────────────────────────────────────────────────
  // DATE / DATETIME / TIME PROFILING
  // ──────────────────────────────────────────────────────────────
  if (histControls) histControls.style.display = 'none'; // no bin control here

  const type = inferDataType(col); // 'date' | 'datetime' | 'time'
  const rawVals = getValues(col);
  const totalRows = data.length;
  const nonMissing = rawVals.length;
  const missing = totalRows - nonMissing;

  // Distinct / mode
  const valsStr = rawVals.map(String);
  const distinctSet = new Set(valsStr);
  const distinct = distinctSet.size;

  // Convert to numeric timeline
  const series = toDateLikeSeries(rawVals, type).slice().sort((a,b)=>a-b);

  // Start-End
  const startNum = series.length ? series[0] : NaN;
  const endNum   = series.length ? series[series.length-1] : NaN;

  // Mode value (most frequent exact string)
  const freq = new Map();
  valsStr.forEach(v => freq.set(v, (freq.get(v)||0) + 1));
  let modeVal = null, modeCnt = 0;
  freq.forEach((c,k) => { if (c > modeCnt) { modeCnt = c; modeVal = k; } });
  const modePct = nonMissing ? (modeCnt / nonMissing) * 100 : 0;
  const isAllUnique = (distinct === nonMissing);

  // Typical interval
  const diffs = consecutiveDiffs(series);
  const intv = intervalSummary(diffs, type === 'time');

  // Build a compact chart:
  //  - date/datetime → counts per day/week/month/year (auto)
  //  - time → counts per hour 0..23
  let labels = [], counts = [], bucketNote = '';
  if (type === 'time') {
    const agg = bucketTimesOfDay(series);
    labels = agg.labels; counts = agg.counts; bucketNote = '(per hour)';
  } else {
    const agg = bucketDateTimes(series);
    labels = agg.labels; counts = agg.counts; bucketNote = `(per ${agg.unit})`;
  }

  // Destroy any existing chart
  if (typeof Chart !== 'undefined' && Chart.getChart(profileChartCanvas)) {
    Chart.getChart(profileChartCanvas).destroy();
  }

  // Render the small bar chart
  profileChart = new Chart(profileChartCanvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: `Count ${bucketNote}`,
        data: counts,
        backgroundColor: 'rgba(0, 122, 204, 0.35)',
        borderColor: 'rgba(0, 122, 204, 0.9)',
        borderWidth: 1
      }]
    },
    options: {
      indexAxis: labels.length <= 40 ? 'x' : 'x', // keep vertical; compact
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 4, right: 8, bottom: 4, left: 8 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `Count: ${ctx.parsed.y}`
          }
        }
      },
      scales: {
        x: {
          ticks: { autoSkip: true, maxRotation: 30, minRotation: 0 },
          title: { display: true, text: (type === 'time' ? 'Hour of day' : 'Bucket') }
        },
        y: { beginAtZero: true, title: { display: true, text: 'Count' } }
      }
    }
  });

  // Pretty strings for start/end
  const startStr = !Number.isFinite(startNum) ? '—'
                  : (type === 'date' ? fmtDateMs(startNum)
                     : type === 'datetime' ? fmtDateTimeMs(startNum)
                     : fmtTimeSec(startNum));
  const endStr   = !Number.isFinite(endNum) ? '—'
                  : (type === 'date' ? fmtDateMs(endNum)
                     : type === 'datetime' ? fmtDateTimeMs(endNum)
                     : fmtTimeSec(endNum));

  // Interval summary pretty
  const intvTxt = (intv.n === 0)
    ? '—'
    : (type === 'time'
        ? `${intv.unit.fmt(intv.median)} (median), mode ≈ ${intv.unit.fmt(intv.mode)}, IQR ≈ ${intv.unit.fmt(intv.iqr)}`
        : `${formatDuration(intv.median)} (median), mode ≈ ${intv.unit.fmt(intv.mode)}, IQR ≈ ${intv.unit.fmt(intv.iqr)}`);

  // Compose stats panel
  const pct = (n, d) => d ? ((n/d)*100).toFixed(2) + '%' : '0.00%';
  const modeLine = isAllUnique
    ? `<div class="pop-text">All values are unique (${pct(distinct, totalRows)} distinct overall).</div>`
    : `<div>Most frequent ${type}: <b>${escapeHtml(modeVal ?? '—')}</b> (${modeCnt} times, ${modePct.toFixed(2)}%)</div>`;

  profileStatsEl.innerHTML = `
    <div><b>${col}</b> (${type})</div>
    <div>Start: <b>${startStr}</b> • End: <b>${endStr}</b></div>
    <div>Distinct: <b>${distinct}</b> (${pct(distinct, totalRows)}) • Missing: <b>${missing}</b> (${pct(missing, totalRows)})</div>
    ${modeLine}
    <div>Typical interval: <b>${intvTxt}</b></div>
  `;

     }else {
    // No numeric data present
    if (typeof Chart !== 'undefined' && Chart.getChart(profileChartCanvas)) {
      Chart.getChart(profileChartCanvas).destroy();
    }
    histControls.style.display = 'none';
  }

  // Stats panel (mathematical notation)
  const pct = (n, d) => d ? ((n/d)*100).toFixed(2) + '%' : '0.00%';
  const fmt = (v) => (Number.isFinite(v) ? smartNumber(v, 6) : '—');
  const html = `
    <div><b>${col}</b> (numeric)</div>
    <div>μ (mean): <b>${fmt(stats.mean)}</b> • σ (std): <b>${fmt(stats.std)}</b></div>
    <div>min: <b>${fmt(stats.min)}</b> • median: <b>${fmt(stats.q50)}</b> • max: <b>${fmt(stats.max)}</b></div>
    <div>Q<sub>0.05</sub>: <b>${fmt(stats.q05)}</b> • Q<sub>1</sub>: <b>${fmt(stats.q25)}</b> • Q<sub>3</sub>: <b>${fmt(stats.q75)}</b> • Q<sub>0.95</sub>: <b>${fmt(stats.q95)}</b></div>
    <div>Distinct: <b>${stats.distinct}</b> (${pct(stats.distinct, stats.total)}) • Missing: <b>${stats.missing}</b> (${pct(stats.missing, stats.total)})</div>
  `;
  profileStatsEl.innerHTML = html;

  } else {
  // ──────────────────────────────────────────────────────────────
  // Non-numeric / categorical-like — improved visualization
  // Shows a uniqueness pie if values are mostly distinct or no dominant value.
  // Otherwise shows the Top-N horizontal bars (as before).
  // ──────────────────────────────────────────────────────────────
  
  // Hide numeric-only histogram controls on non-numeric tabs
  if (histControls) histControls.style.display = 'none';

  const colValues = getValues(col).map(String);
  const totalRows = data.length;
  const totalNonMissing = colValues.length;
  const missing = totalRows - totalNonMissing;
  const distinct = new Set(colValues).size;

  const { total, items } = topN(col, 5); // total === totalNonMissing
  const topPct = items[0]?.pct ?? 0;

  // Distinctness relative to ALL rows (so missing affects the ratio)
  const distinctPctOverall = totalRows ? (distinct / totalRows) * 100 : 0;

  // Thresholds (tweak to taste)
  const DISTINCTNESS_THRESHOLD = 80;   // if >= 80% distinct overall, treat as mostly unique
  const TOP_DOMINANCE_THRESHOLD = 5;   // top value must be >= 5% to be “useful” as a bar chart

  // Safety: if a Chart exists on this canvas, destroy it
  if (typeof Chart !== 'undefined' && Chart.getChart(profileChartCanvas)) {
    Chart.getChart(profileChartCanvas).destroy();
  }

  const pct = (n, d) => d ? ((n / d) * 100).toFixed(2) + '%' : '0.00%';
  const fmt = (v) => (v == null ? '—' : String(v));

  // Decide visualization
  const isMostlyUnique = distinctPctOverall >= DISTINCTNESS_THRESHOLD;
  const hasDominantValue = topPct >= TOP_DOMINANCE_THRESHOLD;

  
  if (totalNonMissing === 0) {
    // Nothing to chart; everything missing
    if (histControls) histControls.style.display = 'none';
    profileStatsEl.innerHTML = `
      <div><b>${col}</b> (non-numeric)</div>
      <div style="color:#c62828;font-weight:600;">All values are missing.</div>
      <div>Distinct: <b>0</b> (0.00%) • Missing: <b>${missing}</b> (${pct(missing, totalRows)})</div>
    `;
    // No chart to render
  } else if (isMostlyUnique || !hasDominantValue) {
    // ── Option A: Uniqueness pie (Unique vs Repeated, among NON-MISSING)
    const repeated = Math.max(0, totalNonMissing - distinct);

    profileChart = new Chart(profileChartCanvas.getContext('2d'), {
      type: 'pie',
      data: {
        labels: ['Unique values', 'Repeated values'],
        datasets: [{
          data: [distinct, repeated],
          backgroundColor: ['#2ECC71', '#FF6384'],
          borderColor: ['#2ECC71', '#FF6384'],
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false, // obey fixed wrapper height
        plugins: {
          legend: { position: 'right' },
          tooltip: {
            callbacks: {
              // Percentages relative to NON-MISSING values (more truthful here)
              label: (ctx) => {
                const val = ctx.parsed;
                return `${ctx.label}: ${val} (${pct(val, totalNonMissing)})`;
              }
            }
          }
        }
      }
    });

    profileStatsEl.innerHTML = `
      <div><b>${col}</b> (non-numeric)</div>
      <div style="pop-text">
        ${isMostlyUnique ? `Most values are unique (${distinctPctOverall.toFixed(2)}% distinct overall).`
                         : `No dominant value (top frequency ${topPct.toFixed(2)}%).`}
      </div>
      <div>Distinct: <b>${distinct}</b> (${pct(distinct, totalRows)}) • Missing: <b>${missing}</b> (${pct(missing, totalRows)})</div>
      <div>Most frequent value: <b>${escapeHtml(fmt(items[0]?.val))}</b> (${fmt(items[0]?.cnt)} times, ${(items[0]?.pct ?? 0).toFixed(2)}%)</div>
    `;

  } else {
    // ── Option B: Top values horizontal bars (original idea, kept compact)
    profileChart = new Chart(profileChartCanvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: items.map(it => it.val.length > 40 ? it.val.slice(0,37) + '…' : it.val),
        datasets: [{
          label: 'Percent',
          data: items.map(it => +it.pct.toFixed(2)),
          backgroundColor: 'rgba(153, 102, 255, 0.35)',
          borderColor: 'rgba(153, 102, 255, 0.9)',
          borderWidth: 1
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false, // obey fixed wrapper height
        layout: { padding: { top: 4, right: 8, bottom: 4, left: 8 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.parsed.x}% (${items[ctx.dataIndex].cnt} of ${total})`
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            max: 100,
            ticks: { callback: v => v + '%' },
            title: { display: true, text: 'Percentage of non-missing' }
          },
          y: { title: { display: true, text: 'Top values' } }
        }
      }
    });

    // Distinct / missing panel (with explicit Top-5 list)
    profileStatsEl.innerHTML = `
      <div><b>${col}</b> (non-numeric)</div>
      <div>Distinct: <b>${distinct}</b> (${pct(distinct, totalRows)}) • Missing: <b>${missing}</b> (${pct(missing, totalRows)})</div>
      <div>Top 5 values (within non-missing ${total} rows):</div>
      <ul style="margin:6px 0 0 18px;">
        ${items.map(it => `<li>${escapeHtml(it.val)} — <b>${it.cnt}</b> (${it.pct.toFixed(2)}%)</li>`).join('')}
      </ul>
    `;
  }
}

}

// [PROFILING] Simple HTML escape for list items
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));// Non-numeric / categorical-like — improved visualizati
}





  // Show parameter inputs for selected condition and data type
function showParamInputs(dataType, condition) {
  clearParamInputs();
  if (!condition) return;

  function createInput(labelText, id, type = 'text', placeholder = '') {
    const div = document.createElement('div');
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = type;
    input.id = id;
    input.placeholder = placeholder;
    input.style.width = '100%';
    div.appendChild(label);
    div.appendChild(document.createElement('br'));
    div.appendChild(input);
    return { div, input };
  }

  function createSelect(labelText, id, entries) {
    const div = document.createElement('div');
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    const select = document.createElement('select');
    select.id = id;
    select.style.width = '100%';
    entries.forEach(([val, text]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      select.appendChild(opt);
    });
    div.appendChild(label);
    div.appendChild(document.createElement('br'));
    div.appendChild(select);
    return { div, select };
  }

  switch (condition) {
    case 'maxLength':
      paramInputs.appendChild(createInput('Max Length (number):', 'paramMaxLength', 'number', 'e.g. 10').div);
      break;

    case 'equals':
      if (dataType === 'date') {
        paramInputs.appendChild(createInput('Date (YYYY-MM-DD):', 'paramEqualsDate', 'date').div);
      } else if (dataType === 'numeric' || dataType === 'integer') {
        paramInputs.appendChild(createInput('Number:', 'paramEqualsNum', 'number').div);
      } else if (dataType === 'time') {
        paramInputs.appendChild(createInput('Time (HH:MM):', 'paramEqualsTime', 'time').div);
      } else if (dataType === 'datetime') {
        // HTML uses 'datetime-local' (returns YYYY-MM-DDTHH:MM)
        paramInputs.appendChild(createInput('Datetime:', 'paramEqualsDateTime', 'datetime-local').div);
      } else if (dataType === 'boolean') {
        const { div } = createSelect('Boolean:', 'paramEqualsBool', [['true', 'true'], ['false', 'false']]);
        paramInputs.appendChild(div);
      } else {
        paramInputs.appendChild(createInput('String:', 'paramEqualsStr', 'text').div);
      }
      break;

case 'classMatch': {
  const classInput = document.createElement('textarea');
  classInput.id = 'paramClassValues';
  classInput.placeholder = 'Paste allowed values (one per line or comma-separated)';
  classInput.style.width = '80%';
  classInput.style.height = '80px';
  paramInputs.appendChild(classInput);
  break;
}


    case 'regexMatch':
const regexInput = createInput('Regex Pattern:', 'paramRegex', 'text', 'e.g. ^[A-Z]{3}\\d{3}$');
regexInput.div.style.width = '100%';
regexInput.input.style.width = '100%';

// Create compact dropdown for suggestions
const patternSelect = document.createElement('select');
patternSelect.id = 'regexPatternSelect';
patternSelect.style.width = '40%'; // smaller width
patternSelect.style.marginBottom = '8px';

[
  ['', '-- Select Pattern --'],
  ['email', 'Email'],
  ['ic', 'Malaysian IC'],
  ['phone', 'Phone Number'],
  ['url', 'URL']
].forEach(([val, label]) => {
  const opt = document.createElement('option');
  opt.value = val;
  opt.textContent = label;
  patternSelect.appendChild(opt);
});

patternSelect.addEventListener('change', () => {
  switch (patternSelect.value) {
    case 'email':
      regexInput.input.value = '^[\\w.-]+@[\\w.-]+\\.\\w{2,}$';
      break;
    case 'ic':
      regexInput.input.value = '^\\d{6}-\\d{2}-\\d{4}$';
      break;
    case 'phone':
      regexInput.input.value = '^\\+?\\d{10,15}$';
      break;
    case 'url':
      regexInput.input.value = '^(https?:\\/\\/)?([\\w.-]+)\\.([a-z\\.]{2,6})([\\/\\w\\.-]*)*\\/?$';
      break;
    default:
      regexInput.input.value = '';
  }
  updateConditionPreview(); // refresh preview
});

paramInputs.appendChild(patternSelect);
paramInputs.appendChild(regexInput.div);

      break;

    case 'range':
      if (dataType === 'numeric' || dataType === 'integer') {
        paramInputs.appendChild(createInput('Min (number):', 'paramMin', 'number').div);
        paramInputs.appendChild(createInput('Max (number):', 'paramMax', 'number').div);
      }
      break;

    case 'dateRange':
      if (dataType === 'date') {
        paramInputs.appendChild(createInput('Min Date:', 'paramMinDate', 'date').div);
        paramInputs.appendChild(createInput('Max Date:', 'paramMaxDate', 'date').div);
      }
      break;

    case 'timeRange':
      if (dataType === 'time') {
        paramInputs.appendChild(createInput('Min Time:', 'paramMinTime', 'time').div);
        paramInputs.appendChild(createInput('Max Time:', 'paramMaxTime', 'time').div);
      }
      break;
	case 'freshnessWithin': {
  	// Only meaningful for date/datetime types
  	if (dataType !== 'date' && dataType !== 'datetime') break;

  	// Wrapper
  	const wrap = document.createElement('div');

 	 // Label
 	 const label = document.createElement('label');
  	label.textContent = 'Fresh within:';
  	wrap.appendChild(label);
 	 wrap.appendChild(document.createElement('br'));

  	// Inline row with number + unit
  	const line = document.createElement('div');
  	line.style.display = 'flex';
  	line.style.gap = '8px';
  	line.style.alignItems = 'center';

  	// Number input (how many units)
  	const num = document.createElement('input');
  	num.type = 'number';
  	num.id = 'paramFreshWithinValue';
  	num.min = '1';
  	num.value = '1';
  	num.style.width = '90px';

  	// Unit select
  	const sel = document.createElement('select');
  	sel.id = 'paramFreshWithinUnit';
  	['minute', 'hour', 'day', 'week'].forEach(u => {
   	 const o = document.createElement('option');
    	o.value = u; o.textContent = u;
    	sel.appendChild(o);
  	});

  	line.appendChild(num);
  	line.appendChild(sel);
  	wrap.appendChild(line);

  	paramInputs.appendChild(wrap);
  	break;
	}

	case 'cadenceWithin': {
	  if (dataType !== 'date' && dataType !== 'datetime' && dataType !== 'time') break;

	  const wrap = document.createElement('div');

	  const label = document.createElement('label');
	  label.textContent = 'Max interval between records:';
	  wrap.appendChild(label);
	  wrap.appendChild(document.createElement('br'));

	  const row = document.createElement('div');
	  row.style.display = 'flex';
	  row.style.gap = '8px';
	  row.style.alignItems = 'center';

	  // Value
	  const val = document.createElement('input');
	  val.type = 'number';
	  val.id = 'paramCadenceValue';
	  val.min = '1';
	  val.value = '1';
	  val.style.width = '90px';

	  // Unit
 	 const unit = document.createElement('select');
	  unit.id = 'paramCadenceUnit';
	  ['minute','hour','day','week'].forEach(u => {
  	  const o = document.createElement('option');
  	  o.value = u; o.textContent = u;
  	  unit.appendChild(o);
	  });

  // Tolerance multiplier (to avoid false positives)
  const tol = document.createElement('input');
  tol.type = 'number';
  tol.step = '0.1';
  tol.min = '1.0';
  tol.value = '1.5';           // default 1.5× the target interval
  tol.id = 'paramCadenceTolerance';
  tol.title = 'Tolerance multiplier';
  tol.style.width = '90px';

  const tolLbl = document.createElement('span');
  tolLbl.textContent = '× tolerance';

  row.appendChild(val);
  row.appendChild(unit);
  row.appendChild(tol);
  row.appendChild(tolLbl);
  wrap.appendChild(row);

  paramInputs.appendChild(wrap);
  break;
}


    case 'datetimeRange':
      if (dataType === 'datetime') {
        paramInputs.appendChild(createInput('Min Datetime:', 'paramMinDateTime', 'datetime-local').div);
        paramInputs.appendChild(createInput('Max Datetime:', 'paramMaxDateTime', 'datetime-local').div);
      }
      break;

    case 'greaterThan':
      paramInputs.appendChild(createInput('Number:', 'paramGreaterThan', 'number').div);
      break;

    case 'lessThan':
      paramInputs.appendChild(createInput('Number:', 'paramLessThan', 'number').div);
      break;

    // boolean helpers require no additional UI
    case 'isTrue':
    case 'isFalse':
    default:
      // no params
      break;
  }

  updateConditionPreview();
}


  // Listen to param input changes to update condition preview & enable add button
  paramInputs.addEventListener('input', () => {
    updateConditionPreview();
  });

  colSelect.addEventListener('input', updateConditionPreview);
  dataTypeSelect.addEventListener('input', updateConditionPreview);
  conditionSelect.addEventListener('input', updateConditionPreview);

function updateConditionPreview() {
  const col = colSelect.value;
  const type = dataTypeSelect.value;
  const cond = conditionSelect.value;

  if (!col || !type || !cond) {
    conditionPreview.value = '';
    addRuleBtn.disabled = true;
    return;
  }

  let condStr = '';
  try {
    switch (cond) {
      case 'notEmpty':
        condStr = `value !== '' && value != null`;
        break;

      case 'maxLength': {
        const maxLength = document.getElementById('paramMaxLength')?.value;
        if (!maxLength || isNaN(maxLength) || maxLength <= 0) { condStr = ''; break; }
        condStr = `typeof value === 'string' && value.length <= ${maxLength}`;
        break;
      }

      case 'equals': {
        if (type === 'date') {
          const d = document.getElementById('paramEqualsDate')?.value;
          if (!d) { condStr = ''; break; }
          condStr = `value === '${d}'`;
        } else if (type === 'numeric' || type === 'integer') {
          const n = document.getElementById('paramEqualsNum')?.value;
          if (n === '' || isNaN(n)) { condStr = ''; break; }
          condStr = `Number(value) === ${Number(n)}`;
        } else if (type === 'time') {
          const t = document.getElementById('paramEqualsTime')?.value;
          if (!t) { condStr = ''; break; }
          // Time strings HH:MM or HH:MM:SS are lexicographically comparable when format is fixed
          condStr = `String(value) === '${t}'`;
        } else if (type === 'datetime') {
          const dt = document.getElementById('paramEqualsDateTime')?.value; // YYYY-MM-DDTHH:MM
          if (!dt) { condStr = ''; break; }
          // Normalize data value (accepts ' ' or 'T')
          condStr = `(Date.parse(String(value).replace(' ', 'T')) === Date.parse('${dt}'))`;
        } else if (type === 'boolean') {
          const b = document.getElementById('paramEqualsBool')?.value;
          if (b !== 'true' && b !== 'false') { condStr = ''; break; }
          condStr = `String(value).toLowerCase() === '${b}'`;
        } else {
          const s = document.getElementById('paramEqualsStr')?.value;
          if (!s) { condStr = ''; break; }
          condStr = `value === '${s}'`;
        }
        break;
      }

	case 'regexMatch': {
	  const r = document.getElementById('paramRegex')?.value;
	  if (!r || r.trim() === '') {
	    condStr = '';
	    break;
	  }
	  condStr = `new RegExp(${JSON.stringify(r)}).test(value)`;
	  break;
	}


      case 'range': {
        const min = document.getElementById('paramMin')?.value;
        const max = document.getElementById('paramMax')?.value;
        if (min === '' || max === '' || isNaN(min) || isNaN(max)) { condStr = ''; break; }
        condStr = `(Number(value) >= ${Number(min)} && Number(value) <= ${Number(max)})`;
        break;
      }

      case 'dateRange': {
        const minD = document.getElementById('paramMinDate')?.value;
        const maxD = document.getElementById('paramMaxDate')?.value;
        if (!minD || !maxD) { condStr = ''; break; }
        // Dates in YYYY-MM-DD compare lexicographically
        condStr = `(value >= '${minD}' && value <= '${maxD}')`;
        break;
      }

      case 'timeRange': {
        const minT = document.getElementById('paramMinTime')?.value;
        const maxT = document.getElementById('paramMaxTime')?.value;
        if (!minT || !maxT) { condStr = ''; break; }
        // Times in HH:MM(:SS) compare lexicographically
        condStr = `(String(value) >= '${minT}' && String(value) <= '${maxT}')`;
        break;
      }

      case 'datetimeRange': {
        const minDT = document.getElementById('paramMinDateTime')?.value; // 'YYYY-MM-DDTHH:MM'
        const maxDT = document.getElementById('paramMaxDateTime')?.value;
        if (!minDT || !maxDT) { condStr = ''; break; }
        const normalize = `String(value).replace(' ', 'T')`;
        condStr = `(Date.parse(${normalize}) >= Date.parse('${minDT}') && Date.parse(${normalize}) <= Date.parse('${maxDT}'))`;
        break;
      }

      case 'greaterThan': {
        const gt = document.getElementById('paramGreaterThan')?.value;
        if (gt === '' || isNaN(gt)) { condStr = ''; break; }
        condStr = `Number(value) > ${Number(gt)}`;
        break;
      }

      case 'lessThan': {
        const lt = document.getElementById('paramLessThan')?.value;
        if (lt === '' || isNaN(lt)) { condStr = ''; break; }
        condStr = `Number(value) < ${Number(lt)}`;
        break;
      }

      case 'isTrue': {
        condStr = `['true','yes','1',true].includes(String(value).toLowerCase())`;
        break;
      }

      case 'isFalse': {
        condStr = `['false','no','0',false].includes(String(value).toLowerCase())`;
        break;
      }

      case 'unique': {
        condStr = `__unique__`; // Placeholder processed during execution
        break;
      }
	case 'classMatch': {
	  const raw = document.getElementById('paramClassValues')?.value;
	  if (!raw) { condStr = ''; break; }
	  const values = raw.split(/[\n,]+/).map(v => v.trim()).filter(v => v !== '');
	  if (values.length === 0) { condStr = ''; break; }
	  const jsonList = JSON.stringify(values);
 	  condStr = `${jsonList}.includes(String(value))`;
	  break;
	}

       case 'freshnessWithin': {
                          const v = Number(document.getElementById('paramFreshWithinValue')?.value);
  		      const u = document.getElementById('paramFreshWithinUnit')?.value;
 		   if (!v || !u) { condStr = ''; break; }
  		       // convert to ms
  		   const ms = (u === 'minute') ? v*60e3 : (u === 'hour') ? v*3600e3 : (u === 'day') ? v*86400e3 : v*7*86400e3;
  		       // Accepts ' ' or 'T' in data value; true when value within last N units
  		       condStr = `(Date.now() - Date.parse(String(value).replace(' ','T')) <= ${ms})`;
  		break;
	}

	case 'cadenceWithin': {
  			const v = Number(document.getElementById('paramCadenceValue')?.value);
  			const u = document.getElementById('paramCadenceUnit')?.value;
  			const t = Number(document.getElementById('paramCadenceTolerance')?.value || 1.5);
  			if (!v || !u || !t) { condStr = ''; break; }
  			// Special placeholder; evaluated in engine (like 'unique')
  			condStr = '__cadence__';
  			break;
	}


      default:
        condStr = '';
    }
  } catch {
    condStr = '';
  }

  conditionPreview.value = condStr;
  addRuleBtn.disabled = condStr === '';
}


  addRuleBtn.addEventListener('click', () => {
    const col = colSelect.value;
    const type = dataTypeSelect.value;
    const cond = conditionSelect.value;
    const condExpr = conditionPreview.value;

    if (!col || !type || !cond || !condExpr) return;

    // Save parameters for display
    const params = {};
    [...paramInputs.querySelectorAll('input')].forEach(input => {
      params[input.id] = input.value;
    });

    const rule = {column: col, dataType: type, condition: condExpr, conditionType: cond, params};
    rules.push(rule);

    renderRules();

    // Reset form inputs (except col)
    dataTypeSelect.value = '';
    conditionSelect.innerHTML = '';
    conditionSelect.disabled = true;
    clearParamInputs();
    conditionPreview.value = '';
    addRuleBtn.disabled = true;

    runRulesBtn.disabled = (data.length === 0 || rules.length === 0);

    previewBadBtn.disabled = true;
  });
function renderRules() {
  // Clear list
  rulesList.innerHTML = '';

  // Empty state
  if (!Array.isArray(rules) || rules.length === 0) {
    rulesList.innerHTML = '<p>No rules added yet.</p>';
    // Keep buttons in a safe state
    runRulesBtn.disabled = (data.length === 0 || rules.length === 0);
    previewBadBtn.disabled = true;
    exportRulesBtn.disabled = true;
    return;
  }

  // Build each rule card
  rules.forEach((rule, i) => {
    const card = document.createElement('div');
    card.className = 'rule';

    // Description
    const desc = document.createElement('div');
    desc.className = 'rule-desc';
    desc.textContent = `[${rule.column}] (${rule.dataType}) - ${rule.conditionType} - Condition: ${rule.condition}`;

    // Actions container
    const actions = document.createElement('div');
    actions.className = 'rule-actions';

// --- EDIT / MODIFY ---
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'rule-btn edit';
    btnEdit.title = 'Edit rule';
    btnEdit.innerHTML = '<span class="icon" aria-label="Edit">&#9998;</span>'; // ✎
    btnEdit.title = 'Edit';

    btnEdit.onclick = () => {
      // 1) Populate the form with this rule's values
      colSelect.value = rule.column;

      dataTypeSelect.value = rule.dataType;
      populateConditionOptions(rule.dataType);

      conditionSelect.value = rule.conditionType;
      showParamInputs(rule.dataType, rule.conditionType);

      // 2) Restore parameter inputs (if any)
      const params = rule.params || {};
      Object.entries(params).forEach(([id, val]) => {
        const input = document.getElementById(id);
        if (input) input.value = val;
      });

      // 3) Update preview and UI state
      updateConditionPreview();

      // 4) Remove the original so when the user clicks "Add Rule"
      //    they're effectively saving the modified rule as a new entry
      rules.splice(i, 1);
      renderRules();

      // UX: surface the compose area so users notice it's now in edit mode
      try {
        conditionPreview.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_) { /* noop */ }

      // Ensure Add button state reflects current preview
      addRuleBtn.disabled = (conditionPreview.value === '');
      previewBadBtn.disabled = true;
      runRulesBtn.disabled = (data.length === 0 || rules.length === 0);
    };

    // --- REMOVE (already in your app, kept here for completeness) ---
    const btnRemove = document.createElement('button');
    btnRemove.type = 'button';
    btnRemove.className = 'rule-btn remove';
    btnRemove.title = 'Remove rule';
    btnRemove.innerHTML = '<span class="icon" aria-label="Remove">&#128465;</span>'; // 🗑️
    btnRemove.title = 'Remove';

    btnRemove.onclick = () => {
      rules.splice(i, 1);
      renderRules();
      runRulesBtn.disabled = (data.length === 0 || rules.length === 0);
      previewBadBtn.disabled = true;
    };

    // --- DUPLICATE ---
    const btnDuplicate = document.createElement('button');
    btnDuplicate.type = 'button';
    btnDuplicate.className = 'rule-btn duplicate';
    btnDuplicate.title = 'Duplicate rule'; 
    btnDuplicate.innerHTML = '<span class="icon" aria-label="Duplicate">&#128209;</span>'; // 📑
    btnDuplicate.title = 'Duplicate';

    btnDuplicate.onclick = () => {
      // Deep-ish copy to preserve params safely
      const clone = JSON.parse(JSON.stringify(rule));
      // Insert right after the current rule
      rules.splice(i + 1, 0, clone);
      renderRules();
      runRulesBtn.disabled = (data.length === 0 || rules.length === 0);
    };

    

    // Assemble
    actions.appendChild(btnEdit);
    actions.appendChild(btnRemove);
    actions.appendChild(btnDuplicate);
    

    card.appendChild(desc);
    card.appendChild(actions);
    rulesList.appendChild(card);
  });

  // Keep main action buttons in sync
  runRulesBtn.disabled = (data.length === 0 || rules.length === 0);
  exportRulesBtn.disabled = (rules.length === 0);
  
  // [DQ TABS] rules changed -> invalidate last results
  lastBadRowsSet = null;

}


function runDataQualityChecks() {
  if (data.length === 0 || rules.length === 0) return;

  const badRowsByDimension = {};
  DQ_DIMENSIONS.forEach(d => (badRowsByDimension[d] = new Set()));

  // NEW: track per-column & per-rule failures
  const badRowsByColumn = new Map(); // column -> Set(rowIdx)
  const badRowsByRule = new Map();   // ruleLabel -> Set(rowIdx)

  // Precompute duplicates for 'unique'
  const dupIdxByRule = new Map();
  rules.forEach(rule => {
    if (rule.conditionType !== 'unique') return;
    const seen = new Map();
    const dupIdxs = new Set();
    data.forEach((r, i) => {
      const v = r[rule.column];
      if (seen.has(v)) { dupIdxs.add(i); dupIdxs.add(seen.get(v)); }
      else { seen.set(v, i); }
    });
    dupIdxByRule.set(rule, dupIdxs);
  });

// Precompute cadence breaches for 'cadenceWithin'
const cadenceIdxByRule = new Map();
rules.forEach(rule => {
  if (rule.conditionType !== 'cadenceWithin') return;

  const col = rule.column;
  const type = inferDataType(col);       // 'date' | 'datetime' | 'time'
  const rawVals = data.map(r => r[col]);
  // build series of {timeNum, idx}
  let nums = [];
  if (type === 'date') {
    nums = rawVals.map((v, i) => [parseDateToMs(v), i]);
  } else if (type === 'datetime') {
    nums = rawVals.map((v, i) => [parseDateTimeToMs(String(v).replace(' ','T')), i]);
  } else if (type === 'time') {
    nums = rawVals.map((v, i) => [parseTimeToSec(v) * 1000, i]); // convert sec→ms for consistent math
  } else {
    cadenceIdxByRule.set(rule, new Set());
    return;
  }
  // keep finite only
  const seq = nums.filter(([t]) => Number.isFinite(t));
  if (seq.length < 2) {
    cadenceIdxByRule.set(rule, new Set());
    return;
  }
  // sort by time
  seq.sort((a, b) => a[0] - b[0]);

  // params: value/unit + tolerance
  const v = Number(rule.params?.value);
  const u = rule.params?.unit;
  const tol = Number(rule.params?.tolerance || rule.params?.toleranceMultiplier || 1.5);

  const baseMs =
    u === 'minute' ? v * 60e3 :
    u === 'hour'   ? v * 3600e3 :
    u === 'day'    ? v * 86400e3 :
                     v * 7 * 86400e3; // week

  const maxAllowed = Math.max(baseMs, 0) * (Number.isFinite(tol) && tol > 0 ? tol : 1.5);

  // any gap > maxAllowed -> mark the *later* row as failing
  const bad = new Set();
  for (let k = 1; k < seq.length; k++) {
    const gap = seq[k][0] - seq[k-1][0];
    if (gap > maxAllowed) {
      bad.add(seq[k][1]);      // mark the later row index
    }
  }
  cadenceIdxByRule.set(rule, bad);
});

  data.forEach((row, idx) => {
    rules.forEach(rule => {
      const markFail = () => {
        const dim = mapRuleToDimension(rule);
        badRowsByDimension[dim].add(idx);
        // by column
        if (!badRowsByColumn.has(rule.column)) badRowsByColumn.set(rule.column, new Set());
        badRowsByColumn.get(rule.column).add(idx);
        // by rule
        const rLabel = `[${rule.column}] ${rule.conditionType}`;
        if (!badRowsByRule.has(rLabel)) badRowsByRule.set(rLabel, new Set());
        badRowsByRule.get(rLabel).add(idx);
      };

      if (rule.conditionType === 'unique') {
        const dupIdxs = dupIdxByRule.get(rule) || new Set();
        if (dupIdxs.has(idx)) markFail();
        return;
      }

	if (rule.conditionType === 'cadenceWithin') {
	   const badIdxs = cadenceIdxByRule.get(rule) || new Set();
	   if (badIdxs.has(idx)) markFail();
	   return;
	 }


      let pass = false;
      try {
        pass = eval(rule.condition.replace(/value/g, JSON.stringify(row[rule.column])));
      } catch { pass = false; }
      if (!pass) markFail();
    });
  });

  // Flatten bad rows
  const badRowsSet = new Set();
  Object.values(badRowsByDimension).forEach(set => set.forEach(i => badRowsSet.add(i)));

  // Dimension scores (existing)
  const dimensionScores = {};
  DQ_DIMENSIONS.forEach(dim => {
    const hasRule = rules.some(rule => mapRuleToDimension(rule) === dim);
    if (!hasRule) dimensionScores[dim] = null;
    else {
      const badCount = badRowsByDimension[dim].size;
      const score = data.length === 0 ? 100 : Math.max(0, parseFloat((100 - (badCount / data.length) * 100).toFixed(2)));
      dimensionScores[dim] = score;
    }
  });

  // === Update scorecards & charts ===
  const total = data.length;
  const bad = badRowsSet.size;

  // KPIs (existing targets)
  totalRowsEl.textContent = total;
  badRowsEl.textContent = bad;

  const applicable = Object.values(dimensionScores).filter(s => s !== null);
  const avgScore = applicable.length ? (applicable.reduce((a,b)=>a+b,0)/applicable.length) : null;
  const goodPctStr = (avgScore == null) ? 'N/A' : `${avgScore.toFixed(2)}%`;
  goodPercentEl.textContent = goodPctStr;

  // Deltas vs previous run
  ensureDashboardLayout();
  if (prevRunMetrics) {
    setDeltaText('totalRows', prevRunMetrics.total, total);
    setDeltaText('badRows', prevRunMetrics.bad, bad);
    if (avgScore != null && prevRunMetrics.avgScore != null) {
      setDeltaText('goodPercent', prevRunMetrics.avgScore, avgScore, pctFormat);
    }
  }
  prevRunMetrics = { total, bad, avgScore };

  // Existing charts
  updateRadarChart(dimensionScores);
  updatePieChart(badRowsByDimension);

  // New charts
  updateDonut(total, bad);

  // Top bad columns (sorted desc by failing rows)
  const badColsCounts = Array.from(badRowsByColumn.entries())
    .map(([col, set]) => [col, set.size])
    .sort((a,b) => b[1] - a[1]);
  updateTopColumnsChart(badColsCounts);

  // Top failing rules (sorted)
  const badRulesCounts = Array.from(badRowsByRule.entries())
    .map(([label, set]) => [label, set.size])
    .sort((a,b) => b[1] - a[1]);
  updateTopRulesChart(badRulesCounts);

  dashboardSection.style.display = 'block';
  previewBadBtn.disabled = false;


    // expose for Analysis tab
  lastBadRowsByColumn = badRowsByColumn;
  lastBadRowsByRule   = badRowsByRule;
  
  // ... after computing total, bad, avgScore, dimensionScores ...
try {
  const src = (window.__dqSource || {});
  const payload = {
    datasetName: src.table ? `${src.database}.${src.schema}.${src.table}` : 'ad-hoc',
    source: { host: src.host, database: src.database, schema: src.schema, table: src.table },
    columns: headers,
    rowCount: total,
    badRowCount: bad,
    avgScore: avgScore == null ? null : Number(avgScore.toFixed(2)),
    dimensionScores
    , rules // your in-memory rules array
  };
  fetch('http://localhost:4000/api/results', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
  }).catch(() => {});
} catch (_) { /* non-blocking */ }


  return badRowsSet;
}



  
runRulesBtn.addEventListener('click', () => {
  ensureDQResultsTabs();                // from your previous change
  ensureDashboardLayout();              // NEW: ensure cards/canvases exist
  badDataTableContainer.style.display = 'none';
  lastBadRowsSet = runDataQualityChecks();  // still the main engine
  activateDQTab('dashboard');           // show the dashboard tab by default
});



  previewBadBtn.addEventListener('click', () => {
    const badRowsSet = runDataQualityChecks();
    if (!badRowsSet || badRowsSet.size === 0) {
      alert('No bad data found based on current rules.');
      badDataTableContainer.style.display = 'none';
      return;
    }
    badDataTableContainer.style.display = 'block';
    const badRows = Array.from(badRowsSet).map(i => data[i]);
    renderTable(badRows, badDataTable);
  });
// --- Export Rules ---
const exportRulesBtn = document.getElementById('exportRulesBtn');
exportRulesBtn.addEventListener('click', () => {
  if (!rules || rules.length === 0) {
    alert('No rules to export.');
    return;
  }
  const blob = new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dq_rules.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// --- Import Rules ---
const importRulesBtn = document.getElementById('importRulesBtn');
const importRulesInput = document.getElementById('importRulesInput');
async function saveRulesToServer() {
  try {
    const resp = await fetch('http://localhost:4000/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rules)
    });
    if (!resp.ok) throw new Error((await resp.json()).error || `HTTP ${resp.status}`);
    alert('Rules saved to server.');
  } catch (e) {
    alert(`Failed to save rules: ${e.message}`);
  }
}

async function loadRulesFromServer() {
  try {
    const resp = await fetch('http://localhost:4000/api/rules');
    if (!resp.ok) throw new Error((await resp.json()).error || `HTTP ${resp.status}`);
    rules = await resp.json();
    renderRules();
  } catch (e) {
    alert(`Failed to load rules: ${e.message}`);
  }
}

importRulesBtn.addEventListener('click', () => {
  importRulesInput.click();
});

importRulesInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const imported = JSON.parse(ev.target.result);
      if (!Array.isArray(imported)) throw new Error('Invalid format');
      rules = imported;
      renderRules();
      runRulesBtn.disabled = (data.length === 0 || rules.length === 0);
      previewBadBtn.disabled = true;
      alert('Rules imported successfully!');
    } catch (err) {
      alert('Failed to import rules: ' + err.message);
    }
  };
  reader.readAsText(file);
});

  // Initialize Charts

  function initRadarChart() {
    const ctx = document.getElementById('radarChart').getContext('2d');
    radarChart = new Chart(ctx, {
      type: 'radar',
      data: {
        labels: DQ_DIMENSIONS,
        datasets: [{
          label: 'DQ Scores',
          data: Array(DQ_DIMENSIONS.length).fill(100),
          fill: true,
          backgroundColor: 'rgba(0, 122, 204, 0.3)',
          borderColor: 'rgba(0, 122, 204, 1)',
          pointBackgroundColor: 'rgba(0, 122, 204, 1)',
          pointBorderColor: '#fff',
          pointHoverBackgroundColor: '#fff',
          pointHoverBorderColor: 'rgba(0, 122, 204, 1)'
        }]
      },
      options: {
        aspectRatio: 1,
        scales: {
          r: {
            angleLines: { display: true },
            suggestedMin: 0,
            suggestedMax: 100,
            ticks: {
              stepSize: 20,
              color: '#666'
            },
            pointLabels: {
              font: {
                size: 14,
                weight: 'bold'
              }
            }
          }
        },
        plugins: {
          legend: { display: false }
        }
      }
    });
  }

  function updateRadarChart(scores) {
    if (!radarChart) initRadarChart();
    radarChart.data.datasets[0].data = DQ_DIMENSIONS.map(dim => scores[dim] === null ? 0 : scores[dim]);
    radarChart.update();
  }

function initPieChart() {
  const ctx = document.getElementById('badPieChart').getContext('2d');
  if (badPieChart) return badPieChart;
  badPieChart = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: DQ_DIMENSIONS,
      datasets: [{
        label: 'Bad Data Distribution',
        data: Array(DQ_DIMENSIONS.length).fill(0),
        backgroundColor: ['#FF6384','#36A2EB','#FFCE56','#4BC0C0','#9966FF','#FF9F40'],
        hoverOffset: 10
      }]
    },
    options: {
      aspectRatio: 1, // keep it circular
      plugins: {
        title: {
          display: true,
          color: '#1a2233',
          font: { weight: '800', size: 14 }
        },
        legend: {
          position: 'right',
          labels: { color: '#1a2233', font: { weight: '600' } }
        }
      }
    }
  });
  return badPieChart;
}


  function updatePieChart(badRowsByDimension) {
    if (!badPieChart) initPieChart();
    const counts = DQ_DIMENSIONS.map(dim => badRowsByDimension[dim]?.size || 0);
    badPieChart.data.datasets[0].data = counts;
    badPieChart.update();
  }

  function initDonut() {
  if (donutChart) return donutChart;
  const ctx = document.getElementById('goodBadDonut')?.getContext('2d');
  if (!ctx) return null;
  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Good', 'Bad'],
      datasets: [{
        data: [1, 0],
        backgroundColor: ['#2ECC71', '#FF6B6B'],
        hoverOffset: 8
      }]
    },
    options: {
      cutout: '65%',
      aspectRatio: 1,
      plugins: { legend: { position: 'right' } }
    }
  });
  return donutChart;
}
function updateDonut(total, bad) {
  const good = Math.max(0, total - bad);
  const ch = initDonut();
  if (!ch) return;
  ch.data.datasets[0].data = [good, bad];
  ch.update();
}

function initTopColumnsChart() {
  if (badByColumnChart) return badByColumnChart;
  const ctx = document.getElementById('badByColumnChart')?.getContext('2d');
  if (!ctx) return null;
  badByColumnChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Bad rows', data: [], backgroundColor: 'rgba(255, 159, 64, 0.4)', borderColor: '#FF9F40', borderWidth: 1 }] },
    options: {
      indexAxis: 'y',
      aspectRatio: 2.5,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx)=>`${ctx.parsed.x} rows` } } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
  return badByColumnChart;
}
function updateTopColumnsChart(countPairs /* [ [col, count], ... ] */) {
  const ch = initTopColumnsChart();
  if (!ch) return;
  const top = countPairs.slice(0, 10);
  ch.data.labels = top.map(([c]) => c);
  ch.data.datasets[0].data = top.map(([_, n]) => n);
  ch.update();

  // Empty-state message
  const card = document.getElementById('card-badByColumnChart');
  if (card) {
    let msg = card.querySelector('.chart-empty');
    if (top.length === 0) {
      if (!msg) {
        msg = document.createElement('div');
        msg.className = 'chart-empty';
        msg.textContent = 'No failing columns for current rules.';
        card.appendChild(msg);
      }
    } else if (msg) msg.remove();
  }
}

function initTopRulesChart() {
  if (badByRuleChart) return badByRuleChart;
  const ctx = document.getElementById('badByRuleChart')?.getContext('2d');
  if (!ctx) return null;
  badByRuleChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Bad rows', data: [], backgroundColor: 'rgba(54, 162, 235, 0.4)', borderColor: '#36A2EB', borderWidth: 1 }] },
    options: {
      indexAxis: 'y',
      aspectRatio: 2.5,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx)=>`${ctx.parsed.x} rows` } } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
  return badByRuleChart;
}
function updateTopRulesChart(countPairs /* [ [ruleLabel, count], ... ] */) {
  const ch = initTopRulesChart();
  if (!ch) return;
  const top = countPairs.slice(0, 10);
  ch.data.labels = top.map(([r]) => r);
  ch.data.datasets[0].data = top.map(([_, n]) => n);
  ch.update();

  const card = document.getElementById('card-badByRuleChart');
  if (card) {
    let msg = card.querySelector('.chart-empty');
    if (top.length === 0) {
      if (!msg) {
        msg = document.createElement('div');
        msg.className = 'chart-empty';
        msg.textContent = 'No rule failures for current rules.';
        card.appendChild(msg);
      }
    } else if (msg) msg.remove();
  }
}


  // Initialize empty
  if (window.Chart) {
    updateRadarChart(DQ_DIMENSIONS.reduce((acc, d) => (acc[d] = 100, acc), {}));
    updatePieChart(DQ_DIMENSIONS.reduce((acc, d) => (acc[d] = 0, acc), {}));
  }
 

  // Data table placeholder - hidden for now
  const dataTablePlaceholder = document.createElement('table');
  dataTablePlaceholder.id = 'dataTable';
  dataTablePlaceholder.style.display = 'none';
  document.body.appendChild(dataTablePlaceholder);


});


// ======= Power BI–style Get Data (PostgreSQL) =======
(() => {
  const baseUrl = 'http://localhost:4000';

  const modal = document.getElementById('getDataModal');
  const openBtn = document.getElementById('getDataBtn');
  const closeBtn = document.getElementById('closeGetData');
  const btnTest = document.getElementById('btnTestConn');
  const btnConnect = document.getElementById('btnConnect');
  const btnPreview = document.getElementById('btnPreview');
  const btnLoad = document.getElementById('btnLoad');
  const connStatus = document.getElementById('connStatus');
  const previewStatus = document.getElementById('previewStatus');
  const tablePicker = document.getElementById('tablePicker');
  const schemaSel = document.getElementById('pgSchema');
  const tableSel  = document.getElementById('pgTable');
  const previewArea = document.getElementById('previewArea');

  const pgHost = () => document.getElementById('pgHost').value.trim();
  const pgPort = () => document.getElementById('pgPort').value.trim();
  const pgDb   = () => document.getElementById('pgDatabase').value.trim();
  const pgUser = () => document.getElementById('pgUser').value.trim();
  const pgPass = () => document.getElementById('pgPassword').value;
  const pgSSL  = () => document.getElementById('pgSSL').value === 'true';

  let connectionId = null;

  function showModal() { modal.classList.remove('hidden'); }
  function hideModal() { modal.classList.add('hidden'); cleanup(); }
  function cleanup() {
    connStatus.textContent = '';
    previewStatus.textContent = '';
    tablePicker.classList.add('hidden');
    previewArea.innerHTML = '';
    schemaSel.innerHTML = '';
    tableSel.innerHTML = '';
    if (connectionId) {
      fetch(`${baseUrl}/api/connect/${connectionId}`, { method: 'DELETE' }).catch(()=>{});
      connectionId = null;
    }
  }

  openBtn?.addEventListener('click', showModal);
  closeBtn?.addEventListener('click', hideModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });

  async function testConn() {
    connStatus.textContent = 'Testing...';
    const body = { host: pgHost(), port: pgPort(), database: pgDb(), user: pgUser(), password: pgPass(), ssl: pgSSL() };
    const resp = await fetch(`${baseUrl}/api/connect/test`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const err = await resp.json().catch(()=>({})); connStatus.textContent = `Failed: ${err.error || resp.status}`;
    } else {
      connStatus.textContent = 'Success';
    }
  }

  async function connectAndListTables() {
    connStatus.textContent = 'Connecting...';
    const body = { host: pgHost(), port: pgPort(), database: pgDb(), user: pgUser(), password: pgPass(), ssl: pgSSL() };
    const resp = await fetch(`${baseUrl}/api/connect/new`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    const json = await resp.json();
    if (!resp.ok) { connStatus.textContent = `Failed: ${json.error || resp.status}`; return; }
    connectionId = json.connectionId;
    connStatus.textContent = 'Connected';

    const t = await fetch(`${baseUrl}/api/connect/${connectionId}/tables`).then(r=>r.json());
    // Group by schema, fill schema select, then table select
    const bySchema = new Map();
    (t.tables || []).forEach(row => {
      if (!bySchema.has(row.table_schema)) bySchema.set(row.table_schema, []);
      bySchema.get(row.table_schema).push(row.table_name);
    });
    schemaSel.innerHTML = ''; tableSel.innerHTML = '';
    for (const [sch, tbls] of bySchema.entries()) {
      const opt = document.createElement('option'); opt.value = sch; opt.textContent = sch; schemaSel.appendChild(opt);
    }
    schemaSel.onchange = () => {
      const sch = schemaSel.value;
      const tbls = bySchema.get(sch) || [];
      tableSel.innerHTML = '';
      tbls.forEach(tn => { const opt = document.createElement('option'); opt.value = tn; opt.textContent = tn; tableSel.appendChild(opt); });
    };
    schemaSel.dispatchEvent(new Event('change'));
    tablePicker.classList.remove('hidden');
  }

  async function preview() {
    previewStatus.textContent = 'Loading preview...';
    const schema = schemaSel.value; const table = tableSel.value;
    const url = `${baseUrl}/api/connect/${connectionId}/preview?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&limit=50`;
    const p = await fetch(url).then(r=>r.json());
    renderPreviewTable(p.headers || [], p.rows || []);
    previewStatus.textContent = `Preview: ${p.rows?.length || 0} rows`;
  }

  function renderPreviewTable(headers, rows) {
    const tbl = document.createElement('table');
    const thead = document.createElement('tr');
    headers.forEach(h => { const th = document.createElement('th'); th.textContent = h; thead.appendChild(th); });
    tbl.appendChild(thead);
    (rows || []).forEach(r => {
      const tr = document.createElement('tr');
      headers.forEach(h => { const td = document.createElement('td'); td.textContent = (r[h] == null ? '' : String(r[h])); tr.appendChild(td); });
      tbl.appendChild(tr);
    });
    previewArea.innerHTML = '';
    previewArea.appendChild(tbl);
  }

  async function loadSelected() {
    const schema = schemaSel.value; const table = tableSel.value;
    const url = `${baseUrl}/api/connect/${connectionId}/preview?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&limit=1000`;
    const p = await fetch(url).then(r=>r.json());
    // integrate with existing globals
    headers = p.headers || [];
    data = p.rows || [];
    totalRowsEl.textContent = data.length;
    badRowsEl.textContent = '0';
    goodPercentEl.textContent = '100%';
    updateColumnDropdown();
    renderTable(data, document.getElementById('dataTable'));
    profilingSection.style.display = 'none';
    dashboardSection.style.display = 'none';
    badDataTableContainer.style.display = 'none';
    rules = [];
    renderRules();
    // keep a tiny memory of source for result-saving
    window.__dqSource = { type: 'postgres', host: pgHost(), database: pgDb(), schema, table };
    hideModal();
  }

  btnTest?.addEventListener('click', (e) => { e.preventDefault(); testConn().catch(err => connStatus.textContent = String(err)); });
  btnConnect?.addEventListener('click', (e) => { e.preventDefault(); connectAndListTables().catch(err => connStatus.textContent = String(err)); });
  btnPreview?.addEventListener('click', (e) => { e.preventDefault(); preview().catch(err => previewStatus.textContent = String(err)); });
  btnLoad?.addEventListener('click', (e) => { e.preventDefault(); loadSelected().catch(err => alert(String(err))); });
})();
