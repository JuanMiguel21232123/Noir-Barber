// Ya no se necesita ninguna key aquí: la página ahora habla con tu propia
// API en /api/*, que es la que internamente habla con Turso.
const API_BASE = "/api";

async function api(path, opts = {}) {
  const res = await fetch(`${API_BASE}/${path}`, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || "Error de red");
    err.status = res.status;
    throw err;
  }
  return data;
}
