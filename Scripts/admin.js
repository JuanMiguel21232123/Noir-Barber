const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);

const TZ = "America/Bogota";
const LABELS = { pending: "Pendiente", approved: "Aprobada", completed: "Completada", rejected: "Rechazada", cancelled: "Cancelada" };
const ACTIONS = {
  pending: [["approved", "Aprobar", "action-approve"], ["rejected", "Rechazar", "action-reject"]],
  approved: [["completed", "Completar", "action-approve"], ["cancelled", "Cancelar", "action-reject"]],
};
const OVERDUE_ACTIONS = {
  pending: [["completed", "Completar", "action-approve"], ["rejected", "Rechazar", "action-reject"]],
  approved: ACTIONS.approved,
};
let me = null, bookings = [];

// ---------- pestañas ----------
const TABS = ["resumen", "citas", "disponibilidad", "finanzas", "horarios"];
function setTab(tab) {
  TABS.forEach((t) => {
    const btn = document.querySelector(`.tab-button[data-tab="${t}"]`);
    const panel = document.querySelector(`.tab-panel[data-tab-panel="${t}"]`);
    const active = t === tab;
    if (btn) btn.setAttribute("aria-selected", String(active));
    if (panel) panel.hidden = !active;
  });
}
document.querySelector(".admin-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-button");
  if (btn) setTab(btn.dataset.tab);
});

const dayOf = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ });
// Cita abierta (pendiente/aprobada) cuya hora de fin ya pasó
const isOverdue = (b) => ["pending", "approved"].includes(b.status) && +new Date(b.starts_at) + b.duration_min * 60000 < Date.now();

function inRange(b, f) {
  if (f === "all") return true;
  const d = dayOf(b.starts_at), today = dayOf(Date.now());
  if (f === "today") return d === today;
  if (f === "tomorrow") return d === dayOf(Date.now() + 864e5);
  const t = new Date(today + "T00:00:00Z"), mon = new Date(t - ((t.getUTCDay() + 6) % 7) * 864e5);
  return d >= mon.toISOString().slice(0, 10) && d <= new Date(+mon + 6 * 864e5).toISOString().slice(0, 10);
}

function toast(t) {
  const el = $("toast");
  el.textContent = t; el.hidden = false;
  clearTimeout(toast.id);
  toast.id = setTimeout(() => (el.hidden = true), 3000);
}
const setMsg = (el, t, state = "info") => { el.textContent = t; el.dataset.state = state; };

// ---------- horario semanal (se reutiliza semana a semana) ----------
const SCHEDULE_DAYS = [[1, "Lunes"], [2, "Martes"], [3, "Miércoles"], [4, "Jueves"], [5, "Viernes"], [6, "Sábado"], [0, "Domingo"]];

function scheduleRow(dow, label, day) {
  const open = day ? day.open : "08:00", close = day ? day.close : "20:00";
  return `<div class="schedule-row" data-dow="${dow}">
    <label class="schedule-day-toggle">
      <input type="checkbox" class="schedule-enabled" ${day ? "checked" : ""}>
      <span>${label}</span>
    </label>
    <div class="schedule-times">
      <input type="time" class="schedule-open" value="${open}" ${day ? "" : "disabled"}>
      <span class="schedule-sep">a</span>
      <input type="time" class="schedule-close" value="${close}" ${day ? "" : "disabled"}>
    </div>
  </div>`;
}

function renderSchedule(schedule) {
  $("schedule-days").innerHTML = SCHEDULE_DAYS.map(([dow, label]) => scheduleRow(dow, label, schedule[String(dow)])).join("");
}

async function loadSchedule() {
  setMsg($("schedule-message"), "Cargando horario...");
  try {
    const { schedule } = await api("admin/schedule");
    renderSchedule(schedule);
    setMsg($("schedule-message"), "");
  } catch {
    setMsg($("schedule-message"), "No se pudo cargar tu horario.", "error");
  }
}

$("schedule-days").addEventListener("change", (e) => {
  if (!e.target.classList.contains("schedule-enabled")) return;
  const row = e.target.closest(".schedule-row"), on = e.target.checked;
  row.querySelector(".schedule-open").disabled = !on;
  row.querySelector(".schedule-close").disabled = !on;
});

