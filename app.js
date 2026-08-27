// ---- Auth ----
const LOGIN_USER  = "admin";
const LOGIN_PASS  = "cafe123";
const SESSION_KEY = "cafe_app_auth";
const PIX_KEY     = "09156713606";

(function initLogin() {
  const screen = document.getElementById("login-screen");
  if (sessionStorage.getItem(SESSION_KEY) === "1") { screen.style.display = "none"; return; }
  const userEl = document.getElementById("login-user");
  const passEl = document.getElementById("login-pass");
  const errEl  = document.getElementById("login-error");
  const tryLogin = () => {
    errEl.style.display = "none";
    if (userEl.value.trim() === LOGIN_USER && passEl.value === LOGIN_PASS) {
      sessionStorage.setItem(SESSION_KEY, "1");
      screen.style.display = "none";
    } else {
      errEl.style.display = "block";
      passEl.value = "";
      passEl.focus();
    }
  };
  document.getElementById("login-btn").onclick = tryLogin;
  [userEl, passEl].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") tryLogin(); }));
})();

document.getElementById("btn-logout").onclick = () => {
  if (confirm("Deseja sair?")) { sessionStorage.removeItem(SESSION_KEY); location.reload(); }
};

// ---- Setup ----
const UNITS = ["kg", "g", "un", "pacote", "caixa", "L", "ml"];
const LOCATIONS = ["Manhuaçu", "BH"];
const PAYMENT_METHODS = [
  { value: "pix", label: "Pix", cls: "badge-pix" },
  { value: "dinheiro", label: "Dinheiro", cls: "badge-dinheiro" },
  { value: "cartao", label: "Cartão", cls: "badge-cartao" },
  { value: "prazo", label: "À prazo", cls: "badge-prazo" },
];
const MONTH_NAMES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const paymentLabel = (v) => (PAYMENT_METHODS.find((p) => p.value === v) || PAYMENT_METHODS[1]).label;
const paymentCls = (v) => (PAYMENT_METHODS.find((p) => p.value === v) || PAYMENT_METHODS[1]).cls;

let db = null;
let configOk = window.SUPABASE_URL && window.SUPABASE_ANON_KEY &&
  !window.SUPABASE_URL.includes("COLE_AQUI") && !window.SUPABASE_ANON_KEY.includes("COLE_AQUI");

let state = {
  tab: "estoque", products: [], sales: [], clients: [], sellers: [], cart: [],
  receivables: [], receivablePayments: [], recompraContacts: [], orderDeliveries: [], stockEntries: [],
  cashRegisters: [], cashMovements: [],
  loading: true, loadError: null,
  resumoMonth: todayISOMonthPrefix(),
  recompraFilter: { window: "7", clientId: "", productName: "", status: "" },
  pedidosPaymentFilter: "todos", pedidosDeliveryFilter: "todos", receberQuery: "",
  movPeriod: "hoje", movProduct: "", movUser: "", movLocation: "", movType: "todos",
  movCustomFrom: "", movCustomTo: "",
  caixaRegister: "", caixaType: "todos", caixaPeriod: "mes", caixaUser: "",
  caixaCustomFrom: "", caixaCustomTo: "",
};

// ===================================================================
// Previsão de recompra — parâmetros CONFIGURÁVEIS
// -------------------------------------------------------------------
// Todos os parâmetros de dias e limiares ficam centralizados aqui para
// que possam ser ajustados no futuro (ou virarem uma tela de config).
// ===================================================================
const RECOMPRA_CONFIG = {
  // Nº mínimo de compras para gerar previsão baseada em comportamento.
  minPurchasesForPrediction: 2,
  // Janela de histórico usada no cálculo (últimas N compras do produto).
  // Preferência: usar de 3 a 6 compras recentes; se houver menos, usa o que tiver.
  historyWindowMax: 6,
  historyWindowPreferred: 3,
  // Margem de segurança para contato (dias ANTES da próxima compra estimada).
  // Pode ser trocada futuramente por 5, 7, 10 ou 15.
  contactDaysBefore: 7,
  // Limiares de status em fração do ciclo (dias decorridos / intervalo médio):
  //   < proxima            -> 🟢 compra recente
  //   [proxima, acabando)  -> 🟡 próxima recompra
  //   [acabando, atrasada) -> 🟠 estoque provavelmente acabando
  //   >= atrasada          -> 🔴 recompra atrasada
  statusThresholds: { proxima: 0.70, acabando: 0.90, atrasada: 1.00 },
  // Confiabilidade pelo coeficiente de variação (desvio padrão / média) dos
  // intervalos. Quanto mais parecidos os intervalos, maior a confiança.
  confidenceCV: { alta: 0.15, media: 0.35 },
};

// Rótulos e classes de badge por status (usa CSS de index.html)
const RECOMPRA_STATUS = {
  recente:  { key: "recente",  emoji: "🟢", label: "Compra recente",                cls: "badge-recente",  order: 3 },
  proxima:  { key: "proxima",  emoji: "🟡", label: "Próxima recompra",              cls: "badge-proxima",  order: 2 },
  acabando: { key: "acabando", emoji: "🟠", label: "Estoque provavelmente acabando", cls: "badge-acabando", order: 1 },
  atrasada: { key: "atrasada", emoji: "🔴", label: "Recompra atrasada",             cls: "badge-atrasada", order: 0 },
  semprev:  { key: "semprev",  emoji: "⚪", label: "Sem previsão",                   cls: "badge-semprev",  order: 4 },
};

