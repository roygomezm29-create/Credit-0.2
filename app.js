/* =============================================================================
   CREDIT — asistente de estabilidad financiera
   Versión PWA (HTML/JS puro, sin build, instalable en iPhone vía Safari)
============================================================================= */

/* ---------------------------- UTILIDADES ---------------------------- */
const fmt = (n) => {
  const v = Number(n) || 0;
  return v.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
};
const fmtDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("es-MX", { day: "numeric", month: "short" });
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const MONTH_NAMES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

function nextOccurrence(day, month, fromDate = new Date()) {
  const from = new Date(fromDate);
  from.setHours(0, 0, 0, 0);
  const safeDay = Math.min(Math.max(Number(day) || 1, 1), 31);
  const safeMonth = Math.min(Math.max(Number(month) || 1, 1), 12);
  let candidate = new Date(from.getFullYear(), safeMonth - 1, safeDay);
  let guard = 0;
  while (candidate < from && guard < 24) {
    candidate = new Date(candidate.getFullYear(), candidate.getMonth() + 1, safeDay);
    guard++;
  }
  return candidate.toISOString().slice(0, 10);
}

/* ---------------------------- SUPABASE ---------------------------- */
const SUPABASE_URL = "https://avanyngwglehvbajsqav.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2YW55bmd3Z2xlaHZiYWpzcWF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1MzAwNTksImV4cCI6MjEwMzEwNjA1OX0.4viJJaUL8edcd2nDfcTNHmfQ5n_bEbT7adP05rQ-iNI";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------------------------- ESTADO / PERSISTENCIA (Supabase) ---------------------------- */
const DEFAULT_STATE = {
  dineroTotalHistory: [],
  cards: [
    { id: uid(), name: "Tarjeta 1", limit: 30000, balance: 8000, cutDay: 5, cutMonth: 8, dueDay: 25, dueMonth: 8, minPaymentToAvoidInterest: 0, msi: [] },
  ],
  expenseCategories: ["Despensa", "Gasolina", "Medicina", "Escuela", "Amigos", "Novia", "Familia", "Personal"],
  transactions: [],
};

let state = structuredClone(DEFAULT_STATE);
let currentTab = "resumen";
let lastResult = null; // resultado del análisis "¿qué tarjeta uso?"
let currentUser = null; // sesión de Supabase Auth activa
let authMode = "signin"; // "signin" | "signup"
let authError = "";
let authInfo = "";
let authBusy = false;
let dataLoading = false;

/* Convierte una fila de "ingresos" (Supabase) al formato de dineroTotalHistory usado por la app */
function ingresoToLocal(row) {
  return { id: row.id, date: row.fecha, amount: Number(row.monto), type: row.tipo || undefined, delta: row.delta != null ? Number(row.delta) : undefined, note: row.nota || "" };
}
/* Convierte una fila de "egresos" (Supabase) al formato de transactions usado por la app */
function egresoToLocal(row) {
  return { id: row.id, date: row.fecha, amount: Number(row.monto), category: row.categoria, cardId: row.card_id || undefined, note: row.nota || "" };
}

async function loadStateFromSupabase() {
  const userId = currentUser.id;

  const [{ data: config, error: configErr }, { data: ingresos, error: ingErr }, { data: egresos, error: egErr }] = await Promise.all([
    sb.from("configuraciones").select("*").eq("user_id", userId).maybeSingle(),
    sb.from("ingresos").select("*").eq("user_id", userId).order("fecha", { ascending: true }),
    sb.from("egresos").select("*").eq("user_id", userId).order("fecha", { ascending: true }),
  ]);
  if (configErr) console.error("Error cargando configuraciones", configErr);
  if (ingErr) console.error("Error cargando ingresos", ingErr);
  if (egErr) console.error("Error cargando egresos", egErr);

  const merged = structuredClone(DEFAULT_STATE);
  if (config) {
    merged.cards = (config.tarjetas || merged.cards).map((c) => ({ ...c, cutMonth: c.cutMonth || 1, dueMonth: c.dueMonth || 1, msi: c.msi || [] }));
    merged.expenseCategories = config.categorias_gasto || merged.expenseCategories;
  } else {
    // Primer inicio de sesión de este usuario: crea su fila de configuraciones por defecto
    await sb.from("configuraciones").insert({ user_id: userId, tarjetas: merged.cards, categorias_gasto: merged.expenseCategories });
  }
  merged.dineroTotalHistory = (ingresos || []).map(ingresoToLocal);
  merged.transactions = (egresos || []).map(egresoToLocal);
  return merged;
}

/* Sincroniza el estado completo con Supabase.
   Estrategia: upsert de "configuraciones" (tarjetas/categorías) y reemplazo total
   de "ingresos"/"egresos" (borra e inserta) — sencillo y suficiente para el volumen
   de datos de un usuario individual de esta app. */
async function persistToSupabase(next) {
  if (!currentUser) return;
  const userId = currentUser.id;
  try {
    await sb.from("configuraciones").upsert(
      { user_id: userId, tarjetas: next.cards, categorias_gasto: next.expenseCategories, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );

    await sb.from("ingresos").delete().eq("user_id", userId);
    if (next.dineroTotalHistory.length) {
      await sb.from("ingresos").insert(
        next.dineroTotalHistory.map((e) => ({
          id: e.id, user_id: userId, fecha: e.date, monto: e.amount, tipo: e.type || null, delta: e.delta ?? null, nota: e.note || null,
        }))
      );
    }

    await sb.from("egresos").delete().eq("user_id", userId);
    if (next.transactions.length) {
      await sb.from("egresos").insert(
        next.transactions.map((t) => ({
          id: t.id, user_id: userId, fecha: t.date, monto: t.amount, categoria: t.category || null, card_id: t.cardId || null, nota: t.note || null,
        }))
      );
    }
  } catch (e) {
    console.error("Error guardando en Supabase", e);
  }
}

function saveState(next) {
  state = next;
  render(); // UI optimista: se refleja de inmediato, la persistencia ocurre en segundo plano
  persistToSupabase(next);
}

/* ---------------------------- LEDGER DE DINERO TOTAL ----------------------------
   Los registros de dineroTotalHistory conservan su forma original {id, date, amount, note}
   para no romper computeEngine ni la gráfica. Los nuevos registros añaden además
   "type" ('inicial' | 'suma' | 'resta') y "delta" para poder mostrarlos como
   operaciones y recalcular el saldo automáticamente al eliminar uno.
   Los registros antiguos (sin "type") se tratan como anclas de saldo absoluto,
   igual que siempre se comportaron. */
function recomputeDineroHistory(hist) {
  const sorted = [...hist].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.seq || 0) - (b.seq || 0);
  });
  let running = 0;
  sorted.forEach((e, i) => {
    if (e.type === "suma" || e.type === "resta") {
      running = e.type === "suma" ? running + (e.delta || 0) : running - (e.delta || 0);
      sorted[i] = { ...e, amount: running };
    } else {
      // ancla: 'inicial' o registro antiguo sin type (saldo absoluto)
      running = e.amount;
    }
  });
  return sorted;
}

