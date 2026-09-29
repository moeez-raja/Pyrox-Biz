import { auth, db } from '../js/firebase.js';
import { renderMetricCards } from '../js/metric-cards.js';
import { collection, query, where, getDocs, addDoc, setDoc, updateDoc, deleteDoc, doc, onSnapshot, runTransaction, getDoc } from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';

/* =========================================================
   MoeezFlow — Purchases Module
   + Batch Management Integration (FEFO-safe)
   ========================================================= */

/* ---------------------------------------------------------
   LOCAL STORAGE KEYS
   --------------------------------------------------------- */

const STORAGE_KEYS = {
  purchases: "moeezflow_purchases",
  suppliers: "moeezflow_purchase_suppliers",
  products: "moeezflow_purchase_inventory",
  returns: "moeezflow_purchase_returns",
  counter: "moeezflow_purchase_counter"
};

/* ---------------------------------------------------------
   STATE
   --------------------------------------------------------- */

let purchases = [];
let suppliers = [];
let products = [];
let returns = [];
let purchaseCounter = 0;

let purchaseLineItems = [];
let selectedSupplier = null;
let editingPurchaseId = null;
let currentPurchaseForView = null;
let currentPurchaseForReturn = null;
let pendingCancelId = null;

let currentPage = 1;
const PAGE_SIZE = 10;

let searchQuery = "";
let filters = { supplier: "", paymentStatus: "", dateFrom: "", dateTo: "" };
let sortState = { field: "createdAt", dir: "desc" };

let isSubmittingPurchase = false;
let isSubmittingReturn = false;

/* ---------------------------------------------------------
   BATCH HELPERS (inline — no external import needed)
   --------------------------------------------------------- */

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toDateValue(value) {
  if (!value) return null;
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    return value.toDate();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getBatchesCollection(productId) {
  return collection(db, 'products', productId, 'batches');
}

function getBatchDoc(productId, batchId) {
  return doc(db, 'products', productId, 'batches', batchId);
}

async function productHasBatches(productId) {
  if (!productId) return false;
  try {
    const snap = await getDocs(getBatchesCollection(productId));
    return !snap.empty;
  } catch (err) {
    console.warn('Could not check batches for', productId, err);
    return false;
  }
}

async function syncProductStockFromBatches(productId) {
  if (!productId) return 0;
  try {
    const snap = await getDocs(getBatchesCollection(productId));
    const total = snap.docs.reduce(
      (sum, d) => sum + numberOrZero(d.data().quantity),
      0
    );
    await updateDoc(doc(db, 'products', productId), {
      stock: total,
      updatedAt: nowISO()
    });
    return total;
  } catch (err) {
    console.warn('Could not sync product stock from batches:', productId, err);
    return 0;
  }
}

/**
 * Create or merge a batch for a purchase line.
 * If a batch with the same batchNumber + expiryDate exists → merge.
 * Otherwise → create new.
 * Returns the batch id.
 */
async function receiveBatchFromPurchase(line, meta) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated.');

  const productId = line.productId;
  if (!productId) throw new Error('Purchase line missing productId.');

  const qty = numberOrZero(line.quantity ?? line.qty);
  if (qty <= 0) return null;

  const batchNumberRaw = String(
    line.batchNumber ||
    meta.invoiceNumber ||
    meta.purchaseNumber ||
    `AUTO-${Date.now()}`
  ).trim();

  const expiryRaw = line.expiryDate || '';
  const mfgRaw = line.manufacturingDate || '';

  // Look for existing batch to merge (same batchNumber + expiry)
  const existingSnap = await getDocs(getBatchesCollection(productId));
  const mergeTarget = existingSnap.docs.find(d => {
    const data = d.data();
    return (
      String(data.batchNumber || '').trim() === batchNumberRaw &&
      String(data.expiryDate || '') === String(expiryRaw || '')
    );
  });

  if (mergeTarget) {
    const existing = mergeTarget.data();
    const newQty = numberOrZero(existing.quantity) + qty;
    await updateDoc(getBatchDoc(productId, mergeTarget.id), {
      quantity: newQty,
      costPrice: numberOrZero(line.costPrice ?? line.purchasePrice ?? existing.costPrice),
      sellingPrice: numberOrZero(line.sellingPrice ?? existing.sellingPrice),
      updatedAt: nowISO()
    });
    await syncProductStockFromBatches(productId);
    return {
      id: mergeTarget.id,
      batchNumber: existing.batchNumber || batchNumberRaw,
      merged: true,
      quantity: newQty
    };
  }

  const payload = {
    batchNumber: batchNumberRaw,
    manufacturingDate: mfgRaw,
    expiryDate: expiryRaw,
    quantity: qty,
    costPrice: numberOrZero(line.costPrice ?? line.purchasePrice ?? 0),
    sellingPrice: numberOrZero(line.sellingPrice ?? 0),
    supplier: String(line.supplier ?? meta.supplierName ?? '').trim(),
    purchaseRef: String(
      meta.purchaseNumber ?? meta.invoiceNumber ?? ''
    ).trim(),
    notes: String(line.notes ?? '').trim(),
    ownerId: user.uid,
    createdAt: nowISO(),
    updatedAt: nowISO()
  };

  const ref = await addDoc(getBatchesCollection(productId), payload);
  await syncProductStockFromBatches(productId);
  return { id: ref.id, ...payload, merged: false };
}

/**
 * Decrement batches when a purchase is cancelled / returned.
 * Decrements from batches matching the stored batchNumber/expiry first,
 * then from FEFO order as fallback.
 */
async function decrementBatchesForPurchaseReturn(productId, quantity, preferredBatchNumber, preferredExpiry) {
  if (!productId || quantity <= 0) return;

  const snap = await getDocs(getBatchesCollection(productId));
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!all.length) return;

  let remaining = quantity;

  // First try the preferred batch (exact match)
  const preferred = all.find(b =>
    String(b.batchNumber || '').trim() === String(preferredBatchNumber || '').trim() &&
    String(b.expiryDate || '') === String(preferredExpiry || '')
  );

  const ordered = preferred
    ? [preferred, ...all.filter(b => b.id !== preferred.id)]
    : all;

  for (const batch of ordered) {
    if (remaining <= 0) break;
    const have = numberOrZero(batch.quantity);
    if (have <= 0) continue;
    const take = Math.min(have, remaining);
    const newQty = have - take;
    await updateDoc(getBatchDoc(productId, batch.id), {
      quantity: newQty,
      updatedAt: nowISO()
    });
    remaining -= take;
  }

  await syncProductStockFromBatches(productId);
}

/* ---------------------------------------------------------
   FUTURE FIRESTORE-READY DATA ACCESS
   --------------------------------------------------------- */

function loadPurchases() {
  const raw = localStorage.getItem(STORAGE_KEYS.purchases);
  return Promise.resolve(raw ? JSON.parse(raw) : []);
}

function savePurchases() {
  localStorage.setItem(STORAGE_KEYS.purchases, JSON.stringify(purchases));
}

function loadSuppliers() {
  const raw = localStorage.getItem(STORAGE_KEYS.suppliers);
  return Promise.resolve(raw ? JSON.parse(raw) : []);
}

function saveSuppliers() {
  localStorage.setItem(STORAGE_KEYS.suppliers, JSON.stringify(suppliers));
}

function loadProducts() {
  const raw = localStorage.getItem(STORAGE_KEYS.products);
  return Promise.resolve(raw ? JSON.parse(raw) : []);
}

function saveProducts() {
  localStorage.setItem(STORAGE_KEYS.products, JSON.stringify(products));
}

function loadReturns() {
  const raw = localStorage.getItem(STORAGE_KEYS.returns);
  return Promise.resolve(raw ? JSON.parse(raw) : []);
}

function saveReturns() {
  localStorage.setItem(STORAGE_KEYS.returns, JSON.stringify(returns));
}

function loadCounter() {
  const raw = localStorage.getItem(STORAGE_KEYS.counter);
  return Promise.resolve(raw ? Number(raw) : 0);
}

function saveCounter() {
  localStorage.setItem(STORAGE_KEYS.counter, String(purchaseCounter));
}

/* ---------------------------------------------------------
   Firestore helpers
   --------------------------------------------------------- */

function getPurchasesCollection() {
  return collection(db, 'purchases');
}

function getPurchaseDoc(id) {
  return doc(db, 'purchases', id);
}

function getProductsCollection() {
  return collection(db, 'products');
}

function getProductDoc(id) {
  return doc(db, 'products', id);
}

function getSuppliersCollection() {
  return collection(db, 'suppliers');
}

