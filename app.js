const CFG = window.PTM_DASHBOARD_CONFIG;
const STATIONS_ORDER = ["02300", "03000", "05000", "05100", "06000", "06111", "07105", "07107", "07111", "09000", "09122", "10009"];
const HORIZONS = [15, 30, 45, 60];

/* ---------------------------------------------------------------- data -- */

async function fetchView(name, query = "") {
  const url = `${CFG.supabaseUrl}/rest/v1/${name}?select=*${query}`;
  const res = await fetch(url, {
    headers: { apikey: CFG.supabaseAnonKey, authorization: `Bearer ${CFG.supabaseAnonKey}` },
  });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
}

async function loadAll() {
  const [runs, models, accuracyRows, stationAccuracy, leaderboard] = await Promise.all([
    fetchView("v_pipeline_status", "&order=started_at.desc"),
    fetchView("v_model_state", "&order=trained_at.desc"),
    fetchView("v_accuracy_timeseries", "&order=computed_at.asc"),
    fetchView("v_station_accuracy"),
    fetchView("v_leaderboard_snapshots", "&order=checked_at.desc"),
  ]);
  return { runs, models, accuracyRows, stationAccuracy, leaderboard };
}

/* ------------------------------------------------------------- helpers -- */

function parseNotes(notes) {
  const submissionId = /submission_id=(\S+)/.exec(notes || "")?.[1] ?? null;
  const model = /model=(\S+?)(?:\s|$)/.exec(notes || "")?.[1] ?? null;
  const cycle = /cyc_[A-Za-z0-9_-]+/.exec(notes || "")?.[0] ?? null;
  const isSubmission = !!submissionId;
  return { submissionId, model, cycle, isSubmission };
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

function renderStatusBanner(runs) {
  const el = document.getElementById("status-banner");
  const lastRun = runs[0];
  const lastSubmission = runs.find((r) => parseNotes(r.notes).isSubmission && r.status === "success");

  if (!lastRun) {
    el.className = "status-banner state-warning";
    el.innerHTML = `<span class="status-dot warning"></span><div><div class="label">Sin datos todavia</div><div class="detail">El pipeline no ha registrado ninguna corrida.</div></div>`;
    return;
  }

  const healthy = lastRun.status === "success" && lastSubmission && (Date.now() - new Date(lastSubmission.started_at)) < 2 * 60 * 60 * 1000;
  el.className = `status-banner ${healthy ? "state-good" : "state-critical"}`;
  el.innerHTML = `
    <span class="status-dot ${healthy ? "good" : "critical"}"></span>
    <div>
      <div class="label">${healthy ? "Pipeline operativo" : "Revisar pipeline"}</div>
      <div class="detail">Ultima corrida: ${lastRun.status === "success" ? "exitosa" : "fallida"} ${timeAgo(lastRun.started_at)}
        &middot; Ultimo envio oficial: ${lastSubmission ? timeAgo(lastSubmission.started_at) : "ninguno registrado"}</div>
    </div>`;
}

/* ------------------------------------------------------- 2. stat tiles -- */

function renderStatTiles({ runs, models, leaderboard }) {
  const wrap = document.getElementById("stat-row");
  const active = models.find((m) => m.is_active) || models[0];
  const cumulative = latestByWindow(leaderboard, "cumulative");
  const rolling = latestByWindow(leaderboard, "rolling_24h");
  const successfulSubmissions = runs.filter((r) => r.status === "success" && parseNotes(r.notes).isSubmission).length;

  const tiles = [
    {
      eyebrow: "Champion actual",
      value: active ? active.model_version.replace("catboost-", "CatBoost ").replace("baseline-shift24h-v2", "Baseline 24h") : "—",
      sub: active ? `Champion desde ${timeAgo(active.trained_at)}` : "Sin modelo activo",
    },
    {
      eyebrow: "Cobertura (acumulada)",
      value: cumulative ? fmtPct(cumulative.coverage * 100) : "—",
      sub: `${successfulSubmissions} envios oficiales registrados`,
    },
    {
      eyebrow: "Leaderboard",
      value: cumulative ? `#${cumulative.rank}` : "—",
      sub: cumulative ? `${fmtPct(cumulative.accuracy)} acumulada` : "Sin datos del leaderboard",
    },
    {
      eyebrow: "Ultimas 24h",
      value: rolling ? fmtPct(rolling.accuracy) : "—",
      sub: rolling ? `Cobertura ${fmtPct(rolling.coverage * 100)}` : "Sin datos recientes",
      alert: rolling && cumulative && cumulative.accuracy - rolling.accuracy >= 5,
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

let accuracyChartState = { tab: "cumulative" };

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

function renderAccuracyChart({ accuracyRows, models, leaderboard }) {
  const container = document.getElementById("accuracy-chart-svg");
  const points = buildCycleSeries(accuracyRows);

  if (points.length === 0) {
    container.innerHTML = `<p class="empty-note">Todavia no hay ciclos evaluados para graficar.</p>`;
    return;
  }

  let series;
  if (accuracyChartState.tab === "cumulative") {
    let running = 0;
    series = points.map((p, i) => {
      running += p.accuracy;
      return { x: p.x, y: running / (i + 1) };
    });
  } else {
    const cutoff = new Date(points[points.length - 1].x.getTime() - 24 * 3600 * 1000);
    series = points.filter((p) => p.x >= cutoff).map((p) => ({ x: p.x, y: p.accuracy }));
    if (series.length === 0) series = points.slice(-1).map((p) => ({ x: p.x, y: p.accuracy }));
  }

  const active = models.find((m) => m.is_active);
  const baselineAccuracy = active?.metrics_summary?.baseline_accuracy ?? null;

  const retrainEvents = models
    .filter((m) => m.model_version.startsWith("catboost-"))
    .map((m) => ({ x: new Date(m.trained_at), label: `Reentrenado: ${m.model_version}` }));
  const driftEvents = leaderboard
    .filter((l) => l.signal === "performance_drift")
    .map((l) => ({ x: new Date(l.checked_at), label: "Drift detectado" }));
  const annotations = [...retrainEvents, ...driftEvents].filter(
    (a) => a.x >= series[0].x && a.x <= series[series.length - 1].x
  );

  container.innerHTML = renderLineChart({
    series,
    baselineY: baselineAccuracy,
    annotations,
    color: "var(--brand)",
    yLabel: "accuracy %",
  });
  attachLineChartInteraction(container, series, baselineAccuracy);
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

function renderRunHistory(runs) {
  const tbody = document.getElementById("run-history-body");
  if (!runs.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-note">Sin corridas registradas todavia.</td></tr>`;
    return;
  }
  tbody.innerHTML = runs
    .slice(0, 15)
    .map((r) => {
      const info = parseNotes(r.notes);
      const pillClass = r.status === "success" ? "success" : r.status === "running" ? "running" : "failed";
      const when = new Date(r.started_at).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      return `<tr>
        <td>${when}</td>
        <td><span class="pill ${pillClass}">${r.status === "success" ? "Exito" : r.status === "running" ? "En curso" : "Fallo"}</span></td>
        <td class="mono">${info.model || "—"}</td>
        <td class="mono">${info.submissionId ? info.submissionId.slice(0, 14) + "…" : "—"}</td>
      </tr>`;
    })
    .join("");
}

/* ------------------------------------------------------------- tabs ----- */

function wireTabs() {
  document.querySelectorAll("#accuracy-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#accuracy-tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      accuracyChartState.tab = btn.dataset.tab;
      if (window.__lastData) renderAccuracyChart(window.__lastData);
    });
  });
}

/* -------------------------------------------------------------- boot ---- */

async function refresh() {
  try {
    const data = await loadAll();
    window.__lastData = data;
    renderStatusBanner(data.runs);
    renderStatTiles(data);
    renderAccuracyChart(data);
    renderStationBars(data.stationAccuracy);
    renderDriftHeatmap(data.accuracyRows);
    renderRunHistory(data.runs);
    document.getElementById("last-updated").textContent = `Actualizado ${new Date().toLocaleTimeString("es-CO")}`;
  } catch (err) {
    console.error(err);
    document.getElementById("last-updated").textContent = `Error actualizando: ${err.message}`;
  }
}

wireTabs();
refresh();
setInterval(refresh, CFG.refreshMs);