function currentDineroTotal(hist) {
  const r = recomputeDineroHistory(hist);
  return r.length ? r[r.length - 1].amount : 0;
}

/* ---------------------------- MOTOR FINANCIERO ---------------------------- */
function computeEngine(state) {
  const hist = [...state.dineroTotalHistory].sort((a, b) => a.date.localeCompare(b.date));
  const dineroTotal = hist.length ? hist[hist.length - 1].amount : 0;

  const today = new Date();
  const findClosestBefore = (daysAgo) => {
    const target = new Date(today);
    target.setDate(target.getDate() - daysAgo);
    const targetISO = target.toISOString().slice(0, 10);
    const candidates = hist.filter((h) => h.date <= targetISO);
    return candidates.length ? candidates[candidates.length - 1].amount : null;
  };
  const week1 = findClosestBefore(7);
  const week4 = findClosestBefore(30);
  const deltaWeek = week1 !== null ? dineroTotal - week1 : null;
  const deltaMonth = week4 !== null ? dineroTotal - week4 : null;

  const weeklyPoints = [];
  for (let i = 8; i >= 0; i--) {
    const amt = findClosestBefore(i * 7);
    if (amt !== null) weeklyPoints.push(amt);
  }
  let decliningStreak = 0;
  for (let i = weeklyPoints.length - 1; i > 0; i--) {
    if (weeklyPoints[i] < weeklyPoints[i - 1]) decliningStreak++;
    else break;
  }

  const horizonDays = 30;
  const cardUpcoming = state.cards.map((card) => {
    const nextCut = nextOccurrence(card.cutDay, card.cutMonth);
    const nextDue = nextOccurrence(card.dueDay, card.dueMonth);
    const daysToCut = daysBetween(todayISO(), nextCut);
    const daysToDue = daysBetween(todayISO(), nextDue);
    const util = card.limit > 0 ? (card.balance / card.limit) * 100 : 0;
    const msiMonthlyTotal = (card.msi || []).reduce((s, m) => s + (m.monthsLeft > 0 ? m.monthly : 0), 0);
    const pagoProximo = Math.max(card.minPaymentToAvoidInterest || 0, msiMonthlyTotal);
    const financingDays = daysToDue >= 0 ? daysToDue : daysToDue + 30;
    return { ...card, nextCut, nextDue, daysToCut, daysToDue, util, msiMonthlyTotal, pagoProximo, financingDays };
  });

  const upcomingPaymentsSum = cardUpcoming.filter((c) => c.daysToDue <= horizonDays).reduce((s, c) => s + c.pagoProximo, 0);

  const avgMonthlySpend = (() => {
    if (!state.transactions.length) return 0;
    const byMonth = {};
    state.transactions.forEach((t) => {
      const m = t.date.slice(0, 7);
      byMonth[m] = (byMonth[m] || 0) + t.amount;
    });
    const months = Object.values(byMonth);
    return months.reduce((a, b) => a + b, 0) / months.length;
  })();

  const safetyMargin = Math.max(dineroTotal * 0.08, 300);
  const proratedSpend = avgMonthlySpend * (horizonDays / 30);
  let dineroUtilizable = dineroTotal - upcomingPaymentsSum - proratedSpend - safetyMargin;
  dineroUtilizable = Math.max(0, dineroUtilizable);

  const insights = [];
  if (deltaWeek !== null) {
    if (deltaWeek > 0) insights.push(`Tienes ${fmt(deltaWeek)} más que hace una semana.`);
    else if (deltaWeek < 0) insights.push(`Tienes ${fmt(Math.abs(deltaWeek))} menos que hace una semana.`);
  }
  if (deltaMonth !== null) {
    if (deltaMonth > 0) insights.push(`Este mes acumulaste ${fmt(deltaMonth)} más de lo que tenías hace 30 días.`);
    else if (deltaMonth < 0) insights.push(`Este mes tu dinero total bajó ${fmt(Math.abs(deltaMonth))} respecto a hace 30 días.`);
  }
  if (decliningStreak >= 2) insights.push(`Tu dinero total lleva ${decliningStreak} semanas consecutivas a la baja.`);
  if (avgMonthlySpend > 0 && state.transactions.length >= 4) insights.push(`Tu gasto promedio reciente es de ${fmt(avgMonthlySpend)} al mes.`);
  cardUpcoming.filter((c) => c.util >= 70).forEach((c) => insights.push(`${c.name} está al ${c.util.toFixed(0)}% de su límite — cerca del máximo recomendado.`));

  return { dineroTotal, hist, deltaWeek, deltaMonth, decliningStreak, cardUpcoming, upcomingPaymentsSum, avgMonthlySpend, safetyMargin, dineroUtilizable, insights };
}

function analizarGasto(engine, monto) {
  const u = engine.dineroUtilizable;
  let nivel, colorVar, mensaje;
  if (u <= 0) {
    nivel = "rojo"; colorVar = "var(--red)";
    mensaje = "Tu margen financiero actual está en cero o comprometido. No es buen momento para gastos no esenciales.";
  } else if (monto <= u * 0.6) {
    nivel = "verde"; colorVar = "var(--green)";
    mensaje = "Este gasto es cómodo dentro de tu capacidad actual y no compromete tus obligaciones proyectadas.";
  } else if (monto <= u) {
    nivel = "amarillo"; colorVar = "var(--amber)";
    mensaje = "Puedes realizar el gasto, pero reducirá tu margen financiero durante las próximas semanas.";
  } else if (monto <= u * 1.6) {
    nivel = "naranja"; colorVar = "var(--amber)";
    mensaje = "El gasto supera tu capacidad recomendada. Es viable solo usando crédito, con precaución y vigilando el impacto en pagos futuros.";
  } else {
    nivel = "rojo"; colorVar = "var(--red)";
    mensaje = "No recomiendo realizar este gasto actualmente: supera ampliamente tu capacidad financiera proyectada.";
  }

  const evaluatedCards = engine.cardUpcoming
    .map((card) => {
      const disponible = card.limit - card.balance;
      const utilTrasCompra = card.limit > 0 ? ((card.balance + monto) / card.limit) * 100 : 100;
      const puedeAbsorber = disponible >= monto;
      let score = 0;
      score += card.util * 1.2;
      score += Math.max(0, utilTrasCompra - card.util) * 0.8;
      score += (60 - Math.min(60, card.financingDays)) * 0.5;
      score += (card.pagoProximo / 1000) * 0.6;
      if (!puedeAbsorber) score += 500;
      let riesgo = "Bajo";
      if (utilTrasCompra >= 80 || !puedeAbsorber) riesgo = "Alto";
      else if (utilTrasCompra >= 50) riesgo = "Moderado";
      const estrellas = Math.max(1, 5 - Math.round(utilTrasCompra / 25));
      return { ...card, disponible, utilTrasCompra, puedeAbsorber, score, riesgo, estrellas };
    })
    .sort((a, b) => a.score - b.score);

  const mejor = evaluatedCards[0];
  const gastoMaxRecomendado = Math.round(u);
  return { nivel, colorVar, mensaje, evaluatedCards, mejor, gastoMaxRecomendado, dineroUtilizable: u, monto };
}