function getSupplierDoc(id) {
  return doc(db, 'suppliers', id);
}

async function setupProductsRealtime() {
  const user = auth.currentUser;
  if (!user) return;

  const q = query(getProductsCollection(), where('ownerId', '==', user.uid));
  if (setupProductsRealtime.unsubscribe) setupProductsRealtime.unsubscribe();

  setupProductsRealtime.unsubscribe = onSnapshot(q, snapshot => {
    products = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    try { renderProductPickerList(); } catch (e) {}
  }, error => {
    console.error('Products realtime error (Purchases):', error);
  });
}

async function setupSuppliersRealtime() {
  const user = auth.currentUser;
  if (!user) return;

  const q = query(getSuppliersCollection(), where('ownerId', '==', user.uid));
  if (setupSuppliersRealtime.unsubscribe) setupSuppliersRealtime.unsubscribe();

  setupSuppliersRealtime.unsubscribe = onSnapshot(q, snapshot => {
    suppliers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    try { refreshSupplierFilterOptions(); } catch (e) {}
  }, error => {
    console.error('Suppliers realtime error (Purchases):', error);
  });
}

async function setupPurchasesRealtime() {
  const user = auth.currentUser;
  if (!user) return;

  const q = query(getPurchasesCollection(), where('ownerId', '==', user.uid));
  if (setupPurchasesRealtime.unsubscribe) setupPurchasesRealtime.unsubscribe();

  setupPurchasesRealtime.unsubscribe = onSnapshot(q, snapshot => {
    purchases = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    purchases.forEach(p => { if (p.createdAt && p.createdAt.toDate) p.createdAt = p.createdAt.toDate().toISOString(); });
    renderStatistics();
    renderPurchasesTable();
  }, error => {
    console.error('Purchases realtime error:', error);
    showNotification('Could not load purchases from Firestore.', 'fa-triangle-exclamation', true);
  });
}

/* ---------------------------------------------------------
   INIT
   --------------------------------------------------------- */

async function initializePurchases() {
  const emptyState = document.getElementById("emptyState");
  if (emptyState) {
    emptyState.style.display = 'none';
    emptyState.hidden = true;
  }

  setupSidebar();
  setupNavigation();
  setupToolbar();
  setupModals();
  setupSupplierSearch();
  setupProductPicker();
  setupQuickAddProduct();
  setupAddSupplier();
  setupLineItemHandlers();
  setupPurchaseForm();
  setupEditPaymentForm();
  setupReturnForm();
  setupCancelFlow();

  document.getElementById("openNewPurchaseBtn").addEventListener("click", openNewPurchaseModal);
  document.getElementById("emptyStateAddBtn").addEventListener("click", openNewPurchaseModal);

  suppliers = await loadSuppliers();
  refreshSupplierFilterOptions();

  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      purchases = [];
      products = [];
      renderStatistics();
      renderPurchasesTable();
      return;
    }

    try {
      setupProductsRealtime();
      setupSuppliersRealtime();
      setupPurchasesRealtime();
      purchaseCounter = await loadCounter();
    } catch (err) {
      console.error('Initialization failed:', err);
      showNotification('Could not initialize Purchases (Firestore).', 'fa-triangle-exclamation', true);
    }
  });
}

document.addEventListener("DOMContentLoaded", initializePurchases);

/* ---------------------------------------------------------
   SIDEBAR / NAV
   --------------------------------------------------------- */

function setupSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const openBtn = document.getElementById("menuToggle");
  const closeBtn = document.getElementById("sidebarClose");

  function open() { sidebar.classList.add("open"); overlay.classList.add("open"); openBtn.setAttribute("aria-expanded", "true"); }
  function close() { sidebar.classList.remove("open"); overlay.classList.remove("open"); openBtn.setAttribute("aria-expanded", "false"); }

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  window.addEventListener("resize", () => { if (window.innerWidth > 860) close(); });
}

function setupNavigation() {
  document.getElementById("logoutBtn").addEventListener("click", (e) => {
    e.preventDefault();
    showNotification("Logout is a placeholder — auth not connected yet.", "fa-arrow-right-from-bracket");
  });
}

/* ---------------------------------------------------------
   HELPERS
   --------------------------------------------------------- */

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function formatMoney(n, currency) {
  const val = Number(n) || 0;
  return (currency || "PKR") + " " + val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

function normalizeCustomFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  Object.entries(value).forEach(([key, raw]) => {
    const next = raw == null ? "" : String(raw).trim();
    if (next) result[key] = next;
  });
  return result;
}

function getItemCustomFields(item) {
  const source = item && typeof item === "object" ? (item.customFields || item) : {};
  const custom = normalizeCustomFields(source);
  const excluded = new Set([
    "productId", "name", "sku", "unit", "currentStock", "currency", "qty", "purchasePrice",
    "discountPct", "taxPct", "lineTotal", "returnedQty", "price", "total", "amount", "stock",
    "id", "customFields"
  ]);
  return Object.fromEntries(Object.entries(custom).filter(([key]) => !excluded.has(key)));
}