// -------------------------------------------------------------------
// Utilidades de data (em dias) — trabalham só com a parte YYYY-MM-DD
// para evitar ruído de fuso horário / horas.
// -------------------------------------------------------------------
function dateOnly(iso) { return String(iso).slice(0, 10); }
function daysBetween(isoA, isoB) {
  const a = new Date(dateOnly(isoA) + "T00:00:00");
  const b = new Date(dateOnly(isoB) + "T00:00:00");
  return Math.round((b - a) / 86400000);
}
function addDaysISO(iso, days) {
  const d = new Date(dateOnly(iso) + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function fmtDateBR(iso) {
  if (!iso) return "—";
  return new Date(dateOnly(iso) + "T00:00:00").toLocaleDateString("pt-BR");
}

// -------------------------------------------------------------------
// Considera apenas vendas CONCLUÍDAS.
// Hoje o app remove do banco vendas canceladas/estornadas (deleteSale),
// então toda venda presente já é concluída. Ainda assim deixamos um
// filtro central e à prova de futuro: se um dia existir uma coluna de
// status/cancelamento ou quantidade negativa, ela já é ignorada aqui.
// -------------------------------------------------------------------
function isConcludedSale(s) {
  if (!s) return false;
  if (Number(s.quantity) <= 0) return false;
  const st = (s.status || "").toString().toLowerCase();
  if (["cancelado", "cancelada", "estornado", "estornada", "devolvido", "devolvida"].includes(st)) return false;
  if (s.canceled_at || s.cancelled_at || s.refunded_at) return false;
  return true;
}

// -------------------------------------------------------------------
// Agrupa as compras de um cliente POR PRODUTO (por product_id, com
// fallback no nome). Produtos/embalagens diferentes (ex.: 250 g e 500 g)
// têm product_id distinto e portanto NUNCA são misturados.
// Compras do mesmo produto no mesmo dia são somadas (evita duplicidade
// quando um item aparece repetido numa mesma venda).
// -------------------------------------------------------------------
function purchaseEventsByProduct(clientId) {
  const sales = state.sales.filter((s) => s.client_id === clientId && isConcludedSale(s));
  const byProduct = {};
  sales.forEach((s) => {
    const pid = s.product_id || `nome:${s.product_name}`;
    if (!byProduct[pid]) {
      byProduct[pid] = { productId: s.product_id || null, productName: s.product_name, unit: s.unit || "un", days: {} };
    }
    const day = dateOnly(s.sold_at);
    byProduct[pid].days[day] = (byProduct[pid].days[day] || 0) + Number(s.quantity || 0);
  });
  // Converte o mapa de dias em uma lista ordenada de eventos de compra.
  return Object.values(byProduct).map((p) => {
    const events = Object.entries(p.days)
      .map(([date, qty]) => ({ date, qty }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    return { productId: p.productId, productName: p.productName, unit: p.unit, events };
  });
}

// -------------------------------------------------------------------
// Motor de previsão para UM produto de UM cliente.
// Recebe { productName, unit, events:[{date, qty}] } e devolve o objeto
// de previsão. Função pura: recalcula tudo do zero a cada chamada, então
// se ajusta automaticamente a cada nova compra.
// -------------------------------------------------------------------
function predictProduct(prod) {
  const { productId, productName, unit, events } = prod;
  const totalPurchases = events.length;
  const last = events[totalPurchases - 1];
  const base = {
    productId, productName, unit,
    totalPurchases,
    lastPurchase: last ? last.date : null,
    lastQty: last ? last.qty : 0,
  };

  // Sem histórico suficiente → não prevê comportamento, só registra a última compra.
  if (totalPurchases < RECOMPRA_CONFIG.minPurchasesForPrediction) {
    return {
      ...base,
      hasPrediction: false,
      status: RECOMPRA_STATUS.semprev,
      avgQty: last ? last.qty : 0,
      note: "Apenas uma compra registrada — sem histórico para prever o ritmo.",
    };
  }

  // Usa as últimas N compras (janela recente) para refletir o comportamento atual.
  const windowN = Math.min(RECOMPRA_CONFIG.historyWindowMax, totalPurchases);
  const win = events.slice(-windowN);

  // Intervalos (em dias) entre compras consecutivas da janela.
  const intervals = [];
  for (let i = 1; i < win.length; i++) intervals.push(daysBetween(win[i - 1].date, win[i].date));
  const validIntervals = intervals.filter((d) => d > 0); // ignora eventos no mesmo dia (já somados)
  const usedIntervals = validIntervals.length ? validIntervals : intervals;

  const avgInterval = usedIntervals.reduce((a, b) => a + b, 0) / usedIntervals.length;
  const avgQty = win.reduce((a, e) => a + e.qty, 0) / win.length;

  // Próxima compra estimada e data recomendada de contato.
  const nextEstimated = addDaysISO(last.date, Math.round(avgInterval));
  const contactDate = addDaysISO(nextEstimated, -RECOMPRA_CONFIG.contactDaysBefore);

  // Progresso do ciclo atual.
  const daysSinceLast = daysBetween(last.date, todayISO());
  const cycleProgress = avgInterval > 0 ? daysSinceLast / avgInterval : 0;
  const daysUntilNext = daysBetween(todayISO(), nextEstimated); // negativo = atrasada
  const daysUntilContact = daysBetween(todayISO(), contactDate);

  // Status a partir do progresso do ciclo.
  const T = RECOMPRA_CONFIG.statusThresholds;
  let status;
  if (cycleProgress >= T.atrasada) status = RECOMPRA_STATUS.atrasada;
  else if (cycleProgress >= T.acabando) status = RECOMPRA_STATUS.acabando;
  else if (cycleProgress >= T.proxima) status = RECOMPRA_STATUS.proxima;
  else status = RECOMPRA_STATUS.recente;

  // Confiabilidade pela CONSISTÊNCIA dos intervalos (coeficiente de variação).
  const conf = confidenceFromIntervals(usedIntervals);

  return {
    ...base,
    hasPrediction: true,
    windowUsed: windowN,
    intervals: usedIntervals,
    avgInterval,
    avgQty,
    nextEstimated,
    contactDate,
    daysSinceLast,
    daysUntilNext,
    daysUntilContact,
    cycleProgress,
    status,
    confidence: conf,
  };
}

// Confiabilidade: baseada na consistência (não só na quantidade) dos intervalos.
function confidenceFromIntervals(intervals) {
  if (!intervals.length) return { key: "baixa", label: "Baixa", cls: "conf-baixa", pct: 25 };
  if (intervals.length === 1) {
    // Só um intervalo: não dá pra medir consistência → confiança limitada.
    return { key: "media", label: "Média", cls: "conf-media", pct: 55 };
  }
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  const C = RECOMPRA_CONFIG.confidenceCV;
  if (cv <= C.alta) return { key: "alta", label: "Alta", cls: "conf-alta", pct: 100, cv };
  if (cv <= C.media) return { key: "media", label: "Média", cls: "conf-media", pct: 60, cv };
  return { key: "baixa", label: "Baixa", cls: "conf-baixa", pct: 30, cv };
}

// Todas as previsões de um cliente (uma por produto), ordenadas por urgência.
function clientPredictions(clientId) {
  return purchaseEventsByProduct(clientId)
    .map(predictProduct)
    .sort((a, b) => {
      const ao = a.status.order, bo = b.status.order;
      if (ao !== bo) return ao - bo;
      const ad = a.daysUntilNext ?? 9999, bd = b.daysUntilNext ?? 9999;
      return ad - bd;
    });
}

// Todas as previsões de TODOS os clientes (para a Central de Recompras).
function allPredictions() {
  const out = [];
  state.clients.forEach((c) => {
    const clientName = `${c.first_name} ${c.last_name || ""}`.trim();
    clientPredictions(c.id).forEach((p) => {
      if (p.hasPrediction) out.push({ ...p, clientId: c.id, clientName });
    });
  });
  return out.sort((a, b) => {
    if (a.status.order !== b.status.order) return a.status.order - b.status.order;
    return (a.daysUntilNext ?? 9999) - (b.daysUntilNext ?? 9999);
  });
}

// Último contato registrado para um cliente+produto (para exibir no histórico).
function lastContactFor(clientId, productName) {
  return state.recompraContacts
    .filter((k) => k.client_id === clientId && (!productName || k.product_name === productName))
    .sort((a, b) => (a.contacted_at < b.contacted_at ? 1 : -1))[0] || null;
}

function todayISOMonthPrefix() { return new Date().toISOString().slice(0, 7); }

const money = (n) => (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const todayISO = () => new Date().toISOString().slice(0, 10);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const totalQty = (p) => Number(p.qty_mhu || 0) + Number(p.qty_bh || 0);
const locQty = (p, loc) => Number((loc === "bh" ? p.qty_bh : p.qty_mhu) || 0);
const locName = (loc) => (loc === "bh" ? "BH" : "Manhuaçu");
const locKey = (name) => (String(name).toLowerCase() === "bh" ? "bh" : "mhu");

// ---- Data layer ----
async function loadAll() {
  const [
    { data: products, error: e1 }, { data: sales, error: e2 },
    { data: clients, error: e3 }, { data: sellers, error: e4 },
    { data: receivables, error: e5 }, { data: receivablePayments, error: e6 },
  ] = await Promise.all([
    db.from("products").select("*").order("name"),
    db.from("sales").select("*").order("sold_at", { ascending: false }),
    db.from("clients").select("*").order("first_name"),
    db.from("sellers").select("*").order("name"),
    db.from("receivables").select("*").order("created_at", { ascending: false }),
    db.from("receivable_payments").select("*").order("paid_at", { ascending: false }),
  ]);
  if (e1 || e2 || e3 || e4 || e5 || e6) {
    console.error(e1, e2, e3, e4, e5, e6);
    state.loading = false;
    state.loadError = (e1 && e1.message) || (e2 && e2.message) || (e3 && e3.message) || (e4 && e4.message) || (e5 && e5.message) || (e6 && e6.message) || "Erro desconhecido";
    render();
    return;
  }
  // Contatos de recompra: carregamento tolerante — se a tabela ainda não
  // existir (usuário não rodou o novo SQL), o app continua funcionando.
  const { data: recompraContacts, error: e7 } = await db
    .from("recompra_contacts").select("*").order("contacted_at", { ascending: false });
  if (e7) { console.warn("recompra_contacts indisponível (rode o supabase-schema.sql):", e7.message); }
  // Status de entrega dos pedidos: mesma lógica tolerante.
  const { data: orderDeliveries, error: e8 } = await db
    .from("order_deliveries").select("*").order("created_at", { ascending: false });
  if (e8) { console.warn("order_deliveries indisponível (rode o supabase-schema.sql):", e8.message); }
  // Movimentações de estoque (entrada/saída).
  const { data: stockEntries, error: e9 } = await db
    .from("stock_entries").select("*").order("entered_at", { ascending: false });
  if (e9) { console.warn("stock_entries indisponível (rode o supabase-schema.sql):", e9.message); }
  // Caixa (livro-caixa).
  const { data: cashRegisters, error: e10 } = await db
    .from("cash_registers").select("*").order("name");
  if (e10) { console.warn("cash_registers indisponível (rode o supabase-schema.sql):", e10.message); }
  const { data: cashMovements, error: e11 } = await db
    .from("cash_movements").select("*").order("occurred_at", { ascending: false });
  if (e11) { console.warn("cash_movements indisponível (rode o supabase-schema.sql):", e11.message); }
  state.loadError = null;
  state.products = products || [];
  state.sales = sales || [];
  state.clients = clients || [];
  state.sellers = sellers || [];
  state.receivables = receivables || [];
  state.receivablePayments = receivablePayments || [];
  state.recompraContacts = recompraContacts || [];
  state.orderDeliveries = orderDeliveries || [];
  state.stockEntries = stockEntries || [];
  state.cashRegisters = cashRegisters || [];
  state.cashMovements = cashMovements || [];
  state.loading = false;
  render();
  updateBirthdayDot();
}

function subscribeRealtime() {
  db
    .channel("cafe-app-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "products" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "sales" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "clients" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "sellers" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "receivables" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "receivable_payments" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "recompra_contacts" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "order_deliveries" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "stock_entries" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "cash_registers" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "cash_movements" }, loadAll)
    .subscribe((status) => {
      const label = $("#sync-indicator");
      if (!label) return;
      if (status === "SUBSCRIBED") {
        label.innerHTML = '<span class="sync-dot"></span>sincronizado em tempo real';
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        label.innerHTML = '<span class="sync-dot off"></span>sem tempo real (dados ainda carregam ao abrir a página)';
      }
    });
}

async function addProduct(data) {
  await db.from("products").insert({
    name: data.name, unit: data.unit,
    min_stock: data.minStock, price: data.price, cost: data.cost,
    cost_packaging: data.costPackaging, cost_roasting: data.costRoasting, cost_stickers: data.costStickers,
  });
}
async function updateProduct(id, data) {
  // Não altera quantidade/localidade — isso só muda pela aba Movimentações.
  await db.from("products").update({
    name: data.name, unit: data.unit,
    min_stock: data.minStock, price: data.price, cost: data.cost,
    cost_packaging: data.costPackaging, cost_roasting: data.costRoasting, cost_stickers: data.costStickers,
  }).eq("id", id);
}
async function deleteProduct(id) { await db.from("products").delete().eq("id", id); }

async function logStockMovement({ productId, productName, unit, movementType, quantity, location, orderKey, reason, note, loggedBy, unitCost, transferGroupId, relatedLocation }) {
  await db.from("stock_entries").insert({
    product_id: productId || null, product_name: productName, unit: unit || null,
    quantity: Math.abs(Number(quantity) || 0),
    unit_cost: Number(unitCost) || 0, total_cost: (Number(unitCost) || 0) * Math.abs(Number(quantity) || 0),
    note: note || null, logged_by: loggedBy || null,
    movement_type: movementType, location: location || null, order_key: orderKey || null, reason: reason || null,
    transfer_group_id: transferGroupId || null, related_location: relatedLocation || null,
  });
}

async function deleteStockMovement(id) {
  const m = state.stockEntries.find((x) => x.id === id);
  if (m && m.transfer_group_id) {
    // Apaga as duas pontas do protocolo juntas, senão fica um registro "órfão".
    await db.from("stock_entries").delete().eq("transfer_group_id", m.transfer_group_id);
  } else {
    await db.from("stock_entries").delete().eq("id", id);
  }
}

// ---- Caixa (livro-caixa) ----
// O saldo de cada caixa NUNCA é armazenado — é sempre a soma das
// movimentações. Assim não existe risco de saldo "dessincronizado".
async function addCashRegister(name) {
  const { data } = await db.from("cash_registers").insert({ name }).select().single();
  return data;
}
async function updateCashRegister(id, name) { await db.from("cash_registers").update({ name }).eq("id", id); }
async function deleteCashRegister(id) {
  if (state.cashMovements.some((m) => m.cash_register_id === id)) {
    alert("Esse caixa já tem movimentações e não pode ser excluído — renomeie em vez de excluir.");
    return;
  }
  await db.from("cash_registers").delete().eq("id", id);
}

async function logCashMovement({ cashRegisterId, movementType, amount, description, originType, originId, transferGroupId, relatedCashRegisterId, loggedBy, note, occurredAt }) {
  if (!cashRegisterId || !(Number(amount) > 0)) return;
  await db.from("cash_movements").insert({
    cash_register_id: cashRegisterId, movement_type: movementType, amount: Number(amount),
    description, origin_type: originType || "manual", origin_id: originId || null,
    transfer_group_id: transferGroupId || null, related_cash_register_id: relatedCashRegisterId || null,
    logged_by: loggedBy || null, note: note || null, occurred_at: occurredAt || new Date().toISOString(),
  });
}

async function registerCashTransfer({ fromRegisterId, toRegisterId, amount, note, loggedBy, occurredAt }) {
  if (!fromRegisterId || !toRegisterId || fromRegisterId === toRegisterId || !(Number(amount) > 0)) return;
  const from = state.cashRegisters.find((c) => c.id === fromRegisterId);
  const to = state.cashRegisters.find((c) => c.id === toRegisterId);
  const transferGroupId = crypto.randomUUID();
  await logCashMovement({
    cashRegisterId: fromRegisterId, movementType: "saida", amount,
    description: `Transferência para ${to ? to.name : "outro caixa"}`,
    originType: "transferencia", transferGroupId, relatedCashRegisterId: toRegisterId,
    loggedBy, note, occurredAt,
  });
  await logCashMovement({
    cashRegisterId: toRegisterId, movementType: "entrada", amount,
    description: `Transferência de ${from ? from.name : "outro caixa"}`,
    originType: "transferencia", transferGroupId, relatedCashRegisterId: fromRegisterId,
    loggedBy, note, occurredAt,
  });
}

async function deleteCashMovement(movement) {
  if (movement.origin_type === "transferencia" && movement.transfer_group_id) {
    // Apaga as duas pernas juntas, senão o saldo consolidado ficaria errado.
    await db.from("cash_movements").delete().eq("transfer_group_id", movement.transfer_group_id);
  } else {
    await db.from("cash_movements").delete().eq("id", movement.id);
  }
}

function cashRegisterBalance(registerId) {
  return state.cashMovements
    .filter((m) => m.cash_register_id === registerId)
    .reduce((s, m) => s + (m.movement_type === "entrada" ? Number(m.amount) : -Number(m.amount)), 0);
}
function consolidatedCashBalance() {
  return state.cashRegisters.reduce((s, r) => s + cashRegisterBalance(r.id), 0);
}

async function registerStockEntry({ product, quantity, location, unitCost, reason, note, loggedBy }) {
  const col = location === "bh" ? "qty_bh" : "qty_mhu";
  const nextVal = Number((Number(product[col] || 0) + Number(quantity)).toFixed(3));
  const otherCol = location === "bh" ? "qty_mhu" : "qty_bh";
  await db.from("products").update({
    [col]: nextVal, quantity: Number((nextVal + Number(product[otherCol] || 0)).toFixed(3)),
  }).eq("id", product.id);
  await logStockMovement({
    productId: product.id, productName: product.name, unit: product.unit,
    movementType: "entrada", quantity, location: locName(location),
    reason: reason || "Compra de fornecedor", note, loggedBy, unitCost,
  });
}

async function registerStockExit({ product, quantity, location, reason, note, loggedBy }) {
  const col = location === "bh" ? "qty_bh" : "qty_mhu";
  const nextVal = Math.max(0, Number((Number(product[col] || 0) - Number(quantity)).toFixed(3)));
  const otherCol = location === "bh" ? "qty_mhu" : "qty_bh";
  await db.from("products").update({
    [col]: nextVal, quantity: Number((nextVal + Number(product[otherCol] || 0)).toFixed(3)),
  }).eq("id", product.id);
  await logStockMovement({
    productId: product.id, productName: product.name, unit: product.unit,
    movementType: "saida", quantity, location: locName(location),
    reason: reason || "Ajuste de estoque", note, loggedBy,
  });
}

// Transferência entre localidades (Manhuaçu ↔ BH) do MESMO produto: retira
// de uma e coloca na outra numa única operação, e gera um protocolo
// (transfer_group_id) que liga as duas pontas do movimento — igual ao que
// já existe pra transferência entre caixas.
async function registerStockTransfer({ product, quantity, fromLocation, toLocation, note, loggedBy }) {
  if (!product || fromLocation === toLocation || !(Number(quantity) > 0)) return;
  const fromCol = fromLocation === "bh" ? "qty_bh" : "qty_mhu";
  const toCol = toLocation === "bh" ? "qty_bh" : "qty_mhu";
  const nextFrom = Math.max(0, Number((Number(product[fromCol] || 0) - Number(quantity)).toFixed(3)));
  const nextTo = Number((Number(product[toCol] || 0) + Number(quantity)).toFixed(3));
  await db.from("products").update({
    [fromCol]: nextFrom, [toCol]: nextTo,
    quantity: Number((nextFrom + nextTo).toFixed(3)), // total do produto não muda, só é redistribuído
  }).eq("id", product.id);

  const transferGroupId = crypto.randomUUID();
  await logStockMovement({
    productId: product.id, productName: product.name, unit: product.unit,
    movementType: "saida", quantity, location: locName(fromLocation),
    reason: "Transferência entre localidades", note, loggedBy,
    transferGroupId, relatedLocation: locName(toLocation),
  });
  await logStockMovement({
    productId: product.id, productName: product.name, unit: product.unit,
    movementType: "entrada", quantity, location: locName(toLocation),
    reason: "Transferência entre localidades", note, loggedBy,
    transferGroupId, relatedLocation: locName(fromLocation),
  });
  return transferGroupId;
}

async function registerSale(product, qty, { paymentMethod, discount, location, clientId, clientName, sellerId, sellerName, saleGroupId }) {
  const subtotal = Number((product.price * qty).toFixed(2));
  const total = Number(Math.max(0, subtotal - (Number(discount) || 0)).toFixed(2));
  await db.from("sales").insert({
    product_id: product.id, product_name: product.name, unit: product.unit,
    quantity: qty, unit_price: product.price, total,
    payment_method: paymentMethod, discount: Number(discount) || 0,
    location: locName(location), cost_at_sale: Number(product.cost || 0),
    client_id: clientId || null, client_name: clientName || null,
    seller_id: sellerId || null, seller_name: sellerName || null,
    sale_group_id: saleGroupId || null,
  });
  const col = location === "bh" ? "qty_bh" : "qty_mhu";
  const otherCol = location === "bh" ? "qty_mhu" : "qty_bh";
  const nextVal = Math.max(0, Number((Number(product[col] || 0) - qty).toFixed(3)));
  await db.from("products").update({
    [col]: nextVal,
    quantity: Number((nextVal + Number(product[otherCol] || 0)).toFixed(3)),
  }).eq("id", product.id);
  await logStockMovement({
    productId: product.id, productName: product.name, unit: product.unit,
    movementType: "saida", quantity: qty, location: locName(location),
    orderKey: saleGroupId || null, reason: "Venda", loggedBy: sellerName || null,
  });
}

async function deleteSale(sale) {
  await db.from("sales").delete().eq("id", sale.id);
  const prod = state.products.find((p) => p.id === sale.product_id);
  if (prod) {
    const loc = locKey(sale.location);
    const col = loc === "bh" ? "qty_bh" : "qty_mhu";
    const otherCol = loc === "bh" ? "qty_mhu" : "qty_bh";
    const nextVal = Number((Number(prod[col] || 0) + Number(sale.quantity)).toFixed(3));
    await db.from("products").update({
      [col]: nextVal,
      quantity: Number((nextVal + Number(prod[otherCol] || 0)).toFixed(3)),
    }).eq("id", prod.id);
  }
  // Remove a movimentação de saída correspondente, pra não deixar um
  // registro fantasma no livro-caixa de estoque referente a uma venda que
  // não existe mais.
  await db.from("stock_entries").delete()
    .eq("order_key", saleOrderKey(sale)).eq("product_id", sale.product_id).eq("movement_type", "saida");
}

// ---- Contas a receber ----
// Gera UM registro de dívida por venda (mesmo se a venda tiver vários itens),
// somando o valor total já com desconto aplicado.
async function createReceivable({ saleGroupId, clientId, clientName, amount }) {
  if (!(Number(amount) > 0)) return;
  await db.from("receivables").insert({
    sale_group_id: saleGroupId || null,
    client_id: clientId || null,
    client_name: clientName,
    amount: Number(amount.toFixed(2)),
    paid_amount: 0,
    status: "aberto",
  });
}

async function registerReceivablePayment(receivable, amount, note, paymentMethod) {
  const add = Math.max(0, Number(amount) || 0);
  if (!add) return;
  const newPaid = Math.min(Number(receivable.amount), Number(receivable.paid_amount || 0) + add);
  const status = newPaid >= Number(receivable.amount) ? "pago" : newPaid > 0 ? "parcial" : "aberto";
  await db.from("receivable_payments").insert({ receivable_id: receivable.id, amount: add, note: note || null, payment_method: paymentMethod || null });
  await db.from("receivables").update({ paid_amount: Number(newPaid.toFixed(2)), status }).eq("id", receivable.id);
}

// Quita um valor do total devido do cliente, sem precisar escolher um
// pedido específico: aplica o valor nas contas em aberto mais antigas
// primeiro (FIFO), pode quitar uma total e deixar outra parcial. Cada conta
// tocada continua tendo seu próprio registro em receivable_payments (com a
// mesma forma de pagamento/observação), então o extrato por pedido continua
// certinho — só o jeito de pagar que fica mais simples pra quem só quer
// "abater a dívida do cliente" sem se preocupar em qual pedido especificamente.
async function registerClientPayment(group, amount, { paymentMethod, note, loggedBy }) {
  let remaining = Math.max(0, Number(amount) || 0);
  if (!remaining) return 0;
  const openReceivables = state.receivables
    .filter((r) => (r.client_id || `nome:${r.client_name}`) === group.key)
    .filter((r) => Number(r.amount) - Number(r.paid_amount || 0) > 0.004)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)); // mais antiga primeiro
  let applied = 0;
  for (const r of openReceivables) {
    if (remaining <= 0.004) break;
    const saldoR = Number((Number(r.amount) - Number(r.paid_amount || 0)).toFixed(2));
    const apply = Math.min(saldoR, remaining);
    await registerReceivablePayment(r, apply, note, paymentMethod);
    remaining = Number((remaining - apply).toFixed(2));
    applied = Number((applied + apply).toFixed(2));
  }
  return applied;
}

async function deleteReceivable(id) { await db.from("receivables").delete().eq("id", id); }

function receivablePaymentsFor(receivableId) {
  return state.receivablePayments.filter((p) => p.receivable_id === receivableId).sort((a, b) => (a.paid_at < b.paid_at ? 1 : -1));
}

function receivableStatusLabel(status) {
  return status === "pago" ? "Pago" : status === "parcial" ? "Parcial" : "Em aberto";
}

// Extrato do cliente: junta compras (cada conta a receber = 1 débito) e
// pagamentos (cada receivable_payment = 1 crédito) numa única linha do
// tempo, com saldo corrido — é o "extrato de pagamentos" pedido.
function clientStatementRows(group) {
  const receivables = state.receivables.filter((r) => (r.client_id || `nome:${r.client_name}`) === group.key);
  const events = [];
  receivables.forEach((r) => {
    events.push({ type: "compra", date: r.created_at, amount: Number(r.amount), saleGroupId: r.sale_group_id, receivableId: r.id });
  });
  receivables.forEach((r) => {
    receivablePaymentsFor(r.id).forEach((p) => {
      events.push({
        type: "pagamento", date: p.paid_at, amount: Number(p.amount),
        paymentMethod: p.payment_method, note: p.note, receivableId: r.id, saleGroupId: r.sale_group_id,
      });
    });
  });
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let running = 0;
  return events.map((e) => {
    running = Number((running + (e.type === "compra" ? e.amount : -e.amount)).toFixed(2));
    return { ...e, runningBalance: running };
  });
}

// ---- Clientes ----
async function addClient(data) {
  const { data: row } = await db.from("clients").insert({
    first_name: data.firstName, last_name: data.lastName,
    phone: data.phone, city: data.city, birthday: data.birthday || null,
  }).select().single();
  return row;
}
async function updateClient(id, data) {
  await db.from("clients").update({
    first_name: data.firstName, last_name: data.lastName,
    phone: data.phone, city: data.city, birthday: data.birthday || null,
  }).eq("id", id);
}
async function deleteClient(id) { await db.from("clients").delete().eq("id", id); }

// ---- Recompra: registro de contato ----
// Grava que a equipe entrou em contato com o cliente sobre a recompra.
// NÃO altera a previsão — ela continua derivada só do histórico de vendas.
async function addRecompraContact({ clientId, clientName, productId, productName, contactedBy, note }) {
  const { error } = await db.from("recompra_contacts").insert({
    client_id: clientId || null,
    client_name: clientName || null,
    product_id: productId || null,
    product_name: productName || null,
    contacted_by: contactedBy || null,
    note: note || null,
  });
  if (error) { console.error(error); alert("Não consegui salvar o contato. Rode o supabase-schema.sql para criar a tabela de contatos."); }
}
async function deleteRecompraContact(id) { await db.from("recompra_contacts").delete().eq("id", id); }

function clientSales(clientId) {
  return state.sales.filter((s) => s.client_id === clientId).sort((a, b) => (a.sold_at < b.sold_at ? 1 : -1));
}

function todaysBirthdays() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return state.clients.filter((c) => c.birthday && c.birthday.slice(5, 7) === mm && c.birthday.slice(8, 10) === dd);
}
function updateBirthdayDot() {
  const dot = $("#birthday-dot");
  if (!dot) return;
  dot.classList.toggle("show", todaysBirthdays().length > 0);
}
function openBirthdayPanel() {
  const list = todaysBirthdays();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">🎂 Aniversariantes de hoje</h3>
        <button class="icon-btn" id="bp-close">✕</button>
      </div>
      ${list.length === 0
        ? `<p style="font-size:13px;color:var(--muted2);">Nenhum aniversário hoje.</p>`
        : list.map((c) => `
            <div class="card" style="margin-bottom:8px;">
              <p style="margin:0;font-size:15px;font-weight:500;">${escapeHtml(c.first_name)} ${escapeHtml(c.last_name || "")}</p>
              <p style="margin:4px 0 0;font-size:12px;color:var(--muted2);">${escapeHtml(c.city || "")} ${c.phone ? "· " + escapeHtml(c.phone) : ""}</p>
            </div>`).join("")}
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#bp-close", backdrop).onclick = () => backdrop.remove();
}
// ---- Tema claro/escuro ----
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("btn-theme");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
}
(function initTheme() {
  applyTheme(localStorage.getItem("cafe_app_theme") || "light");
})();
document.getElementById("btn-theme")?.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  localStorage.setItem("cafe_app_theme", next);
  applyTheme(next);
});

document.getElementById("btn-birthday")?.addEventListener("click", openBirthdayPanel);

// ---- Vendedores ----
async function addSeller(data) {
  await db.from("sellers").insert({ name: data.name, phone: data.phone || null });
}
async function updateSeller(id, data) {
  await db.from("sellers").update({ name: data.name, phone: data.phone || null }).eq("id", id);
}
async function deleteSeller(id) { await db.from("sellers").delete().eq("id", id); }

function sellerSales(sellerId) {
  return state.sales.filter((s) => s.seller_id === sellerId).sort((a, b) => (a.sold_at < b.sold_at ? 1 : -1));
}

function renderVendedores() {
  const sorted = [...state.sellers].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  $("#main").innerHTML = `
    <div class="row" style="margin-bottom:16px;">
      <p style="font-size:13px;color:var(--muted);margin:0;">${sorted.length} vendedor${sorted.length === 1 ? "" : "es"} cadastrado${sorted.length === 1 ? "" : "s"}</p>
      <button class="btn btn-dark" id="btn-new-seller">+ Novo vendedor</button>
    </div>
    ${sorted.length === 0 ? `<div class="empty">Nenhum vendedor cadastrado ainda.</div>` : ""}
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${sorted.map((v) => {
        const sales = sellerSales(v.id);
        const totalSold = sales.reduce((s, x) => s + Number(x.total), 0);
        return `
        <div class="card" data-id="${v.id}">
          <div class="row" style="align-items:flex-start;">
            <div style="min-width:0;">
              <p style="margin:0;font-size:15px;font-weight:500;">${escapeHtml(v.name)}</p>
              <p style="margin:4px 0 0;font-size:12px;color:var(--muted2);">${v.phone ? escapeHtml(v.phone) : ""}</p>
              <p style="margin:6px 0 0;font-size:12px;color:var(--muted);">${sales.length} venda${sales.length === 1 ? "" : "s"} · <span class="mono">${money(totalSold)}</span></p>
            </div>
            <div style="display:flex;gap:2px;flex-shrink:0;">
              <button class="icon-btn btn-edit-seller" title="Editar">✎</button>
              <button class="icon-btn danger btn-delete-seller" title="Remover">🗑</button>
            </div>
          </div>
        </div>`;
      }).join("")}
    </div>`;
  $("#btn-new-seller").onclick = () => openSellerModal(null);
  $$(".card[data-id]", $("#main")).forEach((card) => {
    const id = card.dataset.id;
    const seller = state.sellers.find((v) => v.id === id);
    $(".btn-edit-seller", card).onclick = () => openSellerModal(seller);
    $(".btn-delete-seller", card).onclick = async () => { if (confirm(`Remover ${seller.name}?`)) await deleteSeller(id); };
  });
}