$("schedule-save-button").addEventListener("click", async () => {
  const schedule = {};
  let valid = true;
  document.querySelectorAll(".schedule-row").forEach((row) => {
    const dow = row.dataset.dow, on = row.querySelector(".schedule-enabled").checked;
    if (!on) { schedule[dow] = null; return; }
    const open = row.querySelector(".schedule-open").value, close = row.querySelector(".schedule-close").value;
    if (!open || !close || open >= close) valid = false;
    schedule[dow] = { open, close };
  });
  if (!valid) return setMsg($("schedule-message"), "Revisa que la hora de apertura sea antes que la de cierre en cada día.", "error");
  const btn = $("schedule-save-button");
  btn.disabled = true;
  try {
    await api("admin/schedule", { method: "PATCH", body: { schedule } });
    setMsg($("schedule-message"), "Horario guardado. Se repetirá cada semana.", "success");
    toast("Horario actualizado.");
  } catch {
    setMsg($("schedule-message"), "No se pudo guardar el horario.", "error");
  }
  btn.disabled = false;
});

function paintAccepting() {
  const on = me.accepting;
  $("accepting-title").textContent = on ? "Recibiendo reservas" : "Reservas pausadas";
  $("accepting-text").textContent = on
    ? "Los clientes pueden reservar contigo."
    : "Los clientes no te ven al reservar. Tus citas actuales no cambian.";
  $("accepting-button").textContent = on ? "Pausar reservas" : "Reactivar reservas";
  $("availability-panel").dataset.state = on ? "on" : "off";
}

// barber = { id, name, accepting }, ya viene completo desde /api/login o /api/session
async function enter(barber) {
  me = barber;
  $("login-view").hidden = true;
  $("dashboard-view").hidden = false;
  $("earnings-section").hidden = false;
  $("welcome-name").innerHTML = `Hola, ${esc(me.name)}<span>.</span>`;
  $("user-role-label").textContent = "BARBERO";
  paintAccepting();
  setTab("resumen");
  await load();
  await loadSchedule();
}

async function load() {
  $("loading-state").hidden = false;
  $("bookings-table-wrap").hidden = true;
  $("empty-state").hidden = true;
  try {
    bookings = await api("admin/bookings");
  } catch {
    $("loading-state").hidden = true;
    return setMsg($("dashboard-message"), "No se pudieron cargar las citas.", "error");
  }
  setMsg($("dashboard-message"), "");
  $("last-updated").textContent = "Actualizado " + new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
  render();
}

// Ganancias de las citas completadas: semana (desde el lunes), quincena (1-15 / 16-fin), mes y año
function earnings() {
  const p = $("earnings-filter").value, n = new Date(), y = n.getFullYear(), m = n.getMonth(), d = n.getDate();
  const from =
    p === "week" ? new Date(y, m, d - ((n.getDay() + 6) % 7)) :
    p === "biweekly" ? new Date(y, m, d <= 15 ? 1 : 16) :
    p === "month" ? new Date(y, m, 1) : new Date(y, 0, 1);
  const list = bookings.filter((b) => b.status === "completed" && new Date(b.starts_at) >= from);
  const total = list.reduce((t, b) => t + b.price, 0);
  $("total-earnings").textContent = money(total);
  $("earnings-count").textContent = list.length;
  $("earnings-avg").textContent = money(list.length ? Math.round(total / list.length) : 0);
  const by = {};
  list.forEach((b) => {
    const k = b.service_name || "Otro";
    by[k] = by[k] || { c: 0, t: 0 };
    by[k].c++; by[k].t += b.price;
  });
  $("earnings-services").innerHTML = Object.entries(by).sort((a, b) => b[1].t - a[1].t)
    .map(([k, v]) => `<li><span>${esc(k)}</span><span>${v.c} ${v.c === 1 ? "cita" : "citas"} · ${money(v.t)}</span></li>`).join("")
    || `<li><span>Sin citas completadas en este periodo.</span></li>`;
}

function waLink(b) {
  let p = String(b.customer_phone).replace(/\D/g, "");
  if (p.length === 10) p = "57" + p;
  const d = new Date(b.starts_at);
  const when = `${d.toLocaleDateString("es-CO", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" })} a las ${d.toLocaleTimeString("es-CO", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true })}`;
  const svc = b.service_name || "tu servicio", n = String(b.customer_name).split(" ")[0];
  const t = {
    pending: `Hola ${n}, recibimos tu solicitud de ${svc} para el ${when}. En breve te confirmamos.`,
    approved: `Hola ${n}, tu cita de ${svc} el ${when} fue aprobada. ¡Te esperamos en NOIR Barber Studio!`,
    rejected: `Hola ${n}, lamentablemente no podemos atender tu cita de ${svc} el ${when}. ¿Te ayudamos a elegir otro horario?`,
    cancelled: `Hola ${n}, tu cita de ${svc} el ${when} fue cancelada. Si quieres reagendar, escríbenos.`,
    completed: `Hola ${n}, gracias por visitarnos en NOIR Barber Studio. ¡Esperamos verte pronto!`,
  }[b.status];
  return `https://wa.me/${p}?text=${encodeURIComponent(t)}`;
}