function formatCustomFieldLabel(key) {
  const map = {
    batchNumber: "Batch Number",
    expiryDate: "Expiry Date",
    manufacturer: "Manufacturer",
    size: "Size",
    color: "Color",
    fabric: "Fabric",
    style: "Style",
    design: "Design",
    productCode: "Product Code",
    productType: "Product Type"
  };
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1 $2");
  return map[key] || normalized.replace(/_/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
}

function nowISO() { return new Date().toISOString(); }
function todayInputValue() { return new Date().toISOString().slice(0, 10); }

function isSameDay(iso, dateObj) {
  const d = new Date(iso);
  return d.getFullYear() === dateObj.getFullYear() && d.getMonth() === dateObj.getMonth() && d.getDate() === dateObj.getDate();
}
function isSameMonth(iso, dateObj) {
  const d = new Date(iso);
  return d.getFullYear() === dateObj.getFullYear() && d.getMonth() === dateObj.getMonth();
}

function showNotification(message, icon, isError) {
  const toast = document.getElementById("toast");
  toast.classList.toggle("toast-error", !!isError);
  toast.innerHTML = `<i class="fas ${icon || "fa-circle-check"}"></i> ${escapeHtml(message)}`;
  toast.classList.add("show");
  clearTimeout(showNotification._t);
  showNotification._t = setTimeout(() => toast.classList.remove("show"), 3600);
}

function paymentStatusClass(status) {
  const map = { "Paid": "status-paid", "Partially Paid": "status-partially-paid", "Unpaid": "status-unpaid" };
  return map[status] || "status-unpaid";
}

function purchaseStatusClass(status) {
  const map = { "Completed": "status-completed", "Partially Returned": "status-partially-returned", "Returned": "status-returned", "Cancelled": "status-cancelled" };
  return map[status] || "status-completed";
}

function generatePurchaseNumber() {
  purchaseCounter += 1;
  saveCounter();
  return "PO-" + String(purchaseCounter).padStart(4, "0");
}

function generateId(prefix) {
  return prefix + "-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
}

/* ---------------------------------------------------------
   INVENTORY LOGIC
   (now batch-aware — see completePurchase)
   --------------------------------------------------------- */

function increaseStock(productId, qty) {
  const product = products.find(p => p.id === productId);
  if (!product) return false;
  product.stock = (Number(product.stock) || 0) + qty;
  saveProducts();
  return true;
}

function decreaseStock(productId, qty) {
  const product = products.find(p => p.id === productId);
  if (!product) return false;
  const newStock = (Number(product.stock) || 0) - qty;
  if (newStock < 0) return false;
  product.stock = newStock;
  saveProducts();
  return true;
}

/* ---------------------------------------------------------
   STATISTICS
   --------------------------------------------------------- */

function calculateStatistics() {
  const now = new Date();
  const active = purchases.filter(p => p.status !== "Cancelled");

  const totalPurchases = active.reduce((sum, p) => sum + (Number(p.grandTotal) || 0), 0);
  const todayPurchases = active.filter(p => isSameDay(p.createdAt, now)).reduce((sum, p) => sum + (Number(p.grandTotal) || 0), 0);
  const monthlyPurchases = active.filter(p => isSameMonth(p.createdAt, now)).reduce((sum, p) => sum + (Number(p.grandTotal) || 0), 0);
  const totalTransactions = active.length;
  const outstanding = active.reduce((sum, p) => sum + (Number(p.balance) || 0), 0);

  return { totalPurchases, todayPurchases, monthlyPurchases, totalTransactions, outstanding };
}

function renderStatistics() {
  const s = calculateStatistics();
  const grid = document.getElementById("statsGrid");

  renderMetricCards(grid, [
    { label: "Total Purchases", icon: "fa-dolly", value: formatMoney(s.totalPurchases), delta: { cls: "neutral", text: "—" }, foot: "all time" },
    { label: "Today's Purchases", icon: "fa-sun", value: formatMoney(s.todayPurchases), delta: { cls: "neutral", text: "—" }, foot: "today" },
    { label: "This Month's Purchases", icon: "fa-calendar-days", value: formatMoney(s.monthlyPurchases), delta: { cls: "neutral", text: "—" }, foot: "current month" },
    { label: "Total Transactions", icon: "fa-receipt", value: s.totalTransactions.toLocaleString(), delta: { cls: "neutral", text: "—" }, foot: "active purchases" },
    { label: "Outstanding Supplier Payments", icon: "fa-hourglass-half", value: formatMoney(s.outstanding), delta: { cls: s.outstanding > 0 ? "down" : "neutral", text: s.outstanding > 0 ? "Due" : "Clear" }, foot: "balances due" }
  ]);
}

/* ---------------------------------------------------------
   TOOLBAR
   --------------------------------------------------------- */

function refreshSupplierFilterOptions() {
  const select = document.getElementById("filterSupplier");
  const current = select.value;
  const names = [...new Set(suppliers.map(s => s.name))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="">All Suppliers</option>` + names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  if (names.includes(current)) select.value = current;
}

function setupToolbar() {
  document.getElementById("searchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    currentPage = 1;
    renderPurchasesTable();
  });

  document.getElementById("filterSupplier").addEventListener("change", (e) => {
    filters.supplier = e.target.value; currentPage = 1; renderPurchasesTable();
  });
  document.getElementById("filterPaymentStatus").addEventListener("change", (e) => {
    filters.paymentStatus = e.target.value; currentPage = 1; renderPurchasesTable();
  });
  document.getElementById("filterDateFrom").addEventListener("change", (e) => {
    filters.dateFrom = e.target.value; currentPage = 1; renderPurchasesTable();
  });
  document.getElementById("filterDateTo").addEventListener("change", (e) => {
    filters.dateTo = e.target.value; currentPage = 1; renderPurchasesTable();
  });

  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    filters = { supplier: "", paymentStatus: "", dateFrom: "", dateTo: "" };
    searchQuery = "";
    document.getElementById("searchInput").value = "";
    document.getElementById("filterSupplier").value = "";
    document.getElementById("filterPaymentStatus").value = "";
    document.getElementById("filterDateFrom").value = "";
    document.getElementById("filterDateTo").value = "";
    currentPage = 1;
    renderPurchasesTable();
  });

  document.getElementById("sortField").addEventListener("change", (e) => {
    sortState.field = e.target.value; currentPage = 1; renderPurchasesTable();
  });

  document.getElementById("sortDirBtn").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const newDir = btn.dataset.dir === "asc" ? "desc" : "asc";
    btn.dataset.dir = newDir;
    sortState.dir = newDir;
    btn.innerHTML = `<i class="fas fa-arrow-${newDir === "asc" ? "down-short-wide" : "up-wide-short"}"></i>`;
    currentPage = 1;
    renderPurchasesTable();
  });
}

function searchPurchases(q) { searchQuery = (q || "").trim().toLowerCase(); currentPage = 1; renderPurchasesTable(); }
function filterPurchases(partial) { filters = { ...filters, ...partial }; currentPage = 1; renderPurchasesTable(); }
function sortPurchases(field) { sortState.field = field; currentPage = 1; renderPurchasesTable(); }
function paginate(list) { const start = (currentPage - 1) * PAGE_SIZE; return list.slice(start, start + PAGE_SIZE); }

function getFilteredSortedPurchases() {
  let list = [...purchases];

  if (searchQuery) {
    list = list.filter(p => {
      const haystack = [p.purchaseNumber, p.reference, p.supplierName].join(" ").toLowerCase();
      return haystack.includes(searchQuery);
    });
  }

  if (filters.supplier) list = list.filter(p => p.supplierName === filters.supplier);
  if (filters.paymentStatus) list = list.filter(p => p.paymentStatus === filters.paymentStatus);

  if (filters.dateFrom) {
    const from = new Date(filters.dateFrom);
    list = list.filter(p => new Date(p.date) >= from);
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    list = list.filter(p => new Date(p.date) <= to);
  }

  const { field, dir } = sortState;
  list.sort((a, b) => {
    let av, bv;
    if (field === "createdAt") { av = new Date(a.createdAt).getTime(); bv = new Date(b.createdAt).getTime(); }
    else if (field === "purchaseNumber") { av = a.purchaseNumber; bv = b.purchaseNumber; return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av); }
    else { av = Number(a[field]) || 0; bv = Number(b[field]) || 0; }
    return dir === "asc" ? av - bv : bv - av;
  });

  return list;
}

/* ---------------------------------------------------------
   RENDER PURCHASES TABLE
   --------------------------------------------------------- */

function renderPurchasesTable() {
  refreshSupplierFilterOptions();

  const tbody = document.getElementById("purchasesTableBody");
  const table = document.getElementById("purchasesTable");
  const emptyState = document.getElementById("emptyState");
  const paginationEl = document.getElementById("pagination");
  const toolbarPanel = document.querySelector(".toolbar-panel");

  const filtered = getFilteredSortedPurchases();

  if (purchases.length === 0) {
    if (table) { table.style.display = 'none'; table.hidden = true; }
    if (paginationEl) { paginationEl.style.display = 'none'; paginationEl.hidden = true; }
    if (toolbarPanel) { toolbarPanel.style.display = 'none'; }
    if (emptyState) { emptyState.style.display = ''; emptyState.hidden = false; }
    document.getElementById("emptyStateTitle").textContent = "No purchases yet";
    document.getElementById("emptyStateText").textContent = "Record your first purchase to start tracking stock and supplier payments.";
    document.getElementById("emptyStateAddBtn").hidden = false;
    tbody.innerHTML = "";
    return;
  }

  if (filtered.length === 0) {
    if (table) { table.style.display = 'none'; table.hidden = true; }
    if (paginationEl) { paginationEl.style.display = 'none'; paginationEl.hidden = true; }
    if (toolbarPanel) { toolbarPanel.style.display = ''; }
    if (emptyState) { emptyState.style.display = ''; emptyState.hidden = false; }
    document.getElementById("emptyStateTitle").textContent = "No matching purchases";
    document.getElementById("emptyStateText").textContent = "Try adjusting your search or filters.";
    document.getElementById("emptyStateAddBtn").hidden = true;
    tbody.innerHTML = "";
    return;
  }

  if (toolbarPanel) toolbarPanel.style.display = '';
  if (emptyState) { emptyState.style.display = 'none'; emptyState.hidden = true; }
  if (table) { table.style.display = ''; table.hidden = false; }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const pageItems = paginate(filtered);

  tbody.innerHTML = pageItems.map(p => `
    <tr data-id="${p.id}">
      <td class="cell-mono">${escapeHtml(p.purchaseNumber)}</td>
      <td>${escapeHtml(p.supplierName)}</td>
      <td class="cell-muted">${formatDate(p.date)}</td>
      <td class="cell-mono">${formatMoney(p.grandTotal, p.currency)}</td>
      <td class="cell-mono">${formatMoney(p.amountPaid, p.currency)}</td>
      <td class="cell-mono">${formatMoney(p.balance, p.currency)}</td>
      <td><span class="status-pill ${paymentStatusClass(p.paymentStatus)}">${p.paymentStatus}</span></td>
      <td>${escapeHtml(p.paymentMethod)}</td>
      <td>
        <div class="row-actions">
          <button class="row-action-btn" data-action="view" data-id="${p.id}" aria-label="View purchase"><i class="fas fa-eye"></i></button>
          <button class="row-action-btn" data-action="edit" data-id="${p.id}" aria-label="Edit purchase"><i class="fas fa-pen"></i></button>
          <button class="row-action-btn" data-action="delete" data-id="${p.id}" aria-label="Delete purchase"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll("[data-action='view']").forEach(btn => btn.addEventListener("click", () => openPurchaseDetails(btn.dataset.id)));

  renderPagination(filtered.length, totalPages);
}

function renderPagination(totalItems, totalPages) {
  const paginationEl = document.getElementById("pagination");
  const info = document.getElementById("paginationInfo");
  const controls = document.getElementById("paginationControls");

  if (paginationEl) { paginationEl.style.display = ''; paginationEl.hidden = false; }
  
  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, totalItems);
  info.textContent = `Showing ${start}–${end} of ${totalItems} purchases`;

  let html = `<button class="page-btn" id="prevPageBtn" ${currentPage === 1 ? "disabled" : ""} aria-label="Previous page"><i class="fas fa-chevron-left"></i></button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 1) {
      html += `<button class="page-btn ${i === currentPage ? "active" : ""}" data-page="${i}">${i}</button>`;
    } else if (Math.abs(i - currentPage) === 2) {
      html += `<span style="color:var(--gray-500); padding:0 4px;">…</span>`;
    }
  }
  html += `<button class="page-btn" id="nextPageBtn" ${currentPage === totalPages ? "disabled" : ""} aria-label="Next page"><i class="fas fa-chevron-right"></i></button>`;
  controls.innerHTML = html;

  const prevBtn = document.getElementById("prevPageBtn");
  const nextBtn = document.getElementById("nextPageBtn");
  if (prevBtn) prevBtn.addEventListener("click", () => { currentPage--; renderPurchasesTable(); });
  if (nextBtn) nextBtn.addEventListener("click", () => { currentPage++; renderPurchasesTable(); });

  controls.querySelectorAll("[data-page]").forEach(btn => {
    btn.addEventListener("click", () => { currentPage = Number(btn.dataset.page); renderPurchasesTable(); });
  });
}

/* ---------------------------------------------------------
   GENERIC MODAL SYSTEM
   --------------------------------------------------------- */

let activeModalId = null;
let modalStack = [];

function setupModals() {
  const overlay = document.getElementById("modalOverlay");
  document.querySelectorAll("[data-close-modal]").forEach(btn => btn.addEventListener("click", () => closeModal()));
  overlay.addEventListener("click", () => closeModal());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && activeModalId) closeModal(); });
}

function openModal(id) {
  const modal = document.getElementById(id);
  const overlay = document.getElementById("modalOverlay");
  if (!modal) return;
  if (activeModalId) modalStack.push(activeModalId);
  modal.hidden = false;
  overlay.classList.add("open");
  requestAnimationFrame(() => modal.classList.add("open"));
  activeModalId = id;
}

function closeModal() {
  if (!activeModalId) return;
  const modal = document.getElementById(activeModalId);
  const overlay = document.getElementById("modalOverlay");
  modal.classList.remove("open");

  const previous = modalStack.pop();
  if (!previous) overlay.classList.remove("open");

  setTimeout(() => { modal.hidden = true; }, 220);
  activeModalId = previous || null;
}

/* ---------------------------------------------------------
   SUPPLIER SEARCH + QUICK ADD
   --------------------------------------------------------- */

function setupSupplierSearch() {
  const input = document.getElementById("supplierSearch");
  const resultsEl = document.getElementById("supplierResults");

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    document.getElementById("selectedSupplierId").value = "";
    document.getElementById("selectedSupplierChip").hidden = true;
    if (!q) { resultsEl.hidden = true; return; }

    const matches = suppliers.filter(s => (s.name || "").toLowerCase().includes(q) || (s.phone || "").includes(q)).slice(0, 8);

    resultsEl.innerHTML = matches.length
      ? matches.map(s => `<div class="combo-item" data-id="${s.id}"><div>${escapeHtml(s.name)}</div><div class="combo-item-sub">${escapeHtml(s.phone || "")}</div></div>`).join("")
      : `<div class="combo-empty">No matching suppliers. Try "Add new supplier" below.</div>`;

    resultsEl.hidden = false;

    resultsEl.querySelectorAll(".combo-item").forEach(item => {
      item.addEventListener("click", () => {
        const s = suppliers.find(x => x.id === item.dataset.id);
        selectSupplier(s);
        resultsEl.hidden = true;
      });
    });
  });

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !resultsEl.contains(e.target)) resultsEl.hidden = true;
  });

  document.getElementById("addSupplierInlineBtn").addEventListener("click", () => openModal("addSupplierModal"));
}

function selectSupplier(supplier) {
  selectedSupplier = supplier;
  document.getElementById("selectedSupplierId").value = supplier.id;
  document.getElementById("supplierSearch").value = "";
  const chip = document.getElementById("selectedSupplierChip");
  chip.hidden = false;
  chip.innerHTML = `<i class="fas fa-handshake"></i> ${escapeHtml(supplier.name)} <button type="button" id="clearSupplierBtn" aria-label="Clear supplier">&times;</button>`;
  document.getElementById("clearSupplierBtn").addEventListener("click", () => {
    selectedSupplier = null;
    document.getElementById("selectedSupplierId").value = "";
    chip.hidden = true;
  });
}

function setupAddSupplier() {
  document.getElementById("addSupplierForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById("supName");
    const nameRow = nameInput.closest(".form-row");
    nameRow.classList.remove("invalid");

    const name = nameInput.value.trim();
    if (!name) { nameRow.classList.add("invalid"); return; }

    const phone = document.getElementById("supPhone").value.trim();
    const email = document.getElementById("supEmail").value.trim();
    const address = document.getElementById("supAddress").value.trim();
    const taxNumber = document.getElementById("supTaxNumber").value.trim();

    const user = auth.currentUser;

    const supplierRec = {
      name, phone, email, address, taxNumber,
      balance: 0,
      createdAt: nowISO(),
      updatedAt: nowISO()
    };

    if (user) {
      try {
        supplierRec.ownerId = user.uid;
        const ref = await addDoc(getSuppliersCollection(), supplierRec);
        const supplier = { id: ref.id, ...supplierRec };
        suppliers.push(supplier);
        saveSuppliers();
        document.getElementById("addSupplierForm").reset();
        closeModal();
        selectSupplier(supplier);
        showNotification(`Supplier "${name}" added.`, "fa-circle-check");
        return;
      } catch (err) {
        console.error('Could not create supplier in Firestore, falling back to local:', err);
        if (err && err.code === 'permission-denied') {
          showNotification('Missing permissions creating supplier. Check Firestore rules and ownerId.', 'fa-triangle-exclamation', true);
        } else {
          showNotification('Could not save supplier to Firestore, saved locally instead.', 'fa-triangle-exclamation', true);
        }
      }
    }

    const supplier = { id: generateId("SUP"), ...supplierRec };
    suppliers.push(supplier);
    saveSuppliers();
    document.getElementById("addSupplierForm").reset();
    closeModal();
    selectSupplier(supplier);
    showNotification(`Supplier "${name}" added (local).`, "fa-circle-check");
  });
}

/* ---------------------------------------------------------
   PRODUCT PICKER + QUICK ADD
   --------------------------------------------------------- */

function setupProductPicker() {
  document.getElementById("addLineBtn").addEventListener("click", () => {
    document.getElementById("productPickerSearch").value = "";
    renderProductPickerList();
    openModal("productPickerModal");
  });
  document.getElementById("productPickerSearch").addEventListener("input", renderProductPickerList);
}

function renderProductPickerList() {
  const q = document.getElementById("productPickerSearch").value.trim().toLowerCase();
  const listEl = document.getElementById("productPickerList");

  const filtered = q
    ? products.filter(p => (p.name || "").toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q))
    : products;

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="combo-empty">No products found. Use "Add New Product" above.</div>`;
    return;
  }

  listEl.innerHTML = filtered.map(p => `
    <div class="picker-item" data-id="${p.id}">
      <div>
        <div class="picker-item-name">${escapeHtml(p.name)}</div>
        <div class="picker-item-sub">${escapeHtml(p.sku)}</div>
      </div>
      <div class="picker-item-stock">${Number(p.stock) || 0} ${escapeHtml(p.unit || "")} in stock</div>
    </div>
  `).join("");

  listEl.querySelectorAll(".picker-item").forEach(item => {
    item.addEventListener("click", () => {
      addProductToPurchase(item.dataset.id);
      closeModal();
    });
  });
}