/* ---------------------------- ÍCONOS (glifos de texto, heredan color) ---------------------------- */
const ICO = { sparkle: "✦", wallet: "◧", down: "▾", card: "▤", next: "›", cal: "▦", alert: "▲", check: "✓", x: "✕", plus: "+", trash: "🗑", shield: "⛊", star: "★", starOff: "☆", up: "▲", flat: "–" };

function stars(n) {
  return `<span style="color:var(--amber);letter-spacing:1px;">${ICO.star.repeat(n)}${ICO.starOff.repeat(5 - n)}</span>`;
}

function trendIcon(delta) {
  if (delta === null || delta === undefined) return `<span class="dim">${ICO.flat}</span>`;
  if (delta > 0) return `<span style="color:var(--green)">▲</span>`;
  if (delta < 0) return `<span style="color:var(--red)">▼</span>`;
  return `<span class="dim">${ICO.flat}</span>`;
}

/* ---------------------------- GRÁFICA "EVOLUCIÓN DE DINERO TOTAL" (SVG, sin librerías) ---------------------------- */
const EVO_CHART_W = 640, EVO_CHART_H = 220;
function evolutionChartHTML(points) {
  if (points.length < 2) {
    return `<div class="empty" style="text-align:center;padding:30px 0;">Registra al menos dos actualizaciones de tu dinero total para ver la tendencia.</div>`;
  }
  const w = EVO_CHART_W, h = EVO_CHART_H, padL = 50, padR = 10, padT = 18, padB = 26;
  const values = points.map((p) => p.amount);
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const stepX = points.length > 1 ? (w - padL - padR) / (points.length - 1) : 0;
  const coords = points.map((p, i) => ({
    x: padL + i * stepX,
    y: padT + (1 - (p.amount - min) / range) * (h - padT - padB),
    date: p.date,
    amount: p.amount,
  }));
  const trendUp = points[points.length - 1].amount >= points[0].amount;
  const lineColor = trendUp ? "var(--green)" : "var(--red)";
  const path = coords.map((c, i) => (i === 0 ? `M${c.x},${c.y}` : `L${c.x},${c.y}`)).join(" ");
  const areaPath = `${path} L${coords[coords.length - 1].x},${h - padB} L${coords[0].x},${h - padB} Z`;
  const dots = coords
    .map((c, i) => `<circle class="evo-dot" data-idx="${i}" cx="${c.x}" cy="${c.y}" r="9" fill="transparent"/><circle data-idx="${i}" cx="${c.x}" cy="${c.y}" r="3.5" fill="${lineColor}" stroke="var(--panel)" stroke-width="1.2" style="pointer-events:none;"/>`)
    .join("");
  const labelIdxs = points.length <= 5 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const xLabels = labelIdxs
    .map((i) => `<text x="${coords[i].x}" y="${h - 8}" font-size="10" fill="var(--textDim)" text-anchor="${i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}" font-family="IBM Plex Mono, monospace">${fmtDate(points[i].date)}</text>`)
    .join("");
  const yTop = `<text x="${padL - 8}" y="${padT + 4}" font-size="10" fill="var(--textDim)" text-anchor="end" font-family="IBM Plex Mono, monospace">${fmt(max)}</text>`;
  const yBottom = `<text x="${padL - 8}" y="${h - padB}" font-size="10" fill="var(--textDim)" text-anchor="end" font-family="IBM Plex Mono, monospace">${fmt(min)}</text>`;

  return `
  <div style="position:relative;">
    <svg id="evo-chart-svg" viewBox="0 0 ${w} ${h}" style="width:100%;height:220px;display:block;touch-action:manipulation;" preserveAspectRatio="none">
      <defs>
        <linearGradient id="evoGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="${lineColor}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${h - padB}" stroke="var(--borderSoft)" stroke-width="1"/>
      <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="var(--borderSoft)" stroke-width="1"/>
      <path d="${areaPath}" fill="url(#evoGrad)" stroke="none"/>
      <path d="${path}" fill="none" stroke="${lineColor}" stroke-width="2.2" vector-effect="non-scaling-stroke"/>
      ${dots}
      ${yTop}${yBottom}${xLabels}
    </svg>
    <div id="evo-chart-tooltip" style="display:none;position:absolute;pointer-events:none;background:var(--panel2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;white-space:nowrap;transform:translate(-50%,-115%);z-index:5;"></div>
  </div>`;
}

function attachEvolutionChartTooltip(points) {
  const svg = document.getElementById("evo-chart-svg");
  const tooltip = document.getElementById("evo-chart-tooltip");
  if (!svg || !tooltip) return;
  const showFor = (idx) => {
    const p = points[idx];
    const dot = svg.querySelector(`circle.evo-dot[data-idx="${idx}"]`);
    if (!p || !dot) return;
    const rect = svg.getBoundingClientRect();
    const cx = Number(dot.getAttribute("cx"));
    const cy = Number(dot.getAttribute("cy"));
    const scaleX = rect.width / EVO_CHART_W;
    const scaleY = rect.height / EVO_CHART_H;
    tooltip.style.left = cx * scaleX + "px";
    tooltip.style.top = cy * scaleY + "px";
    tooltip.innerHTML = `<div class="mono" style="font-size:10px;color:var(--textDim);">${fmtDate(p.date)}</div><div class="mono" style="font-size:13px;">${fmt(p.amount)}</div>`;
    tooltip.style.display = "block";
  };
  svg.querySelectorAll("circle.evo-dot").forEach((dot) => {
    const idx = Number(dot.getAttribute("data-idx"));
    dot.addEventListener("pointerdown", (e) => { e.stopPropagation(); showFor(idx); });
    dot.addEventListener("mouseenter", () => showFor(idx));
  });
}

// Listener global único (no se re-registra en cada render) para ocultar el tooltip
// de la gráfica al tocar fuera de ella.
document.addEventListener("pointerdown", (e) => {
  const svg = document.getElementById("evo-chart-svg");
  const tooltip = document.getElementById("evo-chart-tooltip");
  if (svg && tooltip && !svg.contains(e.target)) tooltip.style.display = "none";
});

/* ---------------------------- COMPONENTES DE FORMULARIO (helpers de marcado) ---------------------------- */
const numField = (id, placeholder = "0", value = "") =>
  `<div class="field-prefix"><span>$</span><input class="num" type="number" id="${id}" placeholder="${placeholder}" value="${value}"></div>`;

const dayMonthField = (dayId, monthId, day, month) =>
  `<div style="display:flex;gap:8px;">
    <div style="width:80px;flex-shrink:0;"><input class="num" type="number" id="${dayId}" value="${day}" min="1" max="31"></div>
    <select id="${monthId}" style="flex:1;min-width:0;">
      ${MONTH_NAMES.map((m, i) => `<option value="${i + 1}" ${month == i + 1 ? "selected" : ""}>${m}</option>`).join("")}
    </select>
  </div>`;

