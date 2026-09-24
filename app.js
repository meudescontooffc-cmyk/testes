/* ============================================================
   GRANJA M SANTOS — Sistema de gestão de vendas
   Persistência: Firebase (Authentication + Firestore)
   Funciona offline: o Firestore guarda os dados no aparelho e
   sincroniza sozinho quando a conexão volta.
   ============================================================ */

import { firebaseConfig, auth, db, AUTH_EMAIL_DOMAIN, getSecondaryAuthInstance } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, writeBatch, runTransaction,
  onSnapshot, query, where, orderBy, limit, increment,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

/* ---------- CONSTANTES ---------- */

const QUICK_QTY_KG = [0.5, 1, 1.5, 2, 2.5, 3, 5];
const QUICK_VALUE_REAIS = [10, 15, 20, 25, 30, 50];
const PAYMENT_METHODS = ["Dinheiro", "Pix", "Cartão"];
const PIE_COLORS = ["#C17817", "#3C6E52", "#A63D2F"];

const EMPLOYEE_NAV = [{ key: "home", label: "Atendimentos" }];
const ADMIN_NAV = [
  { key: "overview", label: "Visão geral" },
  { key: "sales", label: "Histórico" },
  { key: "stock", label: "Estoque" },
  { key: "closing", label: "Fechamento" },
  { key: "reports", label: "Relatórios" },
  { key: "products", label: "Produtos" },
  { key: "users", label: "Usuários" },
];

const CONFIG_IS_PLACEHOLDER = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("COLE_AQUI");

