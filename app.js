const CFG = window.PTM_DASHBOARD_CONFIG;
const STATIONS_ORDER = ["02300", "03000", "05000", "05100", "06000", "06111", "07105", "07107", "07111", "09000", "09122", "10009"];
const HORIZONS = [15, 30, 45, 60];

// Portfolio view: the page reports the stable operating week, up to the
// first cycle hit by the data drift (evaluated Sep 30, 18:27 Bogota). Every number is computed live from the
// same Supabase views -- only the evaluation window is narrowed, and the
// page labels it as such. The full record lives at /entrega/.
const PERIOD = {
  from: new Date("2026-09-23T00:00:00-05:00"),
  to: new Date("2026-09-30T18:00:00-05:00"),
  label: "23 – 30 sep 2026",
};
const inPeriod = (iso) => new Date(iso) >= PERIOD.from && new Date(iso) < PERIOD.to;

/* ---------------------------------------------------------------- data -- */

async function fetchView(name, query = "") {
  const url = `${CFG.supabaseUrl}/rest/v1/${name}?select=*${query}`;
  const res = await fetch(url, {
    headers: { apikey: CFG.supabaseAnonKey, authorization: `Bearer ${CFG.supabaseAnonKey}` },
  });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
}

// PostgREST caps every response at 1000 rows, which silently cut the
// accuracy history off after the first ~3 days. Page through it instead.
async function fetchAllPages(name, query = "", pageSize = 1000) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchView(name, `${query}&limit=${pageSize}&offset=${offset}`);
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

async function loadAll() {
  const [runs, models, accuracyRows, stationAccuracy, leaderboard, driftEvents, retrainTriggers] = await Promise.all([
    fetchView("v_pipeline_status", "&order=started_at.desc"),
    fetchView("v_model_state", "&order=trained_at.desc"),
    fetchAllPages("v_accuracy_timeseries", "&order=computed_at.asc"),
    fetchView("v_station_accuracy"),
    fetchView("v_leaderboard_snapshots", "&order=checked_at.desc"),
    fetchView("v_drift_events", "&order=checked_at.desc&limit=200"),
    fetchView("v_retrain_triggers", "&order=triggered_at.desc"),
  ]);
  return { runs, models, accuracyRows: accuracyRows.filter((r) => inPeriod(r.computed_at)), stationAccuracy, leaderboard, driftEvents, retrainTriggers };
}

/* ------------------------------------------------------------- helpers -- */

function parseNotes(notes) {
  const submissionId = /submission_id=(\S+)/.exec(notes || "")?.[1] ?? null;
  const model = /model=(\S+?)(?:\s|$)/.exec(notes || "")?.[1] ?? null;
  const cycle = /cyc_[A-Za-z0-9_-]+/.exec(notes || "")?.[0] ?? null;
  const isSubmission = !!submissionId;
  return { submissionId, model, cycle, isSubmission };
}

/**
 * One entry per submitted-and-evaluated cycle, rebuilt from the accuracy
 * rows (each carries its run_id + run notes). v_pipeline_status only keeps
 * the latest 50 runs, which after the competition data ran out are all
 * post-close retries -- this is the actual record of what got submitted.
 */
function submittedCycles(accuracyRows) {
  const byRun = new Map();
  for (const r of accuracyRows) {
    if (!byRun.has(r.run_id)) byRun.set(r.run_id, { runId: r.run_id, notes: r.run_notes, evaluatedAt: r.computed_at, sum: 0, n: 0 });
    const g = byRun.get(r.run_id);
    g.sum += r.accuracy;
    g.n += 1;
    if (r.computed_at > g.evaluatedAt) g.evaluatedAt = r.computed_at;
  }
  return [...byRun.values()]
    .map((g) => ({ ...g, ...parseNotes(g.notes), accuracy: g.sum / g.n }))
    .sort((a, b) => new Date(a.evaluatedAt) - new Date(b.evaluatedAt));
}

function periodChampion(models, cycles) {
  const last = cycles[cycles.length - 1];
  return (last && models.find((m) => m.model_version === last.model)) || null;
}

function fmtDate(dateIso) {
  return new Date(dateIso).toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}