/* ---------------------------- PESTAÑA: RESUMEN ---------------------------- */
function renderResumen(state, engine) {
  const chartData = engine.hist.map((h) => ({ date: h.date, amount: h.amount }));
  const gaugePct = engine.dineroTotal > 0 ? Math.min(100, (engine.dineroUtilizable / engine.dineroTotal) * 100) : 0;

  return `
  <div class="stack">
    <div class="grid2">
      <div class="panel">
        <div class="label">Dinero total</div>
        <div class="mono" style="font-size:32px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
          ${fmt(engine.dineroTotal)}
          <span style="font-size:13px;display:flex;align-items:center;gap:4px;color:${engine.deltaWeek > 0 ? "var(--green)" : engine.deltaWeek < 0 ? "var(--red)" : "var(--textDim)"};">
            ${trendIcon(engine.deltaWeek)} ${engine.deltaWeek !== null ? fmt(Math.abs(engine.deltaWeek)) + " / 7d" : "sin dato previo"}
          </span>
        </div>
      </div>
      <div class="panel">
        <div class="label">Dinero realmente utilizable</div>
        <div class="mono" style="font-size:32px;color:var(--amber);">${fmt(engine.dineroUtilizable)}</div>
        <div style="margin-top:10px;height:6px;background:var(--panel2);border-radius:4px;overflow:hidden;">
          <div style="width:${gaugePct}%;height:100%;background:var(--amber);border-radius:4px;"></div>
        </div>
        <div class="dim" style="font-size:11px;margin-top:6px;">considera pagos próximos, gastos recurrentes estimados y margen de seguridad</div>
      </div>
    </div>

    <div class="panel">
      <div class="label">Evolución de dinero total</div>
      ${evolutionChartHTML(chartData)}
    </div>

    <div class="panel">
      <div class="label">Observaciones</div>
      ${engine.insights.length === 0
        ? `<div class="empty">Aún no hay suficiente información para generar observaciones.</div>`
        : `<div class="stack" style="gap:8px;">${engine.insights.map((ins) => `<div style="display:flex;gap:8px;align-items:flex-start;font-size:13px;"><span style="color:var(--amber);">${ICO.sparkle}</span>${esc(ins)}</div>`).join("")}</div>`}
    </div>

    <div class="grid3">
      ${engine.cardUpcoming.map((c) => `
        <div class="panel" style="padding:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:13px;font-weight:500;">${esc(c.name)}</span>
            ${c.util >= 70 ? `<span style="color:var(--red);">${ICO.shield}</span>` : ""}
          </div>
          <div class="mono" style="font-size:20px;margin-top:4px;">${c.util.toFixed(0)}%</div>
          <div class="dim" style="font-size:11px;">utilización · vence ${fmtDate(c.nextDue)}</div>
        </div>
      `).join("")}
    </div>
  </div>`;
}

/* ---------------------------- PESTAÑA: DINERO TOTAL ---------------------------- */
function renderDinero(state, engine) {
  const hasHistory = state.dineroTotalHistory.length > 0;
  const sortedHist = [...recomputeDineroHistory(state.dineroTotalHistory)].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return (b.seq || 0) - (a.seq || 0);
  });

  const opLabel = (e) => {
    if (e.type === "inicial") return `<span class="dim">Saldo inicial</span>`;
    if (e.type === "suma") return `<span class="mono" style="color:var(--green);">+ ${fmt(e.delta)}</span>`;
    if (e.type === "resta") return `<span class="mono" style="color:var(--red);">− ${fmt(e.delta)}</span>`;
    return `<span class="mono">${fmt(e.amount)}</span>`; // registro antiguo (saldo absoluto)
  };

  return `
  <div class="stack">
    ${!hasHistory ? `
    <div class="panel">
      <div class="label">Establecer dinero inicial</div>
      <div class="flex-wrap">
        <div style="width:160px;">${numField("dt-init-amount", "0")}</div>
        <div style="flex:1;min-width:160px;"><input type="text" id="dt-init-note" placeholder="Nota (opcional)"></div>
        <button class="btn btn-primary" id="dt-init-set">${ICO.plus} Establecer</button>
      </div>
      <div class="dim" style="font-size:11px;margin-top:8px;">Ingresa tu dinero total actual una sola vez. A partir de aquí solo sumarás o restarás movimientos, como en una calculadora.</div>
    </div>
    ` : `
    <div class="panel">
      <div class="label">Dinero total actual</div>
      <div class="mono" style="font-size:32px;">${fmt(engine.dineroTotal)}</div>
    </div>
    <div class="panel">
      <div class="label">Registrar movimiento</div>
      <div class="flex-wrap">
        <div style="width:150px;">${numField("dt-op-amount", "0")}</div>
        <div style="flex:1;min-width:150px;"><input type="text" id="dt-op-note" placeholder="Nota (opcional)"></div>
        <button class="btn" id="dt-op-subtract" style="border-color:var(--red);color:var(--red);">− Restar</button>
        <button class="btn btn-primary" id="dt-op-add">+ Sumar</button>
      </div>
      <div class="dim" style="font-size:11px;margin-top:8px;">Registra solo el movimiento (por ejemplo, − $750) y el saldo se actualiza automáticamente, con fecha de hoy (${fmtDate(todayISO())}).</div>
    </div>
    `}

    <div class="panel">
      <div class="label">Historial</div>
      ${sortedHist.length === 0 ? `<div class="empty">Sin registros todavía.</div>` :
        `<div>
          ${sortedHist.map((e) => `
            <div class="row">
              <div>
                <div style="font-size:14px;">${opLabel(e)}</div>
                <div class="dim" style="font-size:11px;">${fmtDate(e.date)}${e.note ? " · " + esc(e.note) : ""} · saldo tras esto: <span class="mono">${fmt(e.amount)}</span></div>
              </div>
              <button class="btn btn-ghost" data-remove-entry="${e.id}">${ICO.trash}</button>
            </div>
          `).join("")}
        </div>`}
    </div>
  </div>`;
}