function openSellerModal(seller) {
  const isEdit = !!seller;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">${isEdit ? "Editar vendedor" : "Novo vendedor"}</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div><label class="field-label">Nome</label><input id="s-name" value="${isEdit ? escapeHtml(seller.name) : ""}" /></div>
        <div><label class="field-label">Telefone (opcional)</label><input id="s-phone" value="${isEdit ? escapeHtml(seller.phone || "") : ""}" placeholder="(00) 00000-0000" /></div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn" id="modal-cancel" style="flex:1;">Cancelar</button>
          <button class="btn btn-accent" id="modal-save" style="flex:1;">Salvar</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#modal-close", backdrop).onclick = () => backdrop.remove();
  $("#modal-cancel", backdrop).onclick = () => backdrop.remove();
  $("#modal-save", backdrop).onclick = async () => {
    const data = { name: $("#s-name", backdrop).value.trim(), phone: $("#s-phone", backdrop).value.trim() };
    if (!data.name) return;
    if (isEdit) await updateSeller(seller.id, data); else await addSeller(data);
    backdrop.remove();
  };
}

// ---- Rendering ----
function render() {
  if (!configOk) return renderConfigMissing();
  if (state.loadError) {
    $("#main").innerHTML = `
      <div class="empty" style="text-align:left;">
        <p style="color:var(--danger);font-weight:500;margin-bottom:6px;">Não consegui conectar ao banco de dados</p>
        <p style="font-size:13px;margin-bottom:10px;">Detalhe técnico: <span class="mono">${escapeHtml(state.loadError)}</span></p>
        <p style="font-size:13px;">Confira no Supabase (Table Editor) se as tabelas <b>products</b>, <b>sales</b>, <b>clients</b>, <b>sellers</b>, <b>receivables</b> e <b>receivable_payments</b> existem.</p>
      </div>`;
    return;
  }
  if (state.loading) {
    $("#main").innerHTML = `<p style="text-align:center;color:var(--muted2);padding:40px 0;">Carregando...</p>`;
    return;
  }
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  if (state.tab === "estoque") renderEstoque();
  if (state.tab === "clientes") renderClientes();
  if (state.tab === "recompras") renderRecompras();
  if (state.tab === "receber") renderContasReceber();
  if (state.tab === "pedidos") renderPedidos();
  if (state.tab === "movimentacoes") renderMovimentacoes();
  if (state.tab === "caixa") renderCaixa();
  if (state.tab === "vendedores") renderVendedores();
  if (state.tab === "resumo") renderResumo();
  updateBirthdayDot();
}

function renderConfigMissing() {
  $("#main").innerHTML = `
    <div class="empty">
      <p style="color:var(--ink);font-weight:500;margin-bottom:6px;">Configuração pendente</p>
      <p style="font-size:13px;">Abra o arquivo <code>config.js</code> e cole a URL e a chave anon do seu projeto Supabase. Veja o README.md.</p>
    </div>`;
}

function stockBadge(p) {
  const q = totalQty(p);
  if (q <= 0) return `<span class="badge badge-out">Sem estoque</span>`;
  if (p.min_stock > 0 && q <= p.min_stock) return `<span class="badge badge-low">Estoque baixo</span>`;
  return `<span class="badge badge-ok">Estoque ok</span>`;
}

function renderEstoque() {
  const sorted = [...state.products].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  const buildStockList = (loc) => {
    if (!sorted.length) return `<p style="font-size:13px;color:var(--muted2);margin:0;">Nenhum produto cadastrado.</p>`;
    return sorted.map((p) => {
      const qty = locQty(p, loc);
      let badgeCls, badgeText;
      if (qty <= 0) { badgeCls = "badge-out"; badgeText = "Sem estoque"; }
      else if (p.min_stock > 0 && qty <= p.min_stock) { badgeCls = "badge-low"; badgeText = "Estoque baixo"; }
      else { badgeCls = "badge-ok"; badgeText = "Ok"; }
      return `
        <div class="row" style="padding:7px 0;border-bottom:1px solid var(--border);">
          <span style="font-size:14px;">${escapeHtml(p.name)}</span>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            <span class="mono" style="font-size:13px;">${Number(qty.toFixed(3))} ${p.unit}</span>
            <span class="badge ${badgeCls}">${badgeText}</span>
          </div>
        </div>`;
    }).join("");
  };

  $("#main").innerHTML = `
    <div class="card" style="margin-bottom:20px;">
      <p style="font-size:13px;font-weight:500;color:var(--muted);margin:0 0 10px;">Consultar estoque por localidade</p>
      <div style="margin-bottom:12px;">
        <label class="field-label">Localidade</label>
        <select id="stock-loc-filter">
          <option value="mhu">Manhuaçu</option>
          <option value="bh">BH</option>
        </select>
      </div>
      <div id="stock-loc-list">${buildStockList("mhu")}</div>
    </div>
    <div class="row" style="margin-bottom:16px;">
      <p style="font-size:13px;color:var(--muted);margin:0;">${state.products.length} produto${state.products.length === 1 ? "" : "s"} cadastrado${state.products.length === 1 ? "" : "s"}</p>
      <button class="btn btn-dark" id="btn-new-product">+ Novo produto</button>
    </div>
    ${sorted.length === 0 ? `<div class="empty">Nenhum produto ainda. Cadastre o primeiro item do seu estoque.</div>` : ""}
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${sorted.map((p) => `
        <div class="card" data-id="${p.id}">
          <div class="row" style="align-items:flex-start;">
            <div style="min-width:0;">
              <p style="margin:0;font-size:15px;font-weight:500;">${escapeHtml(p.name)}</p>
              <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
                ${stockBadge(p)}
                <span style="font-size:12px;color:var(--muted2);">${money(p.price)} / ${p.unit}</span>
              </div>
            </div>
            <div style="display:flex;gap:2px;flex-shrink:0;">
              <button class="icon-btn btn-edit" title="Editar">✎</button>
              <button class="icon-btn danger btn-delete" title="Remover">🗑</button>
            </div>
          </div>
          <div class="loc-grid">
            <div class="loc-block">
              <span class="loc-label">Manhuaçu</span>
              <p class="mono" style="margin:2px 0 0;font-size:15px;">${Number(p.qty_mhu || 0)} ${p.unit}</p>
            </div>
            <div class="loc-block">
              <span class="loc-label">BH</span>
              <p class="mono" style="margin:2px 0 0;font-size:15px;">${Number(p.qty_bh || 0)} ${p.unit}</p>
            </div>
          </div>
          <div class="row" style="margin-top:10px;">
            <span style="font-size:12px;color:var(--muted2);">Total: <span class="mono">${Number(totalQty(p).toFixed(3))} ${p.unit}</span></span>
            <button class="btn-vender" style="background:none;border:none;color:var(--accent);font-size:13px;font-weight:500;cursor:pointer;">Vender</button>
          </div>
        </div>
      `).join("")}
    </div>
    <p style="font-size:11px;color:var(--muted2);text-align:center;margin-top:16px;">Para ajustar quantidades, use a aba <b>Movimentações</b> — assim fica registrado quem fez e por quê.</p>
  `;

  $("#stock-loc-filter").onchange = (e) => { $("#stock-loc-list").innerHTML = buildStockList(e.target.value); };
  $("#btn-new-product").onclick = () => openProductModal(null);
  $$(".card[data-id]", $("#main")).forEach((card) => {
    const id = card.dataset.id;
    const product = state.products.find((p) => p.id === id);
    if (!product) return;
    card.style.cursor = "pointer";
    card.onclick = () => openProductModal(product);
    $(".btn-edit", card).onclick = (e) => { e.stopPropagation(); openProductModal(product); };
    $(".btn-delete", card).onclick = async (e) => { e.stopPropagation(); if (confirm(`Remover "${product.name}"?`)) await deleteProduct(id); };
    $(".btn-vender", card).onclick = (e) => { e.stopPropagation(); openNewOrderModal({ presetProductId: id }); };
  });
}

function openProductModal(product) {
  const isEdit = !!product;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">${isEdit ? "Editar produto" : "Novo produto"}</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label class="field-label">Nome do produto</label>
          <input id="f-name" placeholder="Ex.: Café em grãos Bourbon" value="${isEdit ? escapeHtml(product.name) : ""}" />
        </div>
        <div class="grid2">
          <div>
            <label class="field-label">Unidade</label>
            <select id="f-unit">${UNITS.map((u) => `<option value="${u}" ${isEdit && product.unit === u ? "selected" : ""}>${u}</option>`).join("")}</select>
          </div>
          <div>
            <label class="field-label">Estoque mínimo</label>
            <input id="f-min" type="number" step="any" value="${isEdit ? product.min_stock : ""}" placeholder="0" />
          </div>
        </div>
        <p style="margin:0;font-size:13px;font-weight:500;color:var(--muted);">Custo de produção (por ${isEdit ? escapeHtml(product.unit) : "unidade"})</p>
        <div class="grid2">
          <div><label class="field-label">Embalagem (R$)</label><input id="f-cost-packaging" type="number" step="any" value="${isEdit ? Number(product.cost_packaging || 0) : ""}" placeholder="0,00" /></div>
          <div><label class="field-label">Torra (R$)</label><input id="f-cost-roasting" type="number" step="any" value="${isEdit ? Number(product.cost_roasting || 0) : ""}" placeholder="0,00" /></div>
        </div>
        <div><label class="field-label">Adesivos (R$)</label><input id="f-cost-stickers" type="number" step="any" value="${isEdit ? Number(product.cost_stickers || 0) : ""}" placeholder="0,00" /></div>
        <p id="f-cost-total" style="margin:0;font-size:13px;color:var(--muted);">Custo total: <b class="mono">R$ 0,00</b></p>
        <div>
          <label class="field-label">Preço de venda (R$)</label>
          <input id="f-price" type="number" step="any" value="${isEdit ? product.price : ""}" placeholder="0,00" />
        </div>
        <div id="profit-preview" class="profit-preview" style="display:none;"></div>
        ${!isEdit ? `<p style="margin:0;font-size:12px;color:var(--muted2);">Produto novo começa com estoque zerado. Depois de salvar, dê entrada na quantidade inicial pela aba <b>Movimentações</b>.</p>` : ""}
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn" id="modal-cancel" style="flex:1;">Cancelar</button>
          <button class="btn btn-accent" id="modal-save" style="flex:1;">Salvar</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#modal-close", backdrop).onclick = () => backdrop.remove();
  $("#modal-cancel", backdrop).onclick = () => backdrop.remove();

  const totalCost = () =>
    (Number($("#f-cost-packaging", backdrop).value) || 0) +
    (Number($("#f-cost-roasting", backdrop).value) || 0) +
    (Number($("#f-cost-stickers", backdrop).value) || 0);

  const updateProfit = () => {
    const cost = totalCost();
    const price = Number($("#f-price", backdrop).value) || 0;
    $("#f-cost-total", backdrop).innerHTML = `Custo total: <b class="mono">${money(cost)}</b>`;
    const preview = $("#profit-preview", backdrop);
    if (cost > 0 && price > 0) {
      const profit = price - cost;
      const margin = (profit / price) * 100;
      const markup = (price / cost - 1) * 100;
      const goodCls = profit >= 0 ? "profit-good" : "";
      preview.innerHTML = `
        <div class="profit-row"><span>Lucro por ${escapeHtml($("#f-unit", backdrop).value)}</span><span class="mono ${goodCls}">${money(profit)}</span></div>
        <div class="profit-row"><span>Margem</span><span class="mono ${goodCls}">${margin.toFixed(1)}%</span></div>
        <div class="profit-row"><span>Markup</span><span class="mono ${goodCls}">${markup.toFixed(1)}%</span></div>
      `;
      preview.style.display = "flex";
    } else { preview.style.display = "none"; }
  };
  $$("#f-cost-packaging, #f-cost-roasting, #f-cost-stickers, #f-price", backdrop).forEach((el) => { el.oninput = updateProfit; });
  $("#f-unit", backdrop).onchange = updateProfit;
  updateProfit();

  $("#modal-save", backdrop).onclick = async () => {
    const data = {
      name: $("#f-name", backdrop).value.trim(),
      unit: $("#f-unit", backdrop).value,
      minStock: Number($("#f-min", backdrop).value) || 0,
      price: Number($("#f-price", backdrop).value) || 0,
      costPackaging: Number($("#f-cost-packaging", backdrop).value) || 0,
      costRoasting: Number($("#f-cost-roasting", backdrop).value) || 0,
      costStickers: Number($("#f-cost-stickers", backdrop).value) || 0,
    };
    data.cost = data.costPackaging + data.costRoasting + data.costStickers;
    if (!data.name) return;
    if (isEdit) await updateProduct(product.id, data); else await addProduct(data);
    backdrop.remove();
  };
}

// ---- Vendas ----
function openNewOrderModal(opts = {}) {
  if (!state.products.length) { alert("Cadastre um produto no estoque antes de criar um pedido."); return; }
  state.cart = opts.presetProductId ? [{ productId: opts.presetProductId, qty: 1 }] : [];
  if (!state.cart.length) state.cart = [{ productId: state.products[0].id, qty: 1 }];

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal" id="order-modal-body" style="max-width:460px;"></div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) { state.cart = []; backdrop.remove(); } };

  let selectedClientId = "avista";

  const recalc = () => {
    const total = state.cart.reduce((sum, item) => {
      const p = state.products.find((x) => x.id === item.productId);
      return sum + (p ? p.price * item.qty : 0);
    }, 0);
    const disc = Number($("#o-discount", backdrop)?.value) || 0;
    $("#o-subtotal", backdrop) && ($("#o-subtotal", backdrop).textContent = money(total));
    $("#o-total", backdrop) && ($("#o-total", backdrop).textContent = money(Math.max(0, total - disc)));
  };

  function wire() {
    $("#modal-close", backdrop).onclick = () => { state.cart = []; backdrop.remove(); };
    $("#o-client", backdrop).onchange = (e) => { selectedClientId = e.target.value; };
    $("#o-new-client", backdrop).onclick = () => {
      openQuickClientModal((client) => { selectedClientId = client.id; paint(); });
    };
    $("#o-add-item", backdrop).onclick = () => { state.cart.push({ productId: state.products[0].id, qty: 1 }); paint(); };
    $$(".cart-product", backdrop).forEach((sel) => {
      sel.onchange = () => { state.cart[Number(sel.closest(".cart-row").dataset.idx)].productId = sel.value; paint(); };
    });
    $$(".cart-qty", backdrop).forEach((inp) => {
      inp.oninput = () => { state.cart[Number(inp.closest(".cart-row").dataset.idx)].qty = Number(inp.value) || 0; recalc(); };
    });
    $$(".cart-remove", backdrop).forEach((btn) => {
      btn.onclick = () => { state.cart.splice(Number(btn.dataset.idx), 1); paint(); };
    });
    $("#o-discount", backdrop).oninput = recalc;
    $("#o-payment", backdrop).onchange = (e) => {
      $("#o-caixa-wrap", backdrop).style.display = e.target.value === "prazo" ? "none" : "block";
    };
    $("#o-payment", backdrop).dispatchEvent(new Event("change"));

    $("#o-register", backdrop).onclick = async () => {
      const products = state.products;
      const loc = $("#o-location", backdrop).value;
      const clientId = $("#o-client", backdrop).value;
      const client = clientId !== "avista" ? state.clients.find((c) => c.id === clientId) : null;
      const clientName = client ? `${client.first_name} ${client.last_name || ""}`.trim() : "Cliente à vista";
      const sellerId = $("#o-seller", backdrop).value || null;
      const seller = sellerId ? state.sellers.find((v) => v.id === sellerId) : null;
      const sellerName = seller ? seller.name : null;
      const disc = Number($("#o-discount", backdrop).value) || 0;
      const validItems = state.cart.filter((i) => i.qty > 0 && products.find((p) => p.id === i.productId));
      if (!validItems.length) return;

      const cartTotalNow = state.cart.reduce((sum, item) => {
        const p = products.find((x) => x.id === item.productId);
        return sum + (p ? p.price * item.qty : 0);
      }, 0);

      const saleGroupId = crypto.randomUUID();
      let remainingDisc = disc;
      const itemsForMsg = [];
      for (const item of validItems) {
        const p = products.find((x) => x.id === item.productId);
        const itemDisc = validItems.length === 1 ? disc : Math.min(remainingDisc, p.price * item.qty);
        remainingDisc -= itemDisc;
        await registerSale(p, item.qty, {
          paymentMethod: $("#o-payment", backdrop).value, discount: itemDisc, location: loc,
          clientId: client ? client.id : null, clientName,
          sellerId, sellerName, saleGroupId,
        });
        itemsForMsg.push({ ...p, qty: item.qty });
      }
      const finalTotal = Math.max(0, cartTotalNow - disc);
      const paymentMethod = $("#o-payment", backdrop).value;
      if (paymentMethod === "prazo") {
        await createReceivable({ saleGroupId, clientId: client ? client.id : null, clientName, amount: finalTotal });
      } else {
        const caixaId = $("#o-caixa", backdrop).value;
        if (caixaId) {
          await logCashMovement({
            cashRegisterId: caixaId, movementType: "entrada", amount: finalTotal,
            description: `Venda${clientName !== "Cliente à vista" ? " — " + clientName : ""}`,
            originType: "venda", originId: saleGroupId, loggedBy: sellerName || null,
          });
        }
      }
      state.cart = [];
      backdrop.remove();
      showThankYouMessage(clientName, itemsForMsg, finalTotal);
      renderPedidos();
    };
  }

  function paint() {
    const products = state.products;
    const cartTotal = state.cart.reduce((sum, item) => {
      const p = products.find((x) => x.id === item.productId);
      return sum + (p ? p.price * item.qty : 0);
    }, 0);
    const clientOptions = `
      <option value="avista">Cliente à vista (sem cadastro)</option>
      ${state.clients.map((c) => `<option value="${c.id}" ${c.id === selectedClientId ? "selected" : ""}>${escapeHtml(c.first_name)} ${escapeHtml(c.last_name || "")}</option>`).join("")}
    `;
    const sellerOptions = `
      <option value="">Sem vendedor</option>
      ${state.sellers.map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join("")}
    `;
    $("#order-modal-body", backdrop).innerHTML = `
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">Novo pedido</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div>
          <label class="field-label">Cliente</label>
          <div style="display:flex;gap:6px;">
            <select id="o-client" style="flex:1;">${clientOptions}</select>
            <button class="btn" id="o-new-client" type="button" style="flex-shrink:0;">+ Novo</button>
          </div>
        </div>
        <div>
          <label class="field-label">Vendedor</label>
          <select id="o-seller">${sellerOptions}</select>
        </div>
        <div>
          <label class="field-label">Localidade (de qual estoque sai)</label>
          <select id="o-location">
            <option value="mhu">Manhuaçu</option>
            <option value="bh">BH</option>
          </select>
        </div>
        <div>
          <label class="field-label">Itens do pedido</label>
          <div id="o-cart-list">
            ${state.cart.map((item, idx) => {
              const p = products.find((x) => x.id === item.productId);
              return `
                <div class="cart-row" data-idx="${idx}">
                  <select class="cart-product" style="flex:2;">
                    ${products.map((pp) => `<option value="${pp.id}" ${pp.id === item.productId ? "selected" : ""}>${escapeHtml(pp.name)}</option>`).join("")}
                  </select>
                  <input class="cart-qty" type="number" min="0" step="any" value="${item.qty}" />
                  <span class="mono" style="font-size:12px;min-width:70px;text-align:right;">${money(p ? p.price * item.qty : 0)}</span>
                  <button class="cart-remove" data-idx="${idx}">✕</button>
                </div>`;
            }).join("") || `<p style="font-size:13px;color:var(--muted2);">Nenhum item adicionado.</p>`}
          </div>
          <button class="btn" id="o-add-item" type="button" style="margin-top:8px;width:100%;">+ Adicionar produto</button>
        </div>
        <div class="grid2">
          <div><label class="field-label">Desconto (R$)</label><input id="o-discount" type="number" min="0" step="any" value="0" /></div>
          <div>
            <label class="field-label">Forma de pagamento</label>
            <select id="o-payment">
              ${PAYMENT_METHODS.map((m) => `<option value="${m.value}" ${m.value === "dinheiro" ? "selected" : ""}>${m.label}</option>`).join("")}
            </select>
          </div>
        </div>
        <div id="o-caixa-wrap">
          <label class="field-label">Caixa que recebeu</label>
          <select id="o-caixa">
            <option value="">Não lançar no caixa</option>
            ${state.cashRegisters.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
          </select>
        </div>
        <div class="sale-totals">
          <div class="row"><span>Subtotal</span><span class="mono" id="o-subtotal">${money(cartTotal)}</span></div>
          <div class="row" style="font-weight:600;"><span>Total</span><span class="mono" id="o-total">${money(cartTotal)}</span></div>
        </div>
        <button class="btn btn-accent" id="o-register" ${!state.cart.length ? "disabled" : ""}>Registrar pedido</button>
      </div>`;
    wire();
  }

  paint();
}