function addProductToPurchase(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;

  const existing = purchaseLineItems.find(li => li.productId === productId);
  if (existing) {
    existing.qty += 1;
  } else {
    purchaseLineItems.push({
      productId: product.id,
      name: product.name,
      sku: product.sku,
      unit: product.unit || "",
      currentStock: Number(product.stock) || 0,
      currency: product.currency || "PKR",
      qty: 1,
      purchasePrice: Number(product.purchasePrice) || 0,
      discountPct: 0,
      taxPct: 0,
      batchNumber: "",
      expiryDate: "",
      manufacturingDate: "",
      customFields: getItemCustomFields(product)
    });
  }
  renderLineItems();
}

function setupQuickAddProduct() {
  document.getElementById("quickAddProductBtn").addEventListener("click", () => openModal("quickAddProductModal"));

  document.getElementById("quickAddProductForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById("qpName");
    const skuInput = document.getElementById("qpSku");
    const nameRow = nameInput.closest(".form-row");
    const skuRow = skuInput.closest(".form-row");
    nameRow.classList.remove("invalid");
    skuRow.classList.remove("invalid");

    const name = nameInput.value.trim();
    const sku = skuInput.value.trim();
    let valid = true;

    if (!name) { nameRow.classList.add("invalid"); valid = false; }
    if (!sku) { skuRow.classList.add("invalid"); valid = false; }
    else if (products.some(p => (p.sku || "").toLowerCase() === sku.toLowerCase())) { skuRow.classList.add("invalid"); valid = false; }

    if (!valid) return;

    const unit = document.getElementById("qpUnit").value.trim() || "pcs";
    const optionalFields = {
      batchNumber: document.getElementById("qpBatchNumber").value.trim(),
      expiryDate: document.getElementById("qpExpiryDate").value.trim(),
      manufacturer: document.getElementById("qpManufacturer").value.trim(),
      size: document.getElementById("qpSize").value.trim(),
      color: document.getElementById("qpColor").value.trim(),
      fabric: document.getElementById("qpFabric").value.trim(),
      style: document.getElementById("qpStyle").value.trim(),
      productType: document.getElementById("qpProductType").value.trim()
    };
    const customFields = Object.fromEntries(Object.entries(optionalFields).filter(([, value]) => value));

    const user = auth.currentUser;

    const productRec = {
      name, sku, unit,
      stock: 0,
      purchasePrice: 0,
      currency: "PKR",
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    if (Object.keys(customFields).length) {
      productRec.customFields = customFields;
    }

    if (user) {
      try {
        productRec.ownerId = user.uid;
        const ref = await addDoc(getProductsCollection(), productRec);
        const product = { id: ref.id, ...productRec };
        products.push(product);
        saveProducts();
        document.getElementById("quickAddProductForm").reset();
        document.getElementById("qpUnit").value = "pcs";
        closeModal();
        addProductToPurchase(product.id);
        showNotification(`Product "${name}" added.`, "fa-circle-check");
        return;
      } catch (err) {
        console.error('Could not create product in Firestore, falling back to local:', err);
        if (err && err.code === 'permission-denied') {
          showNotification('Missing permissions creating product. Check Firestore rules and ownerId.', 'fa-triangle-exclamation', true);
        } else {
          showNotification('Could not save product to Firestore, saved locally instead.', 'fa-triangle-exclamation', true);
        }
      }
    }

    const product = { id: generateId("PRD"), ...productRec };
    products.push(product);
    saveProducts();
    document.getElementById("quickAddProductForm").reset();
    document.getElementById("qpUnit").value = "pcs";
    closeModal();
    addProductToPurchase(product.id);
    showNotification(`Product "${name}" added (local).`, "fa-circle-check");
  });
}