/* ---------------------------- PESTAÑA: GASTOS ---------------------------- */
function renderGastos(state) {
  const used = state.transactions.map((t) => t.category);
  const knownCategories = Array.from(new Set([...(state.expenseCategories || []), ...used])).filter(Boolean);
  const recentTx = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);

  return `
  <div class="stack">
    <div class="panel">
      <div class="label">Registrar un gasto</div>
      <div class="flex-wrap">
        <div style="width:130px;">${numField("tx-amount")}</div>
        <div style="width:170px;">
          <input list="categorias-gasto" id="tx-category" placeholder="Categoría o descripción">
          <datalist id="categorias-gasto">${knownCategories.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
        </div>
        <div><input type="date" id="tx-date" value="${todayISO()}"></div>
        <div><select id="tx-card">${state.cards.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
        <div style="width:150px;"><input type="text" id="tx-note" placeholder="Nota (opcional)"></div>
        <button class="btn btn-primary" id="tx-add">${ICO.plus} Registrar</button>
      </div>
      <div class="dim" style="font-size:11px;margin-top:8px;">Escribe la categoría que quieras (puedes reutilizar una existente o crear una nueva). El gasto se suma automáticamente al saldo de la tarjeta elegida.</div>
    </div>

    <div class="panel">
      <div class="label">Movimientos recientes</div>
      ${recentTx.length === 0 ? `<div class="empty">Sin movimientos registrados.</div>` :
        `<div>
          ${recentTx.map((t) => {
            const card = state.cards.find((c) => c.id === t.cardId);
            return `
              <div class="row" style="font-size:13px;">
                <div>
                  <span>${esc(t.category)}</span>
                  <span class="dim"> · ${card ? esc(card.name) : "—"} · ${fmtDate(t.date)}${t.note ? " · " + esc(t.note) : ""}</span>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <span class="mono">${fmt(t.amount)}</span>
                  <button class="btn btn-ghost" data-remove-tx="${t.id}">${ICO.trash}</button>
                </div>
              </div>`;
          }).join("")}
        </div>`}
    </div>
  </div>`;
}