function openQuickClientModal(onCreated) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.style.zIndex = "60";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">Novo cliente</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 4px;">Cadastro rápido — dá pra completar os outros dados depois na aba Clientes.</p>
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div><label class="field-label">Nome</label><input id="qc-name" placeholder="Nome do cliente" /></div>
        <div><label class="field-label">Telefone</label><input id="qc-phone" placeholder="(00) 00000-0000" /></div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn" id="modal-cancel" style="flex:1;">Cancelar</button>
          <button class="btn btn-accent" id="modal-save" style="flex:1;">Salvar</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#modal-close", backdrop).onclick = () => backdrop.remove();
  $("#modal-cancel", backdrop).onclick = () => backdrop.remove();
  $("#qc-name", backdrop).focus();
  $("#modal-save", backdrop).onclick = async () => {
    const firstName = $("#qc-name", backdrop).value.trim();
    const phone = $("#qc-phone", backdrop).value.trim();
    if (!firstName) return;
    const client = await addClient({ firstName, lastName: "", phone, city: "", birthday: "" });
    if (client && !state.clients.find((c) => c.id === client.id)) state.clients.push(client);
    backdrop.remove();
    onCreated && onCreated(client);
  };
}

function showThankYouMessage(clientName, items, total) {
  const itemsText = items.map((i) => `- ${i.qty} ${i.unit} de ${i.name}`).join("\n");
  const message = `Muito obrigado pela compra! ☕🤎
É um prazer ter você como cliente do Café Sinceridade. Espero que goste muito do nosso café!

${itemsText}
Total: ${money(total)}

Para finalizar o pedido, segue a chave Pix:

Pix: ${PIX_KEY}

Depois, é só me enviar o comprovante por aqui.

Obrigado pela confiança e aproveite seu café!`;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">Pedido registrado ✅</h3>
        <button class="icon-btn" id="ty-close">✕</button>
      </div>
      <p style="font-size:13px;color:var(--muted);margin:0 0 8px;">Mensagem para ${escapeHtml(clientName)}:</p>
      <div class="thank-msg" id="ty-text">${escapeHtml(message)}</div>
      <button class="btn btn-accent" id="ty-copy" style="width:100%;margin-top:12px;">Copiar mensagem</button>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#ty-close", backdrop).onclick = () => backdrop.remove();
  $("#ty-copy", backdrop).onclick = () => {
    navigator.clipboard.writeText(message);
    $("#ty-copy", backdrop).textContent = "Copiado ✓";
  };
}