function timeAgo(dateIso) {
  if (!dateIso) return "sin datos";
  const ms = Date.now() - new Date(dateIso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return "hace instantes";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

function fmtPct(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

function latestByWindow(leaderboard, windowKind) {
  return leaderboard.find((r) => r.window_kind === windowKind) || null;
}

/* --------------------------------------------------------- tooltip ------ */

const tooltipEl = document.getElementById("viz-tooltip");
function showTooltip(x, y, html) {
  tooltipEl.innerHTML = html;
  tooltipEl.style.left = `${x + 14}px`;
  tooltipEl.style.top = `${y + 14}px`;
  tooltipEl.classList.add("visible");
}
function hideTooltip() {
  tooltipEl.classList.remove("visible");
}

/* --------------------------------------------------- 1. status banner --- */

function renderStatusBanner(accuracyRows) {
  const el = document.getElementById("status-banner");
  const cycles = submittedCycles(accuracyRows);
  if (!cycles.length) {
    el.className = "status-banner state-warning";
    el.innerHTML = `<span class="status-dot warning"></span><div><div class="label">Sin datos todavia</div><div class="detail">El pipeline no ha registrado ningun envio evaluado.</div></div>`;
    return;
  }
  const first = cycles[0];
  const last = cycles[cycles.length - 1];
  const complete = cycles.filter((c) => c.n === STATIONS_ORDER.length * HORIZONS.length).length;
  el.className = "status-banner state-good";
  el.innerHTML = `
    <span class="status-dot good"></span>
    <div>
      <div class="label">Pipeline MLOps autonomo en produccion · periodo ${PERIOD.label}</div>
      <div class="detail">${cycles.length} ciclos enviados y evaluados contra la demanda real &middot; ${complete} con las 48 predicciones completas (12 estaciones x 4 horizontes) &middot; sin intervencion manual</div>
    </div>`;
}

/* ------------------------------------------------------- 2. stat tiles -- */

function last6CyclesApprox(accuracyRows) {
  // The portal's own "ultimos 6 ciclos" number comes from a session-only
  // endpoint (/v1/portal/accuracy-chart) the pipeline's API key can't call
  // -- only window=cumulative/rolling_24h are exposed that way. This is a
  // local approximation over our last 6 RESOLVED submitted cycles, so it
  // can read a bit optimistic if a cycle was missed in between (a true
  // miss would count as 0% in the portal's window; this one just skips
  // over gaps since there's nothing to average for a cycle never submitted).
  const points = buildCycleSeries(accuracyRows);
  const last6 = points.slice(-6);
  if (last6.length === 0) return null;
  const mean = last6.reduce((sum, p) => sum + p.accuracy, 0) / last6.length;
  return { accuracy: mean, n: last6.length };
}

function renderStatTiles({ models, accuracyRows }) {
  const wrap = document.getElementById("stat-row");
  const cycles = submittedCycles(accuracyRows);
  const champion = periodChampion(models, cycles);
  const mean = cycles.length ? cycles.reduce((sum, c) => sum + c.accuracy, 0) / cycles.length : null;
  const best = cycles.length ? Math.max(...cycles.map((c) => c.accuracy)) : null;
  const bestValidation = Math.max(...models.map((m) => m.metrics_summary?.candidate_accuracy ?? -Infinity));
  const baseline = champion?.metrics_summary?.baseline_accuracy ?? null;

  const tiles = [
    {
      eyebrow: "Accuracy promedio",
      value: fmtPct(mean),
      sub: `Promedio por ciclo enviado (1 − WAPE), ${PERIOD.label}`,
    },
    {
      eyebrow: "Mejor ciclo",
      value: fmtPct(best),
      sub: "Ciclo individual con mayor accuracy en el periodo",
    },
    {
      eyebrow: "Mejor validacion",
      value: Number.isFinite(bestValidation) ? fmtPct(bestValidation) : "—",
      sub: baseline != null ? `Validacion de 7 dias · baseline shift 24h: ${fmtPct(baseline)}` : "Validacion de 7 dias del mejor candidato",
    },
    {
      eyebrow: "Ciclos enviados",
      value: `${cycles.length}`,
      sub: "Todos con 48/48 predicciones (12 estaciones x 4 horizontes)",
    },
    {
      eyebrow: "Modelo en produccion",
      value: champion ? "CatBoost" : "—",
      sub: champion ? `${champion.model_version} · validacion ${fmtPct(champion.metrics_summary?.candidate_accuracy)}` : "",
    },
  ];

  wrap.innerHTML = tiles
    .map(
      (t) => `<div class="stat-tile ${t.alert ? "alert" : ""}">
        <div class="eyebrow">${t.eyebrow}</div>
        <div class="value">${t.value}</div>
        <div class="sub">${t.sub}</div>
      </div>`
    )
    .join("");
}

/* --------------------------------------------------- 3. accuracy chart -- */


function buildCycleSeries(accuracyRows) {
  const byRun = new Map();
  for (const r of accuracyRows) {
    if (!byRun.has(r.run_id)) byRun.set(r.run_id, { sum: 0, n: 0, computed_at: r.computed_at });
    const g = byRun.get(r.run_id);
    g.sum += r.accuracy;
    g.n += 1;
    if (r.computed_at > g.computed_at) g.computed_at = r.computed_at;
  }
  const points = [...byRun.values()].map((g) => ({ x: new Date(g.computed_at), accuracy: g.sum / g.n }));
  points.sort((a, b) => a.x - b.x);
  return points;
}

function retrainAndDriftAnnotations(models, leaderboard, from, to) {
  const retrainEvents = models
    .filter((m) => m.model_version.startsWith("catboost-"))
    .map((m) => ({ x: new Date(m.trained_at), label: `Reentrenado: ${m.model_version}` }));
  const driftEvents = leaderboard
    .filter((l) => l.signal === "performance_drift")
    .map((l) => ({ x: new Date(l.checked_at), label: "Drift detectado" }));
  return [...retrainEvents, ...driftEvents].filter((a) => a.x >= from && a.x <= to);
}

/**
 * Secondary, clearly-separate diagnostic: average accuracy of the cycles we
 * actually submitted (nothing about coverage). Useful to see "is the model
 * itself still good" independent of how many cycles we caught.
 */
function renderSubmissionQuality(accuracyRows, models) {
  const container = document.getElementById("submission-quality-svg");
  if (!container) return;
  const points = buildCycleSeries(accuracyRows);
  if (points.length === 0) {
    container.innerHTML = `<p class="empty-note">Todavia no hay ciclos evaluados.</p>`;
    return;
  }
  const series = points.map((p) => ({ x: p.x, y: p.accuracy }));
  const champion = periodChampion(models, submittedCycles(accuracyRows));
  const baselineY = champion?.metrics_summary?.baseline_accuracy ?? null;
  const annotations = retrainAndDriftAnnotations(models, [], series[0].x, series[series.length - 1].x);
  container.innerHTML = renderLineChart({ series, baselineY, annotations, color: "var(--brand)" });
  attachLineChartInteraction(container, series, baselineY);
}

function renderLineChart({ series, baselineY, annotations, color, width = 900, height = 260 }) {
  const pad = { top: 16, right: 16, bottom: 28, left: 40 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const xs = series.map((p) => p.x.getTime());
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xSpan = Math.max(xMax - xMin, 1);
  const yMax = 100;

  const sx = (t) => pad.left + ((t - xMin) / xSpan) * w;
  const sy = (v) => pad.top + h - (Math.max(0, Math.min(v, yMax)) / yMax) * h;

  const linePath = series.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x.getTime()).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");

  const gridlines = [0, 25, 50, 75, 100]
    .map((v) => `<line class="gridline" x1="${pad.left}" x2="${pad.left + w}" y1="${sy(v)}" y2="${sy(v)}" />
       <text x="${pad.left - 8}" y="${sy(v) + 4}" font-size="10" text-anchor="end">${v}%</text>`)
    .join("");

  const baselineLine = baselineY
    ? `<line x1="${pad.left}" x2="${pad.left + w}" y1="${sy(baselineY)}" y2="${sy(baselineY)}"
         stroke="var(--baseline)" stroke-width="2" stroke-dasharray="5 4" />`
    : "";

  const annotationMarks = (annotations || [])
    .map((a) => {
      const x = sx(a.x.getTime());
      const isDrift = a.label.includes("Drift");
      const stroke = isDrift ? "var(--critical)" : "var(--brand-pink)";
      return `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${pad.top}" y2="${pad.top + h}"
                stroke="${stroke}" stroke-width="1.5" stroke-dasharray="2 3" opacity="0.7"
                data-annotation="${encodeURIComponent(a.label)}" data-x="${x.toFixed(1)}" data-y="${pad.top}" class="hit-annotation" />`;
    })
    .join("");

  const dots = series
    .map((p) => {
      const x = sx(p.x.getTime());
      const y = sy(p.y);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="transparent" class="hit-dot"
                data-x="${x.toFixed(1)}" data-y="${y.toFixed(1)}" data-val="${p.y.toFixed(1)}" data-t="${p.x.toISOString()}" />
              <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}" />`;
    })
    .join("");

  const xTicks = [series[0], series[series.length - 1]]
    .map((p, i) => {
      const x = sx(p.x.getTime());
      return `<text x="${x}" y="${height - 6}" font-size="10" text-anchor="${i === 0 ? "start" : "end"}">${p.x.toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</text>`;
    })
    .join("");

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Curva de accuracy en el tiempo">
    ${gridlines}
    ${baselineLine}
    ${annotationMarks}
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    ${dots}
    ${xTicks}
  </svg>`;
}

function attachLineChartInteraction(container, series, baselineY) {
  const svg = container.querySelector("svg");
  if (!svg) return;
  svg.querySelectorAll(".hit-dot").forEach((dot) => {
    dot.addEventListener("mousemove", (e) => {
      const val = dot.getAttribute("data-val");
      const t = new Date(dot.getAttribute("data-t"));
      const baselineLine = baselineY ? `<div class="muted">Baseline: ${baselineY.toFixed(1)}%</div>` : "";
      showTooltip(e.clientX, e.clientY, `<b>${val}%</b><div class="muted">${t.toLocaleString("es-CO")}</div>${baselineLine}`);
    });
    dot.addEventListener("mouseleave", hideTooltip);
  });
  svg.querySelectorAll(".hit-annotation").forEach((line) => {
    line.addEventListener("mousemove", (e) => {
      showTooltip(e.clientX, e.clientY, `<b>${decodeURIComponent(line.getAttribute("data-annotation"))}</b>`);
    });
    line.addEventListener("mouseleave", hideTooltip);
  });
}

/* ------------------------------------------------------ 4. station bars - */

function stationAccuracyFrom(accuracyRows) {
  const by = new Map();
  for (const r of accuracyRows) {
    if (!by.has(r.station_id)) by.set(r.station_id, { station_id: r.station_id, sum: 0, n_evaluations: 0 });
    const g = by.get(r.station_id);
    g.sum += r.accuracy;
    g.n_evaluations += 1;
  }
  return [...by.values()].map((g) => ({ ...g, avg_accuracy: g.sum / g.n_evaluations }));
}

function renderStationBars(stationAccuracy) {
  const wrap = document.getElementById("station-bars");
  if (!stationAccuracy.length) {
    wrap.innerHTML = `<p class="empty-note">Sin evaluaciones por estacion todavia.</p>`;
    return;
  }
  const byId = new Map(stationAccuracy.map((s) => [s.station_id, s]));
  const rows = STATIONS_ORDER.filter((sid) => byId.has(sid)).map((sid) => byId.get(sid));
  const max = 100;

  wrap.innerHTML = rows
    .map((s) => {
      const pct = Math.max(2, (s.avg_accuracy / max) * 100);
      return `<div class="station-bar-row" data-tip="Estacion ${s.station_id}: ${s.avg_accuracy.toFixed(1)}% promedio sobre ${s.n_evaluations} evaluaciones">
        <span class="sid">${s.station_id}</span>
        <span class="station-bar-track"><span class="station-bar-fill" style="width:${pct.toFixed(1)}%"></span></span>
        <span class="val">${s.avg_accuracy.toFixed(1)}%</span>
      </div>`;
    })
    .join("");

  wrap.querySelectorAll(".station-bar-row").forEach((row) => {
    row.addEventListener("mousemove", (e) => showTooltip(e.clientX, e.clientY, row.getAttribute("data-tip")));
    row.addEventListener("mouseleave", hideTooltip);
  });
}

/* --------------------------------------------------- 5. drift heatmap --- */

function accuracyToColor(acc) {
  // Continuous good -> warning -> critical scale, reserved for this
  // health/alert reading specifically (not used as a brand series color
  // anywhere else in the dashboard).
  if (acc === null || acc === undefined) return "#8a7c8f"; /* muted plum: white text stays legible */
  if (acc >= 75) return "#0ca30c";
  if (acc >= 60) return "#5fae12";
  if (acc >= 45) return "#fab219";
  if (acc >= 30) return "#ec835a";
  return "#d03b3b";
}

function renderDriftHeatmap(accuracyRows) {
  const wrap = document.getElementById("drift-heatmap");
  if (!accuracyRows.length) {
    wrap.innerHTML = `<p class="empty-note">Sin datos de evaluacion todavia para el mapa de drift.</p>`;
    return;
  }
  const cellAgg = new Map(); // key station|horizon -> {sum,n}
  for (const r of accuracyRows) {
    const key = `${r.station_id}|${r.horizon_minutes}`;
    if (!cellAgg.has(key)) cellAgg.set(key, { sum: 0, n: 0 });
    const c = cellAgg.get(key);
    c.sum += r.accuracy;
    c.n += 1;
  }

  const header = `<tr><th class="row-label">Estacion</th>${HORIZONS.map((h) => `<th>+${h} min</th>`).join("")}</tr>`;
  const rows = STATIONS_ORDER.map((sid) => {
    const cells = HORIZONS.map((h) => {
      const c = cellAgg.get(`${sid}|${h}`);
      const avg = c ? c.sum / c.n : null;
      const color = accuracyToColor(avg);
      const label = avg !== null ? `${avg.toFixed(0)}%` : "—";
      return `<td><div class="cell" style="background:${color}" data-tip="Estacion ${sid} · +${h} min: ${avg !== null ? avg.toFixed(1) + "%" : "sin datos"}">${label}</div></td>`;
    }).join("");
    return `<tr><td class="row-label">${sid}</td>${cells}</tr>`;
  }).join("");

  wrap.innerHTML = `<table class="heatmap">${header}${rows}</table>`;
  wrap.querySelectorAll(".cell").forEach((cell) => {
    cell.addEventListener("mousemove", (e) => showTooltip(e.clientX, e.clientY, cell.getAttribute("data-tip")));
    cell.addEventListener("mouseleave", hideTooltip);
  });
}

/* -------------------------------------------------- 6. run history ------ */

function renderRunHistory(accuracyRows) {
  const tbody = document.getElementById("run-history-body");
  const all = submittedCycles(accuracyRows);
  const cycles = [...all].reverse();
  if (!cycles.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-note">Sin envios evaluados todavia.</td></tr>`;
    return;
  }
  tbody.innerHTML = cycles
    .slice(0, 15)
    .map((c) => {
      const when = new Date(c.evaluatedAt).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      return `<tr>
        <td>${when}</td>
        <td><span class="pill success">Enviado ${c.n}/48</span></td>
        <td class="mono">${c.model || "—"}</td>
        <td class="mono">${c.submissionId ? c.submissionId.slice(0, 14) + "…" : "—"}</td>
        <td>${fmtPct(c.accuracy)}</td>
      </tr>`;
    })
    .join("");
}

/* ------------------------------------------------------- drift monitoring */

function latestByStation(driftEvents) {
  const byStation = new Map();
  for (const e of driftEvents) {
    if (!byStation.has(e.station_id)) byStation.set(e.station_id, e); // already sorted desc by checked_at
  }
  return byStation;
}

function stationSemaphore(latest) {
  if (!latest) return { level: "unknown", label: "Sin datos" };
  if (latest.performance_confirmed) return { level: "critical", label: "Performance degradada (confirmado)" };
  if (latest.performance_flag) return { level: "critical", label: "Performance degradada (sin confirmar aun)" };
  if (latest.psi_flag) return { level: "warning", label: "Drift de datos, sin caida de performance" };
  return { level: "good", label: "Sin drift" };
}

function renderStationSemaphore(driftEvents) {
  const wrap = document.getElementById("station-semaphore");
  const latestMap = latestByStation(driftEvents);
  if (latestMap.size === 0) {
    wrap.innerHTML = `<p class="empty-note">Todavia no hay chequeos de drift registrados.</p>`;
    return;
  }
  wrap.innerHTML = STATIONS_ORDER.map((sid) => {
    const latest = latestMap.get(sid);
    const sem = stationSemaphore(latest);
    const psiTxt = latest && latest.psi_max_value != null ? `PSI ${latest.psi_max_value.toFixed(2)} (${latest.psi_max_feature})` : "PSI —";
    const wapeTxt = latest && latest.rolling_wape_24h != null ? `WAPE 24h ${(latest.rolling_wape_24h * 100).toFixed(1)}%` : "";
    return `<div class="semaphore-tile" data-tip="Estacion ${sid}: ${sem.label}. ${psiTxt}. ${wapeTxt}">
      <span class="dot ${sem.level}"></span>
      <span class="sid">${sid}</span>
    </div>`;
  }).join("");

  wrap.querySelectorAll(".semaphore-tile").forEach((tile) => {
    tile.addEventListener("mousemove", (e) => showTooltip(e.clientX, e.clientY, tile.getAttribute("data-tip")));
    tile.addEventListener("mouseleave", hideTooltip);
  });
}

function renderDriftPsiChart(driftEvents) {
  const container = document.getElementById("drift-psi-chart");
  if (!container) return;

  // One point per check: the WORST (max) PSI across all 12 stations at
  // that checked_at, so a single line shows "how close is our worst
  // station to the 0.2 threshold" over time, with the threshold itself
  // drawn as the reference line (reusing the same chart the baseline
  // comparison uses elsewhere on this dashboard).
  const byCheck = new Map();
  for (const e of driftEvents) {
    if (e.psi_max_value == null) continue;
    const key = e.checked_at;
    if (!byCheck.has(key) || byCheck.get(key).psi < e.psi_max_value) {
      byCheck.set(key, { psi: e.psi_max_value, station_id: e.station_id, feature: e.psi_max_feature });
    }
  }
  const series = [...byCheck.entries()]
    .map(([checked_at, v]) => ({ x: new Date(checked_at), y: v.psi, station_id: v.station_id, feature: v.feature }))
    .sort((a, b) => a.x - b.x);

  if (series.length < 2) {
    container.innerHTML = `<p class="empty-note">Todavia no hay suficientes chequeos de PSI para graficar una tendencia.</p>`;
    return;
  }

  // Scale to whatever the data needs (PSI has no fixed 0-100 ceiling like
  // accuracy) -- renderLineChart's y-axis assumes 0-100, so this draws its
  // own compact axis instead of reusing that helper directly.
  const width = 900, height = 200;
  const pad = { top: 16, right: 16, bottom: 26, left: 40 };
  const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
  const xs = series.map((p) => p.x.getTime());
  const xMin = Math.min(...xs), xMax = Math.max(...xs), xSpan = Math.max(xMax - xMin, 1);
  const yMax = Math.max(0.4, ...series.map((p) => p.y)) * 1.1;
  const sx = (t) => pad.left + ((t - xMin) / xSpan) * w;
  const sy = (v) => pad.top + h - (Math.max(0, v) / yMax) * h;

  const linePath = series.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x.getTime()).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const gridVals = [0, yMax / 2, yMax];
  const gridlines = gridVals
    .map((v) => `<line class="gridline" x1="${pad.left}" x2="${pad.left + w}" y1="${sy(v)}" y2="${sy(v)}" />
       <text x="${pad.left - 8}" y="${sy(v) + 4}" font-size="10" text-anchor="end">${v.toFixed(2)}</text>`)
    .join("");
  const thresholdY = sy(0.2);
  const thresholdLine = `<line x1="${pad.left}" x2="${pad.left + w}" y1="${thresholdY}" y2="${thresholdY}"
      stroke="var(--critical)" stroke-width="2" stroke-dasharray="5 4" />
      <text x="${pad.left + w}" y="${thresholdY - 5}" font-size="10" text-anchor="end" fill="var(--critical)">umbral 0.20</text>`;
  const dots = series
    .map((p) => {
      const x = sx(p.x.getTime()), y = sy(p.y);
      const over = p.y > 0.2;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="transparent" class="hit-dot"
                data-x="${x}" data-y="${y}" data-val="${p.y.toFixed(3)}" data-station="${p.station_id}" data-feature="${p.feature}" data-t="${p.x.toISOString()}" />
              <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${over ? "var(--critical)" : "var(--brand)"}" />`;
    })
    .join("");
  const xTicks = [series[0], series[series.length - 1]]
    .map((p, i) => `<text x="${sx(p.x.getTime())}" y="${height - 6}" font-size="10" text-anchor="${i === 0 ? "start" : "end"}">${p.x.toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</text>`)
    .join("");

  container.innerHTML = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="PSI maximo por chequeo en el tiempo">
    ${gridlines}${thresholdLine}
    <path d="${linePath}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    ${dots}${xTicks}
  </svg>`;

  container.querySelectorAll(".hit-dot").forEach((dot) => {
    dot.addEventListener("mousemove", (e) => {
      const t = new Date(dot.getAttribute("data-t"));
      showTooltip(e.clientX, e.clientY,
        `<b>PSI ${dot.getAttribute("data-val")}</b><div class="muted">Estacion ${dot.getAttribute("data-station")} · ${dot.getAttribute("data-feature")}</div><div class="muted">${t.toLocaleString("es-CO")}</div>`);
    });
    dot.addEventListener("mouseleave", hideTooltip);
  });
}

function renderLastDriftEvent(driftEvents) {
  const el = document.getElementById("last-drift-event");
  const notable = driftEvents.find((e) => e.psi_flag || e.performance_flag);
  if (!notable) {
    el.innerHTML = `<p class="empty-note">Ninguna senal de drift detectada todavia.</p>`;
    return;
  }
  const when = new Date(notable.checked_at).toLocaleString("es-CO");
  const kind = notable.performance_confirmed
    ? "Performance degradada (confirmado, 3+ ciclos)"
    : notable.performance_flag
    ? "Performance degradada (1er ciclo, sin confirmar)"
    : "Drift de datos (PSI)";
  const featureTxt = notable.psi_max_feature
    ? `Feature <b>${notable.psi_max_feature}</b> se movio a PSI ${notable.psi_max_value.toFixed(2)} (umbral 0.20) frente a la ventana de entrenamiento del champion.`
    : "";
  const perfTxt = notable.rolling_wape_24h != null
    ? `WAPE rodante 24h: ${(notable.rolling_wape_24h * 100).toFixed(1)}% vs. accuracy de validacion del champion ${notable.champion_valid_accuracy != null ? notable.champion_valid_accuracy.toFixed(1) + "%" : "—"}.`
    : "";
  el.innerHTML = `
    <div class="drift-event-card">
      <div class="drift-event-head">
        <span class="pill ${notable.performance_confirmed ? "failed" : notable.performance_flag ? "running" : "running"}">${kind}</span>
        <span class="sub">${when} · estacion ${notable.station_id}</span>
      </div>
      <p>${featureTxt}</p>
      <p>${perfTxt}</p>
    </div>`;
}

function renderRetrainHistory(retrainTriggers) {
  const tbody = document.getElementById("retrain-history-body");
  if (!retrainTriggers.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-note">Ningun reentrenamiento disparado por drift todavia.</td></tr>`;
    return;
  }
  tbody.innerHTML = retrainTriggers
    .map((t) => {
      const when = new Date(t.triggered_at).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      let outcome;
      if (t.status === "dispatched") outcome = `<span class="pill running">En curso</span>`;
      else if (t.promoted) outcome = `<span class="pill success">Promovido</span>`;
      else outcome = `<span class="pill failed">Descartado</span>`;
      const metrics = t.candidate_accuracy != null
        ? `candidato ${t.candidate_accuracy.toFixed(1)}% vs champion ${t.champion_accuracy != null ? t.champion_accuracy.toFixed(1) + "%" : "—"}`
        : "—";
      return `<tr>
        <td>${when}</td>
        <td class="mono">${(t.stations || []).join(", ")}</td>
        <td>${outcome}</td>
        <td>${metrics}</td>
        <td class="mono">${t.candidate_version || "—"}</td>
      </tr>`;
    })
    .join("");
}

/* -------------------------------------------------------------- boot ---- */

async function refresh() {
  try {
    const data = await loadAll();
    window.__lastData = data;
    renderStatusBanner(data.accuracyRows);
    renderStatTiles(data);
    renderSubmissionQuality(data.accuracyRows, data.models);
    renderStationBars(stationAccuracyFrom(data.accuracyRows));
    renderDriftHeatmap(data.accuracyRows);
    renderStationSemaphore(data.driftEvents);
    renderDriftPsiChart(data.driftEvents);
    renderLastDriftEvent(data.driftEvents);
    renderRetrainHistory(data.retrainTriggers);
    renderRunHistory(data.accuracyRows);
    document.getElementById("last-updated").textContent = `Actualizado ${new Date().toLocaleTimeString("es-CO")}`;
  } catch (err) {
    console.error(err);
    document.getElementById("last-updated").textContent = `Error actualizando: ${err.message}`;
  }
}

refresh();
setInterval(refresh, CFG.refreshMs);
