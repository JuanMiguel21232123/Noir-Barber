const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);

const STEP = 30; // minutos entre horarios disponibles; el rango de horas lo define el horario de cada barbero
let services = [];
let barbersList = [];

// "08:00" -> "8:00 a. m." / "14:30" -> "2:30 p. m."
function formatTime12(hm) {
  const [h, m] = hm.split(":").map(Number);
  const period = h < 12 ? "a. m." : "p. m.";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

const KEY = "noir_my_bookings";
const LABELS = { pending: "Pendiente", approved: "Aprobada", completed: "Completada", rejected: "Rechazada", cancelled: "Cancelada" };

const msg = (t, state = "info") => { $("booking-message").textContent = t; $("booking-message").dataset.state = state; };
const myMsg = (t, state = "info") => { $("my-message").textContent = t; $("my-message").dataset.state = state; };
const hint = (t) => { $("availability-hint").textContent = t; };
const fill = (id, items, placeholder, label) => {
  const el = $(id);
  el.innerHTML = "";
  el.add(new Option(placeholder, ""));
  items.forEach((i) => el.add(new Option(label(i), i.id)));
  el.disabled = false;
};

// Citas del cliente guardadas en este navegador (solo los ids)
const mine = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const saveMine = (id) => { try { localStorage.setItem(KEY, JSON.stringify([...new Set([id, ...mine()])].slice(0, 20))); } catch {} };

function updateSummary() {
  const s = services.find((x) => x.id == $("service").value);
  $("summary-service").textContent = s ? s.name : "Sin seleccionar";
  $("summary-duration").textContent = s ? `${s.duration_min} min` : "—";
  $("summary-price").textContent = s ? money(s.price) : "—";
  $("service-details").textContent = s ? s.description || "" : "";
}

async function loadSlots() {
  updateSummary();
  const s = services.find((x) => x.id == $("service").value);
  const barber = $("barber").value, day = $("date").value, t = $("time");
  t.innerHTML = ""; t.disabled = true;
  if (!s || !barber || !day) {
    t.add(new Option("Primero selecciona servicio, barbero y fecha", ""));
    return hint("Selecciona un servicio, un barbero y una fecha para consultar los horarios.");
  }
  const dow = new Date(`${day}T12:00:00`).getDay();
  const barberObj = barbersList.find((x) => x.id == barber);
  const daySchedule = barberObj?.schedule?.[String(dow)];
  if (!daySchedule) {
    t.add(new Option("Sin horarios", ""));
    return hint("Este barbero no atiende ese día.");
  }
  const [openH, openM] = daySchedule.open.split(":").map(Number);
  const [closeH, closeM] = daySchedule.close.split(":").map(Number);
  const OPEN = openH * 60 + openM, CLOSE = closeH * 60 + closeM;

  hint("Consultando horarios...");
  let data;
  try {
    data = await api(`slots?${new URLSearchParams({ barber, day })}`);
  } catch {
    t.add(new Option("Error", ""));
    return hint("No se pudieron consultar los horarios.");
  }
  const taken = data.map((r) => [+new Date(r.starts_at), +new Date(r.starts_at) + r.duration_min * 60000]);
  const free = [];
  for (let m = OPEN; m + s.duration_min <= CLOSE; m += STEP) {
    const hm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const start = +new Date(`${day}T${hm}:00-05:00`), end = start + s.duration_min * 60000;
    if (start > Date.now() && !taken.some(([a, b]) => start < b && end > a)) free.push(hm);
  }
  t.add(new Option(free.length ? "Selecciona una hora" : "Sin horarios", ""));
  free.forEach((h) => t.add(new Option(formatTime12(h), h)));
  t.disabled = !free.length;
  hint(free.length ? `${free.length} horarios disponibles.` : "No hay horarios disponibles ese día.");
}

async function loadMine() {
  const ids = mine(), sec = $("mis-citas");
  if (!ids.length) { sec.hidden = true; return; }
  let data;
  try {
    data = await api(`my-bookings?ids=${ids.join(",")}`);
  } catch { sec.hidden = true; return; }
  if (!data.length) { sec.hidden = true; return; }
  sec.hidden = false;
  $("my-bookings-list").innerHTML = data.map((b) => {
    const d = new Date(b.starts_at), tz = { timeZone: "America/Bogota" };
    const can = ["pending", "approved"].includes(b.status) && d > new Date();
    return `<div class="my-booking">
      <div>
        <strong>${esc(b.service_name)}</strong> con ${esc(b.barber_name)}
        <span>${d.toLocaleDateString("es-CO", { ...tz, day: "2-digit", month: "short", year: "numeric" })} · ${d.toLocaleTimeString("es-CO", { ...tz, hour: "numeric", minute: "2-digit", hour12: true })}</span>
      </div>
      <span class="my-status status-${esc(b.status)}">${esc(LABELS[b.status] || b.status)}</span>
      ${can ? `<button class="button button-outline" type="button" data-cancel="${esc(b.id)}">Cancelar</button>` : ""}
    </div>`;
  }).join("");
}

async function init() {
  $("current-year").textContent = new Date().getFullYear();
  $("date").min = new Date().toLocaleDateString("en-CA");
  let s, b;
  try {
    [s, b] = await Promise.all([api("services"), api("barbers")]);
  } catch {
    $("services-list").innerHTML = "";
    $("services-error").textContent = "No se pudieron cargar los servicios. Intenta más tarde.";
    return;
  }
  services = s;
  barbersList = b;
  $("services-list").innerHTML = services.map((x) => `
    <article class="service-card">
      <h3>${esc(x.name)}</h3>
      <p class="service-description">${esc(x.description)}</p>
      <div class="service-meta">
        <span class="service-price">${money(x.price)}</span>
        <span class="service-duration">${x.duration_min} min</span>
      </div>
      <button class="service-action" type="button" data-id="${x.id}">Reservar este servicio</button>
    </article>`).join("");
  fill("service", services, "Selecciona un servicio", (x) => `${x.name} — ${money(x.price)}`);
  fill("barber", b, "Selecciona un barbero", (x) => x.name);
}

$("services-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  $("service").value = btn.dataset.id;
  loadSlots();
  $("reservar").scrollIntoView();
});