// ---- Clientes ----
function renderClientes() {
  const sorted = [...state.clients].sort((a, b) => a.first_name.localeCompare(b.first_name, "pt-BR"));
  $("#main").innerHTML = `
    <div class="row" style="margin-bottom:16px;">
      <p style="font-size:13px;color:var(--muted);margin:0;">${sorted.length} cliente${sorted.length === 1 ? "" : "s"} cadastrado${sorted.length === 1 ? "" : "s"}</p>
      <button class="btn btn-dark" id="btn-new-client">+ Novo cliente</button>
    </div>
    ${sorted.length === 0 ? `<div class="empty">Nenhum cliente cadastrado ainda.</div>` : ""}
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${sorted.map((c) => {
        const sales = clientSales(c.id);
        const totalSpent = sales.reduce((s, x) => s + Number(x.total), 0);
        // Status de recompra mais urgente do cliente (para destaque na lista).
        const preds = clientPredictions(c.id).filter((p) => p.hasPrediction);
        const topPred = preds[0] || null;
        const recompraLine = topPred ? `
              <p style="margin:6px 0 0;font-size:12px;">
                <span class="badge ${topPred.status.cls}">${topPred.status.emoji} ${topPred.status.label}</span>
                <span style="color:var(--muted2);"> · próx. ${fmtDateBR(topPred.nextEstimated)}</span>
              </p>` : "";
        return `
        <div class="card" data-id="${c.id}">
          <div class="row" style="align-items:flex-start;">
            <div style="min-width:0;">
              <p style="margin:0;font-size:15px;font-weight:500;">${escapeHtml(c.first_name)} ${escapeHtml(c.last_name || "")}</p>
              <p style="margin:4px 0 0;font-size:12px;color:var(--muted2);">${escapeHtml(c.phone || "")} ${c.city ? "· " + escapeHtml(c.city) : ""} ${c.birthday ? "· 🎂 " + new Date(c.birthday + "T00:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : ""}</p>
              <p style="margin:6px 0 0;font-size:12px;color:var(--muted);">${sales.length} compra${sales.length === 1 ? "" : "s"} · <span class="mono">${money(totalSpent)}</span></p>
              ${recompraLine}
            </div>
            <div style="display:flex;gap:2px;flex-shrink:0;">
              <button class="icon-btn btn-history" title="Histórico de compras">🧾</button>
              <button class="icon-btn btn-edit-client" title="Editar">✎</button>
              <button class="icon-btn danger btn-delete-client" title="Remover">🗑</button>
            </div>
          </div>
        </div>`;
      }).join("")}
    </div>`;
  $("#btn-new-client").onclick = () => openClientModal(null);
  $$(".card[data-id]", $("#main")).forEach((card) => {
    const id = card.dataset.id;
    const client = state.clients.find((c) => c.id === id);
    $(".btn-edit-client", card).onclick = () => openClientModal(client);
    $(".btn-history", card).onclick = () => openClientHistoryModal(client);
    $(".btn-delete-client", card).onclick = async () => { if (confirm(`Remover ${client.first_name}?`)) await deleteClient(id); };
  });
}

// ---- Helpers de exibição das previsões (reutilizados na ficha e na Central) ----
const roundQty = (n) => Number(Number(n).toFixed(Number.isInteger(n) ? 0 : 1));

// Texto relativo da próxima recompra: "hoje", "em 3 dias", "atrasada há 2 dias".
function nextRecompraRelative(pred) {
  const d = pred.daysUntilNext;
  if (d === 0) return "hoje";
  if (d > 0) return `em ${d} dia${d === 1 ? "" : "s"}`;
  const a = Math.abs(d);
  return `atrasada há ${a} dia${a === 1 ? "" : "s"}`;
}

// Barrinha de confiabilidade.
function confBarHTML(conf) {
  return `<span class="conf-wrap">Confiabilidade
    <span class="conf-bar"><span class="conf-fill ${conf.cls}" style="width:${conf.pct}%;"></span></span>
    <b style="color:var(--ink);">${conf.label}</b></span>`;
}

// Card detalhado de previsão de um produto (usado na ficha do cliente).
function predictionCardHTML(pred) {
  if (!pred.hasPrediction) {
    return `
      <div class="card" style="padding:12px 14px;">
        <div class="row" style="align-items:flex-start;">
          <p style="margin:0;font-size:14px;font-weight:500;">${escapeHtml(pred.productName)}</p>
          <span class="badge ${pred.status.cls}">${pred.status.emoji} ${pred.status.label}</span>
        </div>
        <p style="margin:6px 0 0;font-size:12px;color:var(--muted2);">Última compra: <b>${fmtDateBR(pred.lastPurchase)}</b> · ${roundQty(pred.lastQty)} ${escapeHtml(pred.unit)}</p>
        <p style="margin:4px 0 0;font-size:12px;color:var(--muted2);">${escapeHtml(pred.note || "Sem histórico suficiente para prever o ritmo.")}</p>
      </div>`;
  }
  const hl = pred.status.key === "atrasada" ? "is-atrasada"
           : pred.status.key === "acabando" ? "is-acabando"
           : pred.status.key === "proxima" ? "is-proxima" : "";
  return `
    <div class="card" style="padding:12px 14px;">
      <div class="row" style="align-items:flex-start;margin-bottom:8px;">
        <p style="margin:0;font-size:14px;font-weight:500;">${escapeHtml(pred.productName)}</p>
        <span class="badge ${pred.status.cls}">${pred.status.emoji} ${pred.status.label}</span>
      </div>
      <div class="recompra-highlight ${hl}">
        <div>
          <div class="rh-label">Próxima recompra</div>
          <div class="rh-date">${fmtDateBR(pred.nextEstimated)}</div>
        </div>
        <div style="text-align:right;">
          <div class="rh-label">${pred.daysUntilNext < 0 ? "Situação" : "Faltam"}</div>
          <div style="font-size:14px;font-weight:600;">${nextRecompraRelative(pred)}</div>
        </div>
      </div>
      <div class="rc-detail"><span>Última compra</span><b>${fmtDateBR(pred.lastPurchase)}</b></div>
      <div class="rc-detail"><span>Quantidade média</span><b>${roundQty(pred.avgQty)} ${escapeHtml(pred.unit)}</b></div>
      <div class="rc-detail"><span>Intervalo médio</span><b>${Math.round(pred.avgInterval)} dias</b></div>
      <div class="rc-detail"><span>Contato recomendado</span><b>${fmtDateBR(pred.contactDate)}</b></div>
      <div class="rc-detail"><span>Compras usadas no cálculo</span><b>${pred.windowUsed} de ${pred.totalPurchases}</b></div>
      <div class="rc-detail" style="border-top:1px solid var(--border);margin-top:4px;padding-top:8px;">
        <span>${confBarHTML(pred.confidence)}</span>
        <button class="btn btn-accent btn-mark-contact"
          data-pid="${pred.productId || ""}" data-pname="${escapeHtml(pred.productName)}"
          style="padding:6px 10px;font-size:12px;">Marcar contato</button>
      </div>
    </div>`;
}

// "Consumo médio" resumido para o cliente (usa a previsão de maior confiança).
function consumoResumo(preds) {
  const withPred = preds.filter((p) => p.hasPrediction);
  if (!withPred.length) return "";
  const lines = withPred.map((p) =>
    `${roundQty(p.avgQty)} × ${escapeHtml(p.productName)} a cada ${Math.round(p.avgInterval)} dias`
  );
  return `
    <div class="card" style="background:var(--surface);margin-bottom:12px;padding:12px 14px;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:var(--muted);">📈 Consumo médio</p>
      <p style="margin:0;font-size:13px;color:var(--ink);">Este cliente consome aproximadamente:</p>
      <ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--muted);">
        ${lines.map((l) => `<li style="margin:2px 0;">${l}</li>`).join("")}
      </ul>
    </div>`;
}

function openClientHistoryModal(client) {
  const sales = clientSales(client.id);
  const totalSpent = sales.reduce((s, x) => s + Number(x.total), 0);
  const clientName = `${client.first_name} ${client.last_name || ""}`.trim();
  const preds = clientPredictions(client.id);
  const predsWith = preds.filter((p) => p.hasPrediction);
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:4px;">
        <h3 class="serif" style="margin:0;font-size:17px;">Ficha de ${escapeHtml(client.first_name)}</h3>
        <button class="icon-btn" id="ch-close">✕</button>
      </div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 14px;">${sales.length} compra${sales.length === 1 ? "" : "s"} · total gasto <span class="mono">${money(totalSpent)}</span></p>

      <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:var(--muted);">🔮 Previsão de Recompra</p>
      ${preds.length === 0
        ? `<p style="font-size:13px;color:var(--muted2);margin:0 0 14px;">Sem compras registradas para este cliente.</p>`
        : `<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
             ${preds.map((p) => predictionCardHTML(p)).join("")}
           </div>`}
      ${predsWith.length ? consumoResumo(preds) : ""}

      <p style="margin:6px 0 8px;font-size:13px;font-weight:600;color:var(--muted);">🧾 Histórico de compras</p>
      ${sales.length === 0 ? `<p style="font-size:13px;color:var(--muted2);">Nenhuma compra registrada ainda.</p>` : `
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${sales.map((s) => `
            <div class="card" style="padding:9px 12px;">
              <div class="row">
                <div style="min-width:0;">
                  <p style="margin:0;font-size:14px;">${escapeHtml(s.product_name)}</p>
                  <p style="margin:0;font-size:12px;color:var(--muted2);">${new Date(s.sold_at).toLocaleDateString("pt-BR")} · ${s.quantity} ${s.unit || ""} × ${money(s.unit_price)}</p>
                  <span class="badge ${paymentCls(s.payment_method)}" style="margin-top:4px;display:inline-block;">${paymentLabel(s.payment_method)}</span>
                </div>
                <span class="mono" style="font-size:14px;flex-shrink:0;">${money(s.total)}</span>
              </div>
            </div>`).join("")}
        </div>`}
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#ch-close", backdrop).onclick = () => backdrop.remove();
  $$(".btn-mark-contact", backdrop).forEach((btn) => {
    btn.onclick = () => {
      backdrop.remove();
      openRecompraContactModal({
        clientId: client.id, clientName,
        productId: btn.dataset.pid || null, productName: btn.dataset.pname,
      });
    };
  });
}

// ---- Modal: registrar contato de recompra ----
function openRecompraContactModal({ clientId, clientName, productId, productName }) {
  const last = lastContactFor(clientId, productName);
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">Registrar contato</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <p style="font-size:13px;color:var(--muted);margin:0 0 14px;">
        <b>${escapeHtml(clientName)}</b>${productName ? ` · ${escapeHtml(productName)}` : ""}
      </p>
      ${last ? `<p style="font-size:12px;color:var(--muted2);margin:0 0 12px;">Último contato: ${fmtDateBR(last.contacted_at)}${last.contacted_by ? " · por " + escapeHtml(last.contacted_by) : ""}</p>` : ""}
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label class="field-label">Responsável pelo contato</label>
          <select id="rc-by"></select>
        </div>
        <div>
          <label class="field-label">Observação (opcional)</label>
          <input id="rc-note" placeholder="Ex.: cliente disse que ainda tem estoque" />
        </div>
        <p style="font-size:11px;color:var(--muted2);margin:0;">O contato é apenas um registro — não altera a previsão, que continua baseada no histórico de compras.</p>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn" id="modal-cancel" style="flex:1;">Cancelar</button>
          <button class="btn btn-accent" id="modal-save" style="flex:1;">Salvar contato</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const bySel = $("#rc-by", backdrop);
  bySel.innerHTML = `<option value="">— selecione —</option>` +
    state.sellers.map((v) => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)}</option>`).join("") +
    `<option value="admin">admin</option>`;
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#modal-close", backdrop).onclick = () => backdrop.remove();
  $("#modal-cancel", backdrop).onclick = () => backdrop.remove();
  $("#modal-save", backdrop).onclick = async () => {
    await addRecompraContact({
      clientId, clientName, productId, productName,
      contactedBy: $("#rc-by", backdrop).value || null,
      note: $("#rc-note", backdrop).value.trim() || null,
    });
    backdrop.remove();
  };
}

function openClientModal(client) {
  const isEdit = !!client;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">${isEdit ? "Editar cliente" : "Novo cliente"}</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="grid2">
          <div><label class="field-label">Nome</label><input id="c-first" value="${isEdit ? escapeHtml(client.first_name) : ""}" /></div>
          <div><label class="field-label">Sobrenome</label><input id="c-last" value="${isEdit ? escapeHtml(client.last_name || "") : ""}" /></div>
        </div>
        <div><label class="field-label">Telefone</label><input id="c-phone" value="${isEdit ? escapeHtml(client.phone || "") : ""}" placeholder="(00) 00000-0000" /></div>
        <div><label class="field-label">Cidade</label><input id="c-city" value="${isEdit ? escapeHtml(client.city || "") : ""}" /></div>
        <div><label class="field-label">Data de aniversário</label><input id="c-birthday" type="date" value="${isEdit && client.birthday ? client.birthday : ""}" /></div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn" id="modal-cancel" style="flex:1;">Cancelar</button>
          <button class="btn btn-accent" id="modal-save" style="flex:1;">Salvar</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#modal-close", backdrop).onclick = () => backdrop.remove();
  $("#modal-cancel", backdrop).onclick = () => backdrop.remove();
  $("#modal-save", backdrop).onclick = async () => {
    const data = {
      firstName: $("#c-first", backdrop).value.trim(),
      lastName: $("#c-last", backdrop).value.trim(),
      phone: $("#c-phone", backdrop).value.trim(),
      city: $("#c-city", backdrop).value.trim(),
      birthday: $("#c-birthday", backdrop).value,
    };
    if (!data.firstName) return;
    if (isEdit) await updateClient(client.id, data); else await addClient(data);
    backdrop.remove();
  };
}

// ---- Central de Recompras ----
const RECOMPRA_WINDOWS = [
  { key: "today",    label: "Hoje" },
  { key: "3",        label: "Próx. 3 dias" },
  { key: "7",        label: "Próx. 7 dias" },
  { key: "15",       label: "Próx. 15 dias" },
  { key: "atrasada", label: "Atrasados" },
  { key: "all",      label: "Todos" },
];

// Aplica o filtro de janela de tempo sobre uma previsão.
function matchesWindow(pred, win) {
  const d = pred.daysUntilNext;
  if (win === "all") return true;
  if (win === "atrasada") return d < 0;
  if (win === "today") return d <= 0; // hoje ou já atrasada
  const n = Number(win);
  return d <= n; // dentro dos próximos N dias (inclui atrasadas)
}

function renderRecompras() {
  const f = state.recompraFilter;
  let preds = allPredictions();

  // Opções de filtro (clientes/produtos com previsão).
  const clientNames = Array.from(new Set(preds.map((p) => p.clientName))).sort((a, b) => a.localeCompare(b, "pt-BR"));
  const productNames = Array.from(new Set(preds.map((p) => p.productName))).sort((a, b) => a.localeCompare(b, "pt-BR"));

  // Aplica filtros.
  let filtered = preds.filter((p) => matchesWindow(p, f.window));
  if (f.clientId) filtered = filtered.filter((p) => p.clientId === f.clientId);
  if (f.productName) filtered = filtered.filter((p) => p.productName === f.productName);
  if (f.status) filtered = filtered.filter((p) => p.status.key === f.status);

  // Contadores por status (para o resumo do topo — sempre sobre o total).
  const counts = { atrasada: 0, acabando: 0, proxima: 0, recente: 0 };
  preds.forEach((p) => { counts[p.status.key] = (counts[p.status.key] || 0) + 1; });

  const pills = RECOMPRA_WINDOWS.map((w) =>
    `<button class="rc-pill ${f.window === w.key ? "active" : ""}" data-win="${w.key}">${w.label}</button>`
  ).join("");

  const clientOpts = `<option value="">Todos os clientes</option>` +
    state.clients.filter((c) => clientNames.includes(`${c.first_name} ${c.last_name || ""}`.trim()))
      .map((c) => `<option value="${c.id}" ${f.clientId === c.id ? "selected" : ""}>${escapeHtml(`${c.first_name} ${c.last_name || ""}`.trim())}</option>`).join("");
  const productOpts = `<option value="">Todos os produtos</option>` +
    productNames.map((n) => `<option value="${escapeHtml(n)}" ${f.productName === n ? "selected" : ""}>${escapeHtml(n)}</option>`).join("");
  const statusOpts = `<option value="">Todos os status</option>` +
    ["atrasada", "acabando", "proxima", "recente"].map((k) =>
      `<option value="${k}" ${f.status === k ? "selected" : ""}>${RECOMPRA_STATUS[k].emoji} ${RECOMPRA_STATUS[k].label}</option>`).join("");

  const rowHTML = (p) => {
    const contactBadge = p.daysUntilContact <= 0
      ? `<span class="badge badge-atrasada" style="margin-left:4px;">Contatar já</span>`
      : `<span style="color:var(--muted2);font-size:11px;"> · contato em ${p.daysUntilContact} dia${p.daysUntilContact === 1 ? "" : "s"}</span>`;
    return `
      <div class="card" data-cid="${p.clientId}" data-pname="${escapeHtml(p.productName)}" data-pid="${p.productId || ""}" style="margin-bottom:10px;">
        <div class="row" style="align-items:flex-start;">
          <div style="min-width:0;">
            <p style="margin:0;font-size:15px;font-weight:500;">${p.status.emoji} ${escapeHtml(p.clientName)}</p>
            <p style="margin:3px 0 0;font-size:13px;color:var(--muted);">${escapeHtml(p.productName)} · ${roundQty(p.avgQty)} ${escapeHtml(p.unit)}</p>
            <p style="margin:4px 0 0;font-size:12px;color:var(--muted2);">
              Recompra estimada: <b style="color:var(--ink);">${fmtDateBR(p.nextEstimated)}</b> (${nextRecompraRelative(p)})${contactBadge}
            </p>
          </div>
          <span class="badge ${p.status.cls}" style="flex-shrink:0;">${p.status.label}</span>
        </div>
        <div class="row" style="margin-top:8px;">
          <span class="conf-wrap">Confiab.
            <span class="conf-bar"><span class="conf-fill ${p.confidence.cls}" style="width:${p.confidence.pct}%;"></span></span>
            <b style="color:var(--ink);">${p.confidence.label}</b></span>
          <button class="btn btn-accent btn-rc-contact" style="padding:6px 10px;font-size:12px;">Marcar contato</button>
        </div>
      </div>`;
  };

  $("#main").innerHTML = `
    <div class="grid2" style="margin-bottom:16px;">
      <div class="metric"><div class="label">🔴 Atrasados</div><div class="value mono">${counts.atrasada}</div></div>
      <div class="metric"><div class="label">🟠 Acabando</div><div class="value mono">${counts.acabando}</div></div>
      <div class="metric"><div class="label">🟡 Próx. recompra</div><div class="value mono">${counts.proxima}</div></div>
      <div class="metric"><div class="label">🟢 Recentes</div><div class="value mono">${counts.recente}</div></div>
    </div>

    <div class="rc-filter-pills" style="margin-bottom:12px;">${pills}</div>

    <div class="grid2" style="margin-bottom:8px;">
      <select id="rc-f-client">${clientOpts}</select>
      <select id="rc-f-product">${productOpts}</select>
    </div>
    <select id="rc-f-status" style="margin-bottom:16px;">${statusOpts}</select>

    <p style="font-size:12px;color:var(--muted);margin:0 0 10px;">${filtered.length} resultado${filtered.length === 1 ? "" : "s"} · ordenados por urgência</p>
    ${filtered.length === 0
      ? `<div class="empty">Nenhuma recompra neste filtro. ${preds.length === 0 ? "Ainda não há clientes com histórico suficiente (2+ compras do mesmo produto)." : ""}</div>`
      : filtered.map(rowHTML).join("")}
  `;

  $$(".rc-pill", $("#main")).forEach((b) => { b.onclick = () => { state.recompraFilter.window = b.dataset.win; renderRecompras(); }; });
  $("#rc-f-client").onchange = (e) => { state.recompraFilter.clientId = e.target.value; renderRecompras(); };
  $("#rc-f-product").onchange = (e) => { state.recompraFilter.productName = e.target.value; renderRecompras(); };
  $("#rc-f-status").onchange = (e) => { state.recompraFilter.status = e.target.value; renderRecompras(); };
  $$(".btn-rc-contact", $("#main")).forEach((btn) => {
    btn.onclick = () => {
      const card = btn.closest(".card");
      const client = state.clients.find((c) => c.id === card.dataset.cid);
      openRecompraContactModal({
        clientId: card.dataset.cid,
        clientName: client ? `${client.first_name} ${client.last_name || ""}`.trim() : "",
        productId: card.dataset.pid || null,
        productName: card.dataset.pname,
      });
    };
  });
}

// ---- Contas a receber ----
function receivablesByClient() {
  const map = {};
  state.receivables.forEach((r) => {
    const key = r.client_id || `nome:${r.client_name}`;
    if (!map[key]) map[key] = { key, clientId: r.client_id, clientName: r.client_name, devido: 0, pago: 0, items: [] };
    map[key].devido += Number(r.amount);
    map[key].pago += Number(r.paid_amount || 0);
    map[key].items.push(r);
  });
  return Object.values(map).map((c) => ({ ...c, saldo: Number((c.devido - c.pago).toFixed(2)) }));
}

function renderContasReceber() {
  const groups = receivablesByClient().sort((a, b) => b.saldo - a.saldo);
  const query = (state.receberQuery || "").toLowerCase();
  const filteredGroups = query ? groups.filter((g) => g.clientName.toLowerCase().includes(query)) : groups;
  const devendoAlgo = filteredGroups.filter((g) => g.saldo > 0.004);
  const quitados = filteredGroups.filter((g) => g.saldo <= 0.004 && g.devido > 0);
  const totalAReceber = groups.filter((g) => g.saldo > 0.004).reduce((s, g) => s + g.saldo, 0);
  const totalClientesDevendo = groups.filter((g) => g.saldo > 0.004).length;

  const rowHtml = (g) => `
    <div class="card" data-key="${escapeHtml(g.key)}" style="margin-bottom:10px;cursor:pointer;">
      <div class="row" style="align-items:flex-start;">
        <div style="min-width:0;">
          <p style="margin:0;font-size:15px;font-weight:500;">${escapeHtml(g.clientName)}</p>
          <p style="margin:4px 0 0;font-size:12px;color:var(--muted2);">Devido: <span class="mono">${money(g.devido)}</span> · Pago: <span class="mono">${money(g.pago)}</span></p>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <p style="margin:0;font-size:15px;font-weight:600;color:${g.saldo > 0.004 ? "var(--danger-text)" : "var(--accent-dark)"};" class="mono">${money(g.saldo)}</p>
          <p style="margin:2px 0 0;font-size:11px;color:var(--muted2);">${g.saldo > 0.004 ? "em aberto" : "quitado"}</p>
        </div>
      </div>
    </div>`;

  $("#main").innerHTML = `
    <div class="grid2" style="margin-bottom:16px;">
      <div class="metric"><div class="label">💸 Total a receber</div><div class="value mono">${money(totalAReceber)}</div></div>
      <div class="metric"><div class="label">🙋 Clientes devendo</div><div class="value mono">${totalClientesDevendo}</div></div>
    </div>
    <input id="receber-search" placeholder="Buscar cliente pelo nome..." value="${escapeHtml(state.receberQuery || "")}" style="margin-bottom:16px;" />
    <p style="font-size:13px;font-weight:500;color:var(--muted);margin:0 0 8px;">Em aberto</p>
    ${devendoAlgo.length === 0 ? `<div class="empty" style="margin-bottom:20px;">${query ? "Nenhum cliente encontrado." : "Ninguém devendo no momento 🎉"}</div>` : `<div style="margin-bottom:20px;">${devendoAlgo.map(rowHtml).join("")}</div>`}
    ${quitados.length ? `
      <p style="font-size:13px;font-weight:500;color:var(--muted);margin:0 0 8px;">Quitados</p>
      <div>${quitados.map(rowHtml).join("")}</div>` : ""}
  `;

  $("#receber-search").oninput = (e) => { state.receberQuery = e.target.value; renderContasReceber(); };
  $$(".card[data-key]", $("#main")).forEach((card) => {
    card.onclick = () => {
      const g = groups.find((x) => x.key === card.dataset.key);
      if (g) openClientReceivablesModal(g);
    };
  });
}

function openClientReceivablesModal(group) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const currentGroup = () => receivablesByClient().find((g) => g.key === group.key) || { ...group, devido: 0, pago: 0, saldo: 0 };

  const renderStatement = () => {
    const g = currentGroup();
    const rows = clientStatementRows(group);
    const receivablesById = {};
    state.receivables.forEach((r) => { receivablesById[r.id] = r; });

    const rowsHtml = rows.length === 0 ? `<p style="font-size:13px;color:var(--muted2);">Nenhuma movimentação ainda.</p>` : rows.map((e) => {
      const date = new Date(e.date).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
      if (e.type === "compra") {
        const r = receivablesById[e.receivableId];
        const saldoR = r ? Number((Number(r.amount) - Number(r.paid_amount || 0)).toFixed(2)) : 0;
        return `
          <div class="rc-detail" data-rid="${e.receivableId}" style="align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border);">
            <span>
              🧾 Compra${e.saleGroupId ? ` · Pedido #${orderNumber(e.saleGroupId)}` : ""}<br/>
              <span style="font-size:11px;color:var(--muted2);">${date}${r ? ` · ${escapeHtml(receivableStatusLabel(r.status))}` : ""}</span>
              <br/>
              ${saldoR > 0.004 ? `<button class="btn btn-quitar-pedido" style="margin-top:4px;font-size:11px;padding:4px 8px;">Quitar este pedido (${money(saldoR)})</button>` : ""}
              <button class="icon-btn danger btn-del-receivable" style="min-width:26px;min-height:26px;font-size:12px;padding:2px;margin-top:4px;" title="Excluir esta conta a receber">🗑</button>
            </span>
            <span style="text-align:right;flex-shrink:0;">
              <b class="mono" style="color:var(--danger-text);">+${money(e.amount)}</b><br/>
              <span style="font-size:11px;color:var(--muted2);">saldo ${money(e.runningBalance)}</span>
            </span>
          </div>`;
      }
      return `
        <div class="rc-detail" style="align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border);">
          <span>
            💰 Pagamento${e.paymentMethod ? " via " + escapeHtml(paymentLabel(e.paymentMethod)) : ""}<br/>
            <span style="font-size:11px;color:var(--muted2);">${date}${e.note ? " · " + escapeHtml(e.note) : ""}</span>
          </span>
          <span style="text-align:right;flex-shrink:0;">
            <b class="mono" style="color:var(--accent-dark);">−${money(e.amount)}</b><br/>
            <span style="font-size:11px;color:var(--muted2);">saldo ${money(e.runningBalance)}</span>
          </span>
        </div>`;
    }).join("");

    $("#crv-body", backdrop).innerHTML = `
      <div class="grid2" style="margin-bottom:16px;">
        <div class="metric"><div class="label">Total devido</div><div class="value mono">${money(g.devido)}</div></div>
        <div class="metric"><div class="label">Saldo em aberto</div><div class="value mono" style="color:${g.saldo > 0.004 ? "var(--danger-text)" : "var(--accent-dark)"};">${money(g.saldo)}</div></div>
      </div>
      ${g.saldo > 0.004 ? `<button class="btn btn-accent btn-pay-total" style="width:100%;margin-bottom:18px;">Quitar pagamento (saldo ${money(g.saldo)})</button>` : ""}
      <p style="font-size:13px;font-weight:500;color:var(--muted);margin:0 0 4px;">Extrato</p>
      <div>${rowsHtml}</div>
    `;

    $(".btn-pay-total", backdrop) && ($(".btn-pay-total", backdrop).onclick = () => openClientPaymentModal(group, () => renderStatement()));
    $$(".btn-quitar-pedido", backdrop).forEach((btn) => {
      btn.onclick = () => {
        const rid = btn.closest("[data-rid]").dataset.rid;
        const receivable = state.receivables.find((r) => r.id === rid);
        openRegisterPaymentModal(receivable, () => renderStatement());
      };
    });
    $$(".btn-del-receivable", backdrop).forEach((btn) => {
      btn.onclick = async () => {
        const rid = btn.closest("[data-rid]").dataset.rid;
        if (confirm("Excluir esta conta a receber? Isso não afeta a venda já registrada, só remove esse lançamento de dívida.")) {
          await deleteReceivable(rid);
          renderStatement();
        }
      };
    });
  };

  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">${escapeHtml(group.clientName)}</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <div id="crv-body"></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#modal-close", backdrop).onclick = () => { backdrop.remove(); renderContasReceber(); };
  renderStatement();
}

function openClientPaymentModal(group, onDone) {
  const g = receivablesByClient().find((x) => x.key === group.key) || group;
  const saldo = Number(g.saldo.toFixed(2));
  const methods = PAYMENT_METHODS.filter((m) => m.value !== "prazo");
  const lastOperator = localStorage.getItem("cafe_app_last_operator") || "";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.style.zIndex = "60";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">Quitar pagamento</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;">
        <p style="margin:0;font-size:13px;color:var(--muted);">
          Saldo devedor de ${escapeHtml(group.clientName)}: <b class="mono">${money(saldo)}</b><br/>
          <span style="font-size:11px;">Se ele tiver mais de um pedido em aberto, o valor abate primeiro os mais antigos.</span>
        </p>
        <div><label class="field-label">Valor pago agora (R$)</label><input id="cp-amount" type="number" min="0.01" max="${saldo}" step="any" value="${saldo}" /></div>
        <div><label class="field-label">Forma de pagamento</label>
          <select id="cp-method">${methods.map((m) => `<option value="${m.value}" ${m.value === "dinheiro" ? "selected" : ""}>${m.label}</option>`).join("")}</select>
        </div>
        <div><label class="field-label">Caixa que recebeu</label>
          <select id="cp-caixa">
            <option value="">Não lançar no caixa</option>
            ${state.cashRegisters.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
          </select>
        </div>
        <div><label class="field-label">Registrado por</label><input id="cp-operator" value="${escapeHtml(lastOperator)}" placeholder="seu nome" /></div>
        <div><label class="field-label">Observação (opcional)</label><input id="cp-note" type="text" placeholder="ex: pagou parcelado" /></div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn" id="modal-cancel" style="flex:1;">Cancelar</button>
          <button class="btn btn-accent" id="modal-save" style="flex:1;">Confirmar</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#modal-close", backdrop).onclick = () => backdrop.remove();
  $("#modal-cancel", backdrop).onclick = () => backdrop.remove();
  $("#modal-save", backdrop).onclick = async () => {
    let amount = Number($("#cp-amount", backdrop).value) || 0;
    if (amount <= 0) return;
    if (amount > saldo + 0.004) {
      alert(`O valor não pode ser maior que o saldo devedor (${money(saldo)}).`);
      return;
    }
    const note = $("#cp-note", backdrop).value.trim();
    const paymentMethod = $("#cp-method", backdrop).value;
    const caixaId = $("#cp-caixa", backdrop).value;
    const operator = $("#cp-operator", backdrop).value.trim();
    if (operator) localStorage.setItem("cafe_app_last_operator", operator);
    const applied = await registerClientPayment(group, amount, { paymentMethod, note, loggedBy: operator || null });
    if (caixaId && applied > 0) {
      await logCashMovement({
        cashRegisterId: caixaId, movementType: "entrada", amount: applied,
        description: `Recebimento — ${group.clientName}`,
        originType: "recebimento", originId: null, loggedBy: operator || null, note,
      });
    }
    backdrop.remove();
    onDone && onDone();
  };
}

function openRegisterPaymentModal(receivable, onDone) {
  const saldo = Number((Number(receivable.amount) - Number(receivable.paid_amount || 0)).toFixed(2));
  const methods = PAYMENT_METHODS.filter((m) => m.value !== "prazo");
  const lastOperator = localStorage.getItem("cafe_app_last_operator") || "";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.style.zIndex = "60";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">Registrar pagamento</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;">
        <p style="margin:0;font-size:13px;color:var(--muted);">Saldo devedor: <b class="mono">${money(saldo)}</b></p>
        <div><label class="field-label">Valor pago agora (R$)</label><input id="rp-amount" type="number" min="0.01" max="${saldo}" step="any" value="${saldo}" /></div>
        <div><label class="field-label">Forma de pagamento</label>
          <select id="rp-method">${methods.map((m) => `<option value="${m.value}" ${m.value === "dinheiro" ? "selected" : ""}>${m.label}</option>`).join("")}</select>
        </div>
        <div><label class="field-label">Caixa que recebeu</label>
          <select id="rp-caixa">
            <option value="">Não lançar no caixa</option>
            ${state.cashRegisters.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
          </select>
        </div>
        <div><label class="field-label">Registrado por</label><input id="rp-operator" value="${escapeHtml(lastOperator)}" placeholder="seu nome" /></div>
        <div><label class="field-label">Observação (opcional)</label><input id="rp-note" type="text" placeholder="ex: pagou parcelado" /></div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn" id="modal-cancel" style="flex:1;">Cancelar</button>
          <button class="btn btn-accent" id="modal-save" style="flex:1;">Confirmar</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#modal-close", backdrop).onclick = () => backdrop.remove();
  $("#modal-cancel", backdrop).onclick = () => backdrop.remove();
  $("#modal-save", backdrop).onclick = async () => {
    const amount = Number($("#rp-amount", backdrop).value) || 0;
    const note = $("#rp-note", backdrop).value.trim();
    const paymentMethod = $("#rp-method", backdrop).value;
    const caixaId = $("#rp-caixa", backdrop).value;
    const operator = $("#rp-operator", backdrop).value.trim();
    if (amount <= 0) return;
    if (operator) localStorage.setItem("cafe_app_last_operator", operator);
    await registerReceivablePayment(receivable, amount, note, paymentMethod);
    if (caixaId) {
      await logCashMovement({
        cashRegisterId: caixaId, movementType: "entrada", amount,
        description: `Recebimento — ${receivable.client_name}`,
        originType: "recebimento", originId: receivable.id, loggedBy: operator || null, note,
      });
    }
    backdrop.remove();
    onDone && onDone();
  };
}

// ---- Pedidos (status de entrega + pagamento das vendas já registradas) ----
// Não duplica nada: agrupa as linhas de "sales" que pertencem à mesma
// venda/carrinho (sale_group_id, ou o próprio id da venda quando ela é
// avulsa) e só guarda, à parte, se aquele pedido já foi entregue/retirado.
// O estoque continua saindo no momento da venda, como já acontece hoje.
function saleOrderKey(sale) { return sale.sale_group_id || sale.id; }

function computeOrders() {
  const groups = {};
  state.sales.forEach((s) => {
    const key = saleOrderKey(s);
    if (!groups[key]) {
      groups[key] = {
        orderKey: key, clientId: s.client_id, clientName: s.client_name,
        sellerName: s.seller_name, paymentMethod: s.payment_method,
        soldAt: s.sold_at, total: 0, items: [],
      };
    }
    groups[key].total += Number(s.total);
    groups[key].items.push(s);
    if (s.sold_at < groups[key].soldAt) groups[key].soldAt = s.sold_at;
  });
  return Object.values(groups)
    .map((g) => {
      const delivery = state.orderDeliveries.find((d) => d.order_key === g.orderKey);
      const receivable = g.paymentMethod === "prazo" ? state.receivables.find((r) => r.sale_group_id === g.orderKey) : null;
      // Status binário, do jeito que a tela de Pedidos mostra: pago/pendente.
      // Vendas à vista (pix/dinheiro/cartão) já nascem pagas. Vendas à prazo
      // seguem o status da conta a receber vinculada (mesma estrutura de sempre).
      const paymentStatus = g.paymentMethod !== "prazo" ? "pago" : (receivable && receivable.status === "pago" ? "pago" : "pendente");
      return {
        ...g,
        statusDelivery: delivery ? delivery.status_delivery : "pendente",
        deliveredAt: delivery ? delivery.delivered_at : null,
        deliveredBy: delivery ? delivery.delivered_by : null,
        receivable, paymentStatus,
      };
    })
    .sort((a, b) => (a.soldAt < b.soldAt ? 1 : -1));
}

async function markOrderDelivered(order, { deliveredBy, note }) {
  const existing = state.orderDeliveries.find((d) => d.order_key === order.orderKey);
  const payload = {
    order_key: order.orderKey, client_id: order.clientId || null, client_name: order.clientName || null,
    status_delivery: "entregue", delivered_at: new Date().toISOString(), delivered_by: deliveredBy || null, note: note || null,
  };
  if (existing) await db.from("order_deliveries").update(payload).eq("id", existing.id);
  else await db.from("order_deliveries").insert(payload);
}

async function markOrderPending(order) {
  const existing = state.orderDeliveries.find((d) => d.order_key === order.orderKey);
  if (existing) await db.from("order_deliveries").update({ status_delivery: "pendente", delivered_at: null, delivered_by: null }).eq("id", existing.id);
}

async function deleteOrder(order) {
  for (const item of order.items) await deleteSale(item);
  if (order.receivable) await db.from("receivables").delete().eq("id", order.receivable.id);
  const delivery = state.orderDeliveries.find((d) => d.order_key === order.orderKey);
  if (delivery) await db.from("order_deliveries").delete().eq("id", delivery.id);
}

function orderNumber(orderKey) { return String(orderKey).replace(/-/g, "").slice(0, 6).toUpperCase(); }

function renderPedidos() {
  const all = computeOrders();
  const payFilters = { todos: () => true, pagos: (o) => o.paymentStatus === "pago", pendentes: (o) => o.paymentStatus === "pendente" };
  const delFilters = { todos: () => true, entregues: (o) => o.statusDelivery === "entregue", pendentes: (o) => o.statusDelivery === "pendente" };
  const list = all.filter(payFilters[state.pedidosPaymentFilter]).filter(delFilters[state.pedidosDeliveryFilter]);

  const payLabel = { todos: "Todos", pagos: "Pagos", pendentes: "Pendentes" };
  const delLabel = { todos: "Todos", entregues: "Entregues", pendentes: "Pendentes" };

  $("#main").innerHTML = `
    <button class="btn btn-dark" id="btn-new-order" style="width:100%;margin-bottom:20px;">+ Novo Pedido</button>

    <p style="font-size:11px;font-weight:600;color:var(--muted2);text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px;">Pagamento</p>
    <div class="rc-filter-pills" style="margin-bottom:12px;">
      ${Object.keys(payLabel).map((k) => `<button class="rc-pill pay-pill ${state.pedidosPaymentFilter === k ? "active" : ""}" data-filter="${k}">${payLabel[k]}</button>`).join("")}
    </div>
    <p style="font-size:11px;font-weight:600;color:var(--muted2);text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px;">Entrega</p>
    <div class="rc-filter-pills" style="margin-bottom:18px;">
      ${Object.keys(delLabel).map((k) => `<button class="rc-pill del-pill ${state.pedidosDeliveryFilter === k ? "active" : ""}" data-filter="${k}">${delLabel[k]}</button>`).join("")}
    </div>

    ${list.length === 0 ? `<div class="empty">Nenhum pedido nessa condição.</div>` : `
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${list.map((o) => {
          const itemsSummary = o.items.map((it) => `${it.quantity}× ${escapeHtml(it.product_name)}`).join(", ");
          const payOk = o.paymentStatus === "pago";
          const delOk = o.statusDelivery === "entregue";
          const paymentExtra = o.paymentMethod === "prazo" && o.receivable && o.receivable.status === "parcial"
            ? ` <span style="color:var(--muted2);font-weight:400;">(pago ${money(o.receivable.paid_amount)} de ${money(o.receivable.amount)})</span>` : "";
          return `
          <div class="card" data-key="${escapeHtml(o.orderKey)}">
            <div class="row" style="align-items:flex-start;">
              <div style="min-width:0;">
                <p style="margin:0;font-size:11px;color:var(--muted2);">Pedido #${orderNumber(o.orderKey)} · ${new Date(o.soldAt).toLocaleDateString("pt-BR")}</p>
                <p style="margin:2px 0 0;font-size:15px;font-weight:500;">${escapeHtml(o.clientName || "Cliente à vista")}</p>
                <p style="margin:2px 0 0;font-size:12px;color:var(--muted2);">${escapeHtml(itemsSummary)}</p>
              </div>
              <span class="mono" style="font-size:14px;flex-shrink:0;">${money(o.total)}</span>
            </div>
            <div style="margin-top:10px;font-size:13px;display:flex;flex-direction:column;gap:3px;">
              <span>Pagamento: ${payOk ? "🟢 Pago" : "🔴 Pendente"}${paymentExtra}</span>
              <span>Entrega: ${delOk ? "🟢 Entregue" : "🔴 Pendente"}</span>
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;">
              ${delOk
                ? `<button class="btn btn-undo-delivery" style="flex:1;font-size:13px;">Desfazer entrega</button>`
                : `<button class="btn btn-accent btn-deliver" style="flex:1;font-size:13px;">Confirmar entrega</button>`}
              ${!payOk && o.receivable ? `<button class="btn btn-pay-order" style="flex:1;font-size:13px;">Quitar pagamento</button>` : ""}
              <button class="icon-btn danger btn-del-order" title="Excluir pedido">🗑</button>
            </div>
          </div>`;
        }).join("")}
      </div>`}
  `;

  $("#btn-new-order").onclick = () => openNewOrderModal();
  $$(".pay-pill", $("#main")).forEach((btn) => { btn.onclick = () => { state.pedidosPaymentFilter = btn.dataset.filter; renderPedidos(); }; });
  $$(".del-pill", $("#main")).forEach((btn) => { btn.onclick = () => { state.pedidosDeliveryFilter = btn.dataset.filter; renderPedidos(); }; });
  $$(".card[data-key]", $("#main")).forEach((card) => {
    const order = list.find((x) => String(x.orderKey) === card.dataset.key);
    const deliverBtn = $(".btn-deliver", card);
    if (deliverBtn) deliverBtn.onclick = () => openMarkDeliveredModal(order);
    const undoBtn = $(".btn-undo-delivery", card);
    if (undoBtn) undoBtn.onclick = async () => { await markOrderPending(order); };
    const payBtn = $(".btn-pay-order", card);
    if (payBtn) payBtn.onclick = () => openRegisterPaymentModal(order.receivable, () => renderPedidos());
    $(".btn-del-order", card).onclick = async () => {
      if (confirm(`Excluir o pedido #${orderNumber(order.orderKey)}? Isso remove a venda, devolve o estoque e apaga a conta a receber ligada a ele (se houver).`)) {
        await deleteOrder(order);
      }
    };
  });
}

