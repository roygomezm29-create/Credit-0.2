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

/* ---------------------------- ESTADO / PERSISTENCIA (Supabase) ----------------------------
   Modelo de datos: 3 tablas reales en Supabase (RLS desactivado, filtrado por user_id
   desde el cliente): "tarjetas", "ingresos", "egresos". Ya NO existe una tabla
   "configuraciones" con blobs JSON — cada tarjeta es una fila propia.
   Cada acción del usuario (agregar/editar/eliminar tarjeta, ingreso o egreso) dispara
   UNA operación puntual (insert/update/delete) contra la tabla correspondiente, y la
   interfaz solo se actualiza si esa operación confirma éxito. No hay overwrite masivo
   de tablas completas en ningún flujo normal. */
const DEFAULT_STATE = {
  dineroTotalHistory: [],
  cards: [], // nunca se siembra con datos de prueba: si Supabase no tiene filas, esto queda []
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
let loadError = ""; // mensaje de error al cargar datos desde Supabase (con botón de reintento)
let settingsOpen = false; // controla el modal de Ajustes

/* ---------- Conversión de filas de Supabase <-> objetos usados por la app ---------- */

/* "tarjetas": una fila por tarjeta.
   Columnas esperadas: id, user_id, nombre, limite, saldo, dia_corte, mes_corte,
   dia_limite, mes_limite, pago_minimo, estilo, color_personalizado, msi (jsonb), created_at */
function rowToCard(row) {
  return {
    id: row.id,
    name: row.nombre || "Otro",
    limit: Number(row.limite) || 0,
    balance: Number(row.saldo) || 0,
    cutDay: row.dia_corte || 1,
    cutMonth: row.mes_corte || 1,
    dueDay: row.dia_limite || 1,
    dueMonth: row.mes_limite || 1,
    minPaymentToAvoidInterest: Number(row.pago_minimo) || 0,
    styleOverride: row.estilo || "auto",
    customColor: row.color_personalizado || undefined,
    msi: row.msi || [],
  };
}
function cardToRow(card, userId) {
  return {
    id: card.id, user_id: userId, nombre: card.name, limite: card.limit, saldo: card.balance,
    dia_corte: card.cutDay, mes_corte: card.cutMonth, dia_limite: card.dueDay, mes_limite: card.dueMonth,
    pago_minimo: card.minPaymentToAvoidInterest, estilo: card.styleOverride || "auto",
    color_personalizado: card.customColor || null, msi: card.msi || [],
  };
}

/* "ingresos": historial de "Dinero total" (anclas iniciales + operaciones +/-) */
function ingresoToLocal(row) {
  return { id: row.id, date: row.fecha, amount: Number(row.monto), type: row.tipo || undefined, delta: row.delta != null ? Number(row.delta) : undefined, note: row.nota || "" };
}
function ingresoToRow(entry, userId) {
  return { id: entry.id, user_id: userId, fecha: entry.date, monto: entry.amount, tipo: entry.type || null, delta: entry.delta ?? null, nota: entry.note || null };
}

/* "egresos": transacciones (pestaña "Transacciones") */
function egresoToLocal(row) {
  return {
    id: row.id, date: row.fecha, amount: Number(row.monto), category: row.categoria, cardId: row.card_id || undefined, note: row.nota || "",
    isMsi: !!row.es_msi, msiMonths: row.msi_meses != null ? Number(row.msi_meses) : undefined,
    isRecurring: !!row.es_recurrente, msiId: row.msi_ref_id || undefined,
  };
}
function egresoToRow(tx, userId) {
  return {
    id: tx.id, user_id: userId, fecha: tx.date, monto: tx.amount, categoria: tx.category || null, card_id: tx.cardId || null, nota: tx.note || null,
    es_msi: !!tx.isMsi, msi_meses: tx.msiMonths ?? null, es_recurrente: !!tx.isRecurring, msi_ref_id: tx.msiId || null,
  };
}

/* ---------- Carga inicial: SELECT a las 3 tablas, sin sembrar nada ---------- */
async function loadStateFromSupabase() {
  const userId = currentUser.id;

  const [{ data: tarjetas, error: cardErr }, { data: ingresos, error: ingErr }, { data: egresos, error: egErr }] = await Promise.all([
    sb.from("tarjetas").select("*").eq("user_id", userId).order("created_at", { ascending: true }),
    sb.from("ingresos").select("*").eq("user_id", userId).order("fecha", { ascending: true }),
    sb.from("egresos").select("*").eq("user_id", userId).order("fecha", { ascending: true }),
  ]);

  // CRÍTICO: si cualquiera de las 3 consultas falla (sin red, error del servidor, etc.)
  // NO seguimos adelante con un estado vacío/parcial: eso antes podía hacer que un
  // guardado posterior borrara datos reales. Lanzamos para mostrar una pantalla de
  // reintento en vez de continuar como si las tablas estuvieran vacías.
  if (cardErr || ingErr || egErr) {
    const err = cardErr || ingErr || egErr;
    console.error("Error cargando datos de Supabase", err);
    throw new Error(err.message || "No se pudo cargar tu información desde la nube.");
  }

  return {
    cards: (tarjetas || []).map(rowToCard), // [] si la tabla no tiene filas — sin datos de prueba
    dineroTotalHistory: (ingresos || []).map(ingresoToLocal),
    transactions: (egresos || []).map(egresoToLocal),
  };
}

/* ---------- Indicador flotante de sincronización ---------- */
function showSyncToast(text) {
  const el = document.getElementById("sync-toast");
  if (!el) return;
  el.classList.remove("error");
  el.innerHTML = `<span class="dot"></span> ${esc(text)}`;
  el.classList.add("show");
}
function hideSyncToast() {
  const el = document.getElementById("sync-toast");
  if (el) el.classList.remove("show");
}

/* ---------- Operaciones puntuales contra Supabase (una fila a la vez) ---------- */
async function dbInsertCard(card) {
  const { error } = await sb.from("tarjetas").insert(cardToRow(card, currentUser.id));
  if (error) throw error;
}
async function dbUpdateCard(card) {
  const { error } = await sb.from("tarjetas").update(cardToRow(card, currentUser.id)).eq("id", card.id).eq("user_id", currentUser.id);
  if (error) throw error;
}
async function dbDeleteCard(id) {
  const { error } = await sb.from("tarjetas").delete().eq("id", id).eq("user_id", currentUser.id);
  if (error) throw error;
}
async function dbInsertIngreso(entry) {
  const { error } = await sb.from("ingresos").insert(ingresoToRow(entry, currentUser.id));
  if (error) throw error;
}
async function dbUpdateIngresoMonto(id, amount) {
  const { error } = await sb.from("ingresos").update({ monto: amount }).eq("id", id).eq("user_id", currentUser.id);
  if (error) throw error;
}
async function dbDeleteIngreso(id) {
  const { error } = await sb.from("ingresos").delete().eq("id", id).eq("user_id", currentUser.id);
  if (error) throw error;
}
async function dbInsertEgreso(tx) {
  const { error } = await sb.from("egresos").insert(egresoToRow(tx, currentUser.id));
  if (error) throw error;
}
async function dbDeleteEgreso(id) {
  const { error } = await sb.from("egresos").delete().eq("id", id).eq("user_id", currentUser.id);
  if (error) throw error;
}

/* Ejecuta una o varias operaciones de Supabase (ya resueltas a promesas, en orden) y
   SOLO SI TODAS tienen éxito aplica el cambio al estado local y re-renderiza. Si
   cualquiera falla, muestra un alert con el mensaje que devolvió Supabase y NO aplica
   ningún cambio local — así la interfaz nunca "miente" sobre lo que quedó guardado. */
async function runSync(dbOps, applyLocal) {
  showSyncToast("Guardando en la nube…");
  try {
    if (Array.isArray(dbOps)) {
      for (const op of dbOps) await op();
    } else {
      await dbOps();
    }
    applyLocal();
    hideSyncToast();
    render();
  } catch (e) {
    console.error("Error de sincronización con Supabase", e);
    hideSyncToast();
    alert(e && e.message ? e.message : "No se pudo sincronizar este cambio con la nube.");
    render(); // vuelve a pintar el estado actual (el cambio fallido no se aplicó)
  }
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

/* ---------------------------- ÍCONOS SVG (header / bottom nav) ---------------------------- */
const SVG_GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.066 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.066-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.066Z"/><circle cx="12" cy="12" r="3.2"/></svg>`;
const SVG_HOME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11.5 12 4l8.5 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1h4v-6h3v6h4a1 1 0 0 0 1-1v-9"/></svg>`;
const SVG_MONEY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 9h.01M18 15h.01"/></svg>`;
const SVG_SWAP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3M4 7l3 3"/><path d="M20 17H7l3 3M20 17l-3-3"/></svg>`;
const SVG_CARD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.2"/><path d="M2.5 9.5h19"/><path d="M6 14.5h4"/></svg>`;
const SVG_CHART = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M11 20V4M18 20v-7"/><path d="M2.5 20h19"/></svg>`;
const SVG_CALENDAR_NAV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2.2"/><path d="M3 9.5h18M8 3v4M16 3v4"/></svg>`;
const SVG_TREND_LINE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17 9 10l4 3 8-9"/><path d="M3 21h18"/></svg>`;

/* ---------------------------- BANCO / ESTILO VISUAL DE TARJETA ---------------------------- */
function normalizeText(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Las 15 opciones del selector de banco (obligatorio, sin texto libre)
const BANK_OPTIONS = [
  "BBVA", "Banorte", "AMEX", "Plata Card", "Citibanamex", "Santander", "HSBC",
  "Nu", "Klar", "Scotiabank", "American Express", "Banregio", "BanBajio", "MercadoLibre", "Otro",
];

// Paleta característica por banco, indexada EXACTAMENTE por el valor del selector
const BANK_PALETTE_BY_NAME = {
  "BBVA": { gradient: "linear-gradient(135deg, #1B5FA8 0%, #0A2547 100%)", fg: "silver" },
  "Banorte": { gradient: "linear-gradient(135deg, #C1272D 0%, #4E0E10 100%)", fg: "silver" },
  "AMEX": { gradient: "linear-gradient(135deg, #086F52 0%, #0A1F1B 100%)", fg: "gold" },
  "Plata Card": { gradient: "linear-gradient(135deg, #3A3B40 0%, #0B0B0D 100%)", fg: "silver" },
  "Citibanamex": { gradient: "linear-gradient(135deg, #0056A4 0%, #7A0C1E 100%)", fg: "silver" },
  "Santander": { gradient: "linear-gradient(135deg, #EA1D25 0%, #5C0000 100%)", fg: "silver" },
  "HSBC": { gradient: "linear-gradient(135deg, #DB0011 0%, #191919 100%)", fg: "silver" },
  "Nu": { gradient: "linear-gradient(135deg, #9526D6 0%, #390A5C 100%)", fg: "silver" },
  "Klar": { gradient: "linear-gradient(135deg, #232323 0%, #000000 100%)", fg: "gold" },
  "Scotiabank": { gradient: "linear-gradient(135deg, #EC111A 0%, #6B0000 100%)", fg: "silver" },
  "American Express": { gradient: "linear-gradient(135deg, #086F52 0%, #0A1F1B 100%)", fg: "gold" },
  "Banregio": { gradient: "linear-gradient(135deg, #F2622E 0%, #7A2408 100%)", fg: "gold" },
  "BanBajio": { gradient: "linear-gradient(135deg, #00704A 0%, #00301F 100%)", fg: "gold" },
  "MercadoLibre": { gradient: "linear-gradient(135deg, #2D3277 0%, #12142E 100%)", fg: "gold" },
};
const DEFAULT_PALETTE = { gradient: "linear-gradient(135deg, #232A33 0%, #10141A 100%)", fg: "gold" };

// Detección difusa: se conserva como respaldo para tarjetas antiguas cuyo "name"
// haya sido guardado como texto libre (versiones previas de la app), antes de
// que el nombre pasara a ser un selector cerrado de 15 bancos.
const BANK_FUZZY_KEYS = [
  { name: "BBVA", keys: ["bbva"] },
  { name: "Banorte", keys: ["banorte"] },
  { name: "American Express", keys: ["american express", "amex"] },
  { name: "Plata Card", keys: ["plata card", "plata"] },
  { name: "Citibanamex", keys: ["citibanamex", "banamex"] },
  { name: "Santander", keys: ["santander"] },
  { name: "HSBC", keys: ["hsbc"] },
  { name: "Nu", keys: ["nubank", "nu"] },
  { name: "Klar", keys: ["klar"] },
  { name: "Scotiabank", keys: ["scotiabank", "scotia"] },
  { name: "Banregio", keys: ["banregio"] },
  { name: "BanBajio", keys: ["banbajio", "bajio"] },
  { name: "MercadoLibre", keys: ["mercadolibre", "mercado libre", "mercado pago", "mercadopago"] },
];

function resolveBankPalette(name) {
  if (BANK_PALETTE_BY_NAME[name]) return BANK_PALETTE_BY_NAME[name];
  const n = normalizeText(name);
  for (const bank of BANK_FUZZY_KEYS) {
    for (const key of bank.keys) {
      const k = normalizeText(key);
      const re = new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
      if (re.test(n)) return BANK_PALETTE_BY_NAME[bank.name] || DEFAULT_PALETTE;
    }
  }
  return DEFAULT_PALETTE;
}

const STYLE_PRESETS = {
  azul: { label: "Azul", gradient: "linear-gradient(135deg, #1B5FA8 0%, #0A2547 100%)", fg: "silver" },
  verde: { label: "Verde", gradient: "linear-gradient(135deg, #086F52 0%, #0A1F1B 100%)", fg: "gold" },
  rojo: { label: "Rojo", gradient: "linear-gradient(135deg, #C1272D 0%, #4E0E10 100%)", fg: "silver" },
  morado: { label: "Morado", gradient: "linear-gradient(135deg, #8A05BE 0%, #33073E 100%)", fg: "silver" },
  oro: { label: "Dorado / Oro", gradient: "linear-gradient(135deg, #C9A24B 0%, #5B4720 100%)", fg: "gold" },
  plata: { label: "Plata", gradient: "linear-gradient(135deg, #B7BFC9 0%, #3C4249 100%)", fg: "silver" },
  grafito: { label: "Grafito", gradient: "linear-gradient(135deg, #3A3B40 0%, #0B0B0D 100%)", fg: "silver" },
};

/* Calcula {gradient, fg} para una tarjeta (o un objeto temporal con los mismos
   campos) según su estilo: automático por banco, preset manual o color
   personalizado. El nombre del banco en el título NUNCA depende de esto —
   siempre se muestra tal cual card.name (ver cardVisualHTML). */
function getCardVisual(card) {
  const override = card.styleOverride || "auto";
  if (override === "personalizado" && card.customColor) {
    return { gradient: `linear-gradient(135deg, ${card.customColor} 0%, #0B0B0D 100%)`, fg: "silver" };
  }
  if (override !== "auto" && STYLE_PRESETS[override]) {
    const p = STYLE_PRESETS[override];
    return { gradient: p.gradient, fg: p.fg };
  }
  return resolveBankPalette(card.name);
}

function cardVisualHTML(card, disponible) {
  const v = getCardVisual(card);
  return `
  <div class="credit-card-visual fg-${v.fg}" id="card-visual-${card.id}" style="background:${v.gradient};">
    <div class="ccv-shine"></div>
    <div class="ccv-top">
      <span class="ccv-bank">${esc(card.name || "Otro")}</span>
      <span class="ccv-chip"></span>
    </div>
    <div class="ccv-bottom">
      <div>
        <div class="ccv-label">Tipo</div>
        <div class="ccv-name">Crédito</div>
      </div>
      <div style="text-align:right;">
        <div class="ccv-label">Disponible</div>
        <div class="ccv-balance">${fmt(disponible)}</div>
      </div>
    </div>
  </div>`;
}

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
    return `
    <div class="chart-empty">
      ${SVG_TREND_LINE}
      <span>Registra al menos 2 movimientos para ver la tendencia.</span>
    </div>`;
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

/* ---------------------------- PESTAÑA: TRANSACCIONES (antes Gastos) ---------------------------- */
const TX_CATEGORIES = [
  "Despensa y Alimentos",
  "Gasolina y Transporte",
  "Vivienda y Servicios",
  "Salud",
  "Salidas y Entretenimiento",
  "Compras y Tecnología",
  "Viajes",
  "Pagos y Transferencias",
  "Otros",
];
const MSI_TERMS = [3, 6, 9, 12, 18, 24];

function renderGastos(state) {
  const recentTx = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);

  if (state.cards.length === 0) {
    return `
    <div class="stack">
      <div class="panel" style="text-align:center;padding:34px 16px;">
        <div class="icon-box" style="width:36px;height:36px;margin:0 auto;color:var(--textDim);">${SVG_CARD}</div>
        <div class="label" style="margin-top:12px;">Aún no tienes tarjetas registradas</div>
        <div class="dim" style="font-size:12.5px;margin-top:4px;">Agrega tu primera tarjeta en la pestaña "Tarjetas" para poder registrar transacciones.</div>
      </div>
    </div>`;
  }

  return `
  <div class="stack">
    <div class="panel">
      <div class="label" style="margin-bottom:16px;">Registrar una transacción</div>

      <div class="step-label"><span class="step-num">1</span> Categoría del gasto</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <select id="tx-category">
            ${TX_CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
          </select>
        </div>
        <div><input type="text" id="tx-note" placeholder="Nota u observación (opcional)"></div>
      </div>

      <div class="step-divider"></div>

      <div class="step-label"><span class="step-num">2</span> Detalles del cargo</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><div class="label">Monto</div>${numField("tx-amount")}</div>
        <div><div class="label">Fecha</div><input type="date" id="tx-date" value="${todayISO()}"></div>
        <div style="grid-column:1/-1;">
          <div class="label">Tarjeta destino</div>
          <select id="tx-card">${state.cards.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
        </div>
      </div>

      <div class="switch-row">
        <span class="switch-label">¿Es a Meses Sin Intereses (MSI)?</span>
        <label class="switch">
          <input type="checkbox" id="tx-is-msi">
          <span class="slider"></span>
        </label>
      </div>
      <div id="tx-msi-term-wrap" style="display:none;margin-bottom:4px;">
        <div class="label">Plazo a meses</div>
        <select id="tx-msi-term">
          ${MSI_TERMS.map((m) => `<option value="${m}" ${m === 12 ? "selected" : ""}>${m} meses</option>`).join("")}
        </select>
      </div>

      <div class="switch-row" style="border-top:1px solid var(--borderSoft);">
        <span class="switch-label">¿Es un cargo recurrente / suscripción?</span>
        <label class="switch">
          <input type="checkbox" id="tx-is-recurring">
          <span class="slider"></span>
        </label>
      </div>

      <button class="btn btn-primary btn-block" id="tx-add" style="margin-top:14px;">${ICO.plus} Registrar</button>
      <div class="dim" style="font-size:11px;margin-top:8px;">El gasto se refleja de inmediato en el saldo de la tarjeta elegida. Si activas MSI, además se agrega como cuota mensual en la pestaña "Tarjetas"; si activas recurrente, se proyecta en "Calendario".</div>
    </div>

    <div class="panel">
      <div class="label">Movimientos recientes</div>
      ${recentTx.length === 0 ? `<div class="empty">Sin movimientos registrados.</div>` :
        `<div>
          ${recentTx.map((t) => {
            const card = state.cards.find((c) => c.id === t.cardId);
            const badges = [
              t.isMsi ? `<span class="mono" style="color:var(--amber);font-size:10.5px;">MSI ${t.msiMonths}m</span>` : "",
              t.isRecurring ? `<span style="color:var(--blueGrey);font-size:10.5px;">Recurrente</span>` : "",
            ].filter(Boolean).join(" · ");
            return `
              <div class="row" style="font-size:13px;">
                <div>
                  <span>${esc(t.category)}</span>
                  <span class="dim"> · ${card ? esc(card.name) : "—"} · ${fmtDate(t.date)}${t.note ? " · " + esc(t.note) : ""}</span>
                  ${badges ? `<div style="margin-top:2px;">${badges}</div>` : ""}
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
      const disponible = card.limit - card.balance;
      return `
      <div class="panel" data-card-panel="${card.id}">
        ${cardVisualHTML(card, disponible)}

        <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;">
          <select data-card-field="name" data-card-bank-select="${card.id}" id="card-bank-${card.id}" style="flex:1;">
            ${BANK_OPTIONS.map((b) => `<option value="${esc(b)}" ${card.name === b ? "selected" : ""}>${esc(b)}</option>`).join("")}
          </select>
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
          <div style="grid-column:1/-1;">
            <div class="label">Estilo de la tarjeta</div>
            <select id="card-style-${card.id}" data-card-style="${card.id}">
              <option value="auto" ${(!card.styleOverride || card.styleOverride === "auto") ? "selected" : ""}>Automático (por banco)</option>
              ${Object.entries(STYLE_PRESETS).map(([key, p]) => `<option value="${key}" ${card.styleOverride === key ? "selected" : ""}>${p.label}</option>`).join("")}
              <option value="personalizado" ${card.styleOverride === "personalizado" ? "selected" : ""}>Personalizado…</option>
            </select>
            <div id="card-customcolor-wrap-${card.id}" style="margin-top:8px;display:${card.styleOverride === "personalizado" ? "flex" : "none"};align-items:center;gap:10px;">
              <input type="color" id="card-customcolor-${card.id}" data-card-customcolor="${card.id}" value="${card.customColor || "#C9A24B"}" style="width:44px;height:34px;padding:2px;border-radius:6px;border:1px solid var(--border);background:var(--panel2);cursor:pointer;">
              <span class="dim" style="font-size:11px;">Color base de la tarjeta personalizada</span>
            </div>
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
function categoryBreakdown(state) {
  const totals = {};
  state.transactions.forEach((t) => {
    totals[t.category] = (totals[t.category] || 0) + t.amount;
  });
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  return Object.entries(totals)
    .map(([category, total]) => ({ category, total, pct: sum > 0 ? (total / sum) * 100 : 0 }))
    .sort((a, b) => b.total - a.total);
}

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

    <div class="panel">
      <div class="label">Desglose por categoría</div>
      ${(() => {
        const bd = categoryBreakdown(state);
        if (bd.length === 0) return `<div class="empty">Aún no hay transacciones registradas.</div>`;
        return bd.map((b) => `
          <div class="cat-bar-row">
            <div class="cat-bar-head">
              <span>${esc(b.category)}</span>
              <span class="mono">${fmt(b.total)} <span class="dim">(${b.pct.toFixed(0)}%)</span></span>
            </div>
            <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${b.pct}%;"></div></div>
          </div>
        `).join("");
      })()}
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
  // Proyecta el próximo cobro de cada transacción marcada como recurrente/suscripción
  state.transactions.filter((t) => t.isRecurring).forEach((t) => {
    const txDate = new Date(t.date + "T00:00:00");
    const nextCharge = nextOccurrence(txDate.getDate(), txDate.getMonth() + 1);
    const card = state.cards.find((c) => c.id === t.cardId);
    events.push({ date: nextCharge, label: `Recurrente: ${t.category}${card ? " — " + card.name : ""} (${fmt(t.amount)})`, type: "recurrente" });
  });
  events.sort((a, b) => a.date.localeCompare(b.date));
  const typeColor = { corte: "var(--blueGrey)", pago: "var(--red)", msi: "var(--amber)", recurrente: "var(--green)" };

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
  settingsOpen = false;
  loadError = "";
  state = structuredClone(DEFAULT_STATE);
  renderAuth();
}

async function bootAfterLogin(user) {
  currentUser = user;
  dataLoading = true;
  loadError = "";
  renderAuth();
  try {
    state = await loadStateFromSupabase();
  } catch (e) {
    console.error("No se pudo cargar el estado desde Supabase", e);
    dataLoading = false;
    loadError = (e && e.message) ? e.message : "No se pudo cargar tu información desde la nube. Revisa tu conexión a internet e inténtalo de nuevo.";
    renderAuth();
    return; // No renderizamos la app con datos vacíos/incompletos.
  }
  dataLoading = false;
  render();
}

function renderAuth() {
  const app = document.getElementById("app");
  if (dataLoading) {
    app.innerHTML = `<div class="auth-wrap"><div class="auth-box"><div class="auth-title">Credit</div><div class="auth-subtitle">Cargando tus datos…</div></div></div>`;
    return;
  }
  if (loadError) {
    app.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-box">
          <div class="auth-title">Credit</div>
          <div class="auth-subtitle" style="color:var(--red);">${esc(loadError)}</div>
          <button class="btn btn-primary btn-block" id="retry-load-btn" style="margin-top:14px;">Reintentar</button>
        </div>
      </div>`;
    const retryBtn = document.getElementById("retry-load-btn");
    if (retryBtn) retryBtn.addEventListener("click", () => bootAfterLogin(currentUser));
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
  { id: "resumen", label: "Resumen", icon: SVG_HOME },
  { id: "dinero", label: "Dinero total", icon: SVG_MONEY },
  { id: "gastos", label: "Transacciones", icon: SVG_SWAP },
  { id: "tarjetas", label: "Tarjetas", icon: SVG_CARD },
  { id: "quetarjeta", label: "Análisis", icon: SVG_CHART },
  { id: "calendario", label: "Calendario", icon: SVG_CALENDAR_NAV },
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
      <div class="header-title">Credit 0.2</div>
      <button id="settings-btn" class="icon-btn" title="Ajustes" aria-label="Ajustes">${SVG_GEAR}</button>
    </div>
    ${body}
    <nav class="bottom-nav">
      ${TABS.map((t) => `
        <button class="bn-item ${t.id === currentTab ? "active" : ""}" data-tab="${t.id}">
          ${t.icon}
          <span>${t.label}</span>
        </button>`).join("")}
    </nav>
    ${settingsOpen ? `
    <div class="modal-overlay" id="settings-overlay">
      <div class="modal-sheet">
        <div class="modal-header">
          <div class="modal-title">Ajustes</div>
          <button class="modal-close" id="settings-close" aria-label="Cerrar">${ICO.x}</button>
        </div>
        <div class="settings-row">
          <div class="label">Sesión activa</div>
          <div class="settings-email">${currentUser?.email ? esc(currentUser.email) : "—"}</div>
        </div>
        <button id="settings-logout-btn" class="btn btn-danger btn-block">Cerrar Sesión</button>
      </div>
    </div>` : ""}
  `;

  attachHandlers();

  if (currentTab === "resumen") {
    attachEvolutionChartTooltip(engine.hist.map((h) => ({ date: h.date, amount: h.amount })));
  }

  window.scrollTo(0, scrollY);
  requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

/* Actualiza en vivo la tarjeta visual (16:9) cuando el usuario cambia el banco,
   el estilo manual o el color personalizado — sin necesidad de presionar
   "Guardar cambios" primero. Los valores definitivos se persisten al guardar. */
function updateCardVisualPreview(id) {
  const bankSel = document.getElementById(`card-bank-${id}`);
  const styleSel = document.getElementById(`card-style-${id}`);
  const colorInp = document.getElementById(`card-customcolor-${id}`);
  const visual = document.getElementById(`card-visual-${id}`);
  if (!bankSel || !styleSel || !visual) return;
  const tempCard = { name: bankSel.value, styleOverride: styleSel.value, customColor: colorInp ? colorInp.value : undefined };
  const v = getCardVisual(tempCard);
  visual.className = `credit-card-visual fg-${v.fg}`;
  visual.style.background = v.gradient;
  const bankEl = visual.querySelector(".ccv-bank");
  if (bankEl) bankEl.textContent = tempCard.name || "Otro";
}

/* ---------------------------- MANEJADORES DE EVENTOS ---------------------------- */
function attachHandlers() {
  const settingsBtn = document.getElementById("settings-btn");
  if (settingsBtn) settingsBtn.addEventListener("click", () => { settingsOpen = true; render(); });

  const settingsOverlay = document.getElementById("settings-overlay");
  if (settingsOverlay) {
    settingsOverlay.addEventListener("click", (e) => {
      if (e.target === settingsOverlay) { settingsOpen = false; render(); }
    });
  }
  const settingsClose = document.getElementById("settings-close");
  if (settingsClose) settingsClose.addEventListener("click", () => { settingsOpen = false; render(); });

  const settingsLogoutBtn = document.getElementById("settings-logout-btn");
  if (settingsLogoutBtn) settingsLogoutBtn.addEventListener("click", () => { settingsOpen = false; handleSignOut(); });

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
      const rawEntry = { id: uid(), date: todayISO(), seq: Date.now(), type: "inicial", amount: Number(amount), note };
      const recomputed = recomputeDineroHistory([...state.dineroTotalHistory, rawEntry]);
      const finalEntry = recomputed.find((e) => e.id === rawEntry.id);
      runSync(() => dbInsertIngreso(finalEntry), () => { state = { ...state, dineroTotalHistory: recomputed }; });
    });
  }
  const dtOpAdd = document.getElementById("dt-op-add");
  if (dtOpAdd) {
    dtOpAdd.addEventListener("click", () => {
      const amount = document.getElementById("dt-op-amount").value;
      const note = document.getElementById("dt-op-note").value;
      if (amount === "" || isNaN(amount) || Number(amount) === 0) return;
      const rawEntry = { id: uid(), date: todayISO(), seq: Date.now(), type: "suma", delta: Math.abs(Number(amount)), note };
      const recomputed = recomputeDineroHistory([...state.dineroTotalHistory, rawEntry]);
      const finalEntry = recomputed.find((e) => e.id === rawEntry.id);
      runSync(() => dbInsertIngreso(finalEntry), () => { state = { ...state, dineroTotalHistory: recomputed }; });
    });
  }
  const dtOpSubtract = document.getElementById("dt-op-subtract");
  if (dtOpSubtract) {
    dtOpSubtract.addEventListener("click", () => {
      const amount = document.getElementById("dt-op-amount").value;
      const note = document.getElementById("dt-op-note").value;
      if (amount === "" || isNaN(amount) || Number(amount) === 0) return;
      const rawEntry = { id: uid(), date: todayISO(), seq: Date.now(), type: "resta", delta: Math.abs(Number(amount)), note };
      const recomputed = recomputeDineroHistory([...state.dineroTotalHistory, rawEntry]);
      const finalEntry = recomputed.find((e) => e.id === rawEntry.id);
      runSync(() => dbInsertIngreso(finalEntry), () => { state = { ...state, dineroTotalHistory: recomputed }; });
    });
  }
  document.querySelectorAll("[data-remove-entry]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-remove-entry");
      const filtered = state.dineroTotalHistory.filter((e) => e.id !== id);
      const recomputed = recomputeDineroHistory(filtered);
      // Eliminar un registro puede recalcular el "amount" (saldo acumulado) de las
      // entradas posteriores tipo suma/resta: además del delete, hay que reflejar
      // ese recálculo con un update puntual por cada entrada cuyo monto cambió.
      const before = new Map(state.dineroTotalHistory.map((e) => [e.id, e.amount]));
      const ops = [() => dbDeleteIngreso(id)];
      recomputed.forEach((e) => {
        if (before.has(e.id) && before.get(e.id) !== e.amount) {
          ops.push(() => dbUpdateIngresoMonto(e.id, e.amount));
        }
      });
      runSync(ops, () => { state = { ...state, dineroTotalHistory: recomputed }; });
    });
  });

  // --- Transacciones ---
  const txIsMsi = document.getElementById("tx-is-msi");
  if (txIsMsi) {
    txIsMsi.addEventListener("change", () => {
      const wrap = document.getElementById("tx-msi-term-wrap");
      if (wrap) wrap.style.display = txIsMsi.checked ? "block" : "none";
    });
  }
  const txAdd = document.getElementById("tx-add");
  if (txAdd) {
    txAdd.addEventListener("click", () => {
      const txAmount = document.getElementById("tx-amount").value;
      const txCategory = document.getElementById("tx-category").value;
      const txDate = document.getElementById("tx-date").value;
      const txCard = document.getElementById("tx-card").value;
      const txNote = document.getElementById("tx-note").value;
      const isMsi = document.getElementById("tx-is-msi").checked;
      const msiMonths = isMsi ? Number(document.getElementById("tx-msi-term").value) || 12 : undefined;
      const isRecurring = document.getElementById("tx-is-recurring").checked;
      if (txAmount === "" || isNaN(txAmount) || !txCategory.trim() || !txCard) return;

      const amountNum = Number(txAmount);
      let msiId;
      const originalCard = state.cards.find((c) => c.id === txCard);
      if (!originalCard) return;
      let updatedCard = { ...originalCard, balance: originalCard.balance + amountNum };
      if (isMsi) {
        msiId = uid();
        const desc = txCategory + (txNote ? " · " + txNote : "");
        const msiEntry = { id: msiId, desc, total: amountNum, monthly: amountNum / msiMonths, monthsLeft: msiMonths, fee: 0 };
        updatedCard = { ...updatedCard, msi: [...(updatedCard.msi || []), msiEntry] };
      }
      const tx = { id: uid(), date: txDate, amount: amountNum, category: txCategory.trim(), cardId: txCard, note: txNote, isMsi, msiMonths, isRecurring, msiId };

      runSync(
        [() => dbInsertEgreso(tx), () => dbUpdateCard(updatedCard)],
        () => {
          const cards = state.cards.map((c) => (c.id === txCard ? updatedCard : c));
          state = { ...state, transactions: [...state.transactions, tx], cards };
        }
      );
    });
  }
  document.querySelectorAll("[data-remove-tx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-remove-tx");
      const tx = state.transactions.find((t) => t.id === id);
      if (!tx) return;
      const originalCard = state.cards.find((c) => c.id === tx.cardId);
      const ops = [() => dbDeleteEgreso(id)];
      let updatedCard = null;
      if (originalCard) {
        const balance = originalCard.balance - tx.amount;
        const msi = tx.msiId ? (originalCard.msi || []).filter((m) => m.id !== tx.msiId) : originalCard.msi;
        updatedCard = { ...originalCard, balance, msi };
        ops.push(() => dbUpdateCard(updatedCard));
      }
      runSync(ops, () => {
        const cards = updatedCard ? state.cards.map((c) => (c.id === tx.cardId ? updatedCard : c)) : state.cards;
        state = { ...state, transactions: state.transactions.filter((t) => t.id !== id), cards };
      });
    });
  });

  // --- Tarjetas ---
  const addCardBtn = document.getElementById("add-card-btn");
  if (addCardBtn) {
    addCardBtn.addEventListener("click", () => {
      const newCard = {
        id: uid(),
        name: "Otro",
        limit: 0,
        balance: 0,
        cutDay: 1,
        cutMonth: 1,
        dueDay: 1,
        dueMonth: 1,
        minPaymentToAvoidInterest: 0,
        msi: [],
        styleOverride: "auto",
      };
      runSync(() => dbInsertCard(newCard), () => { state = { ...state, cards: [...state.cards, newCard] }; });
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
      const ops = [
        ...relatedTx.map((t) => () => dbDeleteEgreso(t.id)),
        () => dbDeleteCard(id),
      ];
      runSync(ops, () => {
        state = {
          ...state,
          cards: state.cards.filter((c) => c.id !== id),
          transactions: state.transactions.filter((t) => t.cardId !== id),
        };
      });
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
      const styleSel = document.getElementById(`card-style-${id}`);
      const styleOverride = styleSel ? styleSel.value : "auto";
      const customColorInput = document.getElementById(`card-customcolor-${id}`);
      const customColor = customColorInput ? customColorInput.value : undefined;
      const original = state.cards.find((c) => c.id === id);
      if (!original) return;
      const updatedCard = { ...original, name, limit, balance, cutDay, cutMonth, dueDay, dueMonth, minPaymentToAvoidInterest: minPay, styleOverride, customColor };
      runSync(() => dbUpdateCard(updatedCard), () => {
        state = { ...state, cards: state.cards.map((c) => (c.id === id ? updatedCard : c)) };
      });
    });
  });
  document.querySelectorAll("[data-card-bank-select]").forEach((sel) => {
    sel.addEventListener("change", () => updateCardVisualPreview(sel.getAttribute("data-card-bank-select")));
  });
  document.querySelectorAll("[data-card-style]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const id = sel.getAttribute("data-card-style");
      const wrap = document.getElementById(`card-customcolor-wrap-${id}`);
      if (wrap) wrap.style.display = sel.value === "personalizado" ? "flex" : "none";
      updateCardVisualPreview(id);
    });
  });
  document.querySelectorAll("[data-card-customcolor]").forEach((inp) => {
    inp.addEventListener("input", () => updateCardVisualPreview(inp.getAttribute("data-card-customcolor")));
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
      const original = state.cards.find((c) => c.id === id);
      if (!original) return;
      const updatedCard = { ...original, msi: [...(original.msi || []), msi] };
      runSync(() => dbUpdateCard(updatedCard), () => {
        state = { ...state, cards: state.cards.map((c) => (c.id === id ? updatedCard : c)) };
      });
    });
  });
  document.querySelectorAll("[data-card-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-card-add");
      const input = document.getElementById(`card-adj-${id}`);
      const val = Number(input.value);
      if (!val || isNaN(val)) return;
      const original = state.cards.find((c) => c.id === id);
      if (!original) return;
      const updatedCard = { ...original, balance: original.balance + val };
      runSync(() => dbUpdateCard(updatedCard), () => {
        state = { ...state, cards: state.cards.map((c) => (c.id === id ? updatedCard : c)) };
      });
    });
  });
  document.querySelectorAll("[data-card-subtract]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-card-subtract");
      const input = document.getElementById(`card-adj-${id}`);
      const val = Number(input.value);
      if (!val || isNaN(val)) return;
      const original = state.cards.find((c) => c.id === id);
      if (!original) return;
      const updatedCard = { ...original, balance: original.balance - val };
      runSync(() => dbUpdateCard(updatedCard), () => {
        state = { ...state, cards: state.cards.map((c) => (c.id === id ? updatedCard : c)) };
      });
    });
  });
  document.querySelectorAll("[data-remove-msi]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cardId = btn.getAttribute("data-remove-msi-card");
      const msiId = btn.getAttribute("data-remove-msi");
      const original = state.cards.find((c) => c.id === cardId);
      if (!original) return;
      const updatedCard = { ...original, msi: original.msi.filter((m) => m.id !== msiId) };
      runSync(() => dbUpdateCard(updatedCard), () => {
        state = { ...state, cards: state.cards.map((c) => (c.id === cardId ? updatedCard : c)) };
      });
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