/* ---------- HELPERS ---------- */

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brl = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtQty = (v, unit) => {
  const n = Number(v) || 0;
  const s = n.toLocaleString("pt-BR", { minimumFractionDigits: unit === "kg" ? (n % 1 === 0 ? 0 : 2) : 0, maximumFractionDigits: 2 });
  return `${s} ${unit === "kg" ? "kg" : "un"}`;
};
const dateKey = (d = new Date()) => {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};
const dateLabel = (key) => { const [y, m, d] = key.split("-"); return `${d}/${m}/${y}`; };
const timeLabel = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const greeting = () => { const h = new Date().getHours(); if (h < 12) return "Bom dia"; if (h < 18) return "Boa tarde"; return "Boa noite"; };
const usernameToEmail = (username) => `${username.trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;

/* ---------- ESTADO GLOBAL ---------- */

const state = {
  booting: true,
  needsSetup: false,
  authError: "",
  currentUser: null,
  core: { products: [], users: [] },
  sales: [],
  movements: [],
  atendimentos: [],
  dailyNote: { totalReceivedKg: 0 },
  page: "home",
  openAtendimentoId: null,
  panelOpen: window.innerWidth > 880,
  online: navigator.onLine,
  hasPendingWrites: false,
  historySelectedDay: null,
  historyFilterEmployee: "",
  historyFilterPayment: "",
  reportsRange: 7,
  stockView: "table",
  counter: 1,
  unsubs: [],
};

window.addEventListener("online", () => { state.online = true; render(); });
window.addEventListener("offline", () => { state.online = false; render(); });

function connStatus() {
  if (!state.online) return "offline";
  if (state.hasPendingWrites) return "syncing";
  return "online";
}

function unsubscribeAll() { state.unsubs.forEach((u) => u()); state.unsubs = []; }

function markPending(snap) {
  const pending = snap.metadata.hasPendingWrites;
  if (pending !== state.hasPendingWrites) { state.hasPendingWrites = pending; }
}

function subscribeAll() {
  unsubscribeAll();

  state.unsubs.push(onSnapshot(collection(db, "products"), (snap) => {
    markPending(snap);
    state.core.products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => console.error("products:", err)));

  state.unsubs.push(onSnapshot(collection(db, "users"), (snap) => {
    state.core.users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => console.error("users:", err)));

  state.unsubs.push(onSnapshot(query(collection(db, "sales"), orderBy("timestamp", "desc"), limit(500)), (snap) => {
    markPending(snap);
    state.sales = snap.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
    render();
  }, (err) => console.error("sales:", err)));

  state.unsubs.push(onSnapshot(query(collection(db, "movements"), orderBy("timestamp", "desc"), limit(500)), (snap) => {
    state.movements = snap.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
    render();
  }, (err) => console.error("movements:", err)));

  if (state.currentUser.role === "employee") {
    state.unsubs.push(onSnapshot(query(collection(db, "atendimentos"), where("employeeUid", "==", state.currentUser.uid)), (snap) => {
      markPending(snap);
      state.atendimentos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }, (err) => console.error("atendimentos:", err)));
  } else {
    state.unsubs.push(onSnapshot(doc(db, "dailyNotes", dateKey()), (snap) => {
      state.dailyNote = snap.exists() ? snap.data() : { totalReceivedKg: 0 };
      render();
    }, (err) => console.error("dailyNotes:", err)));
  }
}

/* ---------- AUTENTICAÇÃO ---------- */

async function checkBootstrap() {
  try {
    const snap = await getDoc(doc(db, "meta", "bootstrap"));
    state.needsSetup = !snap.exists();
  } catch (e) {
    state.needsSetup = false;
  }
}

onAuthStateChanged(auth, async (fbUser) => {
  state.authError = "";
  unsubscribeAll();

  if (!fbUser) {
    state.currentUser = null;
    state.booting = false;
    await checkBootstrap();
    render();
    return;
  }

  try {
    const profileSnap = await getDoc(doc(db, "users", fbUser.uid));
    if (!profileSnap.exists()) {
      await signOut(auth);
      state.authError = "Esta conta ainda não tem um perfil configurado. Fale com o proprietário.";
      state.booting = false;
      render();
      return;
    }
    const profile = profileSnap.data();
    if (profile.active === false) {
      await signOut(auth);
      state.authError = "Este usuário está desativado. Fale com o proprietário.";
      state.booting = false;
      render();
      return;
    }
    state.currentUser = { uid: fbUser.uid, ...profile };
    state.page = state.currentUser.role === "admin" ? "overview" : "home";
    state.booting = false;
    subscribeAll();
    render();
  } catch (e) {
    console.error(e);
    state.booting = false;
    state.authError = "Erro ao carregar seus dados. Verifique sua conexão.";
    render();
  }
});

async function tryLogin(username, password) {
  try {
    await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
    return null;
  } catch (e) {
    if (["auth/invalid-credential", "auth/user-not-found", "auth/wrong-password"].includes(e.code)) return "Usuário ou senha incorretos.";
    if (e.code === "auth/too-many-requests") return "Muitas tentativas seguidas. Aguarde um momento e tente de novo.";
    if (e.code === "auth/network-request-failed") return "Sem conexão com a internet no momento.";
    console.error(e);
    return "Não foi possível entrar. Verifique a configuração do Firebase.";
  }
}

async function trySetup(name, username, password) {
  try {
    const cred = await createUserWithEmailAndPassword(auth, usernameToEmail(username), password);
    await setDoc(doc(db, "users", cred.user.uid), { name, username, role: "admin", active: true });
    await setDoc(doc(db, "meta", "bootstrap"), { done: true, createdAt: new Date().toISOString() });
    return null;
  } catch (e) {
    if (e.code === "auth/email-already-in-use") return "Esse nome de usuário já existe.";
    if (e.code === "auth/weak-password") return "A senha precisa ter pelo menos 6 caracteres.";
    console.error(e);
    return "Não foi possível criar a conta. Verifique a configuração do Firebase (chaves em firebase-config.js).";
  }
}

function logout() { signOut(auth); }

/* ---------- ATENDIMENTOS (FUNCIONÁRIO) ---------- */

async function startAtendimento() {
  const label = `Cliente ${String(state.atendimentos.length + state.counter).padStart(2, "0")}`;
  state.counter += 1;
  const ref = doc(collection(db, "atendimentos")); // gera o ID na hora, sem precisar de rede
  const optimistic = { id: ref.id, employeeUid: state.currentUser.uid, label, items: [], startedAt: new Date().toISOString() };
  // Atualiza a tela imediatamente, sem esperar o Firebase confirmar —
  // é isso que evita o "flash" da tela de atendimentos antes de abrir os produtos.
  state.atendimentos = [...state.atendimentos, optimistic];
  state.openAtendimentoId = ref.id;
  render();
  await setDoc(ref, { employeeUid: optimistic.employeeUid, label: optimistic.label, items: optimistic.items, startedAt: optimistic.startedAt });
}
async function cancelAtendimento(id) {
  if (state.openAtendimentoId === id) state.openAtendimentoId = null;
  await deleteDoc(doc(db, "atendimentos", id));
}
async function addItemToAtendimento(atId, product, qty) {
  const at = state.atendimentos.find((a) => a.id === atId);
  if (!at) return;
  const items = [...at.items, { productId: product.id, name: product.name, unit: product.unit, qty, unitPrice: product.price, subtotal: Number((qty * product.price).toFixed(2)) }];
  await updateDoc(doc(db, "atendimentos", atId), { items });
}
async function removeItemFromAtendimento(atId, idx) {
  const at = state.atendimentos.find((a) => a.id === atId);
  if (!at) return;
  const items = at.items.filter((_, i) => i !== idx);
  await updateDoc(doc(db, "atendimentos", atId), { items });
}
async function finalizeSale(atId, paymentMethod) {
  const at = state.atendimentos.find((a) => a.id === atId);
  if (!at) return;
  const total = Number(at.items.reduce((s, i) => s + i.subtotal, 0).toFixed(2));
  const batch = writeBatch(db);
  const saleRef = doc(collection(db, "sales"));
  batch.set(saleRef, {
    timestamp: new Date().toISOString(),
    employeeUid: state.currentUser.uid,
    employeeUsername: state.currentUser.username,
    employeeName: state.currentUser.name,
    items: at.items, total, paymentMethod,
  });
  at.items.forEach((it) => { batch.update(doc(db, "products", it.productId), { sold: increment(it.qty) }); });
  batch.delete(doc(db, "atendimentos", atId));
  state.openAtendimentoId = null;
  render();
  await batch.commit(); // funciona offline: fica em fila local e sincroniza sozinho
}

/* ---------- AÇÕES ADMINISTRATIVAS ---------- */

async function addProduct(form) {
  await addDoc(collection(db, "products"), { name: form.name, unit: form.unit, price: Number(form.price), minStock: Number(form.minStock) || 0, active: true, received: 0, sold: 0 });
}
async function updateProduct(id, form) {
  await updateDoc(doc(db, "products", id), { name: form.name, unit: form.unit, price: Number(form.price), minStock: Number(form.minStock) || 0 });
}
async function toggleProductActive(id) {
  const p = state.core.products.find((x) => x.id === id);
  await updateDoc(doc(db, "products", id), { active: !p.active });
}
async function registerReceipt(productId, qty, user) {
  let before, after, productName;
  await runTransaction(db, async (tx) => {
    const ref = doc(db, "products", productId);
    const snap = await tx.get(ref);
    const data = snap.data();
    before = data.received - data.sold;
    const newReceived = Number((data.received + qty).toFixed(3));
    after = newReceived - data.sold;
    productName = data.name;
    tx.update(ref, { received: newReceived });
  });
  await addDoc(collection(db, "movements"), { productId, productName, type: "entrada", before, after, user: user.name, timestamp: new Date().toISOString() });
}
async function correctStock(productId, newRemaining, reason, user) {
  let before, productName;
  await runTransaction(db, async (tx) => {
    const ref = doc(db, "products", productId);
    const snap = await tx.get(ref);
    const data = snap.data();
    before = data.received - data.sold;
    const newReceived = Number((newRemaining + data.sold).toFixed(3));
    productName = data.name;
    tx.update(ref, { received: newReceived });
  });
  await addDoc(collection(db, "movements"), { productId, productName, type: "correcao", before, after: newRemaining, reason, user: user.name, timestamp: new Date().toISOString() });
}
async function addUser(form) {
  const { secondaryAuth, cleanup } = getSecondaryAuthInstance();
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, usernameToEmail(form.username), form.password);
    await setDoc(doc(db, "users", cred.user.uid), { name: form.name, username: form.username, role: form.role, active: true });
  } finally {
    await signOut(secondaryAuth).catch(() => {});
    await cleanup();
  }
}
async function updateUser(id, form) {
  await updateDoc(doc(db, "users", id), { name: form.name, role: form.role });
}
async function toggleUserActive(id) {
  const u = state.core.users.find((x) => x.id === id);
  await updateDoc(doc(db, "users", id), { active: !u.active });
}
async function saveDailyNote(value) {
  await setDoc(doc(db, "dailyNotes", dateKey()), {
    totalReceivedKg: Number(String(value).replace(",", ".")) || 0,
    updatedBy: state.currentUser.name,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

/* ---------- COMPONENTES DE UI ---------- */

function connBadge(status) {
  const map = {
    online: { cls: "badge-online", label: "Online", spin: false, glyph: "●" },
    offline: { cls: "badge-offline", label: "Offline — sincronizará depois", spin: false, glyph: "○" },
    syncing: { cls: "badge-syncing", label: "Sincronizando...", spin: true, glyph: "↻" },
  };
  const s = map[status];
  return `<span class="badge ${s.cls}"><span class="${s.spin ? "spin" : ""}">${s.glyph}</span> ${s.label}</span>`;
}
function statCard(label, value, tone) {
  const tones = { ink: "var(--ink)", amber: "var(--amber-dark)", red: "var(--red)", green: "var(--green)" };
  return `<div class="card"><div class="label">${esc(label)}</div><div class="num" style="font-size:24px;color:${tones[tone || "ink"]};margin-top:6px;">${value}</div></div>`;
}

/* ---------- TELA: CONFIGURAÇÃO NECESSÁRIA ---------- */

function renderConfigNeeded() {
  document.getElementById("app").innerHTML = `
    <div class="full-screen-center">
      <div class="card enter" style="max-width:480px;">
        <div class="display" style="font-size:20px;margin-bottom:10px;">Configuração do Firebase pendente</div>
        <p style="color:var(--ink-soft);font-size:14.5px;line-height:1.6;">
          Abra o arquivo <strong>firebase-config.js</strong> e cole os dados do seu projeto Firebase
          no lugar dos campos "COLE_AQUI...". O passo a passo está comentado no topo do próprio arquivo.
        </p>
      </div>
    </div>`;
}

/* ---------- LOGIN / SETUP ---------- */

function renderBoot() {
  document.getElementById("app").innerHTML = `<div class="full-screen-center"><span class="spin" style="font-size:22px;color:var(--amber);">↻</span></div>`;
}

function renderSetup() {
  document.getElementById("app").innerHTML = `
    <div class="full-screen-center">
      <div class="enter" style="width:100%;max-width:400px;">
        <div style="text-align:center;margin-bottom:28px;">
          <div style="width:56px;height:56px;border-radius:16px;background:var(--ink);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;color:var(--amber);font-size:15px;font-weight:700;">GS</div>
          <h1 class="display" style="font-size:22px;margin:0;">Configuração inicial</h1>
          <p style="color:var(--ink-soft);font-size:14px;margin-top:6px;">Crie a conta do proprietário para começar a usar o sistema.</p>
        </div>
        <form id="setup-form" class="card">
          <label class="label">Seu nome</label>
          <input class="input" id="setup-name" style="margin-bottom:14px;" />
          <label class="label">Usuário (login)</label>
          <input class="input" id="setup-username" style="margin-bottom:14px;" placeholder="ex: proprietario" />
          <label class="label">Senha (mínimo 6 caracteres)</label>
          <input class="input" id="setup-password" type="password" style="margin-bottom:8px;" />
          <div id="setup-error" style="color:var(--red);font-size:13px;margin-top:10px;"></div>
          <button class="btn btn-primary btn-block" type="submit" style="margin-top:18px;padding:14px;">Criar conta e entrar</button>
        </form>
      </div>
    </div>`;
  document.getElementById("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    const err = await trySetup(
      document.getElementById("setup-name").value.trim(),
      document.getElementById("setup-username").value.trim(),
      document.getElementById("setup-password").value
    );
    if (err) { document.getElementById("setup-error").textContent = err; btn.disabled = false; }
  });
}

function renderLogin() {
  document.getElementById("app").innerHTML = `
    <div class="full-screen-center">
      <div class="enter" style="width:100%;max-width:380px;">
        <div style="text-align:center;margin-bottom:32px;">
          <div style="width:56px;height:56px;border-radius:16px;background:var(--ink);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;color:var(--amber);font-size:15px;font-weight:700;">GS</div>
          <h1 class="display" style="font-size:24px;margin:0;">Granja M Santos</h1>
          <p style="color:var(--ink-soft);font-size:14px;margin-top:6px;">Gestão de vendas por peso e unidade</p>
        </div>
        <form id="login-form" class="card">
          <label class="label">Usuário</label>
          <input class="input" id="login-username" style="margin-bottom:16px;" autocomplete="username" autofocus />
          <label class="label">Senha</label>
          <input class="input" id="login-password" type="password" style="margin-bottom:8px;" autocomplete="current-password" />
          <div id="login-error" style="color:var(--red);font-size:13px;margin-top:10px;">${esc(state.authError)}</div>
          <button class="btn btn-primary btn-block" type="submit" style="margin-top:18px;padding:14px;">Entrar</button>
        </form>
      </div>
    </div>`;
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    const err = await tryLogin(document.getElementById("login-username").value, document.getElementById("login-password").value);
    if (err) { document.getElementById("login-error").textContent = err; btn.disabled = false; }
  });
}

/* ---------- SHELL ---------- */

function navFor(user) { return user.role === "admin" ? ADMIN_NAV : EMPLOYEE_NAV; }

function renderShell(pageContentHtml, pageTitle) {
  const nav = navFor(state.currentUser);
  const navItemsHtml = (asDrawer) => nav.map((item) => `
    <button class="btn ${state.page === item.key ? "active" : ""}" data-action="nav" data-page="${item.key}" ${asDrawer ? 'data-closedrawer="1"' : ""}>${esc(item.label)}</button>`).join("");

  document.getElementById("app").innerHTML = `
    <div class="layout">
      <aside class="sidebar ${state.panelOpen ? "" : "is-hidden"}">
        <div class="sidebar-brand">
          <div class="sidebar-brand-left"><div class="sidebar-logo">GS</div> Granja M Santos</div>
          <button class="sidebar-close" data-action="closepanel" title="Fechar painel">✕</button>
        </div>
        <nav class="sidebar-nav">${navItemsHtml(false)}</nav>
        <div class="sidebar-foot">
          <div style="margin-bottom:10px;">${connBadge(connStatus())}</div>
          <div style="font-size:13px;color:white;font-weight:600;">${esc(state.currentUser.name)}</div>
          <div style="font-size:12px;margin-bottom:10px;">${state.currentUser.role === "admin" ? "Proprietário" : "Funcionário"}</div>
          <button class="btn btn-ghost btn-block" data-action="logout" style="border-color:#3a392f;color:var(--sidebar-text);">Sair</button>
        </div>
      </aside>

      <div class="content">
        ${!state.panelOpen ? `<div class="desktop-panel-bar"><button data-action="openpanel">☰ Menu</button></div>` : ""}
        <div class="topbar">
          <div style="display:flex;align-items:center;gap:10px;">
            <button class="btn btn-ghost btn-icon" data-action="opendrawer">☰</button>
            <div style="font-weight:700;font-size:16px;">${esc(pageTitle)}</div>
          </div>
          ${connBadge(connStatus())}
        </div>
        <div class="content-inner">${pageContentHtml}</div>
      </div>
    </div>

    ${state.mobileDrawerOpen ? `
    <div class="drawer-backdrop" data-action="closedrawer">
      <div class="drawer">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <span style="font-weight:700;">Menu</span>
          <button class="sidebar-close" data-action="closedrawer">✕</button>
        </div>
        <nav class="sidebar-nav" style="flex:1;">${navItemsHtml(true)}</nav>
        <button class="btn btn-ghost btn-block" data-action="logout" style="border-color:#3a392f;color:var(--sidebar-text);margin-top:14px;">Sair (${esc(state.currentUser.name)})</button>
      </div>
    </div>` : ""}
  `;
}

/* ---------- FUNCIONÁRIO: HOME / ATENDIMENTOS ---------- */

function stockRemaining(productId) {
  const p = state.core.products.find((x) => x.id === productId);
  return p ? p.received - p.sold : 0;
}

function renderEmployeeHome() {
  const openAt = state.atendimentos.find((a) => a.id === state.openAtendimentoId);
  if (openAt) return renderAtendimentoDetail(openAt);

  const mySalesToday = state.sales.filter((s) => s.employeeUid === state.currentUser.uid && dateKey(s.timestamp) === dateKey());
  const myTotalToday = mySalesToday.reduce((s, x) => s + x.total, 0);

  const atCardsHtml = state.atendimentos.length === 0
    ? `<div class="card" style="border-style:dashed;text-align:center;color:var(--ink-soft);padding:30px 0;">Nenhum atendimento em andamento</div>`
    : `<div class="grid-atendimentos">${state.atendimentos.map((a) => atendimentoCardHtml(a)).join("")}</div>`;

  const salesListHtml = mySalesToday.length === 0
    ? `<div style="color:var(--ink-soft);font-size:13.5px;">Nenhuma venda registrada ainda hoje.</div>`
    : `<div class="card hairline-list" style="padding:0;">
        ${mySalesToday.slice().reverse().map((s) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;">
            <div>
              <div style="font-weight:600;font-size:14px;">${timeLabel(s.timestamp)}</div>
              <div style="font-size:12.5px;color:var(--ink-soft);">${esc(s.paymentMethod)}</div>
            </div>
            <span class="num" style="font-size:15px;">${brl(s.total)}</span>
          </div>`).join("")}
      </div>`;

  const html = `
    <div style="margin-bottom:22px;">
      <h1 class="display" style="font-size:22px;margin:0;">${greeting()}, ${esc(state.currentUser.name)}!</h1>
      <p style="color:var(--ink-soft);margin:4px 0 0;">Pronto para atender seus clientes.</p>
    </div>
    <div class="grid-2" style="margin-bottom:26px;">
      ${statCard("Minhas vendas hoje", mySalesToday.length, "ink")}
      ${statCard("Total vendido por mim", brl(myTotalToday), "amber")}
    </div>
    <button class="btn btn-primary btn-block" data-action="startatendimento" style="padding:16px;font-size:16px;margin-bottom:26px;">+ Novo atendimento</button>
    <div class="label" style="margin-bottom:10px;">Atendimentos em andamento</div>
    ${atCardsHtml}
    <div class="label" style="margin:26px 0 10px;">Minhas vendas de hoje</div>
    ${salesListHtml}
  `;
  renderShell(html, "Atendimentos");
}

function atendimentoCardHtml(a) {
  const total = a.items.reduce((s, i) => s + i.subtotal, 0);
  const mins = Math.max(0, Math.round((Date.now() - new Date(a.startedAt).getTime()) / 60000));
  const itemsHtml = a.items.length === 0
    ? `<div style="color:var(--ink-soft);font-size:13.5px;">Nenhum produto ainda</div>`
    : `<div style="font-size:13.5px;color:var(--ink-soft);">
        ${a.items.slice(0, 3).map((it) => `<div>${esc(it.name)} · ${fmtQty(it.qty, it.unit)}</div>`).join("")}
        ${a.items.length > 3 ? `<div>+ ${a.items.length - 3} item(ns)</div>` : ""}
      </div>`;
  return `
    <div class="card enter" style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div class="display" style="font-weight:700;">${esc(a.label)}</div>
        <button class="btn btn-ghost btn-sm" data-action="cancelatendimento" data-id="${a.id}">Cancelar</button>
      </div>
      ${itemsHtml}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
        <span class="num" style="font-size:19px;">${brl(total)}</span>
        <span style="font-size:12px;color:var(--ink-soft);">⏱ ${mins} min</span>
      </div>
      <button class="btn btn-primary" data-action="openatendimento" data-id="${a.id}" style="justify-content:center;">Continuar →</button>
    </div>`;
}

function renderAtendimentoDetail(at) {
  const activeProducts = state.core.products.filter((p) => p.active);
  const productsHtml = activeProducts.map((p) => {
    const remaining = stockRemaining(p.id);
    const low = remaining <= 0;
    return `
      <button class="product-btn" data-action="pickproduct" data-id="${p.id}" ${low ? "disabled" : ""}>
        <span style="font-weight:600;font-size:14.5px;">${esc(p.name)}</span>
        <span class="num" style="color:var(--amber-dark);font-size:14px;">${brl(p.price)}<span style="color:var(--ink-soft);font-weight:500;">/${p.unit}</span></span>
        ${low ? `<span style="font-size:11px;color:var(--red);font-weight:700;">Sem estoque</span>` : ""}
      </button>`;
  }).join("");

  const total = at.items.reduce((s, i) => s + i.subtotal, 0);
  const itemsHtml = at.items.length === 0
    ? `<div style="color:var(--ink-soft);font-size:14px;padding:20px 0;text-align:center;">Toque em um produto acima para adicionar</div>`
    : `<div class="hairline-list">
        ${at.items.map((it, idx) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;">
            <div>
              <div style="font-weight:600;font-size:14.5px;">${esc(it.name)}</div>
              <div style="color:var(--ink-soft);font-size:13px;">${fmtQty(it.qty, it.unit)} × ${brl(it.unitPrice)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="num" style="font-size:15px;">${brl(it.subtotal)}</span>
              <button class="btn btn-ghost btn-icon" data-action="removeitem" data-idx="${idx}">🗑</button>
            </div>
          </div>`).join("")}
      </div>`;

  const html = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">
      <button class="btn btn-ghost btn-icon" data-action="closeatendimento">←</button>
      <div class="display" style="font-weight:700;font-size:18px;">${esc(at.label)}</div>
    </div>
    <div class="label" style="margin-bottom:10px;">Produtos disponíveis</div>
    <div class="grid-products" style="margin-bottom:20px;">${productsHtml}</div>
    <div class="card">
      <div class="label" style="margin-bottom:10px;">Itens do atendimento</div>
      ${itemsHtml}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding-top:14px;border-top:1.5px dashed var(--line);">
        <span style="font-weight:600;">Total</span>
        <span class="num" style="font-size:24px;">${brl(total)}</span>
      </div>
    </div>
    ${at.items.length > 0 ? `<button class="btn btn-primary btn-block" data-action="openfinalize" style="padding:15px;font-size:15.5px;margin-top:16px;">Finalizar venda</button>` : ""}
  `;
  renderShell(html, at.label);
}