function openMarkDeliveredModal(order) {
  const lastUsed = localStorage.getItem("cafe_app_last_delivery_user") || "";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">Confirmar entrega</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <p style="font-size:13px;color:var(--muted);margin:0 0 14px;">${escapeHtml(order.clientName || "Cliente à vista")}</p>
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div><label class="field-label">Quem está entregando/confirmando?</label><input id="od-user" value="${escapeHtml(lastUsed)}" placeholder="seu nome" /></div>
        <div><label class="field-label">Observação (opcional)</label><input id="od-note" placeholder="ex: retirado na loja" /></div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn" id="modal-cancel" style="flex:1;">Cancelar</button>
          <button class="btn btn-accent" id="modal-save" style="flex:1;">Confirmar</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#modal-close", backdrop).onclick = () => backdrop.remove();
  $("#modal-cancel", backdrop).onclick = () => backdrop.remove();
  $("#modal-save", backdrop).onclick = async () => {
    const deliveredBy = $("#od-user", backdrop).value.trim();
    const note = $("#od-note", backdrop).value.trim();
    if (deliveredBy) localStorage.setItem("cafe_app_last_delivery_user", deliveredBy);
    await markOrderDelivered(order, { deliveredBy, note });
    backdrop.remove();
  };
}

// ---- Movimentações de estoque (entradas/saídas) ----
const MOV_PERIODS = [
  { id: "hoje", label: "Hoje" }, { id: "ontem", label: "Ontem" },
  { id: "semana", label: "Semana" }, { id: "mes", label: "Mês" },
  { id: "personalizado", label: "Período" }, { id: "todos", label: "Todos" },
];

function periodRange(period, customFrom, customTo) {
  const now = new Date();
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  if (period === "hoje") return [startOfDay(now), endOfDay(now)];
  if (period === "ontem") { const y = new Date(now); y.setDate(y.getDate() - 1); return [startOfDay(y), endOfDay(y)]; }
  if (period === "semana") { const s = new Date(now); s.setDate(s.getDate() - 6); return [startOfDay(s), endOfDay(now)]; }
  if (period === "mes") { const s = new Date(now.getFullYear(), now.getMonth(), 1); return [startOfDay(s), endOfDay(now)]; }
  if (period === "personalizado" && customFrom && customTo) {
    return [startOfDay(new Date(customFrom + "T00:00:00")), endOfDay(new Date(customTo + "T00:00:00"))];
  }
  return [null, null]; // "todos" — sem limite de data
}
function movPeriodRange() { return periodRange(state.movPeriod, state.movCustomFrom, state.movCustomTo); }

function filteredMovements() {
  const [from, to] = movPeriodRange();
  return state.stockEntries.filter((m) => {
    const t = new Date(m.entered_at);
    if (from && t < from) return false;
    if (to && t > to) return false;
    if (state.movProduct && m.product_id !== state.movProduct) return false;
    if (state.movUser && (m.logged_by || "").toLowerCase() !== state.movUser.toLowerCase()) return false;
    if (state.movLocation && m.location !== state.movLocation) return false;
    if (state.movType === "transferencia" && !m.transfer_group_id) return false;
    if (state.movType !== "todos" && state.movType !== "transferencia" && m.movement_type !== state.movType) return false;
    return true;
  }).sort((a, b) => (a.entered_at < b.entered_at ? 1 : -1));
}

function movementUsers() {
  const set = new Set(state.stockEntries.map((m) => m.logged_by).filter(Boolean));
  return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
}

async function openStockEntryModal() {
  if (!state.products.length) { alert("Cadastre um produto no estoque antes de registrar uma movimentação."); return; }
  const lastUser = localStorage.getItem("cafe_app_last_stock_user") || "";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal" id="se-modal-body"></div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };

  let type = "entrada"; // entrada | saida | transferencia
  const entryReasons = ["Compra de fornecedor", "Ajuste de estoque", "Outro"];
  const exitReasons = ["Perda/quebra", "Uso interno", "Ajuste de estoque", "Outro"];

  function paint() {
    const reasons = type === "entrada" ? entryReasons : exitReasons;
    $("#se-modal-body", backdrop).innerHTML = `
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">Nova movimentação de estoque</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <div class="rc-filter-pills" style="margin-bottom:14px;">
        <button class="rc-pill se-type-pill ${type === "entrada" ? "active" : ""}" data-type="entrada">📥 Entrada</button>
        <button class="rc-pill se-type-pill ${type === "saida" ? "active" : ""}" data-type="saida">📤 Saída</button>
        <button class="rc-pill se-type-pill ${type === "transferencia" ? "active" : ""}" data-type="transferencia">🔁 Transferência</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label class="field-label">Produto</label>
          <select id="se-product">${state.products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}</select>
        </div>
        ${type === "transferencia" ? `
          <div class="grid2">
            <div><label class="field-label">De</label>
              <select id="se-from"><option value="mhu">Manhuaçu</option><option value="bh">BH</option></select>
            </div>
            <div><label class="field-label">Para</label>
              <select id="se-to"><option value="bh">BH</option><option value="mhu">Manhuaçu</option></select>
            </div>
          </div>
          <div><label class="field-label">Quantidade (pacotes)</label><input id="se-qty" type="number" min="0.001" step="any" placeholder="0" /></div>
        ` : `
          <div class="grid2">
            <div><label class="field-label">Quantidade (pacotes)</label><input id="se-qty" type="number" min="0.001" step="any" placeholder="0" /></div>
            <div><label class="field-label">Localidade</label>
              <select id="se-location"><option value="mhu">Manhuaçu</option><option value="bh">BH</option></select>
            </div>
          </div>
          <div class="grid2">
            ${type === "entrada" ? `<div><label class="field-label">Custo unitário (opcional)</label><input id="se-cost" type="number" min="0" step="any" placeholder="0,00" /></div>` : `<div></div>`}
            <div><label class="field-label">Motivo</label>
              <select id="se-reason">${reasons.map((r) => `<option value="${r}">${r}</option>`).join("")}</select>
            </div>
          </div>
        `}
        <div><label class="field-label">Quem está registrando?</label><input id="se-user" value="${escapeHtml(lastUser)}" placeholder="seu nome" /></div>
        <div><label class="field-label">Observação (opcional)</label><input id="se-note" placeholder="ex: nota fiscal 1234" /></div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn" id="modal-cancel" style="flex:1;">Cancelar</button>
          <button class="btn btn-accent" id="modal-save" style="flex:1;">Registrar</button>
        </div>
      </div>`;
    wire();
  }

  function wire() {
    $("#modal-close", backdrop).onclick = () => backdrop.remove();
    $("#modal-cancel", backdrop).onclick = () => backdrop.remove();
    $$(".se-type-pill", backdrop).forEach((btn) => { btn.onclick = () => { type = btn.dataset.type; paint(); }; });
    if (type === "transferencia") {
      $("#se-from", backdrop).onchange = (e) => {
        $("#se-to", backdrop).value = e.target.value === "bh" ? "mhu" : "bh";
      };
    }
    $("#modal-save", backdrop).onclick = async () => {
      const product = state.products.find((p) => p.id === $("#se-product", backdrop).value);
      const quantity = Number($("#se-qty", backdrop).value) || 0;
      const loggedBy = $("#se-user", backdrop).value.trim();
      const note = $("#se-note", backdrop).value.trim();
      if (!product || quantity <= 0) return;
      if (loggedBy) localStorage.setItem("cafe_app_last_stock_user", loggedBy);

      if (type === "transferencia") {
        const fromLocation = $("#se-from", backdrop).value;
        const toLocation = $("#se-to", backdrop).value;
        if (fromLocation === toLocation) { alert("Escolha duas localidades diferentes."); return; }
        const protocolId = await registerStockTransfer({ product, quantity, fromLocation, toLocation, note, loggedBy });
        backdrop.remove();
        if (protocolId) alert(`Transferência registrada! Protocolo #${orderNumber(protocolId)}`);
        return;
      }

      const location = $("#se-location", backdrop).value;
      const unitCost = type === "entrada" ? (Number($("#se-cost", backdrop)?.value) || 0) : 0;
      const reason = $("#se-reason", backdrop).value;
      if (type === "entrada") {
        await registerStockEntry({ product, quantity, location, unitCost, reason, note, loggedBy });
      } else {
        await registerStockExit({ product, quantity, location, reason, note, loggedBy });
      }
      backdrop.remove();
    };
  }

  paint();
}