/* ---------------------------------------------------------
   LINE ITEMS
   --------------------------------------------------------- */

function calculateLineTotal(item) {
  const gross = item.qty * item.purchasePrice;
  const afterDiscount = gross - (gross * (item.discountPct / 100));
  const withTax = afterDiscount + (afterDiscount * (item.taxPct / 100));
  return round2(withTax);
}

function renderLineItems() {
  const body = document.getElementById("lineItemsBody");
  const emptyEl = document.getElementById("lineItemsEmpty");

  if (purchaseLineItems.length === 0) {
    body.innerHTML = "";
    emptyEl.classList.add("show");
    updatePaymentSummary();
    return;
  }
  emptyEl.classList.remove("show");

  body.innerHTML = purchaseLineItems.map((item, index) => {
    const lineTotal = calculateLineTotal(item);
    return `
      <tr data-index="${index}">
        <td>
          <div class="li-product-name">${escapeHtml(item.name)}</div>
          <div class="li-product-sku">${escapeHtml(item.sku)}</div>
        </td>
        <td><span class="li-stock-value">${item.currentStock} ${escapeHtml(item.unit)}</span></td>
        <td><input type="number" class="li-qty-input" min="1" step="1" value="${item.qty}" data-field="qty"></td>
        <td><input type="number" class="li-price-input" min="0" step="0.01" value="${item.purchasePrice}" data-field="purchasePrice"></td>
        <td><input type="number" class="li-discount-input" min="0" max="100" step="0.01" value="${item.discountPct}" data-field="discountPct"></td>
        <td><input type="number" class="li-tax-input" min="0" step="0.01" value="${item.taxPct}" data-field="taxPct"></td>
        <td class="li-line-total">${formatMoney(lineTotal, item.currency)}</td>
        <td><button type="button" class="li-remove-btn" aria-label="Remove line"><i class="fas fa-trash"></i></button></td>
      </tr>
    `;
  }).join("");

  updatePaymentSummary();
}

function setupLineItemHandlers() {
  document.getElementById("lineItemsBody").addEventListener("input", (e) => {
    const input = e.target.closest("input[data-field]");
    if (!input) return;
    const row = input.closest("tr");
    const index = Number(row.dataset.index);
    const field = input.dataset.field;

    let value = Number(input.value);
    if (isNaN(value) || value < 0) value = 0;
    if (field === "qty" && value < 1) value = 1;
    if (field === "discountPct" && value > 100) value = 100;

    purchaseLineItems[index][field] = value;

    const lineTotal = calculateLineTotal(purchaseLineItems[index]);
    row.querySelector(".li-line-total").textContent = formatMoney(lineTotal, purchaseLineItems[index].currency);
    updatePaymentSummary();
  });

  document.getElementById("lineItemsBody").addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".li-remove-btn");
    if (!removeBtn) return;
    const row = removeBtn.closest("tr");
    const index = Number(row.dataset.index);
    purchaseLineItems.splice(index, 1);
    renderLineItems();
  });

  document.getElementById("fAmountPaid").addEventListener("input", updatePaymentSummary);
}

function calculatePurchaseTotals() {
  let subtotal = 0, discountTotal = 0, taxTotal = 0;

  purchaseLineItems.forEach(item => {
    const gross = item.qty * item.purchasePrice;
    const discountAmt = gross * (item.discountPct / 100);
    const afterDiscount = gross - discountAmt;
    const taxAmt = afterDiscount * (item.taxPct / 100);

    subtotal += gross;
    discountTotal += discountAmt;
    taxTotal += taxAmt;
  });

  const grandTotal = round2(subtotal - discountTotal + taxTotal);
  return { subtotal: round2(subtotal), discountTotal: round2(discountTotal), taxTotal: round2(taxTotal), grandTotal };
}

function updatePaymentSummary() {
  const totals = calculatePurchaseTotals();
  const currency = purchaseLineItems[0]?.currency || "PKR";

  document.getElementById("totalSubtotal").textContent = formatMoney(totals.subtotal, currency);
  document.getElementById("totalDiscount").textContent = formatMoney(totals.discountTotal, currency);
  document.getElementById("totalTax").textContent = formatMoney(totals.taxTotal, currency);
  document.getElementById("totalGrand").textContent = formatMoney(totals.grandTotal, currency);

  const paidInput = document.getElementById("fAmountPaid");
  let paid = Number(paidInput.value) || 0;
  if (paid < 0) paid = 0;
  if (paid > totals.grandTotal) paid = totals.grandTotal;

  const balance = round2(totals.grandTotal - paid);
  document.getElementById("balanceDisplay").textContent = formatMoney(balance, currency);

  let status = "Unpaid";
  if (totals.grandTotal > 0 && paid >= totals.grandTotal) status = "Paid";
  else if (paid > 0) status = "Partially Paid";

  const pill = document.getElementById("paymentStatusPill");
  pill.textContent = status;
  pill.className = "status-pill " + paymentStatusClass(status);
}

/* ---------------------------------------------------------
   NEW PURCHASE MODAL
   --------------------------------------------------------- */

function openNewPurchaseModal() {
  editingPurchaseId = null;
  document.getElementById("purchaseFormTitle").innerHTML = '<i class="fas fa-truck-ramp-box"></i> New Purchase';
  document.getElementById("purchaseSubmitBtn").textContent = "Complete Purchase";
  resetPurchaseForm();
  openModal("purchaseFormModal");
}

function resetPurchaseForm() {
  document.getElementById("purchaseForm").reset();
  document.getElementById("purchaseForm").querySelectorAll(".form-row").forEach(r => r.classList.remove("invalid"));
  document.getElementById("selectedSupplierId").value = "";
  document.getElementById("selectedSupplierChip").hidden = true;
  document.getElementById("fPurchaseDate").value = todayInputValue();
  selectedSupplier = null;
  purchaseLineItems = [];
  renderLineItems();
  document.getElementById("purchaseSubmitBtn").disabled = false;
  document.getElementById("purchaseSubmitBtn").textContent = "Complete Purchase";
}