$("my-bookings-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-cancel]");
  if (!btn || !confirm("¿Seguro que quieres cancelar esta cita?")) return;
  btn.disabled = true;
  try {
    await api(`bookings/${btn.dataset.cancel}/cancel`, { method: "POST" });
    myMsg("Tu cita fue cancelada.", "success");
  } catch {
    myMsg("No se pudo cancelar la cita.", "error");
  }
  await loadMine();
  await loadSlots();
});

["service", "barber", "date"].forEach((id) => $(id).addEventListener("change", loadSlots));
const form = $("booking-form");
const syncButton = () => { $("submit-button").disabled = !form.checkValidity(); };
form.addEventListener("input", syncButton);
form.addEventListener("change", syncButton);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("submit-button").disabled = true;
  msg("Enviando solicitud...");
  try {
    const data = await api("bookings", {
      method: "POST",
      body: {
        barber: $("barber").value,
        service: Number($("service").value),
        start: new Date(`${$("date").value}T${$("time").value}:00-05:00`).toISOString(),
        name: $("customer-name").value,
        phone: $("customer-phone").value,
      },
    });
    saveMine(data.id);
    form.reset();
    await loadSlots();
    await loadMine();
    msg("¡Solicitud enviada! Quedará pendiente hasta que el barbero la apruebe. Puedes verla y cancelarla en «Mis citas».", "success");
  } catch (err) {
    msg(err.message?.includes("taken") ? "Ese horario acaba de ser tomado. Elige otro." : err.message?.includes("closed") ? "Este barbero no está recibiendo reservas por ahora. Elige otro." : "No se pudo enviar la solicitud. Intenta de nuevo.", "error");
    await loadSlots();
  }
  syncButton();
});

init();
loadMine();