function renderMovimentacoes() {
  const list = filteredMovements();
  // Transferências entre localidades não contam como entrada/saída "real" nos
  // totais e no relatório por usuário — senão inflaria os números (é o mesmo
  // pacote só mudando de lugar, não uma compra nem um consumo de verdade).
  const entradas = list.filter((m) => m.movement_type === "entrada" && !m.transfer_group_id);
  const saidas = list.filter((m) => m.movement_type === "saida" && !m.transfer_group_id);
  const transferencias = list.filter((m) => m.transfer_group_id && m.movement_type === "saida");
  const totalPacotesEntrada = entradas.reduce((s, m) => s + Number(m.quantity), 0);
  const totalPacotesSaida = saidas.reduce((s, m) => s + Number(m.quantity), 0);

  // Relatório de entradas por usuário (item 12)
  const byUser = {};
  entradas.forEach((m) => {
    const key = m.logged_by || "Sem usuário informado";
    if (!byUser[key]) byUser[key] = { count: 0, qty: 0 };
    byUser[key].count += 1;
    byUser[key].qty += Number(m.quantity);
  });
  const userRows = Object.entries(byUser).sort((a, b) => b[1].qty - a[1].qty);

  // Entrada × Saída × Estoque atual (item 14) — só faz sentido mostrar
  // quando um produto específico está selecionado no filtro.
  let stockFormula = "";
  if (state.movProduct) {
    const product = state.products.find((p) => p.id === state.movProduct);
    if (product) {
      const qtyAtual = state.movLocation === "bh" ? Number(product.qty_bh || 0) : state.movLocation === "mhu" ? Number(product.qty_mhu || 0) : Number(product.quantity || 0);
      const estoqueInicio = qtyAtual - totalPacotesEntrada + totalPacotesSaida;
      stockFormula = `
        <div class="card" style="margin-bottom:16px;">
          <p style="margin:0 0 10px;font-size:13px;font-weight:500;color:var(--muted);">Entrada × Saída × Estoque — ${escapeHtml(product.name)}</p>
          <div class="rc-detail"><span>Estoque no início do período (calculado)</span><b class="mono">${Number(estoqueInicio.toFixed(3))} ${product.unit}</b></div>
          <div class="rc-detail"><span>+ Entradas no período</span><b class="mono" style="color:var(--accent-dark);">${Number(totalPacotesEntrada.toFixed(3))} ${product.unit}</b></div>
          <div class="rc-detail"><span>− Saídas no período</span><b class="mono" style="color:var(--danger-text);">${Number(totalPacotesSaida.toFixed(3))} ${product.unit}</b></div>
          <div class="rc-detail" style="border-top:1px solid var(--border);padding-top:6px;margin-top:2px;"><span>= Estoque atual</span><b class="mono">${Number(qtyAtual.toFixed(3))} ${product.unit}</b></div>
        </div>`;
    }
  }

  $("#main").innerHTML = `
    <button class="btn btn-dark" id="btn-new-entry" style="width:100%;margin-bottom:20px;">+ Registrar entrada/saída</button>

    <p style="font-size:11px;font-weight:600;color:var(--muted2);text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px;">Período</p>
    <div class="rc-filter-pills" style="margin-bottom:10px;">
      ${MOV_PERIODS.map((o) => `<button class="rc-pill mov-period-pill ${state.movPeriod === o.id ? "active" : ""}" data-period="${o.id}">${o.label}</button>`).join("")}
    </div>
    ${state.movPeriod === "personalizado" ? `
      <div class="grid2" style="margin-bottom:10px;">
        <div><label class="field-label">De</label><input id="mov-from" type="date" value="${state.movCustomFrom}" /></div>
        <div><label class="field-label">Até</label><input id="mov-to" type="date" value="${state.movCustomTo}" /></div>
      </div>` : ""}

    <div class="grid2" style="margin-bottom:10px;">
      <div><label class="field-label">Produto</label>
        <select id="mov-product">
          <option value="">Todos os produtos</option>
          ${state.products.map((p) => `<option value="${p.id}" ${state.movProduct === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
        </select>
      </div>
      <div><label class="field-label">Usuário</label>
        <select id="mov-user">
          <option value="">Todos</option>
          ${movementUsers().map((u) => `<option value="${escapeHtml(u)}" ${state.movUser === u ? "selected" : ""}>${escapeHtml(u)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="grid2" style="margin-bottom:18px;">
      <div><label class="field-label">Localidade</label>
        <select id="mov-location">
          <option value="">Todas</option>
          <option value="Manhuaçu" ${state.movLocation === "Manhuaçu" ? "selected" : ""}>Manhuaçu</option>
          <option value="BH" ${state.movLocation === "BH" ? "selected" : ""}>BH</option>
        </select>
      </div>
      <div><label class="field-label">Tipo</label>
        <select id="mov-type">
          <option value="todos" ${state.movType === "todos" ? "selected" : ""}>Entradas e saídas</option>
          <option value="entrada" ${state.movType === "entrada" ? "selected" : ""}>Só entradas</option>
          <option value="saida" ${state.movType === "saida" ? "selected" : ""}>Só saídas</option>
          <option value="transferencia" ${state.movType === "transferencia" ? "selected" : ""}>Só transferências</option>
        </select>
      </div>
    </div>

    <div class="grid2" style="margin-bottom:16px;">
      <div class="metric"><div class="label">📥 Entradas</div><div class="value mono">${entradas.length}</div><div style="font-size:11px;color:var(--muted2);margin-top:2px;">${Number(totalPacotesEntrada.toFixed(3))} pacotes</div></div>
      <div class="metric"><div class="label">📤 Saídas</div><div class="value mono">${saidas.length}</div><div style="font-size:11px;color:var(--muted2);margin-top:2px;">${Number(totalPacotesSaida.toFixed(3))} pacotes</div></div>
    </div>
    ${transferencias.length ? `
    <div class="metric" style="margin-bottom:16px;"><div class="label">🔁 Transferências entre localidades</div><div class="value mono">${transferencias.length}</div><div style="font-size:11px;color:var(--muted2);margin-top:2px;">${Number(transferencias.reduce((s, m) => s + Number(m.quantity), 0).toFixed(3))} pacotes movidos</div></div>
    ` : ""}

    ${stockFormula}

    ${userRows.length ? `
      <div class="card" style="margin-bottom:16px;">
        <p style="margin:0 0 10px;font-size:13px;font-weight:500;color:var(--muted);">Relatório de entradas por usuário</p>
        ${userRows.map(([user, info]) => `
          <div class="rc-detail"><span>${escapeHtml(user)}</span><b>${info.count} entrada${info.count === 1 ? "" : "s"} · ${Number(info.qty.toFixed(3))} pacotes</b></div>
        `).join("")}
        <div class="rc-detail" style="border-top:1px solid var(--border);padding-top:6px;margin-top:2px;"><span>Total</span><b>${entradas.length} entrada${entradas.length === 1 ? "" : "s"} · ${Number(totalPacotesEntrada.toFixed(3))} pacotes</b></div>
      </div>` : ""}

    <p style="font-size:13px;font-weight:500;color:var(--muted);margin:0 0 8px;">Movimentações</p>
    ${list.length === 0 ? `<div class="empty">Nenhuma movimentação nessa condição.</div>` : `
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${list.map((m) => `
          <div class="card" data-mid="${m.id}" style="padding:10px 12px;">
            <div class="row" style="align-items:flex-start;">
              <div style="min-width:0;">
                <p style="margin:0;font-size:14px;">${m.transfer_group_id ? "🔁" : m.movement_type === "entrada" ? "📥" : "📤"} ${escapeHtml(m.product_name)}</p>
                <p style="margin:2px 0 0;font-size:12px;color:var(--muted2);">
                  ${new Date(m.entered_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                  ${m.location ? " · " + escapeHtml(m.location) : ""}
                  ${m.logged_by ? " · " + escapeHtml(m.logged_by) : ""}
                </p>
                ${m.transfer_group_id ? `<p style="margin:4px 0 0;font-size:12px;color:var(--muted2);">
                  Transferência ${m.movement_type === "saida" ? "para" : "de"} ${escapeHtml(m.related_location || "outra localidade")} · Protocolo #${orderNumber(m.transfer_group_id)}${m.note ? " · " + escapeHtml(m.note) : ""}
                </p>` : (m.reason || m.order_key || m.note) ? `<p style="margin:4px 0 0;font-size:12px;color:var(--muted2);">
                  ${m.reason ? escapeHtml(m.reason) : ""}${m.order_key ? ` · Pedido #${orderNumber(m.order_key)}` : ""}${m.note ? " · " + escapeHtml(m.note) : ""}
                </p>` : ""}
              </div>
              <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
                <span class="mono" style="font-size:14px;color:${m.movement_type === "entrada" ? "var(--accent-dark)" : "var(--danger-text)"};">${m.movement_type === "entrada" ? "+" : "−"}${Number(m.quantity)}</span>
                <button class="icon-btn danger btn-del-mov" title="Excluir movimentação">🗑</button>
              </div>
            </div>
          </div>`).join("")}
      </div>`}
  `;

  $("#btn-new-entry").onclick = () => openStockEntryModal();
  $$(".btn-del-mov", $("#main")).forEach((btn) => {
    btn.onclick = async () => {
      const card = btn.closest(".card[data-mid]");
      const m = state.stockEntries.find((x) => x.id === card.dataset.mid);
      const msg = m && m.transfer_group_id
        ? "Essa é uma transferência entre localidades — excluir remove as DUAS pontas do protocolo (origem e destino). Confirmar?"
        : "Excluir esta movimentação do histórico? Isso remove só o registro — não altera a quantidade em estoque do produto.";
      if (confirm(msg)) {
        await deleteStockMovement(card.dataset.mid);
      }
    };
  });
  $$(".mov-period-pill", $("#main")).forEach((btn) => { btn.onclick = () => { state.movPeriod = btn.dataset.period; renderMovimentacoes(); }; });
  $("#mov-from") && ($("#mov-from").onchange = (e) => { state.movCustomFrom = e.target.value; renderMovimentacoes(); });
  $("#mov-to") && ($("#mov-to").onchange = (e) => { state.movCustomTo = e.target.value; renderMovimentacoes(); });
  $("#mov-product").onchange = (e) => { state.movProduct = e.target.value; renderMovimentacoes(); };
  $("#mov-user").onchange = (e) => { state.movUser = e.target.value; renderMovimentacoes(); };
  $("#mov-location").onchange = (e) => { state.movLocation = e.target.value; renderMovimentacoes(); };
  $("#mov-type").onchange = (e) => { state.movType = e.target.value; renderMovimentacoes(); };
}

// ---- Caixa (livro-caixa) ----
function nowForDatetimeLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function filteredCashMovements() {
  const [from, to] = periodRange(state.caixaPeriod, state.caixaCustomFrom, state.caixaCustomTo);
  return state.cashMovements.filter((m) => {
    const t = new Date(m.occurred_at);
    if (from && t < from) return false;
    if (to && t > to) return false;
    if (state.caixaRegister && m.cash_register_id !== state.caixaRegister) return false;
    if (state.caixaUser && (m.logged_by || "").toLowerCase() !== state.caixaUser.toLowerCase()) return false;
    if (state.caixaType === "entrada" && !(m.movement_type === "entrada" && m.origin_type !== "transferencia")) return false;
    if (state.caixaType === "saida" && !(m.movement_type === "saida" && m.origin_type !== "transferencia")) return false;
    if (state.caixaType === "transferencia" && m.origin_type !== "transferencia") return false;
    return true;
  }).sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
}

function cashMovementUsers() {
  return Array.from(new Set(state.cashMovements.map((m) => m.logged_by).filter(Boolean))).sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function cashRegisterName(id) {
  const r = state.cashRegisters.find((x) => x.id === id);
  return r ? r.name : "—";
}

function openCashRegisterModal(register) {
  const isEdit = !!register;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">${isEdit ? "Editar caixa" : "Novo caixa"}</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div><label class="field-label">Nome</label><input id="cr-name" value="${isEdit ? escapeHtml(register.name) : ""}" placeholder="Ex.: Caixa BH" /></div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn" id="modal-cancel" style="flex:1;">Cancelar</button>
          <button class="btn btn-accent" id="modal-save" style="flex:1;">Salvar</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  $("#modal-close", backdrop).onclick = () => backdrop.remove();
  $("#modal-cancel", backdrop).onclick = () => backdrop.remove();
  $("#modal-save", backdrop).onclick = async () => {
    const name = $("#cr-name", backdrop).value.trim();
    if (!name) return;
    if (isEdit) await updateCashRegister(register.id, name); else await addCashRegister(name);
    backdrop.remove();
  };
}

function openCashMovementModal() {
  if (!state.cashRegisters.length) { alert("Cadastre um caixa primeiro (botão \"+ Novo caixa\")."); return; }
  const lastOperator = localStorage.getItem("cafe_app_last_operator") || "";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal" id="cm-modal-body"></div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };

  let type = "entrada"; // entrada | saida | transferencia

  const registerOptions = (excludeId) => state.cashRegisters
    .filter((c) => c.id !== excludeId)
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  function paint() {
    $("#cm-modal-body", backdrop).innerHTML = `
      <div class="row" style="margin-bottom:16px;">
        <h3 class="serif" style="margin:0;font-size:17px;">Nova movimentação</h3>
        <button class="icon-btn" id="modal-close">✕</button>
      </div>
      <div class="rc-filter-pills" style="margin-bottom:14px;">
        <button class="rc-pill cm-type-pill ${type === "entrada" ? "active" : ""}" data-type="entrada">Entrada</button>
        <button class="rc-pill cm-type-pill ${type === "saida" ? "active" : ""}" data-type="saida">Saída</button>
        <button class="rc-pill cm-type-pill ${type === "transferencia" ? "active" : ""}" data-type="transferencia">Transferência</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${type === "transferencia" ? `
          <div class="grid2">
            <div><label class="field-label">Caixa de origem</label><select id="cm-from">${registerOptions()}</select></div>
            <div><label class="field-label">Caixa de destino</label><select id="cm-to">${registerOptions()}</select></div>
          </div>
        ` : `
          <div><label class="field-label">Caixa</label><select id="cm-register">${registerOptions()}</select></div>
          <div><label class="field-label">Descrição / histórico</label><input id="cm-desc" placeholder="Ex.: Pagamento de fornecedor" /></div>
        `}
        <div class="grid2">
          <div><label class="field-label">Valor (R$)</label><input id="cm-amount" type="number" min="0.01" step="any" placeholder="0,00" /></div>
          <div><label class="field-label">Data e hora</label><input id="cm-datetime" type="datetime-local" value="${nowForDatetimeLocal()}" /></div>
        </div>
        <div><label class="field-label">Operador</label><input id="cm-operator" value="${escapeHtml(lastOperator)}" placeholder="seu nome" /></div>
        <div><label class="field-label">Observação (opcional)</label><input id="cm-note" placeholder="" /></div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn" id="modal-cancel" style="flex:1;">Cancelar</button>
          <button class="btn btn-accent" id="cm-save" style="flex:1;">Registrar</button>
        </div>
      </div>`;
    wire();
  }

  function wire() {
    $("#modal-close", backdrop).onclick = () => backdrop.remove();
    $("#modal-cancel", backdrop).onclick = () => backdrop.remove();
    $$(".cm-type-pill", backdrop).forEach((btn) => { btn.onclick = () => { type = btn.dataset.type; paint(); }; });
    $("#cm-save", backdrop).onclick = async () => {
      const amount = Number($("#cm-amount", backdrop).value) || 0;
      const occurredAt = $("#cm-datetime", backdrop).value ? new Date($("#cm-datetime", backdrop).value).toISOString() : new Date().toISOString();
      const operator = $("#cm-operator", backdrop).value.trim();
      const note = $("#cm-note", backdrop).value.trim();
      if (amount <= 0) return;
      if (operator) localStorage.setItem("cafe_app_last_operator", operator);

      if (type === "transferencia") {
        const fromId = $("#cm-from", backdrop).value;
        const toId = $("#cm-to", backdrop).value;
        if (!fromId || !toId || fromId === toId) { alert("Escolha dois caixas diferentes."); return; }
        await registerCashTransfer({ fromRegisterId: fromId, toRegisterId: toId, amount, note, loggedBy: operator || null, occurredAt });
      } else {
        const registerId = $("#cm-register", backdrop).value;
        const description = $("#cm-desc", backdrop).value.trim();
        if (!registerId || !description) return;
        await logCashMovement({
          cashRegisterId: registerId, movementType: type, amount, description,
          originType: "manual", loggedBy: operator || null, note, occurredAt,
        });
      }
      backdrop.remove();
    };
  }

  paint();
}

function cashMovementOriginLabel(m) {
  if (m.origin_type === "venda") return `Venda${m.origin_id ? ` · Pedido #${orderNumber(m.origin_id)}` : ""}`;
  if (m.origin_type === "recebimento") {
    const rec = state.receivables.find((r) => r.id === m.origin_id);
    return `Recebimento de conta a receber${rec ? " · " + escapeHtml(rec.client_name) : ""}`;
  }
  if (m.origin_type === "transferencia") {
    return m.movement_type === "saida"
      ? `🔁 Transferência para ${escapeHtml(cashRegisterName(m.related_cash_register_id))}`
      : `🔁 Transferência de ${escapeHtml(cashRegisterName(m.related_cash_register_id))}`;
  }
  return "Lançamento manual";
}

function renderCaixa() {
  const list = filteredCashMovements();
  const entradasPeriodo = list.filter((m) => m.movement_type === "entrada").reduce((s, m) => s + Number(m.amount), 0);
  const saidasPeriodo = list.filter((m) => m.movement_type === "saida").reduce((s, m) => s + Number(m.amount), 0);

  const typeLabel = { todos: "Todos", entrada: "Entrada", saida: "Saída", transferencia: "Transferência" };

  $("#main").innerHTML = `
    <div class="metric" style="margin-bottom:16px;">
      <div class="label">💰 Saldo consolidado (todos os caixas)</div>
      <div class="value mono">${money(consolidatedCashBalance())}</div>
    </div>

    <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;margin-bottom:18px;-webkit-overflow-scrolling:touch;">
      ${state.cashRegisters.map((r) => `
        <div class="card cr-card" data-crid="${r.id}" style="flex-shrink:0;min-width:140px;${state.caixaRegister === r.id ? "border-color:var(--accent);" : ""}">
          <p style="margin:0;font-size:12px;color:var(--muted2);cursor:pointer;" class="cr-select">${escapeHtml(r.name)}</p>
          <p style="margin:4px 0 0;font-size:16px;font-weight:600;cursor:pointer;" class="mono cr-select">${money(cashRegisterBalance(r.id))}</p>
          <div style="display:flex;gap:2px;margin-top:4px;">
            <button class="icon-btn cr-edit" style="min-width:28px;min-height:28px;font-size:14px;padding:2px;" title="Editar">✎</button>
            <button class="icon-btn danger cr-delete" style="min-width:28px;min-height:28px;font-size:14px;padding:2px;" title="Excluir">🗑</button>
          </div>
        </div>`).join("")}
      <button class="card" id="btn-new-register" style="flex-shrink:0;min-width:100px;background:none;border-style:dashed;color:var(--muted);cursor:pointer;">+ Novo caixa</button>
    </div>

    <div class="grid2" style="margin-bottom:20px;">
      <button class="btn btn-dark" id="btn-new-movement">+ Nova movimentação</button>
      <button class="btn" id="btn-clear-caixa-filter">Limpar filtros</button>
    </div>

    <p style="font-size:11px;font-weight:600;color:var(--muted2);text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px;">Período</p>
    <div class="rc-filter-pills" style="margin-bottom:10px;">
      ${MOV_PERIODS.map((o) => `<button class="rc-pill caixa-period-pill ${state.caixaPeriod === o.id ? "active" : ""}" data-period="${o.id}">${o.label}</button>`).join("")}
    </div>
    ${state.caixaPeriod === "personalizado" ? `
      <div class="grid2" style="margin-bottom:10px;">
        <div><label class="field-label">De</label><input id="caixa-from" type="date" value="${state.caixaCustomFrom}" /></div>
        <div><label class="field-label">Até</label><input id="caixa-to" type="date" value="${state.caixaCustomTo}" /></div>
      </div>` : ""}

    <div class="grid2" style="margin-bottom:18px;">
      <div><label class="field-label">Caixa</label>
        <select id="caixa-register-filter">
          <option value="">Todos os caixas</option>
          ${state.cashRegisters.map((r) => `<option value="${r.id}" ${state.caixaRegister === r.id ? "selected" : ""}>${escapeHtml(r.name)}</option>`).join("")}
        </select>
      </div>
      <div><label class="field-label">Tipo</label>
        <select id="caixa-type-filter">
          ${Object.keys(typeLabel).map((k) => `<option value="${k}" ${state.caixaType === k ? "selected" : ""}>${typeLabel[k]}</option>`).join("")}
        </select>
      </div>
    </div>
    <div style="margin-bottom:18px;">
      <label class="field-label">Usuário</label>
      <select id="caixa-user-filter">
        <option value="">Todos</option>
        ${cashMovementUsers().map((u) => `<option value="${escapeHtml(u)}" ${state.caixaUser === u ? "selected" : ""}>${escapeHtml(u)}</option>`).join("")}
      </select>
    </div>

    <div class="grid2" style="margin-bottom:18px;">
      <div class="metric"><div class="label">📥 Entradas no período</div><div class="value mono" style="color:var(--accent-dark);">${money(entradasPeriodo)}</div></div>
      <div class="metric"><div class="label">📤 Saídas no período</div><div class="value mono" style="color:var(--danger-text);">${money(saidasPeriodo)}</div></div>
    </div>

    <p style="font-size:13px;font-weight:500;color:var(--muted);margin:0 0 8px;">Livro-caixa</p>
    ${list.length === 0 ? `<div class="empty">Nenhuma movimentação nessa condição.</div>` : `
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${list.map((m) => `
          <div class="card" data-cmid="${m.id}" style="padding:10px 12px;">
            <div class="row" style="align-items:flex-start;">
              <div style="min-width:0;">
                <p style="margin:0;font-size:14px;">${escapeHtml(m.description)}</p>
                <p style="margin:2px 0 0;font-size:12px;color:var(--muted2);">
                  ${new Date(m.occurred_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                  · ${escapeHtml(cashRegisterName(m.cash_register_id))}
                  ${m.logged_by ? " · " + escapeHtml(m.logged_by) : ""}
                </p>
                <p style="margin:4px 0 0;font-size:12px;color:var(--muted2);">${cashMovementOriginLabel(m)}${m.note ? " · " + escapeHtml(m.note) : ""}</p>
              </div>
              <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
                <span class="mono" style="font-size:14px;color:${m.movement_type === "entrada" ? "var(--accent-dark)" : "var(--danger-text)"};">${m.movement_type === "entrada" ? "+" : "−"}${money(m.amount)}</span>
                <button class="icon-btn danger btn-del-cm" style="min-width:28px;min-height:28px;font-size:14px;padding:2px;" title="Excluir">🗑</button>
              </div>
            </div>
          </div>`).join("")}
      </div>`}
  `;

  $("#btn-new-register").onclick = () => openCashRegisterModal(null);
  $("#btn-new-movement").onclick = () => openCashMovementModal();
  $("#btn-clear-caixa-filter").onclick = () => {
    state.caixaRegister = ""; state.caixaType = "todos"; state.caixaPeriod = "mes";
    state.caixaUser = ""; state.caixaCustomFrom = ""; state.caixaCustomTo = "";
    renderCaixa();
  };
  $$(".cr-card", $("#main")).forEach((card) => {
    const register = state.cashRegisters.find((r) => r.id === card.dataset.crid);
    $$(".cr-select", card).forEach((el) => {
      el.onclick = () => { state.caixaRegister = state.caixaRegister === card.dataset.crid ? "" : card.dataset.crid; renderCaixa(); };
    });
    $(".cr-edit", card).onclick = () => openCashRegisterModal(register);
    $(".cr-delete", card).onclick = () => deleteCashRegister(register.id);
  });
  $$(".btn-del-cm", $("#main")).forEach((btn) => {
    btn.onclick = async () => {
      const card = btn.closest(".card[data-cmid]");
      const movement = state.cashMovements.find((m) => m.id === card.dataset.cmid);
      if (!movement) return;
      const msg = movement.origin_type === "transferencia"
        ? "Essa é uma transferência entre caixas — excluir remove as DUAS pernas dela (origem e destino). Confirmar?"
        : "Excluir esta movimentação do caixa? Essa ação não pode ser desfeita.";
      if (confirm(msg)) await deleteCashMovement(movement);
    };
  });
  $$(".caixa-period-pill", $("#main")).forEach((btn) => { btn.onclick = () => { state.caixaPeriod = btn.dataset.period; renderCaixa(); }; });
  $("#caixa-from") && ($("#caixa-from").onchange = (e) => { state.caixaCustomFrom = e.target.value; renderCaixa(); });
  $("#caixa-to") && ($("#caixa-to").onchange = (e) => { state.caixaCustomTo = e.target.value; renderCaixa(); });
  $("#caixa-register-filter").onchange = (e) => { state.caixaRegister = e.target.value; renderCaixa(); };
  $("#caixa-type-filter").onchange = (e) => { state.caixaType = e.target.value; renderCaixa(); };
  $("#caixa-user-filter").onchange = (e) => { state.caixaUser = e.target.value; renderCaixa(); };
}

// ---- Exportação para Excel ----
function exportSheetsToExcel(sheets, filename) {
  if (typeof XLSX === "undefined") {
    alert("A biblioteca de exportação não carregou (verifique sua conexão com a internet e tente de novo).");
    return;
  }
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ " ": "Sem dados nesse período" }]);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31)); // Excel limita o nome da aba a 31 caracteres
  });
  XLSX.writeFile(wb, filename);
}

