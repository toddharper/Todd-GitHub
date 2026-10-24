/* Venue Network Atlas — browser app backed by Supabase. No build step. */
(() => {
  "use strict";

  // ---------- constants ----------
  const PORTFOLIOS = ["Legends", "Live Nation", "Real Madrid"];
  const TABS = [
    { id: "equipment", label: "Network Equipment" },
    { id: "circuits", label: "Circuits" },
    { id: "ip_addresses", label: "IP Addressing" },
    { id: "diagram", label: "Site Diagram" },
  ];
  const COLS = {
    equipment: [
      { f: "hostname", l: "Hostname", mono: 1 },
      { f: "role", l: "Role", opts: ["Firewall", "Core switch", "Access switch", "Router", "Wireless controller", "Access point", "Server", "UPS", "Other"] },
      { f: "model", l: "Make / Model" }, { f: "serial", l: "Serial", mono: 1 }, { f: "mgmt_ip", l: "Mgmt IP", mono: 1 },
      { f: "location", l: "Location / Rack" }, { f: "notes", l: "Notes" }],
    circuits: [
      { f: "role", l: "Role", opts: ["Primary", "Secondary", "Backup"] }, { f: "carrier", l: "Carrier" },
      { f: "circuit_id", l: "Circuit / Account ID", mono: 1 }, { f: "bandwidth", l: "Bandwidth" },
      { f: "ip_block", l: "WAN IP / Block", mono: 1, hosts: 1 }, { f: "gateway", l: "Gateway", mono: 1 },
      { f: "account", l: "Account / Rep" }, { f: "support", l: "Support" },
      { f: "status", l: "Status", opts: ["Active", "Pending", "Down", "Decommissioned"], chip: 1 }, { f: "notes", l: "Notes" }],
    ip_addresses: [
      { f: "vlan", l: "VLAN", mono: 1 }, { f: "name", l: "Name" }, { f: "subnet", l: "Subnet / Address", mono: 1, hosts: 1 },
      { f: "gateway", l: "Gateway", mono: 1 }, { f: "dhcp", l: "DHCP range", mono: 1 }, { f: "notes", l: "Notes" }],
  };
  const INTRO = {
    equipment: "Every managed device at the site, with its management address and physical location.",
    circuits: "Carrier circuits terminating at the site. Keep the circuit ID and support number handy for trouble tickets.",
    ip_addresses: "VLANs, subnets and public addresses in use at the site. Usable host counts are calculated from the CIDR prefix.",
  };
  const VENUE_FIELDS = ["id", "name", "code", "portfolio", "status", "description", "client", "address", "city", "state", "zip", "country",
    "contact_name", "contact_title", "contact_phone", "contact_email", "contact_employer", "venue_tech", "notes", "parent_id",
    "diagram_path", "diagram_kind", "diagram_notes", "updated_at", "updated_by"];

  // ---------- setup ----------
  const CFG = window.ATLAS_CONFIG || {};
  const configured = !!(CFG.supabaseUrl && CFG.supabaseKey && !/YOUR-/.test(CFG.supabaseUrl + CFG.supabaseKey));
  const sb = configured && window.supabase ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;

  const S = {
    email: "", role: null, venues: [], byId: new Map(), sel: null, tab: "equipment", view: "venues",
    editing: false, draft: null, isNew: false, editBase: null, q: "", group: "All", loaded: false, loadedAt: 0,
    delArmed: false, pending: [], signed: {}, history: null, users: [], rmArmed: null, otpEmail: "",
  };
  try { const t = localStorage.getItem("vna.tab"); if (TABS.some(x => x.id === t)) S.tab = t; } catch (e) {}

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const canEdit = () => S.role === "editor" || S.role === "admin";
  const isAdmin = () => S.role === "admin";
  const needsReview = v => /Import review/.test(v.notes || "");
  const slug = s => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "venue";
  const fmtTime = t => t ? new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";

  function toast(msg, ms = 2800) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
  }
  function hostsFor(cidr) {
    const m = String(cidr || "").trim().match(/^(\d{1,3}\.){3}\d{1,3}\/(\d{1,2})$/); if (!m) return "";
    const p = +m[2]; if (p > 32) return ""; if (p === 32) return "1 host"; if (p === 31) return "2 hosts (p2p)";
    return (2 ** (32 - p) - 2).toLocaleString() + " usable";
  }
  function blankVenue() {
    const v = {}; VENUE_FIELDS.forEach(f => (v[f] = ""));
    Object.assign(v, { portfolio: "Legends", status: "Active", parent_id: null, updated_at: null, equipment: [], circuits: [], ip_addresses: [] });
    return v;
  }
  function norm(row) {
    const v = blankVenue(); Object.assign(v, row);
    for (const k of ["equipment", "circuits", "ip_addresses"]) {
      v[k] = (Array.isArray(row[k]) ? row[k] : []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(r => { const o = {}; COLS[k].forEach(c => (o[c.f] = r[c.f] ?? "")); return o; });
    }
    return v;
  }
  function friendlyError(err, fallback) {
    const m = (err && (err.message || err.error_description)) || "";
    if (/fetch|network|Failed to/i.test(m)) return "Couldn't reach the database. Check your connection and try again.";
    if (/JWT expired|invalid claim/i.test(m)) return "Your session expired. Sign in again.";
    return m || fallback;
  }

  // ---------- gate screens ----------
  function showGate(html) { $("app").hidden = true; $("gate").hidden = false; $("gateCard").innerHTML = html; }
  function showApp() { $("gate").hidden = true; $("app").hidden = false; }

  function renderSetup() {
    showGate(`<h1>Venue Network Atlas</h1>
      <p>This copy isn't connected to a database yet.</p>
      <p>Open <code>config.js</code> and paste in your Supabase project URL and publishable key, then commit and reload. The README walks through each step.</p>`);
  }
  function renderSignIn(state = {}) {
    const sent = !!S.otpEmail;
    showGate(`<h1>Venue Network Atlas</h1>
      <p>Sign in with your work email. Only people on the access list can get in.</p>
      <form id="signInForm" class="form-section" novalidate>
        <div class="field"><label class="label" for="signInEmail">Work email</label>
          <input id="signInEmail" type="email" autocomplete="email" required value="${esc(S.otpEmail)}" ${sent ? "readonly" : ""}></div>
        ${sent ? `<div class="field"><label class="label" for="otpCode">Sign-in code from the email</label>
          <input id="otpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="6-digit code"></div>` : ""}
        <div class="row">
          <button class="btn primary" type="submit" id="signInBtn">${sent ? "Sign in" : "Email me a sign-in link"}</button>
          ${sent ? `<button class="btn ghost" type="button" id="otpRestart">Use a different email</button>` : ""}
        </div>
      </form>
      ${sent ? `<div class="msg ok">Check your inbox for an email from Supabase. Click the link in it, or type the code above.</div>` : ""}
      ${state.error ? `<div class="msg bad">${esc(state.error)}</div>` : ""}`);
    $("signInForm").addEventListener("submit", onSignIn);
    $("otpRestart")?.addEventListener("click", () => { S.otpEmail = ""; renderSignIn(); });
    (sent ? $("otpCode") : $("signInEmail")).focus();
  }
  async function onSignIn(e) {
    e.preventDefault();
    const btn = $("signInBtn"); btn.disabled = true;
    if (!S.otpEmail) {
      const email = $("signInEmail").value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { btn.disabled = false; return renderSignIn({ error: "Enter a valid email address." }); }
      btn.textContent = "Sending…";
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true } });
      if (error) {
        const m = error.message || "";
        let msg = friendlyError(error, "Couldn't send the sign-in email. Try again.");
        if (/Database error|not on the|access list|Signups not allowed/i.test(m)) msg = "That email isn't on the access list. Ask a Venue Network Atlas admin to add you.";
        else if (/rate limit|too many|seconds/i.test(m) || error.status === 429) msg = "Too many sign-in emails were requested. Wait a minute and try again.";
        return renderSignIn({ error: msg });
      }
      S.otpEmail = email; renderSignIn();
    } else {
      const token = $("otpCode").value.replace(/\s+/g, "");
      if (!token) { btn.disabled = false; return renderSignIn({ error: "Type the code from the email, or click the link in it." }); }
      btn.textContent = "Signing in…";
      const { error } = await sb.auth.verifyOtp({ email: S.otpEmail, token, type: "email" });
      if (error) return renderSignIn({ error: /expired|invalid/i.test(error.message) ? "That code is wrong or has expired. Request a new email." : friendlyError(error, "Sign-in failed.") });
    }
  }
  function renderNotListed() {
    showGate(`<h1>No access yet</h1>
      <p>You're signed in as <strong>${esc(S.email)}</strong>, but that email isn't on the Venue Network Atlas access list.</p>
      <p>Ask an admin to add you, then reload this page.</p>
      <div class="row"><button class="btn" id="gateSignOut">Sign out</button></div>`);
    $("gateSignOut").addEventListener("click", () => sb.auth.signOut());
  }

  // ---------- data ----------
  async function loadAll(quiet) {
    const { data, error } = await sb.from("venues").select("*, equipment(*), circuits(*), ip_addresses(*)").order("name");
    if (error) { if (!quiet) toast(friendlyError(error, "Couldn't load venues.")); S.loaded = true; render(); return; }
    S.venues = data.map(norm); S.byId = new Map(S.venues.map(v => [v.id, v]));
    S.loadedAt = Date.now();
    if (!S.loaded) {
      S.loaded = true;
      const h = decodeURIComponent((location.hash || "").slice(1));
      S.sel = S.byId.has(h) ? h : (filtered()[0]?.id || null);
    } else if (!S.editing && S.sel && !S.byId.has(S.sel)) S.sel = filtered()[0]?.id || null;
    if (S.editing) renderList(); else render();
  }
  function putVenue(v) {
    const i = S.venues.findIndex(x => x.id === v.id);
    if (i >= 0) S.venues[i] = v; else S.venues.push(v);
    S.venues.sort((a, b) => a.name.localeCompare(b.name)); S.byId.set(v.id, v);
  }

  async function signedUrl(path) {
    const c = S.signed[path]; if (c && c.exp > Date.now()) return c.url;
    const { data, error } = await sb.storage.from("diagrams").createSignedUrl(path, 3600);
    if (error) throw error;
    S.signed[path] = { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 };
    return data.signedUrl;
  }

  // ---------- list ----------
  function filtered() {
    const q = S.q.trim().toLowerCase();
    let l = S.venues.filter(v => S.group === "All" || (S.group === "Review" ? needsReview(v) : v.portfolio === S.group));
    if (q) l = l.filter(v => JSON.stringify([v.name, v.code, v.description, v.client, v.address, v.city, v.state, v.zip, v.contact_name,
      v.contact_email, v.contact_phone, v.venue_tech, v.notes, v.equipment, v.circuits, v.ip_addresses]).toLowerCase().includes(q));
    return l.slice().sort((a, b) => (a.status === "Obsolete") - (b.status === "Obsolete") || a.name.localeCompare(b.name));
  }
  function renderList() {
    const n = g => g === "All" ? S.venues.length : g === "Review" ? S.venues.filter(needsReview).length : S.venues.filter(v => v.portfolio === g).length;
    $("groups").innerHTML = ["All", ...PORTFOLIOS, "Review"].filter(g => g !== "Review" || n("Review"))
      .map(g => `<button class="gchip${g === S.group ? " on" : ""}${g === "Review" ? " rev" : ""}" data-g="${g}" aria-pressed="${g === S.group}">${g === "Review" ? "Needs review" : esc(g)}<span>${n(g)}</span></button>`).join("");
    const list = filtered();
    $("count").textContent = !S.loaded ? "Loading venues…" : (S.q || S.group !== "All") ? `${list.length} of ${S.venues.length} venues` : `${S.venues.length} venue${S.venues.length === 1 ? "" : "s"}`;
    $("list").innerHTML = list.map(v => `<li><button class="venue-item${v.id === S.sel && S.view === "venues" ? " on" : ""}${v.status === "Obsolete" ? " obs" : ""}" data-id="${esc(v.id)}">
      <span class="n">${needsReview(v) ? '<i class="dot" title="Needs review"></i>' : ""}${esc(v.name)}</span><span class="c">${v.status === "Obsolete" ? "Obsolete" : esc(v.code)}</span>
      <span class="a">${esc([v.city, v.state].filter(Boolean).join(", ") || v.address || "No address yet")}</span></button></li>`).join("")
      || (S.loaded ? `<li style="padding:14px;color:var(--muted);font-size:14px">${S.q || S.group !== "All" ? "No venues match." : "No venues yet."}</li>` : "");
    $("addVenue").hidden = !canEdit();
    $("adminTools").hidden = !isAdmin();
  }

  // ---------- venue view ----------
  function cell(kind, col, row, i) {
    const val = row[col.f] ?? "";
    if (S.editing) {
      const id = `${kind}-${i}-${col.f}`;
      if (col.opts) return `<td><select id="${id}" data-kind="${kind}" data-i="${i}" data-f="${col.f}" aria-label="${esc(col.l)}"><option value=""></option>${col.opts.map(o => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}${val && !col.opts.includes(val) ? `<option selected>${esc(val)}</option>` : ""}</select></td>`;
      return `<td><input id="${id}" class="${col.mono ? "mono" : ""}" value="${esc(val)}" data-kind="${kind}" data-i="${i}" data-f="${col.f}" aria-label="${esc(col.l)}"></td>`;
    }
    if (col.chip && val) return `<td><span class="chip ${esc(val)}">${esc(val)}</span></td>`;
    if (col.hosts && val) { const h = hostsFor(val); return `<td><span class="mono">${esc(val)}</span>${h ? `<div class="hosts">${h}</div>` : ""}</td>`; }
    return `<td class="${col.mono ? "mono" : ""}">${esc(val) || '<span class="dash">—</span>'}</td>`;
  }
  function tablePanel(kind, v) {
    const cols = COLS[kind], rows = v[kind];
    const head = cols.map(c => `<th>${c.l}</th>`).join("") + (S.editing ? "<th></th>" : "");
    const body = rows.length ? rows.map((r, i) => `<tr>${cols.map(c => cell(kind, c, r, i)).join("")}${S.editing ? `<td class="rm"><button class="btn ghost" data-rm="${kind}" data-i="${i}">Remove</button></td>` : ""}</tr>`).join("")
      : `<tr class="empty-row"><td colspan="${cols.length + (S.editing ? 1 : 0)}">Nothing recorded yet${canEdit() && !S.editing ? ". Choose Edit venue to add entries" : ""}.</td></tr>`;
    return `<p class="panel-intro">${INTRO[kind]}</p><div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      ${S.editing ? `<button class="btn add-row" data-add="${kind}">+ Add row</button>` : ""}`;
  }
  function diagramPanel(v) {
    const view = v.diagram_path
      ? `<div class="diagram-frame" id="diagView" data-path="${esc(v.diagram_path)}" data-kind="${esc(v.diagram_kind)}"><span class="muted">Loading diagram…</span></div>`
      : `<div class="diagram-empty">No site diagram uploaded yet.${canEdit() && !S.editing ? " Choose Edit venue to attach a PNG, JPG, SVG or PDF." : ""}</div>`;
    const up = S.editing ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <label class="btn" for="diagFile">${v.diagram_path ? "Replace diagram…" : "Upload diagram…"}</label>
        <input type="file" id="diagFile" accept="image/png,image/jpeg,image/svg+xml,image/webp,application/pdf" hidden>
        ${v.diagram_path ? `<button class="btn ghost" id="diagClear">Remove diagram</button>` : ""}<span class="ro-note" id="diagStatus"></span></div>` : "";
    const notes = S.editing
      ? `<div class="field"><label class="label" for="diagNotes">Diagram notes</label><textarea id="diagNotes" data-path="diagram_notes">${esc(v.diagram_notes)}</textarea></div>`
      : (v.diagram_notes ? `<div><div class="label">Notes</div><div class="diagram-notes">${esc(v.diagram_notes)}</div></div>` : "");
    return `<div class="diagram">${view}${up}${notes}</div>`;
  }
  async function fillDiagram() {
    const box = $("diagView"); if (!box) return;
    const path = box.dataset.path, kind = box.dataset.kind;
    try {
      const url = await signedUrl(path);
      if ($("diagView")?.dataset.path !== path) return;
      const name = esc(path.split("/").pop().replace(/^\d+-/, ""));
      box.innerHTML = kind === "pdf" ? `<iframe src="${esc(url)}" title="Site diagram"></iframe>` : `<img src="${esc(url)}" alt="Site diagram">`;
      box.insertAdjacentHTML("afterend", `<div><a href="${esc(url)}" target="_blank" rel="noopener">Open ${name} in a new tab</a></div>`);
    } catch (e) { box.innerHTML = `<span class="muted">Couldn't load the diagram. ${esc(friendlyError(e, ""))}</span>`; }
  }

  function headView(v) {
    const line2 = [v.city, [v.state, v.zip].filter(Boolean).join(" "), v.country && v.country !== "USA" ? v.country : ""].filter(Boolean).join(", ");
    const kv = (k, val) => val ? `<div class="kv"><span class="label">${k}</span><span class="v">${esc(val)}</span><button class="copy" data-copy="${esc(val)}">Copy</button></div>` : "";
    const parent = v.parent_id && S.byId.get(v.parent_id);
    const kids = S.venues.filter(x => x.parent_id === v.id);
    const descBits = [v.description, v.client && v.client !== v.description ? v.client : "", v.portfolio !== "Legends" ? v.portfolio : ""].filter(Boolean);
    return `<div class="rec-head"><div>
        <div class="title-row"><h2>${esc(v.name)}</h2>${v.code ? `<span class="code-tag">${esc(v.code)}</span>` : ""}${v.status === "Obsolete" ? `<span class="status-chip">Obsolete</span>` : ""}</div>
        ${descBits.length ? `<div class="desc">${esc(descBits.join(" · "))}</div>` : ""}
        <div class="addr">${esc(v.address) || '<span class="muted">No street address</span>'}${line2 ? `<br>${esc(line2)}` : ""}</div>
        <div class="meta">
          ${parent ? `<span>Part of <button class="linkish" data-goto="${esc(parent.id)}">${esc(parent.name)}</button></span>` : ""}
          ${kids.length ? `<span>Also on this site: ${kids.map(k => `<button class="linkish" data-goto="${esc(k.id)}">${esc(k.name)}</button>`).join(", ")}</span>` : ""}
          ${v.updated_at ? `<span>Last updated ${esc(fmtTime(v.updated_at))}${v.updated_by ? ` by ${esc(v.updated_by)}` : ""}</span>` : ""}
        </div>
      </div>
      <div class="contact"><div class="label">Main contact</div>
        ${v.contact_name ? `<div class="who">${esc(v.contact_name)}</div>${v.contact_title || v.contact_employer ? `<div class="role">${esc([v.contact_title, v.contact_employer].filter(Boolean).join(" · "))}</div>` : ""}` : `<div class="role" style="margin:0">No contact recorded</div>`}
        ${kv("Phone", v.contact_phone)}${kv("Email", v.contact_email)}
        ${v.venue_tech && v.venue_tech !== v.contact_name ? `<div class="kv"><span class="label">Tech</span><span class="v">${esc(v.venue_tech)}</span><span></span></div>` : ""}
      </div></div>
      ${v.notes ? `<div class="notes-wrap"><div class="notes-box${needsReview(v) ? " review" : ""}"><span class="label">${needsReview(v) ? "Notes · needs review" : "Notes"}</span>${esc(v.notes)}</div></div>` : ""}`;
  }
  function headEdit(v) {
    const f = (path, label, wide, type = "text") => `<div class="field${wide ? " wide" : ""}"><label class="label" for="f-${path}">${label}</label><input id="f-${path}" type="${type}" data-path="${path}" value="${esc(v[path])}"></div>`;
    const sel = (path, label, opts, val) => `<div class="field"><label class="label" for="f-${path}">${label}</label><select id="f-${path}" data-path="${path}">${opts.map(([k, t]) => `<option value="${esc(k)}"${k === (val ?? "") ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></div>`;
    const parents = [["", "None"], ...S.venues.filter(x => x.id !== v.id).map(x => [x.id, x.name])];
    return `<div class="rec-head"><div class="form-section"><div class="label">Venue</div><div class="form-grid">
        ${f("name", "Venue name")}${f("code", "Site code / short name")}
        ${sel("portfolio", "Portfolio", PORTFOLIOS.map(p => [p, p]), v.portfolio)}${sel("status", "Status", [["Active", "Active"], ["Obsolete", "Obsolete"]], v.status)}
        ${f("description", "Description", 1)}${f("client", "Client / tenant", 1)}
        ${f("address", "Street address", 1)}
        ${f("city", "City")}${f("state", "State / province")}${f("zip", "ZIP / postal code")}${f("country", "Country")}
        <div class="field wide"><label class="label" for="f-parent_id">Part of (shared network)</label><select id="f-parent_id" data-path="parent_id">${parents.map(([k, t]) => `<option value="${esc(k)}"${k === (v.parent_id || "") ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
      </div></div>
      <div class="form-section"><div class="label">Main contact</div><div class="form-grid">
        ${f("contact_name", "Name")}${f("contact_title", "Title")}
        ${f("contact_phone", "Phone", 0, "tel")}${f("contact_email", "Email", 0, "email")}
        ${f("contact_employer", "Employer")}${f("venue_tech", "Venue tech")}
        <div class="field wide"><label class="label" for="f-notes">Notes</label><textarea id="f-notes" data-path="notes">${esc(v.notes)}</textarea></div>
      </div></div></div>`;
  }
  function historyBlock() {
    if (!S.history) return "";
    if (S.history === "loading") return `<div class="history">Loading change history…</div>`;
    if (!S.history.length) return `<div class="history">No changes recorded yet.</div>`;
    const word = { create: "Created", update: "Updated", delete: "Deleted" };
    return `<div class="history"><span class="label">Change history</span><ol>${S.history.map(h => `<li>${esc(word[h.action] || h.action)} ${esc(fmtTime(h.changed_at))} by ${esc(h.changed_by || "unknown")}</li>`).join("")}</ol></div>`;
  }

  function renderMain() {
    const m = $("main");
    if (S.view === "access") return renderAccess();
    const v = S.editing ? S.draft : S.byId.get(S.sel);
    if (!v) {
      m.innerHTML = S.loaded && !S.venues.length
        ? `<div class="blank"><h2>No venues yet</h2><p>Each venue gets a record with contact details, network equipment, circuits, IP addressing and a site diagram. ${canEdit() ? "Add the first venue, or load the seed file described in the README." : "Ask an editor to add venues."}</p>${canEdit() ? `<button class="btn primary" id="addVenue2">+ Add venue</button>` : ""}</div>`
        : `<div class="blank"><h2>${S.loaded ? "Select a venue" : "Loading venues…"}</h2><p>${S.loaded ? "Choose a venue from the list to see its details." : ""}</p></div>`;
      return;
    }
    const counts = { equipment: v.equipment.length, circuits: v.circuits.length, ip_addresses: v.ip_addresses.length };
    const actions = S.editing
      ? `<span class="ro-note">${S.isNew ? "New venue, not saved yet" : "Editing"}</span><span class="spacer"></span>
         ${!S.isNew ? `<button class="btn danger${S.delArmed ? " armed" : ""}" id="del">${S.delArmed ? "Confirm delete" : "Delete venue"}</button>` : ""}
         <button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save venue</button>`
      : `<button class="btn ghost" id="toggleHistory">${S.history ? "Hide history" : "Change history"}</button><span class="spacer"></span>
         ${canEdit() ? `<button class="btn" id="edit">Edit venue</button>` : `<span class="ro-note">View only</span>`}`;
    const body = S.tab === "diagram" ? diagramPanel(v) : tablePanel(S.tab, v);
    m.innerHTML = `<section class="record">${S.editing ? headEdit(v) : headView(v)}<div class="actions">${actions}</div>${S.editing ? "" : historyBlock()}
      <div class="tabs" role="tablist">${TABS.map(t => `<button class="tab${t.id === S.tab ? " on" : ""}" role="tab" aria-selected="${t.id === S.tab}" data-tab="${t.id}">${t.label}${counts[t.id] !== undefined ? `<span class="badge">${counts[t.id]}</span>` : ""}</button>`).join("")}</div>
      <div class="panel" role="tabpanel">${body}</div></section>`;
    if (S.tab === "diagram") fillDiagram();
  }
  function render() { renderList(); renderMain(); }

  // ---------- venue actions ----------
  function select(id) {
    if (S.editing) { toast("Save or cancel your edits first."); return; }
    S.view = "venues"; S.sel = id; S.delArmed = false; S.history = null;
    try { history.replaceState(null, "", "#" + encodeURIComponent(id)); } catch (e) {}
    render();
    if (matchMedia("(max-width:820px)").matches) $("main").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function startEdit() {
    const v = S.byId.get(S.sel); if (!v) return;
    S.draft = clone(v); S.editBase = v.updated_at; S.editing = true; S.isNew = false; S.delArmed = false; S.pending = [];
    render();
  }
  function startNew() {
    if (S.editing) { toast("Save or cancel your edits first."); return; }
    S.view = "venues"; S.draft = blankVenue(); S.editing = true; S.isNew = true; S.editBase = null; S.pending = []; S.tab = "equipment";
    render(); setTimeout(() => $("f-name")?.focus(), 0);
  }
  async function discardPending(keep) {
    const drop = S.pending.filter(p => p && p !== keep);
    S.pending = [];
    if (drop.length) await sb.storage.from("diagrams").remove(drop).catch(() => {});
  }
  function cancel() {
    discardPending(null);
    S.editing = false; S.draft = null; S.isNew = false; S.delArmed = false;
    if (S.sel && !S.byId.has(S.sel)) S.sel = filtered()[0]?.id || null;
    render();
  }
  async function save() {
    const d = S.draft;
    if (!d.name.trim()) { toast("Give the venue a name before saving."); $("f-name")?.focus(); return; }
    const btn = $("save"); btn.disabled = true; btn.textContent = "Saving…";
    if (S.isNew) {
      let id = slug(d.name), n = 2; while (S.byId.has(id)) id = `${slug(d.name)}-${n++}`;
      d.id = id;
    }
    const keepRow = r => Object.values(r).some(x => String(x || "").trim());
    const payload = {};
    VENUE_FIELDS.forEach(f => (payload[f] = d[f] ?? ""));
    payload.parent_id = d.parent_id || null;
    for (const k of ["equipment", "circuits", "ip_addresses"]) payload[k] = d[k].filter(keepRow);
    const oldPath = S.isNew ? "" : (S.byId.get(d.id)?.diagram_path || "");
    const { data, error } = await sb.rpc("save_venue", { payload, is_new: S.isNew, expected_updated_at: S.isNew ? null : S.editBase });
    if (error) {
      btn.disabled = false; btn.textContent = "Save venue";
      const msg = friendlyError(error, "Couldn't save. Try again.");
      toast(error.code === "40001" ? msg + " Cancel, then reopen the venue to see their changes." : msg, 5000);
      return;
    }
    await discardPending(payload.diagram_path);
    if (oldPath && oldPath !== payload.diagram_path) sb.storage.from("diagrams").remove([oldPath]).catch(() => {});
    const saved = norm(data); putVenue(saved);
    S.sel = saved.id; S.editing = false; S.draft = null; S.isNew = false; S.history = null;
    try { history.replaceState(null, "", "#" + encodeURIComponent(saved.id)); } catch (e) {}
    toast("Venue saved"); render();
  }
  async function del() {
    if (!S.delArmed) { S.delArmed = true; renderMain(); return; }
    const v = S.byId.get(S.draft.id);
    const { error } = await sb.rpc("delete_venue", { v_id: S.draft.id });
    if (error) { toast(friendlyError(error, "Couldn't delete the venue.")); return; }
    await discardPending(null);
    if (v?.diagram_path) sb.storage.from("diagrams").remove([v.diagram_path]).catch(() => {});
    S.venues = S.venues.filter(x => x.id !== S.draft.id); S.byId.delete(S.draft.id);
    S.editing = false; S.draft = null; S.delArmed = false; S.sel = filtered()[0]?.id || null;
    toast("Venue deleted"); render();
  }
  async function uploadDiagram(file) {
    const st = $("diagStatus");
    const okType = /^(image\/(png|jpeg|webp|svg\+xml)|application\/pdf)$/.test(file.type);
    if (!okType) { if (st) st.textContent = "Use a PNG, JPG, WebP, SVG or PDF file."; return; }
    if (file.size > 20 * 1024 * 1024) { if (st) st.textContent = "That file is over 20 MB."; return; }
    if (st) st.textContent = "Uploading…";
    const safe = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").slice(-80);
    const path = `${S.draft.id || "new"}/${Date.now()}-${safe}`;
    const { error } = await sb.storage.from("diagrams").upload(path, file, { contentType: file.type, upsert: false });
    if (error) { if ($("diagStatus")) $("diagStatus").textContent = "Upload failed: " + friendlyError(error, "try again."); return; }
    S.pending.push(path);
    S.draft.diagram_path = path; S.draft.diagram_kind = file.type === "application/pdf" ? "pdf" : "image";
    renderMain(); toast("Diagram attached. Save the venue to keep it.");
  }
  async function toggleHistory() {
    if (S.history) { S.history = null; renderMain(); return; }
    S.history = "loading"; renderMain();
    const id = S.sel;
    const { data, error } = await sb.from("venue_changes").select("action, changed_at, changed_by").eq("venue_id", id).order("changed_at", { ascending: false }).limit(25);
    if (S.sel !== id) return;
    S.history = error ? [] : data; renderMain();
  }

  // ---------- access list (admins) ----------
  async function openAccess() {
    if (S.editing) { toast("Save or cancel your edits first."); return; }
    S.view = "access"; S.rmArmed = null; render();
    const { data, error } = await sb.from("allowed_users").select("*").order("email");
    if (error) { toast(friendlyError(error, "Couldn't load the access list.")); return; }
    S.users = data; renderAccess();
  }
  function renderAccess() {
    const roleSel = u => `<select data-role="${esc(u.email)}" aria-label="Role for ${esc(u.email)}">${["viewer", "editor", "admin"].map(r => `<option${r === u.role ? " selected" : ""}>${r}</option>`).join("")}</select>`;
    $("main").innerHTML = `<section class="access">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h2>Access list</h2><button class="btn small" id="closeAccess">Back to venues</button></div>
      <p>Only these emails can sign in. Viewers can read everything, editors can also change venues, and admins can also manage this list.</p>
      <form class="add-user" id="addUser" novalidate>
        <div class="field"><label class="label" for="nuEmail">Email</label><input id="nuEmail" type="email" required placeholder="name@legends.net"></div>
        <div class="field"><label class="label" for="nuName">Name (optional)</label><input id="nuName"></div>
        <div class="field"><label class="label" for="nuRole">Role</label><select id="nuRole"><option>viewer</option><option>editor</option><option>admin</option></select></div>
        <button class="btn primary" type="submit">Add person</button>
      </form>
      <div class="tbl-wrap"><table><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Added</th><th></th></tr></thead><tbody>
        ${S.users.length ? S.users.map(u => `<tr><td class="mono">${esc(u.email)}${u.email === S.email ? ' <span class="muted">(you)</span>' : ""}</td><td>${esc(u.display_name) || '<span class="dash">—</span>'}</td>
          <td>${roleSel(u)}</td><td class="muted">${esc(fmtTime(u.added_at))}${u.added_by ? `<br>by ${esc(u.added_by)}` : ""}</td>
          <td class="rm"><button class="btn ${S.rmArmed === u.email ? "danger armed" : "ghost"}" data-rmuser="${esc(u.email)}">${S.rmArmed === u.email ? "Confirm remove" : "Remove"}</button></td></tr>`).join("")
        : `<tr class="empty-row"><td colspan="5">Loading…</td></tr>`}
      </tbody></table></div>
      <p>Removing someone stops them from reading anything right away. They stay signed in on their device until they sign out, but they'll only see an empty page.</p>
    </section>`;
  }
  async function addUser(e) {
    e.preventDefault();
    const email = $("nuEmail").value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("Enter a valid email address."); return; }
    const { error } = await sb.from("allowed_users").insert({ email, display_name: $("nuName").value.trim(), role: $("nuRole").value });
    if (error) { toast(error.code === "23505" ? "That email is already on the list." : friendlyError(error, "Couldn't add that person.")); return; }
    toast(`Added ${email}. They can sign in now.`); openAccess();
  }
  async function setRole(email, role) {
    const { error } = await sb.from("allowed_users").update({ role }).eq("email", email);
    if (error) { toast(friendlyError(error, "Couldn't change the role."), 5000); }
    else { toast(`${email} is now ${role === "admin" ? "an admin" : "a" + (role === "editor" ? "n " : " ") + role}.`); if (email === S.email) { S.role = role; updateMe(); } }
    openAccess();
  }
  async function removeUser(email) {
    if (S.rmArmed !== email) { S.rmArmed = email; renderAccess(); return; }
    const { error } = await sb.from("allowed_users").delete().eq("email", email);
    S.rmArmed = null;
    if (error) toast(friendlyError(error, "Couldn't remove that person."), 5000); else toast(`Removed ${email}.`);
    openAccess();
  }

  // ---------- export (admins) ----------
  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  function exportJson() { download(`venue-atlas-${stamp()}.json`, JSON.stringify(S.venues, null, 2), "application/json"); }
  function exportCsv() {
    const q = x => `"${String(x ?? "").replace(/"/g, '""')}"`;
    const cols = ["id", "name", "portfolio", "status", "code", "description", "client", "address", "city", "state", "zip", "country",
      "contact_name", "contact_title", "contact_phone", "contact_email", "contact_employer", "venue_tech", "notes"];
    const rows = [[...cols, "circuits", "wan_ips"].map(q).join(",")];
    for (const v of S.venues) rows.push([...cols.map(c => q(v[c])),
      q(v.circuits.map(c => [c.role, c.carrier, c.circuit_id, c.bandwidth].filter(Boolean).join(" ")).join(" | ")),
      q(v.circuits.map(c => c.ip_block).filter(Boolean).join(" | "))].join(","));
    download(`venue-atlas-${stamp()}.csv`, rows.join("\r\n"), "text/csv");
  }

  function copy(text) {
    const done = () => toast("Copied");
    const fallback = () => { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); done(); } catch (e) { toast("Select the text to copy it"); } ta.remove(); };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
  }
  function updateMe() { $("meEmail").textContent = S.email; $("meRole").textContent = S.role || ""; }

  // ---------- events ----------
  $("q").addEventListener("input", e => { S.q = e.target.value; renderList(); });
  $("groups").addEventListener("click", e => { const b = e.target.closest(".gchip"); if (b) { S.group = b.dataset.g; renderList(); } });
  $("addVenue").addEventListener("click", startNew);
  $("signOut").addEventListener("click", () => sb.auth.signOut());
  $("openAccess").addEventListener("click", openAccess);
  $("exportJson").addEventListener("click", exportJson);
  $("exportCsv").addEventListener("click", exportCsv);
  $("list").addEventListener("click", e => { const b = e.target.closest(".venue-item"); if (b) select(b.dataset.id); });

  $("main").addEventListener("click", e => {
    const t = e.target.closest("button,[data-tab]"); if (!t) return;
    if (t.dataset.tab) { S.tab = t.dataset.tab; try { localStorage.setItem("vna.tab", S.tab); } catch (err) {} renderMain(); return; }
    if (t.dataset.copy !== undefined) { copy(t.dataset.copy); return; }
    if (t.dataset.goto) { select(t.dataset.goto); return; }
    if (t.dataset.rmuser) { removeUser(t.dataset.rmuser); return; }
    if (t.dataset.add) {
      const kind = t.dataset.add, row = {};
      COLS[kind].forEach(c => (row[c.f] = c.f === "status" ? "Active" : (kind === "circuits" && c.f === "role") ? "Primary" : ""));
      S.draft[kind].push(row); renderMain();
      document.getElementById(`${kind}-${S.draft[kind].length - 1}-${COLS[kind][0].f}`)?.focus(); return;
    }
    if (t.dataset.rm) { S.draft[t.dataset.rm].splice(+t.dataset.i, 1); renderMain(); return; }
    switch (t.id) {
      case "edit": startEdit(); break;
      case "cancel": cancel(); break;
      case "save": save(); break;
      case "del": del(); return;
      case "addVenue2": startNew(); break;
      case "toggleHistory": toggleHistory(); break;
      case "closeAccess": S.view = "venues"; render(); break;
      case "diagClear": S.draft.diagram_path = ""; S.draft.diagram_kind = ""; renderMain(); break;
    }
    if (S.delArmed && t.id !== "del") { S.delArmed = false; if (S.editing) renderMain(); }
  });
  $("main").addEventListener("input", e => {
    const el = e.target; if (!S.editing) return;
    if (el.dataset.kind) S.draft[el.dataset.kind][+el.dataset.i][el.dataset.f] = el.value;
    else if (el.dataset.path) S.draft[el.dataset.path] = el.value;
  });
  $("main").addEventListener("change", e => {
    const el = e.target;
    if (el.id === "diagFile" && el.files?.[0]) uploadDiagram(el.files[0]);
    else if (el.dataset.role) setRole(el.dataset.role, el.value);
    else if (S.editing && el.dataset.kind) S.draft[el.dataset.kind][+el.dataset.i][el.dataset.f] = el.value;
    else if (S.editing && el.dataset.path) S.draft[el.dataset.path] = el.value;
  });
  $("main").addEventListener("submit", e => { if (e.target.id === "addUser") addUser(e); });
  window.addEventListener("focus", () => { if (S.role && !S.editing && S.view === "venues" && Date.now() - S.loadedAt > 60000) loadAll(true); });
  window.addEventListener("beforeunload", e => { if (S.editing) { e.preventDefault(); e.returnValue = ""; } });

  // ---------- auth flow ----------
  let lastUser = null;
  async function onSession(session) {
    const email = session?.user?.email?.toLowerCase() || "";
    if (email === lastUser) return; lastUser = email;
    if (!email) { S.role = null; S.email = ""; S.venues = []; S.byId = new Map(); S.loaded = false; renderSignIn(); return; }
    S.email = email; S.otpEmail = "";
    if (/[#&](access_token|error)=/.test(location.hash)) { try { history.replaceState(null, "", location.pathname); } catch (e) {} }
    const { data, error } = await sb.from("allowed_users").select("role").eq("email", email).maybeSingle();
    if (error) { showGate(`<h1>Venue Network Atlas</h1><div class="msg bad">${esc(friendlyError(error, "Couldn't check your access."))}</div><div class="row"><button class="btn" onclick="location.reload()">Try again</button></div>`); return; }
    S.role = data?.role || null;
    if (!S.role) { renderNotListed(); return; }
    updateMe(); showApp(); render(); loadAll();
  }

  if (!configured) { renderSetup(); return; }
  if (!sb) { showGate(`<h1>Venue Network Atlas</h1><div class="msg bad">The Supabase library didn't load. Check your connection and reload.</div>`); return; }
  sb.auth.onAuthStateChange((event, session) => { setTimeout(() => onSession(session), 0); });
})();