/* ---------- MODAIS ---------- */

function openOverlay(html) { document.getElementById("overlay").innerHTML = html; }
function closeOverlay() { document.getElementById("overlay").innerHTML = ""; }

function openQuantityPicker(product) {
  const isKg = product.unit === "kg";
  const priceVal = product.price;
  let mode = "kg"; // "kg" ou "valor" — só existe escolha para produtos por kg
  let currentQty = 0;

  openOverlay(`
    <div class="modal-sheet-backdrop" data-action="closeoverlay">
      <div class="sheet enter" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;">
          <div>
            <div class="display" style="font-weight:700;font-size:18px;">${esc(product.name)}</div>
            <div style="color:var(--ink-soft);font-size:13.5px;">${brl(product.price)} / ${isKg ? "kg" : "un"}</div>
          </div>
          <button class="btn btn-ghost btn-icon" data-action="closeoverlay">✕</button>
        </div>
        ${isKg ? `
          <div style="display:flex;gap:8px;margin-bottom:14px;" id="qty-mode-group">
            <button type="button" class="btn" data-mode="kg" style="flex:1;justify-content:center;border:1.5px solid var(--amber);background:var(--amber-bg);">Por peso (kg)</button>
            <button type="button" class="btn" data-mode="valor" style="flex:1;justify-content:center;border:1.5px solid var(--line);background:transparent;">Por valor (R$)</button>
          </div>` : ""}
        <div id="qty-body"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin:18px 0;padding:12px 0;border-top:1px dashed var(--line);">
          <span style="color:var(--ink-soft);font-size:14px;">Subtotal</span>
          <span class="num" id="qty-subtotal" style="font-size:22px;">R$ 0,00</span>
        </div>
        <button class="btn btn-primary btn-block" id="qty-confirm" disabled style="padding:15px;font-size:15.5px;">Adicionar</button>
      </div>
    </div>`);

  function updateSubtotal() {
    const raw = document.getElementById("qty-input").value;
    const num = Number(String(raw).replace(",", ".")) || 0;
    if (isKg && mode === "valor") {
      currentQty = priceVal > 0 ? Number((num / priceVal).toFixed(3)) : 0;
      document.getElementById("qty-subtotal").textContent = brl(num);
      const equivEl = document.getElementById("qty-equiv");
      if (equivEl) equivEl.textContent = `≈ ${fmtQty(currentQty, "kg")}`;
    } else {
      currentQty = num;
      document.getElementById("qty-subtotal").textContent = brl(num * priceVal);
    }
    document.getElementById("qty-confirm").disabled = !(currentQty > 0);
    return currentQty;
  }

  function renderBody() {
    const body = document.getElementById("qty-body");
    if (!isKg) {
      body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;gap:24px;margin:10px 0;">
          <button class="btn btn-ghost" data-action="stepqty" data-v="-1" style="padding:14px;border-radius:100px;">−</button>
          <span class="num" id="qty-display" style="font-size:40px;min-width:60px;text-align:center;">1</span>
          <button class="btn btn-ghost" data-action="stepqty" data-v="1" style="padding:14px;border-radius:100px;">+</button>
        </div>
        <input type="hidden" id="qty-input" value="1" />`;
      document.querySelectorAll('[data-action="stepqty"]').forEach((btn) => btn.addEventListener("click", () => {
        const hidden = document.getElementById("qty-input");
        const next = Math.max(1, Number(hidden.value) + Number(btn.dataset.v));
        hidden.value = next; document.getElementById("qty-display").textContent = next; updateSubtotal();
      }));
      updateSubtotal();
      return;
    }
    if (mode === "kg") {
      body.innerHTML = `
        <label class="label">Quantidade (kg)</label>
        <input class="input num" id="qty-input" style="font-size:28px;text-align:center;padding:16px;" inputmode="decimal" placeholder="0,000" />
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">
          ${QUICK_QTY_KG.map((v) => `<button class="btn btn-ghost" data-action="quickqty" data-v="${v}" style="padding:8px 14px;font-size:13.5px;">${String(v).replace(".", ",")} kg</button>`).join("")}
        </div>`;
    } else {
      body.innerHTML = `
        <label class="label">Valor (R$)</label>
        <input class="input num" id="qty-input" style="font-size:28px;text-align:center;padding:16px;" inputmode="decimal" placeholder="0,00" />
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">
          ${QUICK_VALUE_REAIS.map((v) => `<button class="btn btn-ghost" data-action="quickvalue" data-v="${v}" style="padding:8px 14px;font-size:13.5px;">R$ ${v}</button>`).join("")}
        </div>
        <div style="font-size:12.5px;color:var(--ink-soft);margin-top:10px;">Peso equivalente: <span id="qty-equiv">—</span></div>`;
    }
    const input = document.getElementById("qty-input");
    input.addEventListener("input", () => { input.value = input.value.replace(/[^0-9,]/g, ""); updateSubtotal(); });
    document.querySelectorAll('[data-action="quickqty"]').forEach((btn) => btn.addEventListener("click", () => { input.value = btn.dataset.v.replace(".", ","); updateSubtotal(); }));
    document.querySelectorAll('[data-action="quickvalue"]').forEach((btn) => btn.addEventListener("click", () => { input.value = btn.dataset.v.replace(".", ","); updateSubtotal(); }));
    input.focus();
  }

  if (isKg) {
    document.querySelectorAll("#qty-mode-group button").forEach((btn) => btn.addEventListener("click", () => {
      mode = btn.dataset.mode;
      document.querySelectorAll("#qty-mode-group button").forEach((b) => { b.style.border = "1.5px solid var(--line)"; b.style.background = "transparent"; });
      btn.style.border = "1.5px solid var(--amber)"; btn.style.background = "var(--amber-bg)";
      renderBody();
    }));
  }
  renderBody();

  document.getElementById("qty-confirm").addEventListener("click", () => {
    updateSubtotal();
    if (currentQty > 0) { addItemToAtendimento(state.openAtendimentoId, product, currentQty); closeOverlay(); }
  });
  document.querySelectorAll('[data-action="closeoverlay"]').forEach((el) => el.addEventListener("click", (e) => { if (e.target === el) closeOverlay(); }));
}

function openFinalizeModal(at) {
  const total = at.items.reduce((s, i) => s + i.subtotal, 0);
  openOverlay(`
    <div class="modal-sheet-backdrop" data-action="closeoverlay">
      <div class="sheet enter" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;margin-bottom:14px;">
          <div class="display" style="font-weight:700;font-size:18px;">Resumo da venda</div>
          <button class="btn btn-ghost btn-icon" data-action="closeoverlay">✕</button>
        </div>
        <div style="max-height:180px;overflow-y:auto;margin-bottom:14px;">
          ${at.items.map((it) => `<div style="display:flex;justify-content:space-between;font-size:14px;padding:6px 0;"><span>${esc(it.name)} · ${fmtQty(it.qty, it.unit)}</span><span class="num">${brl(it.subtotal)}</span></div>`).join("")}
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:16px;padding-top:10px;border-top:1.5px dashed var(--line);">
          <span style="font-weight:600;">Total</span><span class="num" style="font-size:22px;">${brl(total)}</span>
        </div>
        <div class="label">Forma de pagamento</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:18px;" id="payment-options">
          ${PAYMENT_METHODS.map((m) => `<button class="btn btn-ghost" data-action="selectpayment" data-m="${m}" style="justify-content:center;">${m}</button>`).join("")}
        </div>
        <button class="btn btn-primary btn-block" id="finalize-confirm" disabled style="padding:15px;font-size:15.5px;">Confirmar e finalizar</button>
      </div>
    </div>`);

  let selected = null;
  document.querySelectorAll('[data-action="selectpayment"]').forEach((btn) => btn.addEventListener("click", () => {
    selected = btn.dataset.m;
    document.querySelectorAll('[data-action="selectpayment"]').forEach((b) => { b.style.border = "1.5px solid var(--line)"; b.style.background = "transparent"; b.style.color = "var(--ink)"; });
    btn.style.border = "1.5px solid var(--amber)"; btn.style.background = "var(--amber-bg)"; btn.style.color = "var(--amber-dark)";
    document.getElementById("finalize-confirm").disabled = false;
  }));
  document.getElementById("finalize-confirm").addEventListener("click", () => { if (selected) { finalizeSale(at.id, selected); closeOverlay(); } });
  document.querySelectorAll('[data-action="closeoverlay"]').forEach((el) => el.addEventListener("click", (e) => { if (e.target === el) closeOverlay(); }));
}

function openProductForm(product) {
  const f = product || { name: "", unit: "kg", price: "", minStock: "", active: true };
  openOverlay(`
    <div class="modal-backdrop" data-action="closeoverlay">
      <div class="modal enter" onclick="event.stopPropagation()">
        <div class="display" style="font-weight:700;font-size:17px;margin-bottom:16px;">${product ? "Editar produto" : "Novo produto"}</div>
        <label class="label">Nome</label>
        <input class="input" id="pf-name" style="margin-bottom:12px;" value="${esc(f.name)}" />
        <label class="label">Unidade de venda</label>
        <div style="display:flex;gap:8px;margin-bottom:12px;" id="pf-unit-group">
          <button type="button" class="btn" data-unit="kg" style="flex:1;justify-content:center;border:1.5px solid ${f.unit === "kg" ? "var(--amber)" : "var(--line)"};background:${f.unit === "kg" ? "var(--amber-bg)" : "transparent"};">Por KG</button>
          <button type="button" class="btn" data-unit="un" style="flex:1;justify-content:center;border:1.5px solid ${f.unit === "un" ? "var(--amber)" : "var(--line)"};background:${f.unit === "un" ? "var(--amber-bg)" : "transparent"};">Por unidade</button>
        </div>
        <input type="hidden" id="pf-unit-value" value="${f.unit}" />
        <label class="label">Preço (R$)</label>
        <input class="input" id="pf-price" type="number" step="0.01" style="margin-bottom:12px;" value="${f.price}" />
        <label class="label">Estoque mínimo (alerta)</label>
        <input class="input" id="pf-minstock" type="number" step="0.01" style="margin-bottom:18px;" value="${f.minStock}" />
        <div style="display:flex;gap:10px;">
          <button class="btn btn-ghost" style="flex:1;justify-content:center;" data-action="closeoverlay">Cancelar</button>
          <button class="btn btn-primary" id="pf-save" style="flex:1;justify-content:center;">Salvar</button>
        </div>
      </div>
    </div>`);
  document.querySelectorAll("#pf-unit-group button").forEach((btn) => btn.addEventListener("click", () => {
    document.getElementById("pf-unit-value").value = btn.dataset.unit;
    document.querySelectorAll("#pf-unit-group button").forEach((b) => { b.style.border = "1.5px solid var(--line)"; b.style.background = "transparent"; });
    btn.style.border = "1.5px solid var(--amber)"; btn.style.background = "var(--amber-bg)";
  }));
  document.getElementById("pf-save").addEventListener("click", async () => {
    const form = { name: document.getElementById("pf-name").value, unit: document.getElementById("pf-unit-value").value, price: document.getElementById("pf-price").value, minStock: document.getElementById("pf-minstock").value };
    if (!form.name || !form.price) return;
    closeOverlay();
    if (product) await updateProduct(product.id, form); else await addProduct(form);
  });
  document.querySelectorAll('[data-action="closeoverlay"]').forEach((el) => el.addEventListener("click", (e) => { if (e.target === el) closeOverlay(); }));
}

function openUserForm(user) {
  const f = user || { name: "", username: "", password: "", role: "employee" };
  openOverlay(`
    <div class="modal-backdrop" data-action="closeoverlay">
      <div class="modal enter" onclick="event.stopPropagation()">
        <div class="display" style="font-weight:700;font-size:17px;margin-bottom:16px;">${user ? "Editar usuário" : "Novo usuário"}</div>
        <label class="label">Nome</label>
        <input class="input" id="uf-name" style="margin-bottom:12px;" value="${esc(f.name)}" />
        <label class="label">Usuário (login)</label>
        <input class="input" id="uf-username" style="margin-bottom:12px;" value="${esc(f.username)}" ${user ? "disabled" : ""} />
        ${!user ? `<label class="label">Senha (mínimo 6 caracteres)</label><input class="input" id="uf-password" style="margin-bottom:12px;" />` : `
          <div style="font-size:12.5px;color:var(--ink-soft);margin-bottom:12px;">
            Por limitação do Firebase, a senha de outra pessoa não pode ser alterada por aqui.
            Para redefinir, é necessário excluir e recriar o usuário (ou configurar um e-mail real e usar "esqueci minha senha").
          </div>`}
        <label class="label">Função</label>
        <div style="display:flex;gap:8px;margin-bottom:18px;" id="uf-role-group">
          <button type="button" class="btn" data-role="employee" style="flex:1;justify-content:center;border:1.5px solid ${f.role === "employee" ? "var(--amber)" : "var(--line)"};background:${f.role === "employee" ? "var(--amber-bg)" : "transparent"};">Funcionário</button>
          <button type="button" class="btn" data-role="admin" style="flex:1;justify-content:center;border:1.5px solid ${f.role === "admin" ? "var(--amber)" : "var(--line)"};background:${f.role === "admin" ? "var(--amber-bg)" : "transparent"};">Proprietário</button>
        </div>
        <input type="hidden" id="uf-role-value" value="${f.role}" />
        <div style="display:flex;gap:10px;">
          <button class="btn btn-ghost" style="flex:1;justify-content:center;" data-action="closeoverlay">Cancelar</button>
          <button class="btn btn-primary" id="uf-save" style="flex:1;justify-content:center;">Salvar</button>
        </div>
      </div>
    </div>`);
  document.querySelectorAll("#uf-role-group button").forEach((btn) => btn.addEventListener("click", () => {
    document.getElementById("uf-role-value").value = btn.dataset.role;
    document.querySelectorAll("#uf-role-group button").forEach((b) => { b.style.border = "1.5px solid var(--line)"; b.style.background = "transparent"; });
    btn.style.border = "1.5px solid var(--amber)"; btn.style.background = "var(--amber-bg)";
  }));
  document.getElementById("uf-save").addEventListener("click", async () => {
    const saveBtn = document.getElementById("uf-save");
    const form = {
      name: document.getElementById("uf-name").value,
      username: document.getElementById("uf-username").value,
      password: user ? "" : document.getElementById("uf-password").value,
      role: document.getElementById("uf-role-value").value,
    };
    if (!form.name || !form.username || (!user && !form.password)) return;
    saveBtn.disabled = true;
    try {
      if (user) await updateUser(user.id, form); else await addUser(form);
      closeOverlay();
    } catch (e) {
      console.error(e);
      saveBtn.disabled = false;
      alert(e.code === "auth/email-already-in-use" ? "Esse nome de usuário já existe." : "Não foi possível salvar. Verifique a conexão.");
    }
  });
  document.querySelectorAll('[data-action="closeoverlay"]').forEach((el) => el.addEventListener("click", (e) => { if (e.target === el) closeOverlay(); }));
}

function openStockModal(mode, product) {
  const isReceipt = mode === "receipt";
  openOverlay(`
    <div class="modal-backdrop" data-action="closeoverlay">
      <div class="modal enter" onclick="event.stopPropagation()">
        <div class="display" style="font-weight:700;font-size:17px;margin-bottom:4px;">${isReceipt ? "Registrar recebimento" : "Corrigir estoque"}</div>
        <div style="color:var(--ink-soft);font-size:13.5px;margin-bottom:16px;">${esc(product.name)}</div>
        <label class="label">${isReceipt ? `Quantidade recebida (${product.unit})` : `Nova quantidade restante (${product.unit})`}</label>
        <input class="input" id="sm-qty" type="number" step="0.01" style="margin-bottom:12px;" />
        ${!isReceipt ? `<label class="label">Motivo da correção (obrigatório)</label><input class="input" id="sm-reason" style="margin-bottom:12px;" placeholder="ex: contagem física, produto avariado..." />` : ""}
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px;">Esta ação precisa de conexão com a internet.</div>
        <div style="display:flex;gap:10px;margin-top:8px;">
          <button class="btn btn-ghost" style="flex:1;justify-content:center;" data-action="closeoverlay">Cancelar</button>
          <button class="btn btn-primary" id="sm-save" style="flex:1;justify-content:center;">Confirmar</button>
        </div>
      </div>
    </div>`);
  document.getElementById("sm-save").addEventListener("click", async () => {
    const saveBtn = document.getElementById("sm-save");
    const qty = document.getElementById("sm-qty").value;
    const reason = isReceipt ? "" : document.getElementById("sm-reason").value;
    if (qty === "" || (!isReceipt && !reason)) return;
    saveBtn.disabled = true;
    try {
      if (isReceipt) await registerReceipt(product.id, Number(qty), state.currentUser);
      else await correctStock(product.id, Number(qty), reason, state.currentUser);
      closeOverlay();
    } catch (e) {
      console.error(e);
      saveBtn.disabled = false;
      alert("Não foi possível salvar. Verifique sua conexão com a internet.");
    }
  });
  document.querySelectorAll('[data-action="closeoverlay"]').forEach((el) => el.addEventListener("click", (e) => { if (e.target === el) closeOverlay(); }));
}

/* ---------- ADMIN: VISÃO GERAL ---------- */

function renderAdminOverview() {
  const today = dateKey();
  const salesToday = state.sales.filter((s) => dateKey(s.timestamp) === today);
  const totalToday = salesToday.reduce((s, x) => s + x.total, 0);
  const kgSold = salesToday.reduce((s, x) => s + x.items.filter((i) => i.unit === "kg").reduce((a, i) => a + i.qty, 0), 0);
  const lowStock = state.core.products.filter((p) => p.active && stockRemaining(p.id) <= p.minStock);

  const last7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); return dateKey(d); });
  const chartData = last7.map((k) => ({ day: dateLabel(k).slice(0, 5), total: state.sales.filter((s) => dateKey(s.timestamp) === k).reduce((a, s) => a + s.total, 0) }));
  const maxVal = Math.max(1, ...chartData.map((d) => d.total));
  const barsHtml = chartData.map((d) => `
    <div class="bar-col"><div class="bar" style="height:${Math.max(2, (d.total / maxVal) * 150)}px;" title="${brl(d.total)}"></div><div class="bar-label">${d.day}</div></div>`).join("");

  const paymentData = PAYMENT_METHODS.map((m, i) => ({ name: m, value: salesToday.filter((s) => s.paymentMethod === m).reduce((a, s) => a + s.total, 0), color: PIE_COLORS[i] })).filter((d) => d.value > 0);
  const paymentTotalSum = paymentData.reduce((a, d) => a + d.value, 0) || 1;
  let acc = 0;
  const gradientParts = paymentData.map((d) => { const start = (acc / paymentTotalSum) * 360; acc += d.value; const end = (acc / paymentTotalSum) * 360; return `${d.color} ${start}deg ${end}deg`; }).join(", ");

  const lowStockHtml = lowStock.length === 0 ? "" : `
    <div class="card" style="background:var(--red-bg);border-color:#E3C5BC;margin-top:20px;">
      <div style="display:flex;align-items:center;gap:8px;font-weight:700;color:var(--red);margin-bottom:8px;">⚠ Estoque baixo</div>
      ${lowStock.map((p) => `<div style="font-size:14px;color:var(--red);padding:3px 0;">${esc(p.name)} — restam ${fmtQty(stockRemaining(p.id), p.unit)}</div>`).join("")}
    </div>`;

  const html = `
    <h1 class="display" style="font-size:22px;margin:0 0 20px;">${greeting()}, ${esc(state.currentUser.name)}.</h1>
    <div class="grid-stats" style="margin-bottom:26px;">
      ${statCard("Vendas hoje", brl(totalToday), "amber")}
      ${statCard("Nº de vendas", salesToday.length, "ink")}
      ${statCard("Estoque baixo", lowStock.length + " produto(s)", lowStock.length ? "red" : "green")}
      ${statCard("Produtos vendidos (kg)", kgSold.toLocaleString("pt-BR", { maximumFractionDigits: 1 }), "ink")}
    </div>
    <div class="grid-2" style="margin-bottom:26px;">
      <div class="card"><div class="label" style="margin-bottom:12px;">Vendas — últimos 7 dias</div><div class="bars">${barsHtml}</div></div>
      <div class="card">
        <div class="label" style="margin-bottom:12px;">Pagamento hoje</div>
        ${paymentData.length === 0 ? `<div style="color:var(--ink-soft);font-size:13.5px;padding:30px 0;text-align:center;">Sem vendas ainda hoje</div>` : `
          <div class="pie" style="background:conic-gradient(${gradientParts});"></div>
          <div class="pie-legend">${paymentData.map((d) => `<div><span class="dot" style="background:${d.color};"></span>${d.name} — ${brl(d.value)}</div>`).join("")}</div>`}
      </div>
    </div>
    ${lowStockHtml}
  `;
  renderShell(html, "Visão geral");
}

/* ---------- ADMIN: PRODUTOS ---------- */

function renderAdminProducts() {
  const rows = state.core.products.map((p) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;opacity:${p.active ? 1 : 0.5};">
      <div>
        <div style="font-weight:600;">${esc(p.name)}</div>
        <div style="font-size:13px;color:var(--ink-soft);">${brl(p.price)}/${p.unit} · restam ${fmtQty(stockRemaining(p.id), p.unit)}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost btn-icon" data-action="editproduct" data-id="${p.id}">✎</button>
        <button class="btn ${p.active ? "btn-danger-soft" : "btn-green-soft"} btn-sm" data-action="toggleproduct" data-id="${p.id}">${p.active ? "Desativar" : "Ativar"}</button>
      </div>
    </div>`).join("");

  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h1 class="display" style="font-size:22px;margin:0;">Produtos</h1>
      <button class="btn btn-primary" data-action="newproduct">+ Novo produto</button>
    </div>
    <div class="card hairline-list" style="padding:0;">${rows || `<div style="padding:20px;text-align:center;color:var(--ink-soft);">Nenhum produto cadastrado ainda</div>`}</div>
  `;
  renderShell(html, "Produtos");
}

/* ---------- ADMIN: ESTOQUE ---------- */

function renderAdminStock() {
  const toggleBtn = `<button class="btn btn-ghost" data-action="togglestockview">${state.stockView === "table" ? "Ver movimentações" : "Ver tabela"}</button>`;
  let bodyHtml;
  if (state.stockView === "table") {
    bodyHtml = `<div class="card" style="padding:0;overflow:auto;">
      <table style="min-width:640px;">
        <thead><tr><th>Produto</th><th>Recebido</th><th>Vendido</th><th>Restante</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${state.core.products.map((p) => {
            const remaining = p.received - p.sold;
            const low = remaining <= p.minStock;
            return `<tr>
              <td style="font-weight:600;">${esc(p.name)}</td>
              <td class="num">${fmtQty(p.received, p.unit)}</td>
              <td class="num">${fmtQty(p.sold, p.unit)}</td>
              <td class="num" style="font-weight:700;">${fmtQty(remaining, p.unit)}</td>
              <td><span class="badge ${low ? "badge-lowstock" : "badge-okstock"}">${low ? "Estoque baixo" : "OK"}</span></td>
              <td style="display:flex;gap:8px;">
                <button class="btn btn-ghost btn-sm" data-action="openreceipt" data-id="${p.id}">+ Receber</button>
                <button class="btn btn-ghost btn-sm" data-action="opencorrect" data-id="${p.id}">Corrigir</button>
              </td>
            </tr>`;
          }).join("") || `<tr><td colspan="6" style="text-align:center;color:var(--ink-soft);padding:20px;">Nenhum produto cadastrado</td></tr>`}
        </tbody>
      </table>
    </div>`;
  } else {
    bodyHtml = `<div class="card" style="padding:0;overflow:auto;">
      <table style="min-width:700px;font-size:13.5px;">
        <thead><tr><th>Data/hora</th><th>Produto</th><th>Tipo</th><th>Anterior</th><th>Nova</th><th>Motivo</th><th>Usuário</th></tr></thead>
        <tbody>
          ${state.movements.slice().reverse().map((m) => `<tr>
            <td>${new Date(m.timestamp).toLocaleString("pt-BR")}</td>
            <td style="font-weight:600;">${esc(m.productName)}</td>
            <td>${m.type === "entrada" ? "Entrada" : "Correção manual"}</td>
            <td class="num">${m.before}</td><td class="num">${m.after}</td>
            <td>${esc(m.reason || "—")}</td><td>${esc(m.user)}</td>
          </tr>`).join("") || `<tr><td colspan="7" style="text-align:center;color:var(--ink-soft);padding:20px;">Nenhuma movimentação ainda</td></tr>`}
        </tbody>
      </table>
    </div>`;
  }

  const dailyNoteCard = `
    <div class="card" style="margin-bottom:20px;">
      <div class="label" style="margin-bottom:8px;">Peso total recebido hoje (anotação livre — não precisa bater com a soma dos produtos)</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <input class="input num" id="daily-note-input" type="number" step="0.1" style="max-width:160px;" value="${state.dailyNote.totalReceivedKg || ""}" placeholder="kg" />
        <button class="btn btn-primary btn-sm" data-action="savedailynote">Salvar</button>
        ${state.dailyNote.updatedAt ? `<span style="font-size:12px;color:var(--ink-soft);">atualizado às ${timeLabel(state.dailyNote.updatedAt)} por ${esc(state.dailyNote.updatedBy || "")}</span>` : ""}
      </div>
    </div>`;

  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h1 class="display" style="font-size:22px;margin:0;">Estoque</h1>
      ${toggleBtn}
    </div>
    ${dailyNoteCard}
    ${bodyHtml}
  `;
  renderShell(html, "Estoque");
}

/* ---------- ADMIN: FECHAMENTO ---------- */

function renderAdminClosing() {
  const today = dateKey();
  const salesToday = state.sales.filter((s) => dateKey(s.timestamp) === today);
  const total = salesToday.reduce((s, x) => s + x.total, 0);

  const byPayment = PAYMENT_METHODS.map((m) => ({ method: m, total: salesToday.filter((s) => s.paymentMethod === m).reduce((a, s) => a + s.total, 0) }));
  const byProduct = state.core.products.map((p) => {
    const items = salesToday.flatMap((s) => s.items.filter((i) => i.productId === p.id));
    return { name: p.name, value: items.reduce((a, i) => a + i.subtotal, 0) };
  }).filter((r) => r.value > 0);

  const receivedToday = (pid) => state.movements.filter((m) => m.productId === pid && m.type === "entrada" && dateKey(m.timestamp) === today).reduce((a, m) => a + (m.after - m.before), 0);
  const soldToday = (pid) => salesToday.flatMap((s) => s.items.filter((i) => i.productId === pid)).reduce((a, i) => a + i.qty, 0);

  const html = `
    <h1 class="display" style="font-size:22px;margin:0 0 20px;">Fechamento do dia — ${dateLabel(today)}</h1>
    <div class="grid-2" style="margin-bottom:24px;">
      ${statCard("Total vendido", brl(total), "amber")}
      ${statCard("Quantidade de vendas", salesToday.length, "ink")}
    </div>
    ${state.dailyNote.totalReceivedKg ? `<div class="card" style="margin-bottom:24px;"><div class="label" style="margin-bottom:4px;">Peso total recebido hoje (anotação do proprietário)</div><div class="num" style="font-size:20px;">${fmtQty(state.dailyNote.totalReceivedKg, "kg")}</div></div>` : ""}
    <div class="grid-2" style="margin-bottom:24px;">
      <div class="card">
        <div class="label" style="margin-bottom:12px;">Por forma de pagamento</div>
        ${byPayment.map((r) => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);"><span>${r.method}</span><span class="num">${brl(r.total)}</span></div>`).join("")}
      </div>
      <div class="card">
        <div class="label" style="margin-bottom:12px;">Por produto</div>
        ${byProduct.length === 0 ? `<div style="color:var(--ink-soft);font-size:13.5px;">Sem vendas hoje</div>` : byProduct.map((r) => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);"><span>${esc(r.name)}</span><span class="num">${brl(r.value)}</span></div>`).join("")}
      </div>
    </div>
    <div class="card" style="padding:0;overflow:auto;">
      <div class="label" style="padding:16px 18px 0;">Estoque do dia</div>
      <table style="min-width:520px;">
        <thead><tr><th>Produto</th><th>Recebido hoje</th><th>Vendido hoje</th><th>Restante (atual)</th></tr></thead>
        <tbody>
          ${state.core.products.map((p) => `<tr>
            <td style="font-weight:600;">${esc(p.name)}</td>
            <td class="num">${fmtQty(receivedToday(p.id), p.unit)}</td>
            <td class="num">${fmtQty(soldToday(p.id), p.unit)}</td>
            <td class="num">${fmtQty(stockRemaining(p.id), p.unit)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
  renderShell(html, "Fechamento");
}

/* ---------- ADMIN: HISTÓRICO ---------- */

function renderAdminHistory() {
  if (state.historySelectedDay) {
    let daySales = state.sales.filter((s) => dateKey(s.timestamp) === state.historySelectedDay);
    if (state.historyFilterEmployee) daySales = daySales.filter((s) => s.employeeUsername === state.historyFilterEmployee);
    if (state.historyFilterPayment) daySales = daySales.filter((s) => s.paymentMethod === state.historyFilterPayment);
    const employees = state.core.users.filter((u) => u.role === "employee");

    const html = `
      <button class="btn btn-ghost" data-action="backhistory" style="margin-bottom:16px;">← Voltar ao histórico</button>
      <h1 class="display" style="font-size:22px;margin:0 0 16px;">Vendas de ${dateLabel(state.historySelectedDay)}</h1>
      <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
        <select class="input" id="hist-filter-emp" style="width:auto;">
          <option value="">Todos os funcionários</option>
          ${employees.map((u) => `<option value="${u.username}" ${state.historyFilterEmployee === u.username ? "selected" : ""}>${esc(u.name)}</option>`).join("")}
        </select>
        <select class="input" id="hist-filter-pay" style="width:auto;">
          <option value="">Todas as formas</option>
          ${PAYMENT_METHODS.map((m) => `<option value="${m}" ${state.historyFilterPayment === m ? "selected" : ""}>${m}</option>`).join("")}
        </select>
      </div>
      <div class="card hairline-list" style="padding:0;">
        ${daySales.map((s) => `
          <div style="padding:14px 18px;display:flex;justify-content:space-between;">
            <div>
              <div style="font-weight:600;">${timeLabel(s.timestamp)} · ${esc(s.employeeName)}</div>
              <div style="font-size:12.5px;color:var(--ink-soft);">${esc(s.items.map((i) => i.name).join(", "))} · ${esc(s.paymentMethod)}</div>
            </div>
            <span class="num" style="font-size:15px;">${brl(s.total)}</span>
          </div>`).join("") || `<div style="padding:20px;text-align:center;color:var(--ink-soft);">Nenhuma venda com esse filtro</div>`}
      </div>
    `;
    renderShell(html, "Histórico");
    document.getElementById("hist-filter-emp").addEventListener("change", (e) => { state.historyFilterEmployee = e.target.value; render(); });
    document.getElementById("hist-filter-pay").addEventListener("change", (e) => { state.historyFilterPayment = e.target.value; render(); });
    return;
  }

  const map = {};
  state.sales.forEach((s) => { const k = dateKey(s.timestamp); if (!map[k]) map[k] = { key: k, total: 0, count: 0 }; map[k].total += s.total; map[k].count += 1; });
  const days = Object.values(map).sort((a, b) => (a.key < b.key ? 1 : -1));

  const html = `
    <h1 class="display" style="font-size:22px;margin:0 0 20px;">Histórico</h1>
    <div class="card hairline-list" style="padding:0;">
      ${days.map((d) => `
        <button class="btn" data-action="opendayhistory" data-day="${d.key}" style="width:100%;justify-content:space-between;border-radius:0;background:transparent;padding:16px 18px;">
          <span style="font-weight:600;">${dateLabel(d.key)}</span>
          <span style="display:flex;align-items:center;gap:14px;"><span style="color:var(--ink-soft);font-size:13.5px;">${d.count} vendas</span><span class="num">${brl(d.total)}</span> →</span>
        </button>`).join("") || `<div style="padding:20px;text-align:center;color:var(--ink-soft);">Nenhuma venda registrada ainda</div>`}
    </div>
  `;
  renderShell(html, "Histórico");
}

/* ---------- ADMIN: RELATÓRIOS ---------- */

function renderAdminReports() {
  const cutoff = Date.now() - state.reportsRange * 86400000;
  const filtered = state.sales.filter((s) => new Date(s.timestamp).getTime() >= cutoff);
  const total = filtered.reduce((s, x) => s + x.total, 0);

  const productTotals = {};
  filtered.forEach((s) => s.items.forEach((i) => { productTotals[i.name] = (productTotals[i.name] || 0) + i.subtotal; }));
  const sortedProducts = Object.entries(productTotals).sort((a, b) => b[1] - a[1]);
  const top = sortedProducts[0], bottom = sortedProducts[sortedProducts.length - 1];

  const paymentTotals = {};
  filtered.forEach((s) => { paymentTotals[s.paymentMethod] = (paymentTotals[s.paymentMethod] || 0) + s.total; });
  const topPayment = Object.entries(paymentTotals).sort((a, b) => b[1] - a[1])[0];

  const byEmployee = {};
  filtered.forEach((s) => { byEmployee[s.employeeName] = (byEmployee[s.employeeName] || 0) + s.total; });

  const rangeBtns = [{ v: 1, l: "Hoje" }, { v: 7, l: "7 dias" }, { v: 30, l: "30 dias" }]
    .map((o) => `<button class="btn btn-sm" data-action="setreportsrange" data-v="${o.v}" style="border:1.5px solid ${state.reportsRange === o.v ? "var(--amber)" : "var(--line)"};background:${state.reportsRange === o.v ? "var(--amber-bg)" : "transparent"};">${o.l}</button>`).join("");

  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
      <h1 class="display" style="font-size:22px;margin:0;">Relatórios</h1>
      <div style="display:flex;gap:8px;">${rangeBtns}</div>
    </div>
    <div class="grid-stats" style="margin-bottom:24px;">
      ${statCard("Total no período", brl(total), "amber")}
      ${statCard("Nº de vendas", filtered.length, "ink")}
      ${statCard("Produto mais vendido", top ? top[0] : "—", "green")}
      ${statCard("Produto menos vendido", bottom ? bottom[0] : "—", "red")}
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="label" style="margin-bottom:10px;">Forma de pagamento mais usada</div>
        <div class="num" style="font-size:22px;">${topPayment ? topPayment[0] : "—"}</div>
        <div style="color:var(--ink-soft);font-size:13.5px;">${topPayment ? brl(topPayment[1]) : ""}</div>
      </div>
      <div class="card">
        <div class="label" style="margin-bottom:10px;">Vendas por funcionário</div>
        ${Object.keys(byEmployee).length === 0 ? `<div style="color:var(--ink-soft);font-size:13.5px;">Sem dados no período</div>` :
          Object.entries(byEmployee).sort((a, b) => b[1] - a[1]).map(([name, val]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;"><span>${esc(name)}</span><span class="num">${brl(val)}</span></div>`).join("")}
      </div>
    </div>
  `;
  renderShell(html, "Relatórios");
}

/* ---------- ADMIN: USUÁRIOS ---------- */

function renderAdminUsers() {
  const rows = state.core.users.map((u) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;opacity:${u.active ? 1 : 0.5};">
      <div>
        <div style="font-weight:600;">${esc(u.name)} <span style="color:var(--ink-soft);font-weight:500;">· @${esc(u.username)}</span></div>
        <div style="font-size:12.5px;color:var(--ink-soft);">${u.role === "admin" ? "Proprietário" : "Funcionário"}${!u.active ? " · desativado" : ""}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost btn-icon" data-action="edituser" data-id="${u.id}">✎</button>
        ${u.id !== state.currentUser.uid ? `<button class="btn ${u.active ? "btn-danger-soft" : "btn-green-soft"} btn-sm" data-action="toggleuser" data-id="${u.id}">${u.active ? "Desativar" : "Ativar"}</button>` : ""}
      </div>
    </div>`).join("");

  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h1 class="display" style="font-size:22px;margin:0;">Usuários</h1>
      <button class="btn btn-primary" data-action="newuser">+ Novo usuário</button>
    </div>
    <div class="card hairline-list" style="padding:0;">${rows}</div>
    <p style="font-size:12.5px;color:var(--ink-soft);margin-top:14px;">Desativar aqui impede o login no sistema, mas não apaga a conta do Firebase.</p>
  `;
  renderShell(html, "Usuários");
}

/* ---------- ROTEADOR PRINCIPAL ---------- */

function render() {
  if (CONFIG_IS_PLACEHOLDER) { renderConfigNeeded(); return; }
  if (state.booting) { renderBoot(); return; }
  if (!state.currentUser) {
    if (state.needsSetup) renderSetup(); else renderLogin();
    return;
  }
  closeOverlay();
  const page = state.page;
  if (state.currentUser.role === "employee") { renderEmployeeHome(); }
  else {
    if (page === "overview") renderAdminOverview();
    else if (page === "products") renderAdminProducts();
    else if (page === "stock") renderAdminStock();
    else if (page === "closing") renderAdminClosing();
    else if (page === "sales") renderAdminHistory();
    else if (page === "reports") renderAdminReports();
    else if (page === "users") renderAdminUsers();
    else renderAdminOverview();
  }
}

/* ---------- DELEGAÇÃO DE EVENTOS ---------- */

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case "nav":
      state.page = el.dataset.page;
      if (el.dataset.closedrawer) state.mobileDrawerOpen = false;
      render();
      break;
    case "logout": logout(); break;
    case "opendrawer": state.mobileDrawerOpen = true; render(); break;
    case "closedrawer": if (e.target === el || el.tagName === "BUTTON") { state.mobileDrawerOpen = false; render(); } break;
    case "openpanel": state.panelOpen = true; render(); break;
    case "closepanel": state.panelOpen = false; render(); break;

    case "startatendimento": startAtendimento(); break;
    case "openatendimento": state.openAtendimentoId = el.dataset.id; render(); break;
    case "closeatendimento": state.openAtendimentoId = null; render(); break;
    case "cancelatendimento": cancelAtendimento(el.dataset.id); break;
    case "pickproduct": openQuantityPicker(state.core.products.find((p) => p.id === el.dataset.id)); break;
    case "removeitem": removeItemFromAtendimento(state.openAtendimentoId, Number(el.dataset.idx)); break;
    case "openfinalize": openFinalizeModal(state.atendimentos.find((a) => a.id === state.openAtendimentoId)); break;
    case "closeoverlay": if (e.target === el) closeOverlay(); break;

    case "newproduct": openProductForm(null); break;
    case "editproduct": openProductForm(state.core.products.find((p) => p.id === el.dataset.id)); break;
    case "toggleproduct": toggleProductActive(el.dataset.id); break;

    case "togglestockview": state.stockView = state.stockView === "table" ? "log" : "table"; render(); break;
    case "openreceipt": openStockModal("receipt", state.core.products.find((p) => p.id === el.dataset.id)); break;
    case "opencorrect": openStockModal("correct", state.core.products.find((p) => p.id === el.dataset.id)); break;

    case "opendayhistory": state.historySelectedDay = el.dataset.day; state.historyFilterEmployee = ""; state.historyFilterPayment = ""; render(); break;
    case "backhistory": state.historySelectedDay = null; render(); break;

    case "setreportsrange": state.reportsRange = Number(el.dataset.v); render(); break;

    case "newuser": openUserForm(null); break;
    case "edituser": openUserForm(state.core.users.find((u) => u.id === el.dataset.id)); break;
    case "toggleuser": toggleUserActive(el.dataset.id); break;

    case "savedailynote": saveDailyNote(document.getElementById("daily-note-input").value); break;
  }
});

/* ---------- INICIALIZAÇÃO ---------- */

render();