/* ---------------------------- PESTAÑA: TARJETAS ---------------------------- */
function renderTarjetas(state, engine) {
  return `
  <div class="stack">
    <div class="panel" style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div class="label" style="margin-bottom:2px;">Tus tarjetas</div>
        <div class="dim" style="font-size:11px;">${state.cards.length} tarjeta${state.cards.length === 1 ? "" : "s"} registrada${state.cards.length === 1 ? "" : "s"}</div>
      </div>
      <button class="btn btn-primary" id="add-card-btn">${ICO.plus} Agregar tarjeta</button>
    </div>

    ${state.cards.map((card) => {
      const upcoming = engine.cardUpcoming.find((c) => c.id === card.id);
      return `
      <div class="panel" data-card-panel="${card.id}">
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;">
          <input type="text" data-card-field="name" data-card-id="${card.id}" value="${esc(card.name)}" style="flex:1;">
          <button class="btn btn-ghost" data-delete-card="${card.id}" title="Eliminar tarjeta" style="color:var(--red);flex-shrink:0;">${ICO.trash}</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div><div class="label">Límite</div>${numField(`card-limit-${card.id}`, "0", card.limit)}</div>
          <div><div class="label">Saldo actual</div>${numField(`card-balance-${card.id}`, "0", card.balance)}</div>
          <div style="grid-column:1/-1;">
            <div class="label">Fecha de corte</div>
            ${dayMonthField(`card-cutday-${card.id}`, `card-cutmonth-${card.id}`, card.cutDay, card.cutMonth)}
          </div>
          <div style="grid-column:1/-1;">
            <div class="label">Fecha límite de pago</div>
            ${dayMonthField(`card-dueday-${card.id}`, `card-duemonth-${card.id}`, card.dueDay, card.dueMonth)}
          </div>
          <div style="grid-column:1/-1;">
            <div class="label">Pago requerido para evitar intereses (próximo corte)</div>
            ${numField(`card-minpay-${card.id}`, "0", card.minPaymentToAvoidInterest)}
          </div>
        </div>
        <button class="btn" data-save-card="${card.id}" style="margin-top:12px;">Guardar cambios de la tarjeta</button>


        <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--borderSoft);">
          <div class="label">Ajustar saldo (suma/resta rápida)</div>
          <div class="flex-wrap">
            <div style="width:130px;">${numField(`card-adj-${card.id}`, "0")}</div>
            <button class="btn" data-card-subtract="${card.id}" style="border-color:var(--red);color:var(--red);">− Restar</button>
            <button class="btn btn-primary" data-card-add="${card.id}">+ Sumar</button>
          </div>
          <div class="dim" style="font-size:11px;margin-top:6px;">Registra una compra o un pago directamente sobre el saldo, sin tener que reescribirlo completo.</div>
        </div>

        <div style="margin-top:14px;display:flex;gap:16px;font-size:12px;flex-wrap:wrap;" class="muted">
          <span>Disponible: <b class="mono" style="color:var(--text);">${fmt(card.limit - card.balance)}</b></span>
          <span>Utilización: <b class="mono" style="color:${upcoming.util >= 70 ? "var(--red)" : "var(--text)"};">${upcoming.util.toFixed(0)}%</b></span>
          <span>Corte: ${fmtDate(upcoming.nextCut)}</span>
          <span>Vence: ${fmtDate(upcoming.nextDue)}</span>
        </div>

        <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--borderSoft);">
          <div class="label">Compras a MSI</div>
          ${(card.msi || []).length === 0 ? `<div class="dim" style="font-size:12px;margin-bottom:8px;">Sin compras a meses sin intereses.</div>` : ""}
          ${(card.msi || []).map((m) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:12px;">
              <span>${esc(m.desc)} · ${m.monthsLeft} meses restantes</span>
              <span style="display:flex;align-items:center;gap:8px;">
                <span class="mono" style="color:var(--amber);">${fmt(m.monthly)}/mes</span>
                <button class="btn btn-ghost" data-remove-msi-card="${card.id}" data-remove-msi="${m.id}">${ICO.trash}</button>
              </span>
            </div>
          `).join("")}
          <div class="flex-wrap" style="margin-top:8px;">
            <div style="width:100px;"><input type="text" id="msi-desc-${card.id}" placeholder="Descripción"></div>
            <div style="width:85px;">${numField(`msi-total-${card.id}`, "Total")}</div>
            <div style="width:60px;"><input class="num" type="number" id="msi-months-${card.id}" placeholder="Meses"></div>
            <div style="width:75px;">${numField(`msi-fee-${card.id}`, "Comisión")}</div>
            <button class="btn" data-add-msi="${card.id}">${ICO.plus}</button>
          </div>
        </div>
      </div>`;
    }).join("")}
  </div>`;
}

/* ---------------------------- PESTAÑA: ¿QUÉ TARJETA USO? ---------------------------- */
function renderQueTarjeta(state, engine) {
  const nivelIcon = { verde: ICO.check, amarillo: ICO.alert, naranja: ICO.alert, rojo: ICO.x };
  const r = lastResult;

  return `
  <div class="stack">
    <div class="panel">
      <div class="label">¿Qué tarjeta uso?</div>
      <div class="display" style="font-size:18px;margin-bottom:12px;">Voy a gastar...</div>
      <div class="flex-wrap">
        <div style="width:180px;">${numField("qt-monto")}</div>
        <button class="btn btn-primary" id="qt-analizar">${ICO.next} Analizar</button>
      </div>
    </div>

    ${r ? `
      <div class="panel" style="border-left:3px solid ${r.colorVar};">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <span style="color:${r.colorVar};font-size:18px;flex-shrink:0;">${nivelIcon[r.nivel]}</span>
          <div>
            <div style="font-size:14px;line-height:1.5;">${esc(r.mensaje)}</div>
            <div class="muted" style="font-size:12px;margin-top:8px;">Gasto máximo recomendado actualmente: <b class="mono" style="color:var(--text);">${fmt(r.gastoMaxRecomendado)}</b></div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="label">Comparativa de tarjetas</div>
        <div class="stack" style="gap:10px;">
          ${r.evaluatedCards.map((c, i) => `
            <div style="padding:14px;border-radius:8px;background:${i === 0 ? "var(--amberSoft)" : "var(--panel2)"};border:1px solid ${i === 0 ? "var(--amber)" : "var(--border)"};">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="font-size:14px;font-weight:500;">${i === 0 ? "★ " : ""}${esc(c.name)}</span>
                ${stars(c.estrellas)}
              </div>
              <div style="display:flex;gap:16px;margin-top:8px;font-size:12px;flex-wrap:wrap;" class="muted">
                <span>Utilización tras compra: <b class="mono" style="color:${c.utilTrasCompra >= 70 ? "var(--red)" : "var(--text)"};">${c.utilTrasCompra.toFixed(0)}%</b></span>
                <span>Riesgo: <b style="color:${c.riesgo === "Alto" ? "var(--red)" : c.riesgo === "Moderado" ? "var(--amber)" : "var(--green)"};">${c.riesgo}</b></span>
                <span>Días de financiamiento: <b style="color:var(--text);">${c.financingDays}</b></span>
                <span>Pago próximo: <b class="mono" style="color:var(--text);">${fmt(c.pagoProximo)}</b></span>
              </div>
            </div>
          `).join("")}
        </div>
        ${r.mejor ? `<div style="margin-top:14px;font-size:13px;line-height:1.5;"><b>Recomendación: ${esc(r.mejor.name)}.</b> ${r.nivel === "rojo" ? " Aunque tienes crédito disponible, esta es la tarjeta de menor riesgo si decides continuar; considera posponer el gasto." : " Ofrece la mejor combinación de utilización baja, pago próximo manejable y periodo de financiamiento favorable."}</div>` : ""}
      </div>
    ` : ""}

    <div class="panel">
      <div class="label">Simulador de meses sin intereses</div>
      <div class="flex-wrap">
        <div style="width:130px;">${numField("msi-sim-monto", "Total")}</div>
        <div style="width:90px;"><input class="num" type="number" id="msi-sim-meses" value="12" placeholder="Meses"></div>
        <div style="width:110px;">${numField("msi-sim-comision", "Comisión")}</div>
        <button class="btn" id="msi-sim-calc">Calcular</button>
      </div>
      <div id="msi-sim-result"></div>
      <div class="dim" style="font-size:11px;margin-top:10px;">Recuerda: una compra a MSI es una obligación futura, no dinero gratis. Se registrará contra la tarjeta que elijas en la pestaña "Tarjetas".</div>
    </div>
  </div>`;
}

/* ---------------------------- PESTAÑA: CALENDARIO ---------------------------- */
function renderCalendario(state, engine) {
  const events = [];
  engine.cardUpcoming.forEach((c) => {
    events.push({ date: c.nextCut, label: `Corte — ${c.name}`, type: "corte" });
    events.push({ date: c.nextDue, label: `Pago límite — ${c.name} (${fmt(c.pagoProximo)})`, type: "pago" });
    (c.msi || []).forEach((m) => {
      if (m.monthsLeft > 0) events.push({ date: c.nextDue, label: `MSI: ${m.desc} — ${fmt(m.monthly)}`, type: "msi" });
    });
  });
  events.sort((a, b) => a.date.localeCompare(b.date));
  const typeColor = { corte: "var(--blueGrey)", pago: "var(--red)", msi: "var(--amber)" };

  const dailyBurn = engine.avgMonthlySpend / 30;
  const proj = [30, 60, 90].map((d) => {
    const paymentsInWindow = engine.cardUpcoming.reduce((s, c) => s + (c.daysToDue <= d ? c.pagoProximo : 0), 0);
    return { d, value: engine.dineroTotal - dailyBurn * d - paymentsInWindow };
  });

  return `
  <div class="stack">
    <div class="panel">
      <div class="label">Proyección financiera</div>
      <div class="grid3">
        ${proj.map((p) => `
          <div style="padding:14px;background:var(--panel2);border-radius:8px;text-align:center;">
            <div class="dim" style="font-size:11px;">en ${p.d} días</div>
            <div class="mono" style="font-size:18px;margin-top:4px;color:${p.value < 0 ? "var(--red)" : "var(--text)"};">${fmt(p.value)}</div>
          </div>
        `).join("")}
      </div>
      <div class="dim" style="font-size:11px;margin-top:10px;">Estimación si mantienes tu ritmo de gasto actual, considerando pagos de tarjetas ya programados.</div>
    </div>

    <div class="panel">
      <div class="label">Próximos eventos financieros</div>
      ${events.length === 0 ? `<div class="empty">Sin eventos próximos.</div>` :
        `<div>
          ${events.map((e) => `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--borderSoft);">
              <div style="width:8px;height:8px;border-radius:50%;background:${typeColor[e.type]};flex-shrink:0;"></div>
              <div class="mono muted" style="width:60px;font-size:12px;">${fmtDate(e.date)}</div>
              <div style="font-size:13px;">${esc(e.label)}</div>
            </div>
          `).join("")}
        </div>`}
    </div>
  </div>`;
}

/* ---------------------------- APP PRINCIPAL / RENDER ---------------------------- */
/* ---------------------------- AUTENTICACIÓN ---------------------------- */
async function handleSignUp(email, password) {
  authError = ""; authInfo = ""; authBusy = true; renderAuth();
  const { data, error } = await sb.auth.signUp({ email, password });
  authBusy = false;
  if (error) { authError = error.message; renderAuth(); return; }
  if (data.session) {
    // confirmación de correo desactivada: sesión iniciada de inmediato
    await bootAfterLogin(data.session.user);
  } else {
    authInfo = "Cuenta creada. Revisa tu correo para confirmar tu cuenta y luego inicia sesión.";
    authMode = "signin";
    renderAuth();
  }
}

async function handleSignIn(email, password) {
  authError = ""; authInfo = ""; authBusy = true; renderAuth();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  authBusy = false;
  if (error) { authError = error.message; renderAuth(); return; }
  await bootAfterLogin(data.session.user);
}

async function handleSignOut() {
  await sb.auth.signOut();
  currentUser = null;
  state = structuredClone(DEFAULT_STATE);
  renderAuth();
}

async function bootAfterLogin(user) {
  currentUser = user;
  dataLoading = true;
  renderAuth();
  state = await loadStateFromSupabase();
  dataLoading = false;
  render();
}

function renderAuth() {
  const app = document.getElementById("app");
  if (dataLoading) {
    app.innerHTML = `<div class="auth-wrap"><div class="auth-box"><div class="auth-title">Credit</div><div class="auth-subtitle">Cargando tus datos…</div></div></div>`;
    return;
  }
  const isSignUp = authMode === "signup";
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-box">
        <div class="auth-title">Credit</div>
        <div class="auth-subtitle">${isSignUp ? "Crea tu cuenta" : "Inicia sesión"}</div>
        <div class="stack">
          <div>
            <div class="label">Correo</div>
            <input id="auth-email" type="email" placeholder="tucorreo@ejemplo.com" autocomplete="username" />
          </div>
          <div>
            <div class="label">Contraseña</div>
            <input id="auth-password" type="password" placeholder="••••••••" autocomplete="${isSignUp ? "new-password" : "current-password"}" />
          </div>
          <button id="auth-submit" class="btn btn-primary btn-block" ${authBusy ? "disabled" : ""}>
            ${authBusy ? "Procesando…" : isSignUp ? "Crear cuenta" : "Entrar"}
          </button>
        </div>
        ${authError ? `<div class="auth-error">${esc(authError)}</div>` : ""}
        ${authInfo ? `<div class="auth-info">${esc(authInfo)}</div>` : ""}
        <div class="auth-switch">
          ${isSignUp ? "¿Ya tienes cuenta?" : "¿No tienes cuenta todavía?"}
          <a id="auth-toggle">${isSignUp ? "Inicia sesión" : "Regístrate"}</a>
        </div>
      </div>
    </div>`;

  document.getElementById("auth-submit").addEventListener("click", () => {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    if (!email || !password) { authError = "Ingresa correo y contraseña."; renderAuth(); return; }
    if (isSignUp) handleSignUp(email, password);
    else handleSignIn(email, password);
  });
  document.getElementById("auth-toggle").addEventListener("click", () => {
    authMode = isSignUp ? "signin" : "signup";
    authError = ""; authInfo = "";
    renderAuth();
  });
}