function exportMonthSalesExcel(monthSales, monthLabelText) {
  const rows = monthSales
    .slice()
    .sort((a, b) => (a.sold_at < b.sold_at ? -1 : 1))
    .map((s) => ({
      "Data/hora": new Date(s.sold_at).toLocaleString("pt-BR"),
      Produto: s.product_name,
      Cliente: s.client_name || "Cliente à vista",
      Vendedor: s.seller_name || "",
      "Forma de pagamento": paymentLabel(s.payment_method),
      Localidade: s.location || "",
      Quantidade: Number(s.quantity),
      "Preço unitário (R$)": Number(s.unit_price),
      "Desconto (R$)": Number(s.discount || 0),
      "Custo no momento da venda (R$)": Number(s.cost_at_sale || 0),
      "Total (R$)": Number(s.total),
    }));
  exportSheetsToExcel([{ name: "Vendas", rows }], `vendas-${monthLabelText.replace(/\s+/g, "-")}.xlsx`);
}

function exportFullReportExcel() {
  // Resumo mensal — faturamento, custo e lucro mês a mês (bom pra enxergar tendência e comparar com metas).
  const monthKeys = Array.from(new Set(state.sales.map((s) => s.sold_at.slice(0, 7)))).sort();
  const monthlyRows = monthKeys.map((mk) => {
    const sales = state.sales.filter((s) => s.sold_at.slice(0, 7) === mk);
    const revenue = sales.reduce((s, x) => s + Number(x.total), 0);
    const cost = sales.reduce((s, x) => s + Number(x.cost_at_sale || 0) * Number(x.quantity), 0);
    const [y, m] = mk.split("-");
    return {
      Mês: `${MONTH_NAMES[Number(m) - 1]} de ${y}`,
      "Nº de vendas": sales.length,
      "Faturamento (R$)": Number(revenue.toFixed(2)),
      "Custo estimado (R$)": Number(cost.toFixed(2)),
      "Lucro estimado (R$)": Number((revenue - cost).toFixed(2)),
    };
  });

  // Estoque atual — quantidade, valor parado em estoque e markup de cada produto.
  const stockRows = state.products.map((p) => {
    const cost = Number(p.cost || 0);
    const price = Number(p.price || 0);
    return {
      Produto: p.name, Unidade: p.unit,
      "Qtd. Manhuaçu": Number(p.qty_mhu || 0), "Qtd. BH": Number(p.qty_bh || 0),
      "Qtd. total": Number(totalQty(p).toFixed(3)),
      "Custo total (R$)": Number(cost.toFixed(2)),
      "Preço de venda (R$)": Number(price.toFixed(2)),
      "Markup (%)": cost > 0 ? Number(((price / cost - 1) * 100).toFixed(1)) : "",
      "Valor em estoque (R$)": Number((price * totalQty(p)).toFixed(2)),
    };
  });

  // Contas a receber — quem deve, quanto já pagou e o saldo, pra cobrança e projeção de caixa.
  const receivableRows = receivablesByClient()
    .sort((a, b) => b.saldo - a.saldo)
    .map((g) => ({
      Cliente: g.clientName,
      "Total devido (R$)": Number(g.devido.toFixed(2)),
      "Já pago (R$)": Number(g.pago.toFixed(2)),
      "Saldo em aberto (R$)": Number(g.saldo.toFixed(2)),
      Status: g.saldo > 0.004 ? "Em aberto" : "Quitado",
    }));

  // Vendas do mês selecionado no momento (mesmo recorte que o botão de exportar só o mês).
  const monthSales = state.sales.filter((s) => s.sold_at.slice(0, 7) === state.resumoMonth);
  const monthSalesRows = monthSales
    .slice()
    .sort((a, b) => (a.sold_at < b.sold_at ? -1 : 1))
    .map((s) => ({
      "Data/hora": new Date(s.sold_at).toLocaleString("pt-BR"),
      Produto: s.product_name, Cliente: s.client_name || "Cliente à vista",
      Vendedor: s.seller_name || "", "Forma de pagamento": paymentLabel(s.payment_method),
      Quantidade: Number(s.quantity), "Total (R$)": Number(s.total),
    }));

  exportSheetsToExcel([
    { name: "Resumo mensal", rows: monthlyRows },
    { name: "Vendas do mês", rows: monthSalesRows },
    { name: "Estoque atual", rows: stockRows },
    { name: "Contas a receber", rows: receivableRows },
  ], `relatorio-cafe-sinceridade-${todayISO()}.xlsx`);
}

// ---- Resumo ----
function renderResumo() {
  const availableMonths = Array.from(new Set(state.sales.map((s) => s.sold_at.slice(0, 7)))).sort().reverse();
  if (!availableMonths.includes(state.resumoMonth)) {
    if (!availableMonths.includes(todayISOMonthPrefix())) availableMonths.unshift(todayISOMonthPrefix());
    state.resumoMonth = availableMonths[0] || todayISOMonthPrefix();
  }
  const monthPrefix = state.resumoMonth;
  const monthLabel = () => {
    const [y, m] = monthPrefix.split("-");
    return `${MONTH_NAMES[Number(m) - 1]} de ${y}`;
  };

  const today = todayISO();
  const todaySales = state.sales.filter((s) => s.sold_at.slice(0, 10) === today);
  const todayRevenue = todaySales.reduce((s, x) => s + Number(x.total), 0);

  const monthSales = state.sales.filter((s) => s.sold_at.slice(0, 7) === monthPrefix);
  const monthRevenue = monthSales.reduce((s, x) => s + Number(x.total), 0);

  const stockValueMhu = state.products.reduce((s, p) => s + Number(p.price) * Number(p.qty_mhu || 0), 0);
  const stockValueBh = state.products.reduce((s, p) => s + Number(p.price) * Number(p.qty_bh || 0), 0);
  const stockValue = stockValueMhu + stockValueBh;
  const lowStock = state.products.filter((p) => p.min_stock > 0 && totalQty(p) <= p.min_stock);

  const payTotals = { pix: 0, dinheiro: 0, cartao: 0, prazo: 0 };
  monthSales.forEach((s) => { const key = payTotals.hasOwnProperty(s.payment_method) ? s.payment_method : "dinheiro"; payTotals[key] += Number(s.total); });

  const hasCostData = monthSales.some((s) => Number(s.cost_at_sale) > 0);
  const monthProfit = monthSales.reduce((sum, s) => sum + (Number(s.unit_price) - Number(s.cost_at_sale)) * Number(s.quantity) - Number(s.discount || 0), 0);

  const salesByProduct = {};
  monthSales.forEach((s) => { salesByProduct[s.product_name] = (salesByProduct[s.product_name] || 0) + Number(s.quantity); });
  const ranking = Object.entries(salesByProduct).sort((a, b) => b[1] - a[1]);

  const salesByClient = {};
  monthSales.forEach((s) => {
    const key = s.client_name || "Cliente à vista";
    if (!salesByClient[key]) salesByClient[key] = { total: 0, count: 0 };
    salesByClient[key].total += Number(s.total);
    salesByClient[key].count += 1;
  });
  const clientRanking = Object.entries(salesByClient).sort((a, b) => b[1].total - a[1].total);

  const salesBySeller = {};
  monthSales.forEach((s) => {
    const key = s.seller_name || "Sem vendedor";
    salesBySeller[key] = (salesBySeller[key] || 0) + Number(s.total);
  });
  const sellerRanking = Object.entries(salesBySeller).sort((a, b) => b[1] - a[1]);

  const monthOptions = availableMonths.map((m) => {
    const [y, mo] = m.split("-");
    return `<option value="${m}" ${m === monthPrefix ? "selected" : ""}>${MONTH_NAMES[Number(mo) - 1]} de ${y}</option>`;
  }).join("");

  $("#main").innerHTML = `
    <div class="grid2" style="margin-bottom:20px;">
      <div class="metric"><div class="label">📈 Receita hoje</div><div class="value mono">${money(todayRevenue)}</div></div>
      <div class="metric"><div class="label">📊 Receita do mês</div><div class="value mono">${money(monthRevenue)}</div></div>
      <div class="metric"><div class="label">📦 Valor em estoque</div><div class="value mono">${money(stockValue)}</div></div>
      <div class="metric"><div class="label">🛒 Vendas hoje</div><div class="value mono">${todaySales.length}</div></div>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="row" style="margin-bottom:10px;">
        <p style="margin:0;font-size:13px;font-weight:500;color:var(--muted);">Vendas por mês</p>
        <select id="resumo-month-select" style="width:auto;max-width:200px;">${monthOptions}</select>
      </div>
      <p style="margin:0;font-size:12px;color:var(--muted2);">Exibindo dados de <b>${monthLabel()}</b>: ${monthSales.length} venda${monthSales.length === 1 ? "" : "s"}, total ${money(monthRevenue)}.</p>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <p style="margin:0 0 10px;font-size:13px;font-weight:500;color:var(--muted);">Recebido no mês por forma de pagamento</p>
      ${PAYMENT_METHODS.map((m) => `
        <div class="row" style="font-size:14px;padding:4px 0;">
          <span><span class="badge ${m.cls}">${m.label}</span></span>
          <span class="mono" style="color:var(--muted);">${money(payTotals[m.value])}</span>
        </div>
      `).join("")}
    </div>

    <div class="card" style="margin-bottom:20px;">
      <p style="margin:0 0 10px;font-size:13px;font-weight:500;color:var(--muted);">Valor em estoque por localidade</p>
      <div class="row" style="font-size:14px;padding:4px 0;"><span>Manhuaçu</span><span class="mono" style="color:var(--muted);">${money(stockValueMhu)}</span></div>
      <div class="row" style="font-size:14px;padding:4px 0;"><span>BH</span><span class="mono" style="color:var(--muted);">${money(stockValueBh)}</span></div>
    </div>

    ${hasCostData ? `
      <div class="card" style="margin-bottom:20px;background:var(--warn-bg);border-color:var(--warn-border);">
        <p style="margin:0 0 6px;font-size:13px;font-weight:500;color:var(--warn-text);">💰 Lucro estimado do mês</p>
        <p class="value mono" style="margin:0;color:var(--accent-dark);">${money(monthProfit)}</p>
        <p style="margin:6px 0 0;font-size:11px;color:var(--warn-text);">Aproximado — baseado no custo registrado em cada venda, já descontando os descontos concedidos.</p>
      </div>` : ""}

    ${lowStock.length ? `
      <div class="card" style="background:var(--warn-bg);border-color:var(--warn-border);margin-bottom:20px;">
        <p style="margin:0 0 8px;font-size:13px;font-weight:500;color:var(--warn-text);">⚠ Estoque baixo</p>
        ${lowStock.map((p) => `<div class="row" style="font-size:13px;color:var(--warn-text);"><span>${escapeHtml(p.name)}</span><span class="mono">${Number(totalQty(p).toFixed(3))} / ${p.min_stock} ${p.unit}</span></div>`).join("")}
      </div>` : ""}

    <div class="card" style="margin-bottom:20px;">
      <p style="margin:0 0 10px;font-size:13px;font-weight:500;color:var(--muted);">Ranking de produtos — ${monthLabel()}</p>
      ${ranking.length === 0 ? `<p style="font-size:13px;color:var(--muted2);">Sem vendas neste mês.</p>` : ranking.map(([name, qty], i) => `
        <div class="row" style="font-size:14px;padding:4px 0;"><span>${i + 1}. ${escapeHtml(name)}</span><span class="mono" style="color:var(--muted);">${Number(qty.toFixed(2))}</span></div>
      `).join("")}
    </div>

    <div class="card" style="margin-bottom:20px;">
      <p style="margin:0 0 10px;font-size:13px;font-weight:500;color:var(--muted);">Ranking de clientes — ${monthLabel()}</p>
      ${clientRanking.length === 0 ? `<p style="font-size:13px;color:var(--muted2);">Sem vendas neste mês.</p>` : clientRanking.map(([name, info], i) => `
        <div class="row" style="font-size:14px;padding:4px 0;">
          <span>${i + 1}. ${escapeHtml(name)} <span style="color:var(--muted2);font-size:12px;">(${info.count} compra${info.count === 1 ? "" : "s"})</span></span>
          <span class="mono" style="color:var(--muted);">${money(info.total)}</span>
        </div>
      `).join("")}
    </div>

    <div class="card" style="margin-bottom:20px;">
      <p style="margin:0 0 10px;font-size:13px;font-weight:500;color:var(--muted);">Ranking de vendedores — ${monthLabel()}</p>
      ${sellerRanking.length === 0 ? `<p style="font-size:13px;color:var(--muted2);">Sem vendas neste mês.</p>` : sellerRanking.map(([name, total], i) => `
        <div class="row" style="font-size:14px;padding:4px 0;"><span>${i + 1}. ${escapeHtml(name)}</span><span class="mono" style="color:var(--muted);">${money(total)}</span></div>
      `).join("")}
    </div>

    <div class="card" style="margin-top:20px;">
      <p style="margin:0 0 4px;font-size:13px;font-weight:500;color:var(--muted);">📊 Exportar para Excel</p>
      <p style="margin:0 0 12px;font-size:12px;color:var(--muted2);">Planilhas prontas pra apurar números e definir metas.</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button class="btn" id="btn-export-month" style="width:100%;">Exportar vendas de ${monthLabel()} (.xlsx)</button>
        <button class="btn btn-accent" id="btn-export-full" style="width:100%;">Exportar relatório completo (.xlsx)</button>
      </div>
    </div>
  `;

  $("#resumo-month-select").onchange = (e) => { state.resumoMonth = e.target.value; renderResumo(); };
  $("#btn-export-month").onclick = () => exportMonthSalesExcel(monthSales, monthLabel());
  $("#btn-export-full").onclick = () => exportFullReportExcel();
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---- Init ----
$$("#tabs button").forEach((btn) => { btn.onclick = () => { state.tab = btn.dataset.tab; render(); }; });

try {
  if (configOk) {
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error("A biblioteca do Supabase não carregou (verifique sua conexão com a internet, bloqueador de anúncios, ou tente outro navegador).");
    }
    db = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  }
} catch (err) {
  console.error(err);
  state.loadError = err.message;
  state.loading = false;
}

render();

if (configOk && db && !state.loadError) {
  loadAll();
  subscribeRealtime();
}