/* ---------------------------------------------------------
   VALIDATION
   --------------------------------------------------------- */

function validatePurchaseForm() {
  let valid = true;
  const supplierRow = document.getElementById("supplierSearch").closest(".form-row");
  const dateRow = document.getElementById("fPurchaseDate").closest(".form-row");
  const paidRow = document.getElementById("fAmountPaid").closest(".form-row");

  supplierRow.classList.remove("invalid");
  dateRow.classList.remove("invalid");
  paidRow.classList.remove("invalid");

  if (!document.getElementById("selectedSupplierId").value) { supplierRow.classList.add("invalid"); valid = false; }
  if (!document.getElementById("fPurchaseDate").value) { dateRow.classList.add("invalid"); valid = false; }

  if (purchaseLineItems.length === 0) {
    showNotification("Add at least one product before completing the purchase.", "fa-triangle-exclamation", true);
    valid = false;
  }

  const invalidQtyItem = purchaseLineItems.find(li => li.qty < 1 || isNaN(li.qty));
  if (invalidQtyItem) {
    showNotification(`"${invalidQtyItem.name}" has an invalid quantity.`, "fa-triangle-exclamation", true);
    valid = false;
  }

  const negativeItem = purchaseLineItems.find(li => li.purchasePrice < 0 || li.discountPct < 0 || li.taxPct < 0);
  if (negativeItem) {
    showNotification(`"${negativeItem.name}" has a negative price, discount, or tax value.`, "fa-triangle-exclamation", true);
    valid = false;
  }

  const totals = calculatePurchaseTotals();
  const paid = Number(document.getElementById("fAmountPaid").value) || 0;
  if (paid < 0 || paid > totals.grandTotal) { paidRow.classList.add("invalid"); valid = false; }

  return valid;
}

function setupPurchaseForm() {
  document.getElementById("purchaseForm").addEventListener("submit", handlePurchaseSubmit);
}