const TABS = [
  { id: "resumen", label: "Resumen" },
  { id: "dinero", label: "Dinero total" },
  { id: "gastos", label: "Gastos" },
  { id: "tarjetas", label: "Tarjetas" },
  { id: "quetarjeta", label: "¿Qué tarjeta uso?" },
  { id: "calendario", label: "Calendario" },
];

function render() {
  // Preserva la posición de scroll: al reemplazar #app.innerHTML el navegador
  // puede perder el foco del elemento eliminado y saltar hasta el inicio de
  // la página. Guardamos y restauramos la posición para evitar ese salto.
  const scrollY = window.scrollY;

  const engine = computeEngine(state);
  const app = document.getElementById("app");

  let body = "";
  if (currentTab === "resumen") body = renderResumen(state, engine);
  else if (currentTab === "dinero") body = renderDinero(state, engine);
  else if (currentTab === "gastos") body = renderGastos(state);
  else if (currentTab === "tarjetas") body = renderTarjetas(state, engine);
  else if (currentTab === "quetarjeta") body = renderQueTarjeta(state, engine);
  else if (currentTab === "calendario") body = renderCalendario(state, engine);

  app.innerHTML = `
    <div class="header">
      <button id="logout-btn" class="btn btn-ghost logout-btn" title="Cerrar sesión">Salir</button>
      <div class="title">Credit</div>
      <div class="subtitle">${currentUser?.email ? esc(currentUser.email) : "tu asistente de estabilidad financiera"}</div>
    </div>
    <div class="tabs">
      ${TABS.map((t) => `<button class="tab-btn ${t.id === currentTab ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
    </div>
    ${body}
  `;

  attachHandlers();

  if (currentTab === "resumen") {
    attachEvolutionChartTooltip(engine.hist.map((h) => ({ date: h.date, amount: h.amount })));
  }

  window.scrollTo(0, scrollY);
  requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

/* ---------------------------- MANEJADORES DE EVENTOS ---------------------------- */
function attachHandlers() {
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", handleSignOut);

  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTab = btn.getAttribute("data-tab");
      render();
    });
  });

  // --- Dinero total ---
  const dtInitSet = document.getElementById("dt-init-set");
  if (dtInitSet) {
    dtInitSet.addEventListener("click", () => {
      const amount = document.getElementById("dt-init-amount").value;
      const note = document.getElementById("dt-init-note").value;
      if (amount === "" || isNaN(amount)) return;
      const entry = { id: uid(), date: todayISO(), seq: Date.now(), type: "inicial", amount: Number(amount), note };
      const newHist = recomputeDineroHistory([...state.dineroTotalHistory, entry]);
      saveState({ ...state, dineroTotalHistory: newHist });
    });
  }
  const dtOpAdd = document.getElementById("dt-op-add");
  if (dtOpAdd) {
    dtOpAdd.addEventListener("click", () => {
      const amount = document.getElementById("dt-op-amount").value;
      const note = document.getElementById("dt-op-note").value;
      if (amount === "" || isNaN(amount) || Number(amount) === 0) return;
      const entry = { id: uid(), date: todayISO(), seq: Date.now(), type: "suma", delta: Math.abs(Number(amount)), note };
      const newHist = recomputeDineroHistory([...state.dineroTotalHistory, entry]);
      saveState({ ...state, dineroTotalHistory: newHist });
    });
  }
  const dtOpSubtract = document.getElementById("dt-op-subtract");
  if (dtOpSubtract) {
    dtOpSubtract.addEventListener("click", () => {
      const amount = document.getElementById("dt-op-amount").value;
      const note = document.getElementById("dt-op-note").value;
      if (amount === "" || isNaN(amount) || Number(amount) === 0) return;
      const entry = { id: uid(), date: todayISO(), seq: Date.now(), type: "resta", delta: Math.abs(Number(amount)), note };
      const newHist = recomputeDineroHistory([...state.dineroTotalHistory, entry]);
      saveState({ ...state, dineroTotalHistory: newHist });
    });
  }
  document.querySelectorAll("[data-remove-entry]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-remove-entry");
      const filtered = state.dineroTotalHistory.filter((e) => e.id !== id);
      const newHist = recomputeDineroHistory(filtered);
      saveState({ ...state, dineroTotalHistory: newHist });
    });
  });

  // --- Gastos ---
  const txAdd = document.getElementById("tx-add");
  if (txAdd) {
    txAdd.addEventListener("click", () => {
      const txAmount = document.getElementById("tx-amount").value;
      const txCategory = document.getElementById("tx-category").value;
      const txDate = document.getElementById("tx-date").value;
      const txCard = document.getElementById("tx-card").value;
      const txNote = document.getElementById("tx-note").value;
      if (txAmount === "" || isNaN(txAmount) || !txCategory.trim()) return;
      const tx = { id: uid(), date: txDate, amount: Number(txAmount), category: txCategory.trim(), cardId: txCard, note: txNote };
      const cards = state.cards.map((c) => (c.id === txCard ? { ...c, balance: c.balance + Number(txAmount) } : c));
      saveState({ ...state, transactions: [...state.transactions, tx], cards });
    });
  }
  document.querySelectorAll("[data-remove-tx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-remove-tx");
      const tx = state.transactions.find((t) => t.id === id);
      if (!tx) return;
      const cards = state.cards.map((c) => (c.id === tx.cardId ? { ...c, balance: c.balance - tx.amount } : c));
      saveState({ ...state, transactions: state.transactions.filter((t) => t.id !== id), cards });
    });
  });

  // --- Tarjetas ---
  const addCardBtn = document.getElementById("add-card-btn");
  if (addCardBtn) {
    addCardBtn.addEventListener("click", () => {
      const n = state.cards.length + 1;
      const newCard = {
        id: uid(),
        name: `Tarjeta ${n}`,
        limit: 0,
        balance: 0,
        cutDay: 1,
        cutMonth: 1,
        dueDay: 1,
        dueMonth: 1,
        minPaymentToAvoidInterest: 0,
        msi: [],
      };
      saveState({ ...state, cards: [...state.cards, newCard] });
    });
  }
  document.querySelectorAll("[data-delete-card]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-delete-card");
      const card = state.cards.find((c) => c.id === id);
      if (!card) return;
      if (state.cards.length <= 1) {
        alert("Debe existir al menos una tarjeta. Agrega otra antes de eliminar esta.");
        return;
      }
      const relatedTx = state.transactions.filter((t) => t.cardId === id);
      const hasMsi = (card.msi || []).length > 0;
      let msg = `¿Seguro que deseas eliminar "${card.name}"?\nEsta acción eliminará también la información asociada a esta tarjeta.`;
      if (relatedTx.length > 0 || hasMsi) {
        const parts = [];
        if (relatedTx.length > 0) parts.push(`${relatedTx.length} gasto(s) registrado(s)`);
        if (hasMsi) parts.push("compras a MSI activas");
        msg = `"${card.name}" tiene ${parts.join(" y ")} asociados.\n\n¿Seguro que deseas eliminarla de todos modos? Se eliminará también esa información.`;
      }
      if (!confirm(msg)) return;
      const cards = state.cards.filter((c) => c.id !== id);
      const transactions = state.transactions.filter((t) => t.cardId !== id);
      saveState({ ...state, cards, transactions });
    });
  });
  document.querySelectorAll("[data-save-card]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-save-card");
      const panel = document.querySelector(`[data-card-panel="${id}"]`);
      const name = panel.querySelector(`[data-card-field="name"]`).value;
      const limit = Number(document.getElementById(`card-limit-${id}`).value) || 0;
      const balance = Number(document.getElementById(`card-balance-${id}`).value) || 0;
      const cutDay = Math.min(31, Math.max(1, Number(document.getElementById(`card-cutday-${id}`).value) || 1));
      const cutMonth = Number(document.getElementById(`card-cutmonth-${id}`).value) || 1;
      const dueDay = Math.min(31, Math.max(1, Number(document.getElementById(`card-dueday-${id}`).value) || 1));
      const dueMonth = Number(document.getElementById(`card-duemonth-${id}`).value) || 1;
      const minPay = Number(document.getElementById(`card-minpay-${id}`).value) || 0;
      const cards = state.cards.map((c) => (c.id === id ? { ...c, name, limit, balance, cutDay, cutMonth, dueDay, dueMonth, minPaymentToAvoidInterest: minPay } : c));
      saveState({ ...state, cards });
    });
  });
  document.querySelectorAll("[data-add-msi]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-add-msi");
      const desc = document.getElementById(`msi-desc-${id}`).value;
      const total = Number(document.getElementById(`msi-total-${id}`).value);
      const months = Number(document.getElementById(`msi-months-${id}`).value);
      const fee = Number(document.getElementById(`msi-fee-${id}`).value) || 0;
      if (!total || !months) return;
      const monthly = (total + fee) / months;
      const msi = { id: uid(), desc: desc || "Compra a MSI", total, monthly, monthsLeft: months, fee };
      const cards = state.cards.map((c) => (c.id === id ? { ...c, msi: [...(c.msi || []), msi] } : c));
      saveState({ ...state, cards });
    });
  });
  document.querySelectorAll("[data-card-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-card-add");
      const input = document.getElementById(`card-adj-${id}`);
      const val = Number(input.value);
      if (!val || isNaN(val)) return;
      const cards = state.cards.map((c) => (c.id === id ? { ...c, balance: c.balance + val } : c));
      saveState({ ...state, cards });
    });
  });
  document.querySelectorAll("[data-card-subtract]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-card-subtract");
      const input = document.getElementById(`card-adj-${id}`);
      const val = Number(input.value);
      if (!val || isNaN(val)) return;
      const cards = state.cards.map((c) => (c.id === id ? { ...c, balance: c.balance - val } : c));
      saveState({ ...state, cards });
    });
  });
  document.querySelectorAll("[data-remove-msi]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cardId = btn.getAttribute("data-remove-msi-card");
      const msiId = btn.getAttribute("data-remove-msi");
      const cards = state.cards.map((c) => (c.id === cardId ? { ...c, msi: c.msi.filter((m) => m.id !== msiId) } : c));
      saveState({ ...state, cards });
    });
  });

  // --- ¿Qué tarjeta uso? ---
  const qtAnalizar = document.getElementById("qt-analizar");
  if (qtAnalizar) {
    qtAnalizar.addEventListener("click", () => {
      const monto = document.getElementById("qt-monto").value;
      if (monto === "" || isNaN(monto) || Number(monto) <= 0) return;
      const engine = computeEngine(state);
      lastResult = analizarGasto(engine, Number(monto));
      render();
    });
  }
  const msiSimCalc = document.getElementById("msi-sim-calc");
  if (msiSimCalc) {
    msiSimCalc.addEventListener("click", () => {
      const total = Number(document.getElementById("msi-sim-monto").value);
      const meses = Number(document.getElementById("msi-sim-meses").value);
      const fee = Number(document.getElementById("msi-sim-comision").value) || 0;
      const resultEl = document.getElementById("msi-sim-result");
      if (!total || !meses) { resultEl.innerHTML = ""; return; }
      const mensualidad = (total + fee) / meses;
      resultEl.innerHTML = `
        <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px;">
          <div style="padding:12px;background:var(--panel2);border-radius:6px;">
            <div class="dim" style="font-size:11px;">Pago de contado</div>
            <div class="mono" style="font-size:16px;">${fmt(total)}</div>
          </div>
          <div style="padding:12px;background:var(--panel2);border-radius:6px;">
            <div class="dim" style="font-size:11px;">Mensualidad a ${meses} MSI</div>
            <div class="mono" style="font-size:16px;color:var(--amber);">${fmt(mensualidad)}/mes</div>
          </div>
        </div>`;
    });
  }
}

/* ---------------------------- INICIO ---------------------------- */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await bootAfterLogin(session.user);
  } else {
    renderAuth();
  }
}

// Reacciona a inicios/cierres de sesión que ocurran en segundo plano
// (por ejemplo, expiración de token o login desde otra pestaña).
sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") {
    currentUser = null;
    state = structuredClone(DEFAULT_STATE);
    renderAuth();
  }
});

boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.error("SW error", e));
  });
}
