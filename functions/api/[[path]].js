// ============================================================================
// Backend de NOIR Barber Studio sobre Cloudflare Pages Functions + Turso.
// Reemplaza: Supabase Auth (login/sesión) y las 4 funciones RPC
// (taken_slots, create_booking, my_bookings, cancel_booking).
//
// Variables de entorno necesarias (Cloudflare Pages > tu proyecto >
// Settings > Environment variables):
//   TURSO_URL     -> ej: https://tu-base-tuorg.turso.io
//   TURSO_TOKEN   -> el token de la base (Turso dashboard > tu base > Tokens)
//   JWT_SECRET    -> cualquier cadena larga y aleatoria (marca "Encrypt")
// ============================================================================

const COOKIE_NAME = "session";
const SESSION_SECONDS = 60 * 60 * 24 * 7; // 7 días

// ---------- utilidades generales ----------

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}
const bad = (msg, status = 400) => json({ error: msg }, { status });

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// ---------- Turso (HTTP API / Hrana pipeline) ----------

function toArg(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  return { type: "text", value: String(v) };
}
function fromCell(cell) {
  if (!cell || cell.type === "null") return null;
  if (cell.type === "integer") return Number(cell.value);
  if (cell.type === "float") return cell.value;
  return cell.value;
}

async function tursoRun(env, statements) {
  // statements: [{sql, args: []}, ...]  -> se ejecutan en UNA sola conexión (pipeline)
  const res = await fetch(`${env.TURSO_URL}/v2/pipeline`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.TURSO_TOKEN}`,
    },
    body: JSON.stringify({
      requests: [
        ...statements.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: (s.args || []).map(toArg) } })),
        { type: "close" },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Error de Turso: " + JSON.stringify(data));

  return data.results.filter((r) => r.type !== "close" || r.response).map((r) => {
    if (r.type === "error") throw new Error("Turso SQL error: " + (r.error?.message || JSON.stringify(r.error)));
    const result = r.response?.result;
    if (!result) return { rows: [], affectedRowCount: 0, lastInsertRowid: null };
    const cols = (result.cols || []).map((c) => c.name);
    const rows = (result.rows || []).map((row) => {
      const obj = {};
      row.forEach((cell, i) => (obj[cols[i]] = fromCell(cell)));
      return obj;
    });
    return {
      rows,
      affectedRowCount: Number(result.affected_row_count || 0),
      lastInsertRowid: result.last_insert_rowid ?? null,
    };
  }).slice(0, statements.length);
}
// atajo para una sola sentencia
const tursoOne = (env, sql, args) => tursoRun(env, [{ sql, args }]).then((r) => r[0]);

// ---------- contraseñas (PBKDF2 vía Web Crypto, sin dependencias) ----------

function toHex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function fromHex(hex) { const a = new Uint8Array(hex.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a; }

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return `pbkdf2$100000$${toHex(salt)}$${toHex(bits)}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]), salt = fromHex(parts[2]), expected = parts[3];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  const got = toHex(bits);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ---------- JWT (HS256 minimal, sin dependencias) ----------

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signJWT(payload, secret, expSeconds) {
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expSeconds };
  const unsigned = `${b64url(new TextEncoder().encode(JSON.stringify(header)))}.${b64url(new TextEncoder().encode(JSON.stringify(body)))}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}
async function verifyJWT(token, secret) {
  try {
    const [h, p, s] = token.split(".");
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlToBuf(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBuf(p)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function getSessionBarber(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return null;
  const r = await tursoOne(env, "SELECT id, name, accepting, active FROM barbers WHERE id = ?", [payload.sub]);
  const barber = r.rows[0];
  if (!barber || !barber.active) return null;
  return barber;
}

function setCookieHeader(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}
function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------- horarios: generación y choque de citas ----------

function dayBoundsBogota(day) {
  // day = "YYYY-MM-DD" -> límites del día en hora de Bogotá (UTC-5 fijo, sin horario de verano)
  return [`${day}T00:00:00-05:00`, `${day}T23:59:59-05:00`];
}

// ---------- horario semanal de cada barbero (se reutiliza semana a semana) ----------
// Formato guardado en barbers.schedule (columna TEXT con JSON):
//   { "0": null, "1": {"open":"08:00","close":"20:00"}, ... "6": {...} }
// Las llaves son el día de la semana como en Date#getDay() (0 = domingo … 6 = sábado).
// null / ausente = el barbero no atiende ese día.

const DEFAULT_SCHEDULE = {
  0: null,
  1: { open: "08:00", close: "20:00" },
  2: { open: "08:00", close: "20:00" },
  3: { open: "08:00", close: "20:00" },
  4: { open: "08:00", close: "20:00" },
  5: { open: "08:00", close: "20:00" },
  6: { open: "08:00", close: "20:00" },
};

function parseSchedule(raw) {
  if (!raw) return DEFAULT_SCHEDULE;
  try {
    const s = JSON.parse(raw);
    return s && typeof s === "object" ? s : DEFAULT_SCHEDULE;
  } catch {
    return DEFAULT_SCHEDULE;
  }
}

// Valida y normaliza un horario enviado por el panel admin antes de guardarlo.
function validateSchedule(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
  for (const day of ["0", "1", "2", "3", "4", "5", "6"]) {
    const v = input[day];
    if (v === null || v === undefined) {
      out[day] = null;
      continue;
    }
    if (typeof v !== "object" || !timeRe.test(v.open) || !timeRe.test(v.close)) return null;
    if (v.open >= v.close) return null;
    out[day] = { open: v.open, close: v.close };
  }
  return out;
}

// Convierte un Date (instante UTC) a los componentes de hora local de Bogotá (UTC-5 fijo),
// sin depender de la zona horaria del entorno donde corre el worker.
function bogotaParts(date) {
  const local = new Date(date.getTime() - 5 * 60 * 60000);
  return { dow: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

// ============================================================================
// Router
// ============================================================================

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = (params.path || []).join("/");
  const method = request.method;
  const url = new URL(request.url);

  try {
    // ---------------- públicas ----------------

    if (method === "GET" && path === "services") {
      const r = await tursoOne(env, "SELECT * FROM services WHERE active = 1 ORDER BY price");
      return json(r.rows);
    }

    if (method === "GET" && path === "barbers") {
      const r = await tursoOne(env, "SELECT id, name, schedule FROM barbers WHERE active = 1 AND accepting = 1 ORDER BY name");
      return json(r.rows.map((b) => ({ id: b.id, name: b.name, schedule: parseSchedule(b.schedule) })));
    }

    if (method === "GET" && path === "slots") {
      const barber = url.searchParams.get("barber"), day = url.searchParams.get("day");
      if (!barber || !day) return bad("Falta barber o day");
      const [from, to] = dayBoundsBogota(day);
      const r = await tursoOne(
        env,
        "SELECT starts_at, duration_min FROM bookings WHERE barber_id = ? AND status IN ('pending','approved') AND starts_at BETWEEN ? AND ?",
        [barber, from, to]
      );
      return json(r.rows);
    }

    if (method === "POST" && path === "bookings") {
      const b = await request.json().catch(() => ({}));
      const { barber, service, start, name, phone } = b;
      if (!barber || !service || !start || !name || !phone) return bad("Faltan datos de la reserva");

      const svcRes = await tursoOne(env, "SELECT * FROM services WHERE id = ? AND active = 1", [service]);
      const svc = svcRes.rows[0];
      if (!svc) return bad("Servicio no válido");

      const startsAt = new Date(start);
      if (isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now()) return bad("Horario no válido");
      const endsAt = new Date(startsAt.getTime() + svc.duration_min * 60000);

      const barberRowSched = await tursoOne(env, "SELECT schedule FROM barbers WHERE id = ? AND active = 1", [barber]);
      if (!barberRowSched.rows[0]) return bad("Barbero no válido");
      const schedule = parseSchedule(barberRowSched.rows[0].schedule);
      const { dow, minutes } = bogotaParts(startsAt);
      const day = schedule[String(dow)];
      if (!day) return bad("Este barbero no atiende ese día.", 409);
      const [openH, openM] = day.open.split(":").map(Number);
      const [closeH, closeM] = day.close.split(":").map(Number);
      const openMin = openH * 60 + openM, closeMin = closeH * 60 + closeM;
      if (minutes < openMin || minutes + svc.duration_min > closeMin) {
        return bad("Ese horario está fuera del horario de atención del barbero.", 409);
      }

      const id = crypto.randomUUID();

      const r = await tursoOne(
        env,
        `INSERT INTO bookings (id, barber_id, service_id, starts_at, ends_at, duration_min, price, status, customer_name, customer_phone)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
         WHERE (SELECT accepting FROM barbers WHERE id = ? AND active = 1) = 1
           AND NOT EXISTS (
             SELECT 1 FROM bookings
             WHERE barber_id = ? AND status IN ('pending','approved')
               AND starts_at < ? AND ends_at > ?
           )`,
        [id, barber, service, startsAt.toISOString(), endsAt.toISOString(), svc.duration_min, svc.price, name, phone,
         barber, barber, endsAt.toISOString(), startsAt.toISOString()]
      );
      if (r.affectedRowCount === 0) {
        const barberRow = await tursoOne(env, "SELECT accepting FROM barbers WHERE id = ? AND active = 1", [barber]);
        if (!barberRow.rows[0] || !barberRow.rows[0].accepting) return bad("closed: barbero no disponible", 409);
        return bad("taken: horario ya tomado", 409);
      }
      return json({ id });
    }

    if (method === "GET" && path === "my-bookings") {
      const ids = (url.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
      if (!ids.length) return json([]);
      const placeholders = ids.map(() => "?").join(",");
      const r = await tursoOne(
        env,
        `SELECT b.id, b.status, b.starts_at, b.customer_name, s.name AS service_name, br.name AS barber_name
         FROM bookings b JOIN services s ON s.id = b.service_id JOIN barbers br ON br.id = b.barber_id
         WHERE b.id IN (${placeholders}) ORDER BY b.starts_at DESC`,
        ids
      );
      return json(r.rows);
    }

    if (method === "POST" && path.match(/^bookings\/[^/]+\/cancel$/)) {
      const id = path.split("/")[1];
      const r = await tursoOne(
        env,
        "UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status IN ('pending','approved') AND starts_at > datetime('now')",
        [id]
      );
      if (r.affectedRowCount === 0) return bad("No se pudo cancelar la cita", 409);
      return json({ ok: true });
    }

    // ---------------- autenticación ----------------

    if (method === "POST" && path === "login") {
      const { username, password } = await request.json().catch(() => ({}));
      if (!username || !password) return bad("Usuario o contraseña faltante");
      const r = await tursoOne(env, "SELECT * FROM barbers WHERE username = ? AND active = 1", [String(username).toLowerCase()]);
      const barber = r.rows[0];
      const ok = barber && (await verifyPassword(password, barber.pass_hash));
      if (!ok) return bad("Usuario o contraseña incorrectos.", 401);
      const token = await signJWT({ sub: barber.id }, env.JWT_SECRET, SESSION_SECONDS);
      return json(
        { id: barber.id, name: barber.name, accepting: !!barber.accepting },
        { headers: { "Set-Cookie": setCookieHeader(token) } }
      );
    }

    if (method === "POST" && path === "logout") {
      return json({ ok: true }, { headers: { "Set-Cookie": clearCookieHeader() } });
    }

    if (method === "GET" && path === "session") {
      const barber = await getSessionBarber(request, env);
      if (!barber) return bad("No autenticado", 401);
      return json({ id: barber.id, name: barber.name, accepting: !!barber.accepting });
    }

    // ---------------- admin (requiere sesión) ----------------

    if (path.startsWith("admin/")) {
      const barber = await getSessionBarber(request, env);
      if (!barber) return bad("No autenticado", 401);

      if (method === "GET" && path === "admin/bookings") {
        const r = await tursoOne(
          env,
          `SELECT b.*, s.name AS service_name FROM bookings b
           JOIN services s ON s.id = b.service_id
           WHERE b.barber_id = ? ORDER BY b.starts_at DESC LIMIT 1000`,
          [barber.id]
        );
        return json(r.rows);
      }

      if (method === "PATCH" && path.match(/^admin\/bookings\/[^/]+$/)) {
        const id = path.split("/")[2];
        const { status } = await request.json().catch(() => ({}));
        if (!["pending", "approved", "completed", "rejected", "cancelled"].includes(status)) return bad("Estado no válido");
        const r = await tursoOne(env, "UPDATE bookings SET status = ? WHERE id = ? AND barber_id = ?", [status, id, barber.id]);
        if (r.affectedRowCount === 0) return bad("No se pudo actualizar la cita", 404);
        return json({ ok: true });
      }

      if (method === "PATCH" && path === "admin/accepting") {
        const { accepting } = await request.json().catch(() => ({}));
        const r = await tursoOne(env, "UPDATE barbers SET accepting = ? WHERE id = ?", [accepting ? 1 : 0, barber.id]);
        if (r.affectedRowCount === 0) return bad("No se pudo actualizar", 404);
        return json({ accepting: !!accepting });
      }

      if (method === "GET" && path === "admin/schedule") {
        const r = await tursoOne(env, "SELECT schedule FROM barbers WHERE id = ?", [barber.id]);
        return json({ schedule: parseSchedule(r.rows[0]?.schedule) });
      }

      if (method === "PATCH" && path === "admin/schedule") {
        const { schedule } = await request.json().catch(() => ({}));
        const valid = validateSchedule(schedule);
        if (!valid) return bad("Horario no válido. Revisa que la hora de apertura sea antes que la de cierre.");
        const r = await tursoOne(env, "UPDATE barbers SET schedule = ? WHERE id = ?", [JSON.stringify(valid), barber.id]);
        if (r.affectedRowCount === 0) return bad("No se pudo actualizar", 404);
        return json({ schedule: valid });
      }
    }

    return bad("No encontrado", 404);
  } catch (err) {
    console.error(err);
    return bad("Error del servidor: " + err.message, 500);
  }
}