async function handlePurchaseSubmit(e) {
  e.preventDefault();
  if (isSubmittingPurchase) return;
  if (!validatePurchaseForm()) return;

  const submitBtn = document.getElementById("purchaseSubmitBtn");
  isSubmittingPurchase = true;
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Saving...`;

  try {
    const purchaseId = await completePurchase();
    showNotification("Purchase completed and stock updated.", "fa-circle-check");
    closeModal();
    renderStatistics();
    renderPurchasesTable();

    try {
      const redirectUrl = `../invoices/invoices.html?generate=purchase&id=${purchaseId}`;
      window.location.href = redirectUrl;
      return;
    } catch (redirErr) {
      console.warn('Could not redirect to invoices for auto-generation:', redirErr);
    }

  } catch (err) {
    console.error("Purchase failed:", err);
    showNotification(err.message || "Could not complete purchase. Please try again.", "fa-triangle-exclamation", true);
  } finally {
    isSubmittingPurchase = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Complete Purchase";
  }
}

/* ---------------------------------------------------------
   COMPLETE PURCHASE — BATCH-AWARE
   --------------------------------------------------------- */

async function completePurchase() {
  const supplierId = document.getElementById("selectedSupplierId").value;
  const supplier = suppliers.find(s => s.id === supplierId);
  if (!supplier) throw new Error("Selected supplier could not be found.");

  const totals = calculatePurchaseTotals();
  const amountPaid = round2(Number(document.getElementById("fAmountPaid").value) || 0);
  const balance = round2(totals.grandTotal - amountPaid);
  const paymentMethod = document.getElementById("fPaymentMethod").value;

  let paymentStatus = "Unpaid";
  if (totals.grandTotal > 0 && amountPaid >= totals.grandTotal) paymentStatus = "Paid";
  else if (amountPaid > 0) paymentStatus = "Partially Paid";

  const currency = purchaseLineItems[0]?.currency || "PKR";
  const itemsSnapshot = purchaseLineItems.map(li => ({
    productId: li.productId,
    name: li.name,
    sku: li.sku,
    unit: li.unit,
    qty: li.qty,
    returnedQty: 0,
    purchasePrice: li.purchasePrice,
    discountPct: li.discountPct,
    taxPct: li.taxPct,
    lineTotal: calculateLineTotal(li),
    batchNumber: li.batchNumber || "",
    expiryDate: li.expiryDate || "",
    manufacturingDate: li.manufacturingDate || "",
    customFields: getItemCustomFields(li)
  }));

  for (const item of itemsSnapshot) {
    if (item.qty < 1) throw new Error(`Invalid quantity for "${item.name}".`);
  }

  const purchaseOrder = document.getElementById("fReference").value.trim();
  const purchase = {
    id: generateId("PUR"),
    purchaseNumber: generatePurchaseNumber(),
    supplierId: supplier.id,
    supplierName: supplier.name,
    reference: purchaseOrder,
    purchaseOrder,
    date: document.getElementById("fPurchaseDate").value,
    items: itemsSnapshot,
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    taxTotal: totals.taxTotal,
    grandTotal: totals.grandTotal,
    amountPaid,
    balance,
    paymentStatus,
    paymentMethod,
    currency,
    status: "Completed",
    createdAt: nowISO(),
    updatedAt: nowISO()
  };

  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated.');

  // 1) Save purchase doc + supplier balance via transaction (no direct product stock touches)
  try {
    await runTransaction(db, async (tx) => {
      const purchaseRef = getPurchaseDoc(purchase.id);
      const rec = { ...purchase, ownerId: user.uid };

      const supplierRef = getSupplierDoc(supplier.id);
      let supSnap = null;
      try {
        supSnap = await tx.get(supplierRef);
      } catch (e) {
        supSnap = null;
      }

      tx.set(purchaseRef, rec);

      try {
        if (supSnap && supSnap.exists()) {
          const prev = Number(supSnap.data().balance || 0);
          const next = round2(prev + balance);
          tx.update(supplierRef, { balance: next, updatedAt: nowISO() });
        } else {
          supplier.balance = round2((Number(supplier.balance) || 0) + balance);
          saveSuppliers();
        }
      } catch (innerErr) {
        console.warn('Supplier balance not updated in Firestore:', innerErr);
        supplier.balance = round2((Number(supplier.balance) || 0) + balance);
        saveSuppliers();
      }
    });
  } catch (err) {
    console.error('Transaction failed:', err);
    if (err && err.code && err.code === 'permission-denied') {
      showNotification('Missing or insufficient permissions. Check Firestore rules and ownerId fields.', 'fa-triangle-exclamation', true);
    }
    throw err;
  }

  // 2) Create / merge batches for each line, then sync stock
  for (const item of itemsSnapshot) {
    const product = products.find(p => p.id === item.productId);
    const hasBatches = await productHasBatches(item.productId);

    if (hasBatches) {
      // Product already uses batches → create batch, sync stock
      try {
        await receiveBatchFromPurchase(
          {
            productId: item.productId,
            quantity: item.qty,
            batchNumber: item.batchNumber,
            expiryDate: item.expiryDate,
            manufacturingDate: item.manufacturingDate,
            costPrice: item.purchasePrice,
            sellingPrice: 0,
            supplier: supplier.name,
            notes: ""
          },
          {
            purchaseNumber: purchase.purchaseNumber,
            invoiceNumber: purchase.reference || purchase.purchaseNumber,
            supplierName: supplier.name
          }
        );
      } catch (batchErr) {
        console.error('Batch creation failed for', item.name, batchErr);
        showNotification(`Purchase saved but batch creation failed for "${item.name}".`, 'fa-triangle-exclamation', true);
      }
    } else {
      // Legacy product without batches → increment stock directly
      if (product) {
        const newStock = (Number(product.stock) || 0) + Number(item.qty || 0);
        try {
          await updateDoc(getProductDoc(item.productId), {
            stock: newStock,
            purchasePrice: item.purchasePrice,
            updatedAt: nowISO()
          });
          product.stock = newStock;
          product.purchasePrice = item.purchasePrice;
        } catch (stockErr) {
          console.warn('Could not update legacy product stock:', stockErr);
        }
      }
    }

    // Update local product purchase price
    if (product) {
      product.purchasePrice = item.purchasePrice;
    }
  }

  return purchase.id;
}

/* ---------------------------------------------------------
   PURCHASE DETAILS VIEW
   --------------------------------------------------------- */

function openPurchaseDetails(purchaseId) {
  const purchase = purchases.find(p => p.id === purchaseId);
  if (!purchase) return;
  currentPurchaseForView = purchase;

  const body = document.getElementById("purchaseDetailsBody");
  const purchaseOrder = purchase.purchaseOrder || purchase.reference || "";
  body.innerHTML = `
    <div class="detail-header">
      <div>
        <div class="detail-header-name">${escapeHtml(purchase.purchaseNumber)}</div>
        <div class="detail-header-sub">${escapeHtml(purchase.supplierName)} · ${formatDate(purchase.date)}${purchaseOrder ? " · PO: " + escapeHtml(purchaseOrder) : ""}</div>
      </div>
      <div>
        <span class="status-pill ${purchaseStatusClass(purchase.status)}">${purchase.status}</span>
        <span class="status-pill ${paymentStatusClass(purchase.paymentStatus)}">${purchase.paymentStatus}</span>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Products</div>
      <div class="line-items-wrap">
        <table class="line-items-table">
          <thead>
            <tr><th class="li-product">Product</th><th class="li-qty">Qty</th><th class="li-stock">Returned</th><th class="li-price">Purchase Price</th><th class="li-discount">Disc %</th><th class="li-tax">Tax %</th><th class="li-total">Line Total</th></tr>
          </thead>
          <tbody>
            ${purchase.items.map(it => `
              <tr>
                <td><div class="li-product-name">${escapeHtml(it.name)}</div><div class="li-product-sku">${escapeHtml(it.sku)}</div></td>
                <td class="cell-mono">${it.qty}</td>
                <td class="cell-mono">${it.returnedQty || 0}</td>
                <td class="cell-mono">${formatMoney(it.purchasePrice, purchase.currency)}</td>
                <td class="cell-mono">${it.discountPct}%</td>
                <td class="cell-mono">${it.taxPct}%</td>
                <td class="li-line-total">${formatMoney(it.lineTotal, purchase.currency)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Payment</div>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-item-label">Subtotal</span><span class="detail-item-value mono">${formatMoney(purchase.subtotal, purchase.currency)}</span></div>
        <div class="detail-item"><span class="detail-item-label">Discount</span><span class="detail-item-value mono">${formatMoney(purchase.discountTotal, purchase.currency)}</span></div>
        <div class="detail-item"><span class="detail-item-label">Tax</span><span class="detail-item-value mono">${formatMoney(purchase.taxTotal, purchase.currency)}</span></div>
        <div class="detail-item"><span class="detail-item-label">Grand Total</span><span class="detail-item-value mono">${formatMoney(purchase.grandTotal, purchase.currency)}</span></div>
        <div class="detail-item"><span class="detail-item-label">Amount Paid</span><span class="detail-item-value mono">${formatMoney(purchase.amountPaid, purchase.currency)}</span></div>
        <div class="detail-item"><span class="detail-item-label">Balance</span><span class="detail-item-value mono">${formatMoney(purchase.balance, purchase.currency)}</span></div>
        <div class="detail-item"><span class="detail-item-label">Payment Method</span><span class="detail-item-value">${escapeHtml(purchase.paymentMethod)}</span></div>
      </div>
    </div>
  `;

  const returnBtn = document.getElementById("openReturnBtn");
  const cancelBtn = document.getElementById("cancelPurchaseBtn");
  const editBtn = document.getElementById("editPurchaseBtn");
  const isCancelled = purchase.status === "Cancelled";
  const isFullyReturned = purchase.status === "Returned";

  returnBtn.style.display = (isCancelled || isFullyReturned) ? "none" : "inline-flex";
  cancelBtn.style.display = isCancelled ? "none" : "inline-flex";
  editBtn.style.display = isCancelled ? "none" : "inline-flex";

  openModal("purchaseDetailsModal");
}

/* ---------------------------------------------------------
   EDIT PAYMENT
   --------------------------------------------------------- */

document.getElementById("editPurchaseBtn").addEventListener("click", () => {
  if (!currentPurchaseForView) return;
  const p = currentPurchaseForView;
  const purchaseOrderValue = p.purchaseOrder || p.reference || "";
  document.getElementById("editPaymentPurchaseId").value = p.id;
  document.getElementById("editReference").value = purchaseOrderValue;
  document.getElementById("editAmountPaid").value = p.amountPaid;
  document.getElementById("editPaymentMethod").value = p.paymentMethod;
  updateEditPaymentStatus(p.grandTotal);
  openModal("editPaymentModal");
});

function updateEditPaymentStatus(grandTotal) {
  const paid = Number(document.getElementById("editAmountPaid").value) || 0;
  let status = "Unpaid";
  if (grandTotal > 0 && paid >= grandTotal) status = "Paid";
  else if (paid > 0) status = "Partially Paid";
  const pill = document.getElementById("editPaymentStatusPill");
  pill.textContent = status;
  pill.className = "status-pill " + paymentStatusClass(status);
}

function setupEditPaymentForm() {
  document.getElementById("editAmountPaid").addEventListener("input", () => {
    if (currentPurchaseForView) updateEditPaymentStatus(currentPurchaseForView.grandTotal);
  });

  document.getElementById("editPaymentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("editPaymentPurchaseId").value;
    const purchase = purchases.find(p => p.id === id);
    if (!purchase) return;

    const paidRow = document.getElementById("editAmountPaid").closest(".form-row");
    paidRow.classList.remove("invalid");

    const paid = round2(Number(document.getElementById("editAmountPaid").value) || 0);
    if (paid < 0 || paid > purchase.grandTotal) { paidRow.classList.add("invalid"); return; }

    const purchaseRef = getPurchaseDoc(purchase.id);
    const updatedPurchaseOrder = document.getElementById("editReference").value.trim();
    try {
      await updateDoc(purchaseRef, {
        reference: updatedPurchaseOrder,
        purchaseOrder: updatedPurchaseOrder,
        amountPaid: paid,
        balance: round2(purchase.grandTotal - paid),
        paymentMethod: document.getElementById("editPaymentMethod").value,
        paymentStatus: purchase.grandTotal > 0 && paid >= purchase.grandTotal ? "Paid" : (paid > 0 ? "Partially Paid" : "Unpaid"),
        updatedAt: nowISO()
      });

      closeModal();
      closeModal();
      showNotification("Payment details updated.", "fa-circle-check");
    } catch (err) {
      console.error('Could not update payment in Firestore:', err);
      showNotification('Could not update payment. Please try again.', 'fa-triangle-exclamation', true);
    }
  });
}

/* ---------------------------------------------------------
   CANCEL PURCHASE — BATCH-AWARE
   --------------------------------------------------------- */

function setupCancelFlow() {
  document.getElementById("cancelPurchaseBtn").addEventListener("click", () => {
    if (!currentPurchaseForView) return;
    pendingCancelId = currentPurchaseForView.id;
    openModal("cancelConfirmModal");
  });

  document.getElementById("confirmCancelBtn").addEventListener("click", async () => {
    if (!pendingCancelId) return;
    const purchase = purchases.find(p => p.id === pendingCancelId);
    if (!purchase) { closeModal(); return; }

    const user = auth.currentUser;
    if (!user) { showNotification('Not authenticated.', 'fa-triangle-exclamation', true); return; }

    try {
      // 1) Mark purchase as cancelled
      await updateDoc(getPurchaseDoc(purchase.id), {
        status: 'Cancelled',
        updatedAt: nowISO()
      });

      // 2) Reverse stock: batches if exists, else legacy decrement
      for (const item of purchase.items) {
        const stillHeld = Number(item.qty) - Number(item.returnedQty || 0);
        if (stillHeld <= 0) continue;

        const hasBatches = await productHasBatches(item.productId);

        if (hasBatches) {
          await decrementBatchesForPurchaseReturn(
            item.productId,
            stillHeld,
            item.batchNumber,
            item.expiryDate
          );
        } else {
          const product = products.find(p => p.id === item.productId);
          if (product) {
            const newStock = Math.max(0, (Number(product.stock) || 0) - stillHeld);
            await updateDoc(getProductDoc(item.productId), {
              stock: newStock,
              updatedAt: nowISO()
            });
            product.stock = newStock;
          }
        }
      }

      pendingCancelId = null;
      closeModal();
      closeModal();
      showNotification(`Purchase "${purchase.purchaseNumber}" cancelled.`, "fa-ban");
    } catch (err) {
      console.error('Could not cancel purchase:', err);
      showNotification('Could not cancel purchase. Please try again.', 'fa-triangle-exclamation', true);
    }
  });
}

/* ---------------------------------------------------------
   PURCHASE RETURNS — BATCH-AWARE
   --------------------------------------------------------- */

document.getElementById("openReturnBtn").addEventListener("click", () => {
  if (!currentPurchaseForView) return;
  closeModal();
  setTimeout(() => openReturnModal(currentPurchaseForView), 220);
});

function openReturnModal(purchase) {
  currentPurchaseForReturn = purchase;
  const body = document.getElementById("returnItemsBody");
  document.getElementById("returnReason").value = "";
  document.getElementById("returnForm").querySelectorAll(".form-row").forEach(r => r.classList.remove("invalid"));

  body.innerHTML = purchase.items.map((it, index) => {
    const returnable = it.qty - (it.returnedQty || 0);
    return `
      <tr data-index="${index}">
        <td><div class="li-product-name">${escapeHtml(it.name)}</div><div class="li-product-sku">${escapeHtml(it.sku)}</div></td>
        <td class="cell-mono">${it.qty}</td>
        <td class="cell-mono">${it.returnedQty || 0}</td>
        <td><input type="number" class="return-qty-input" min="0" max="${returnable}" step="1" value="0" data-max="${returnable}" data-price="${it.purchasePrice}"></td>
        <td class="return-refund-amount cell-mono">${formatMoney(0, purchase.currency)}</td>
      </tr>
    `;
  }).join("");

  body.querySelectorAll(".return-qty-input").forEach(input => {
    input.addEventListener("input", () => {
      let val = Number(input.value) || 0;
      const max = Number(input.dataset.max);
      if (val < 0) val = 0;
      if (val > max) val = max;
      input.value = val;
      const refund = round2(val * Number(input.dataset.price));
      input.closest("tr").querySelector(".return-refund-amount").textContent = formatMoney(refund, purchase.currency);
      updateReturnTotal();
    });
  });

  updateReturnTotal();
  openModal("returnModal");
}

function updateReturnTotal() {
  const rows = document.querySelectorAll("#returnItemsBody tr");
  let total = 0;
  rows.forEach(row => {
    const input = row.querySelector(".return-qty-input");
    const qty = Number(input.value) || 0;
    total += qty * Number(input.dataset.price);
  });
  document.getElementById("returnTotalRefund").textContent = formatMoney(round2(total), currentPurchaseForReturn?.currency);
}

function setupReturnForm() {
  document.getElementById("returnForm").addEventListener("submit", handleReturnSubmit);
}

async function handleReturnSubmit(e) {
  e.preventDefault();
  if (isSubmittingReturn) return;
  if (!currentPurchaseForReturn) return;

  const reasonEl = document.getElementById("returnReason");
  const reasonRow = reasonEl.closest(".form-row");
  reasonRow.classList.remove("invalid");

  const rows = Array.from(document.querySelectorAll("#returnItemsBody tr"));
  const returnItems = rows.map(row => {
    const index = Number(row.dataset.index);
    const qty = Number(row.querySelector(".return-qty-input").value) || 0;
    return { index, qty };
  }).filter(r => r.qty > 0);

  let valid = true;
  if (returnItems.length === 0) {
    showNotification("Enter a return quantity for at least one item.", "fa-triangle-exclamation", true);
    valid = false;
  }
  if (!reasonEl.value.trim()) { reasonRow.classList.add("invalid"); valid = false; }
  if (!valid) return;

  const submitBtn = document.getElementById("returnForm").querySelector("button[type='submit']");
  isSubmittingReturn = true;
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Processing...`;

  try {
    await processReturn(currentPurchaseForReturn, returnItems, reasonEl.value.trim());
    showNotification("Return processed and inventory updated.", "fa-circle-check");
    closeModal();
    renderStatistics();
    renderPurchasesTable();
  } catch (err) {
    console.error("Return failed:", err);
    showNotification(err.message || "Could not process return. Please try again.", "fa-triangle-exclamation", true);
  } finally {
    isSubmittingReturn = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Confirm Return";
  }
}

async function processReturn(purchase, returnItems, reason) {
  const affected = returnItems.map(ri => ({ ...ri, item: purchase.items[ri.index] }));

  affected.forEach(a => {
    const alreadyReturned = Number(a.item.returnedQty) || 0;
    const returnable = a.item.qty - alreadyReturned;
    if (a.qty > returnable) throw new Error(`Cannot return ${a.qty} of "${a.item.name}" — only ${returnable} returnable.`);
  });

  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');

  // 1) Update purchase doc + supplier balance
  try {
    await runTransaction(db, async (tx) => {
      const purchaseRef = getPurchaseDoc(purchase.id);
      const pSnap = await tx.get(purchaseRef);
      if (!pSnap.exists()) throw new Error('Purchase not found');
      const pData = pSnap.data();

      let totalRefund = 0;
      const returnLog = [];

      affected.forEach(r => {
        const item = pData.items[r.index];
        const alreadyReturned = Number(item.returnedQty) || 0;
        const newReturned = alreadyReturned + r.qty;
        item.returnedQty = newReturned;
        const refundAmount = round2(r.qty * item.purchasePrice);
        totalRefund += refundAmount;
        returnLog.push({ productId: item.productId, name: item.name, sku: item.sku, qty: r.qty, refundAmount });
      });

      const supplierRef = getSupplierDoc(purchase.supplierId);
      let supSnap = null;
      try {
        supSnap = await tx.get(supplierRef);
      } catch (e) {
        supSnap = null;
      }

      const newGrand = round2((Number(pData.grandTotal) || 0) - totalRefund);
      const newAmountPaid = Number(pData.amountPaid) || 0;
      const newBalance = round2(newGrand - newAmountPaid);
      const newPaymentStatus = newGrand > 0 && newAmountPaid >= newGrand ? 'Paid' : (newAmountPaid > 0 ? 'Partially Paid' : 'Unpaid');

      const totalPurchased = pData.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
      const totalReturnedNow = pData.items.reduce((s, it) => s + (Number(it.returnedQty) || 0), 0);
      const newStatus = totalReturnedNow >= totalPurchased ? 'Returned' : (totalReturnedNow > 0 ? 'Partially Returned' : (pData.status || 'Completed'));

      tx.update(purchaseRef, {
        items: pData.items,
        grandTotal: newGrand,
        balance: newBalance,
        paymentStatus: newPaymentStatus,
        status: newStatus,
        updatedAt: nowISO()
      });

      try {
        if (supSnap && supSnap.exists()) {
          const prev = Number(supSnap.data().balance || 0);
          const next = round2(prev - totalRefund);
          tx.update(supplierRef, { balance: next, updatedAt: nowISO() });
        } else {
          const sup = suppliers.find(s => s.id === purchase.supplierId);
          if (sup) { sup.balance = round2((Number(sup.balance) || 0) - totalRefund); saveSuppliers(); }
        }
      } catch (innerErr) {
        console.warn('Could not update supplier balance in Firestore for return:', innerErr);
      }
    });
  } catch (err) {
    console.error('Return transaction failed:', err);
    throw err;
  }

  // 2) Reverse stock: batches if exists, else legacy decrement
  for (const a of affected) {
    const item = purchase.items[a.index];
    const hasBatches = await productHasBatches(item.productId);

    if (hasBatches) {
      try {
        await decrementBatchesForPurchaseReturn(
          item.productId,
          a.qty,
          item.batchNumber,
          item.expiryDate
        );
      } catch (batchErr) {
        console.error('Batch decrement failed for', item.name, batchErr);
      }
    } else {
      const product = products.find(p => p.id === item.productId);
      if (product) {
        const newStock = Math.max(0, (Number(product.stock) || 0) - a.qty);
        try {
          await updateDoc(getProductDoc(item.productId), {
            stock: newStock,
            updatedAt: nowISO()
          });
          product.stock = newStock;
        } catch (stockErr) {
          console.warn('Could not update legacy product stock on return:', stockErr);
        }
      }
    }

    // Update local purchase item returnedQty
    item.returnedQty = (Number(item.returnedQty) || 0) + a.qty;
  }

  // 3) Local returns log
  const totalRefundLocal = affected.reduce((s, a) => s + round2(a.qty * purchase.items[a.index].purchasePrice), 0);
  returns.unshift({
    id: generateId('RET'),
    purchaseId: purchase.id,
    purchaseNumber: purchase.purchaseNumber,
    supplierId: purchase.supplierId,
    supplierName: purchase.supplierName,
    items: affected.map(a => ({ productId: a.item.productId, name: a.item.name, sku: a.item.sku, qty: a.qty, refundAmount: round2(a.qty * a.item.purchasePrice) })),
    totalRefund: round2(totalRefundLocal),
    reason,
    createdAt: nowISO()
  });
  saveReturns();
}