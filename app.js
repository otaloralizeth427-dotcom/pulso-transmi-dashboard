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
  const [runs, models, accuracyRows, stationAccuracy, leaderboard, driftEvents, retrainTriggers] = await Promise.all([
    fetchView("v_pipeline_status", "&order=started_at.desc"),
    fetchView("v_model_state", "&order=trained_at.desc"),
    fetchView("v_accuracy_timeseries", "&order=computed_at.asc"),
    fetchView("v_station_accuracy"),
    fetchView("v_leaderboard_snapshots", "&order=checked_at.desc"),
    fetchView("v_drift_events", "&order=checked_at.desc&limit=200"),
    fetchView("v_retrain_triggers", "&order=triggered_at.desc"),
  ]);
  return { runs, models, accuracyRows, stationAccuracy, leaderboard, driftEvents, retrainTriggers };
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

function renderStatTiles({ runs, models, leaderboard, accuracyRows }) {
  const wrap = document.getElementById("stat-row");
  const active = models.find((m) => m.is_active) || models[0];
  const cumulative = latestByWindow(leaderboard, "cumulative");
  const rolling = latestByWindow(leaderboard, "rolling_24h");
  const successfulSubmissions = runs.filter((r) => r.status === "success" && parseNotes(r.notes).isSubmission).length;
  const last6 = last6CyclesApprox(accuracyRows);

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
    {
      eyebrow: "Ultimos 6 ciclos (aprox.)",
      value: last6 ? fmtPct(last6.accuracy) : "—",
      sub: last6 ? `Promedio de tus ultimos ${last6.n} ciclos enviados -- no es el numero oficial del portal` : "Sin ciclos evaluados todavia",
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
 * Main chart: the OFFICIAL accuracy history from /v1/leaderboard, exactly
 * as monitor.py recorded it over time -- this is the same number the
 * course portal shows (coverage-weighted, missed cycles count as zero).
 * It intentionally does NOT use accuracyRows/buildCycleSeries below, which
 * only average the cycles we actually submitted and read much higher --
 * plotting those on this chart looked like it contradicted the official
 * number shown one card up, which is why this got split out.
 */
function renderAccuracyChart({ models, leaderboard }) {
  const container = document.getElementById("accuracy-chart-svg");
  const windowKind = accuracyChartState.tab === "cumulative" ? "cumulative" : "rolling_24h";
  const snapshots = leaderboard
    .filter((l) => l.window_kind === windowKind)
    .map((l) => ({ x: new Date(l.checked_at), y: l.accuracy }))
    .sort((a, b) => a.x - b.x);

  if (snapshots.length === 0) {
    container.innerHTML = `<p class="empty-note">Todavia no hay lecturas del leaderboard oficial guardadas.</p>`;
    return;
  }
  if (snapshots.length === 1) {
    const only = snapshots[0];
    container.innerHTML = `<p class="empty-note">Solo hay una lectura oficial todavia: <b>${only.y.toFixed(1)}%</b>
      (${only.x.toLocaleString("es-CO")}). La curva se empieza a trazar con las siguientes corridas del pipeline.</p>`;
    return;
  }

  const active = models.find((m) => m.is_active);
  const baselineAccuracy = active?.metrics_summary?.baseline_accuracy ?? null;
  const annotations = retrainAndDriftAnnotations(models, leaderboard, snapshots[0].x, snapshots[snapshots.length - 1].x);

  container.innerHTML = renderLineChart({ series: snapshots, baselineY: baselineAccuracy, annotations, color: "var(--brand)" });
  attachLineChartInteraction(container, snapshots, baselineAccuracy);
}

/**
 * Secondary, clearly-separate diagnostic: average accuracy of the cycles we
 * actually submitted (nothing about coverage). Useful to see "is the model
 * itself still good" independent of how many cycles we caught.
 */
function renderSubmissionQuality(accuracyRows) {
  const container = document.getElementById("submission-quality-svg");
  if (!container) return;
  const points = buildCycleSeries(accuracyRows);
  if (points.length === 0) {
    container.innerHTML = `<p class="empty-note">Todavia no hay ciclos evaluados.</p>`;
    return;
  }
  const series = points.map((p) => ({ x: p.x, y: p.accuracy }));
  container.innerHTML = renderLineChart({ series, baselineY: null, annotations: [], color: "var(--brand-pink)", height: 180 });
  attachLineChartInteraction(container, series, null);
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
    renderSubmissionQuality(data.accuracyRows);
    renderStationBars(data.stationAccuracy);
    renderDriftHeatmap(data.accuracyRows);
    renderStationSemaphore(data.driftEvents);
    renderDriftPsiChart(data.driftEvents);
    renderLastDriftEvent(data.driftEvents);
    renderRetrainHistory(data.retrainTriggers);
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