function row(b) {
  const d = new Date(b.starts_at), tz = { timeZone: TZ }, late = isOverdue(b);
  const buttons = ((late ? OVERDUE_ACTIONS : ACTIONS)[b.status] || []).map(([s, l, c]) => `<button class="action-button ${c}" data-id="${b.id}" data-status="${s}">${l}</button>`).join("");
  const wa = `<a class="action-button action-whatsapp" href="${waLink(b)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`;
  return `<tr${late ? ' class="row-overdue"' : ""}>
    <td class="booking-date"><strong>${d.toLocaleDateString("es-CO", { ...tz, day: "2-digit", month: "short", year: "numeric" })}</strong><span>${d.toLocaleTimeString("es-CO", { ...tz, hour: "numeric", minute: "2-digit", hour12: true })}</span></td>
    <td class="customer-cell"><strong>${esc(b.customer_name)}</strong><span>${esc(b.customer_phone)}</span></td>
    <td class="service-cell"><strong>${esc(b.service_name)}</strong><span>${money(b.price)} · ${b.duration_min} min</span></td>
    <td class="barber-cell hide-mobile">${esc(me.name)}</td>
    <td><span class="status-badge status-${b.status}">${LABELS[b.status]}</span>${late ? '<span class="overdue-tag">Vencida</span>' : ""}</td>
    <td class="actions-cell"><div class="action-group">${buttons}${wa}</div></td>
  </tr>`;
}

function render() {
  const count = (s) => bookings.filter((b) => b.status === s).length;
  $("stat-total").textContent = bookings.length;
  $("stat-pending").textContent = count("pending");
  $("stat-approved").textContent = count("approved");
  $("stat-closed").textContent = count("rejected") + count("cancelled");
  earnings();

  const pending = count("pending"), badge = $("tab-citas-badge");
  badge.hidden = !pending;
  badge.textContent = pending;

  const od = bookings.filter(isOverdue).length;
  $("overdue-alert").hidden = !od;
  $("overdue-text").textContent = `⚠ ${od} ${od === 1 ? "cita ya pasó y sigue abierta" : "citas ya pasaron y siguen abiertas"}. Ciérralas como completadas, rechazadas o canceladas.`;

  const q = $("search-bookings").value.trim().toLowerCase(), st = $("status-filter").value, df = $("date-filter").value;
  const rows = bookings.filter((b) =>
    (st === "all" || (st === "overdue" ? isOverdue(b) : b.status === st)) &&
    inRange(b, df) &&
    (!q || [b.customer_name, b.customer_phone, b.service_name].join(" ").toLowerCase().includes(q)));
  $("loading-state").hidden = true;
  $("empty-state").hidden = rows.length > 0;
  $("bookings-table-wrap").hidden = !rows.length;
  $("bookings-body").innerHTML = rows.map(row).join("");
}

$("bookings-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  btn.disabled = true;
  try {
    await api(`admin/bookings/${btn.dataset.id}`, { method: "PATCH", body: { status: btn.dataset.status } });
    toast("Cita actualizada.");
    load();
  } catch {
    toast("No se pudo actualizar la cita.");
    btn.disabled = false;
  }
});

$("accepting-button").addEventListener("click", async () => {
  const btn = $("accepting-button"), next = !me.accepting;
  btn.disabled = true;
  try {
    const data = await api("admin/accepting", { method: "PATCH", body: { accepting: next } });
    me.accepting = data.accepting;
    paintAccepting();
    toast(next ? "Reservas reactivadas." : "Reservas pausadas.");
  } catch {
    toast("No se pudo cambiar la disponibilidad.");
  }
  btn.disabled = false;
});

$("overdue-view").addEventListener("click", () => {
  $("status-filter").value = "overdue";
  $("date-filter").value = "all";
  setTab("citas");
  render();
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-button"), m = $("login-message");
  btn.disabled = true;
  setMsg(m, "Verificando...");
  try {
    const barber = await api("login", {
      method: "POST",
      body: { username: $("username").value.trim().toLowerCase(), password: $("password").value },
    });
    await enter(barber);
    $("password").value = "";
    setMsg(m, "");
  } catch (err) {
    setMsg(m, err.message || "No se pudo iniciar sesión.", "error");
  }
  btn.disabled = false;
});

$("logout-button").addEventListener("click", async () => {
  try { await api("logout", { method: "POST" }); } catch {}
  location.reload();
});
$("refresh-button").addEventListener("click", load);
$("search-bookings").addEventListener("input", render);
$("status-filter").addEventListener("change", render);
$("date-filter").addEventListener("change", render);
$("earnings-filter").addEventListener("change", earnings);

api("session").then(enter).catch(() => {});
