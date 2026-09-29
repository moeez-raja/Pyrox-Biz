/* =========================================================
   Pyrox Biz — Invoices Module
   Includes Excel-style custom columns for invoices
   ========================================================= */
import { db, auth } from "../js/firebase.js";
import { renderMetricCards } from "../js/metric-cards.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  orderBy,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

let currentUser = null;
let businessId = null;
let authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    businessId = user ? user.uid : null;
    resolve(user);
  });
});

function getBusinessId() {
  if (!businessId) throw new Error("No authenticated business context.");
  return businessId;
}

function bizCollection(name) {
  return collection(db, 'businesses', getBusinessId(), name);
}
function bizDoc(name, id) {
  return doc(db, 'businesses', getBusinessId(), name, id);
}

function invoicesCollection() { return bizCollection('invoices'); }
function invoiceDoc(id) { return bizDoc('invoices', id); }
function salesCollection() { return bizCollection('sales'); }
function saleDoc(id) { return bizDoc('sales', id); }
function purchasesCollection() { return bizCollection('purchases'); }
function purchaseDoc(id) { return bizDoc('purchases', id); }
function countersDoc(id) { return bizDoc('counters', id); }

const LS_PURCHASES = "moeezflow_purchases";
const LS_CUSTOMERS = "moeezflow_customers";
const LS_SUPPLIERS = "moeezflow_suppliers";

function readLocal(key) {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : [];
}
function writeLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

async function loadCustomersAndSuppliers() {
  customersCache = [];
  suppliersCache = [];

  try {
    if (!currentUser) return;
    const custQ = query(collection(db, 'customers'), where('ownerId', '==', currentUser.uid));
    const custSnap = await getDocs(custQ);
    customersCache = custSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn('Could not load customers from Firestore, falling back to localStorage:', err);
    customersCache = readLocal(LS_CUSTOMERS);
  }

  try {
    if (!currentUser) return;
    const suppQ = query(collection(db, 'suppliers'), where('ownerId', '==', currentUser.uid));
    const suppSnap = await getDocs(suppQ);
    suppliersCache = suppSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn('Could not load suppliers from Firestore, falling back to localStorage:', err);
    suppliersCache = readLocal(LS_SUPPLIERS);
  }
}

let invoicesCache = [];
let customersCache = [];
let suppliersCache = [];

let lineItems = [];
let selectedParty = null;
let manualInvoiceType = "Sales";
let editingInvoiceId = null;

// Excel-style custom columns for the current manual invoice
// Shape: [{ key: 'col_1', label: 'Batch No.' }, ...]
let customColumns = [];
let customColumnCounter = 0;

let pickerType = "sale";

let currentPage = 1;
const PAGE_SIZE = 10;

let searchQuery = "";
let filters = { type: "", paymentStatus: "", dateFrom: "", dateTo: "" };
let sortState = { field: "createdAt", dir: "desc" };

let isSubmittingManual = false;
let isGenerating = false;

let profileData = {};

async function initializeInvoices() {
  const emptyState = document.getElementById("emptyState");
  if (emptyState) {
    emptyState.style.display = 'none';
    emptyState.hidden = true;
  }

  setupSidebar();
  setupNavigation();
  setupToolbar();
  setupModals();
  setupManualInvoiceForm();
  setupGeneratePicker();
  setupAddColumnModal();

  document.getElementById("openManualInvoiceBtn").addEventListener("click", openManualInvoiceModal);
  document.getElementById("emptyStateAddBtn").addEventListener("click", openManualInvoiceModal);
  document.getElementById("openGeneratePickerBtn").addEventListener("click", openGeneratePickerModal);
  document.getElementById("printInvoiceBtn").addEventListener("click", () => {
    if (window.__currentViewedInvoice) printInvoice(window.__currentViewedInvoice);
  });

  await authReady;
  if (!currentUser) {
    showNotification("You must be signed in to view invoices.", "fa-lock", true);
    return;
  }

  await loadCustomersAndSuppliers();
  await loadProfileData();

  await loadInvoicesIntoCache();
  renderStatistics();
  renderInvoicesTable();

  await handleAutoGenerateFromUrl();
}

document.addEventListener("DOMContentLoaded", initializeInvoices);

async function loadProfileData() {
  try {
    const profileSnap = await getDoc(bizDoc("settings", "profile"));
    profileData = profileSnap.exists() ? profileSnap.data() : {};
  } catch (err) {
    console.error("Failed to load business profile:", err);
    profileData = {};
  }
}

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
function formatDate(value) {
  if (!value) return "—";
  const d = value.toDate ? value.toDate() : new Date(value);
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}
function todayInputValue() { return new Date().toISOString().slice(0, 10); }

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
function typeBadgeClass(type) { return type === "Purchase" ? "type-purchase" : "type-sales"; }

async function generateInvoiceNumber(tx, type) {
  const counterRef = countersDoc('invoices');
  const counterSnap = await tx.get(counterRef);
  const data = counterSnap.exists() ? counterSnap.data() : {};
  const field = type === "Purchase" ? "lastPurchaseInvoice" : "lastSalesInvoice";
  const nextSeq = (Number(data[field]) || 0) + 1;
  const prefix = type === "Purchase" ? "PINV-" : "INV-";
  const invoiceNumber = prefix + String(nextSeq).padStart(4, "0");
  tx.set(counterRef, { [field]: nextSeq, ownerId: currentUser ? currentUser.uid : null }, { merge: true });
  return invoiceNumber;
}

async function loadInvoicesIntoCache() {
  const loadingEl = document.getElementById("loadingState");
  loadingEl.hidden = false;
  try {
    let q;
    if (typeof bizCollection === 'function') {
      q = query(bizCollection("invoices"), orderBy("createdAt", "desc"));
    } else {
      q = query(invoicesCollection(), where('ownerId', '==', currentUser.uid), orderBy("createdAt", "desc"));
    }

    const snap = await getDocs(q);
    invoicesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("Failed to load invoices:", err);
    showNotification("Could not load invoices. Check your connection and try again.", "fa-triangle-exclamation", true);
  } finally {
    loadingEl.hidden = true;
  }
}

async function generateInvoiceFromSale(saleId) {
  const invoicesColRef = invoicesCollection();
  const newInvoiceRef = doc(invoicesColRef);

  const result = await runTransaction(db, async (tx) => {
    const candidateRefs = [doc(db, 'sales', saleId), saleDoc(saleId)];
    let saleSnap = null;
    let usedSaleRef = null;
    for (const r of candidateRefs) {
      try {
        saleSnap = await tx.get(r);
        if (saleSnap.exists()) { usedSaleRef = r; break; }
      } catch (e) { }
    }

    if (!saleSnap || !saleSnap.exists()) throw new Error('Sale no longer exists.');
    const sale = saleSnap.data();

    if (sale.invoiceId) {
      return { alreadyExists: true, invoiceId: sale.invoiceId };
    }

    const normalized = {
      subtotal: Number(sale.subtotal || 0),
      discountTotal: Number((sale.discountTotal != null) ? sale.discountTotal : ((sale.discount != null) ? sale.discount : 0)),
      taxTotal: Number((sale.taxTotal != null) ? sale.taxTotal : ((sale.tax != null) ? sale.tax : 0)),
      grandTotal: Number(sale.grandTotal != null ? sale.grandTotal : 0),
      amountPaid: Number(sale.amountPaid != null ? sale.amountPaid : 0),
      balance: (sale.balance != null) ? Number(sale.balance) : (Number(sale.grandTotal != null ? sale.grandTotal : 0) - Number(sale.amountPaid != null ? sale.amountPaid : 0)),
      paymentStatus: sale.paymentStatus || (Number(sale.amountPaid || 0) >= Number(sale.grandTotal || 0) && Number(sale.grandTotal || 0) > 0 ? 'Paid' : (Number(sale.amountPaid || 0) > 0 ? 'Partially Paid' : 'Unpaid')),
      paymentMethod: sale.paymentMethod || '',
      currency: sale.currency || 'PKR',
      reference: sale.reference ?? '',
      items: (Array.isArray(sale.items) ? sale.items : []).map(it => ({
        name: it.productName || it.name || '',
        sku: it.sku || '',
        qty: Number(it.quantity != null ? it.quantity : (it.qty != null ? it.qty : 0)),
        unitPrice: Number(it.unitPrice != null ? it.unitPrice : (it.purchasePrice != null ? it.purchasePrice : 0)),
        discountPct: Number(it.discountRate != null ? it.discountRate : (it.discountPct != null ? it.discountPct : 0)),
        taxPct: Number(it.taxRate != null ? it.taxRate : (it.taxPct != null ? it.taxPct : 0)),
        lineTotal: Number(it.total != null ? it.total : (it.lineTotal != null ? it.lineTotal : 0)),
        productId: it.productId || null
      })),
      sourceNumber: sale.saleNumber || ''
    };

    const invoiceNumber = await generateInvoiceNumber(tx, 'Sales');

    const invoiceData = {
      invoiceNumber,
      type: 'Sales',
      sourceCollection: usedSaleRef && usedSaleRef.path.includes('/businesses/') ? 'businesses_sales' : 'sales',
      sourceId: saleId,
      sourceNumber: normalized.sourceNumber,
      partyType: 'customer',
      partyId: sale.customerId || null,
      partyName: sale.customerName || '',
      date: sale.createdAt || serverTimestamp(),
      reference: normalized.reference,
      items: normalized.items,
      customColumns: [],
      subtotal: normalized.subtotal,
      discountTotal: normalized.discountTotal,
      taxTotal: normalized.taxTotal,
      grandTotal: normalized.grandTotal,
      amountPaid: normalized.amountPaid,
      balance: normalized.balance,
      paymentStatus: normalized.paymentStatus,
      paymentMethod: normalized.paymentMethod,
      currency: normalized.currency,
      manuallyCreated: false,
      ownerId: currentUser ? currentUser.uid : null,
      createdAt: serverTimestamp(),
      createdBy: currentUser ? currentUser.uid : null
    };

    tx.set(newInvoiceRef, invoiceData);
    tx.update(usedSaleRef, { invoiceId: newInvoiceRef.id, invoiceNumber, updatedAt: serverTimestamp() });

    return { alreadyExists: false, invoiceId: newInvoiceRef.id };
  });

  if (result.alreadyExists) {
    const existing = await getDoc(invoiceDoc(result.invoiceId));
    return { id: existing.id, ...existing.data() };
  }
  const created = await getDoc(invoiceDoc(result.invoiceId));
  return { id: created.id, ...created.data() };
}

async function generateInvoiceFromPurchase(purchaseId) {
  const invoicesColRef = invoicesCollection();
  const newInvoiceRef = doc(invoicesColRef);

  const result = await runTransaction(db, async (tx) => {
    const candidateRefs = [purchaseDoc(purchaseId), doc(db, 'purchases', purchaseId)];
    let purchaseSnap = null;
    let usedPurchaseRef = null;
    for (const r of candidateRefs) {
      try {
        purchaseSnap = await tx.get(r);
        if (purchaseSnap.exists()) { usedPurchaseRef = r; break; }
      } catch (e) { }
    }

    if (!purchaseSnap || !purchaseSnap.exists()) throw new Error('Purchase no longer exists.');
    const purchase = purchaseSnap.data();

    if (purchase.invoiceId) {
      return { alreadyExists: true, invoiceId: purchase.invoiceId };
    }

    const invoiceNumber = await generateInvoiceNumber(tx, 'Purchase');

    const normalizedItems = (purchase.items || []).map(it => ({
      productId: it.productId,
      name: it.name,
      sku: it.sku,
      unit: it.unit,
      qty: it.qty,
      unitPrice: it.purchasePrice,
      discountPct: it.discountPct,
      taxPct: it.taxPct,
      lineTotal: it.lineTotal
    }));

    const purchaseOrderValue = purchase.purchaseOrder || purchase.reference || '';

    const invoiceData = {
      invoiceNumber,
      type: 'Purchase',
      sourceCollection: usedPurchaseRef && usedPurchaseRef.path.includes('/businesses/') ? 'businesses_purchases' : 'purchases',
      sourceId: purchaseId,
      sourceNumber: purchase.purchaseNumber,
      partyType: 'supplier',
      partyId: purchase.supplierId,
      partyName: purchase.supplierName,
      date: purchase.date || purchase.createdAt,
      reference: purchaseOrderValue,
      purchaseOrder: purchaseOrderValue,
      items: normalizedItems,
      customColumns: [],
      subtotal: purchase.subtotal,
      discountTotal: purchase.discountTotal,
      taxTotal: purchase.taxTotal,
      grandTotal: purchase.grandTotal,
      amountPaid: purchase.amountPaid,
      balance: purchase.balance,
      paymentStatus: purchase.paymentStatus,
      paymentMethod: purchase.paymentMethod,
      currency: purchase.currency,
      manuallyCreated: false,
      ownerId: currentUser ? currentUser.uid : null,
      createdAt: serverTimestamp(),
      createdBy: currentUser ? currentUser.uid : null
    };

    tx.set(newInvoiceRef, invoiceData);
    tx.update(usedPurchaseRef, { invoiceId: newInvoiceRef.id, invoiceNumber, updatedAt: serverTimestamp() });

    return { alreadyExists: false, invoiceId: newInvoiceRef.id };
  });

  if (result.alreadyExists) {
    const existing = await getDoc(invoiceDoc(result.invoiceId));
    return { id: existing.id, ...existing.data() };
  }

  const created = await getDoc(invoiceDoc(result.invoiceId));
  return { id: created.id, ...created.data() };
}

async function handleAutoGenerateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const type = params.get("generate");
  const id = params.get("id");
  if (!type || !id) return;

  window.history.replaceState({}, "", window.location.pathname);

  if (isGenerating) return;
  isGenerating = true;

  try {
    let invoice;
    if (type === "sale") invoice = await generateInvoiceFromSale(id);
    else if (type === "purchase") invoice = await generateInvoiceFromPurchase(id);
    else return;

    if (invoice && !invoicesCache.find(i => i.id === invoice.id)) {
      invoicesCache.unshift(invoice);
    }
    renderStatistics();
    renderInvoicesTable();
    showNotification(`Invoice ${invoice.invoiceNumber} generated.`, "fa-circle-check");
    openViewInvoiceModal(invoice.id);
  } catch (err) {
    console.error("Auto-generate invoice failed:", err);
    showNotification(err.message || "Could not generate invoice.", "fa-triangle-exclamation", true);
  } finally {
    isGenerating = false;
  }
}

function calculateStatistics() {
  const total = invoicesCache.length;
  const salesCount = invoicesCache.filter(i => i.type === "Sales").length;
  const purchaseCount = invoicesCache.filter(i => i.type === "Purchase").length;
  const totalInvoiced = invoicesCache.reduce((sum, i) => sum + (Number(i.grandTotal) || 0), 0);
  const totalOutstanding = invoicesCache.reduce((sum, i) => sum + (Number(i.balance) || 0), 0);
  return { total, salesCount, purchaseCount, totalInvoiced, totalOutstanding };
}

function renderStatistics() {
  const grid = document.getElementById("statsGrid");
  if (!grid) return;
  const s = calculateStatistics();
  renderMetricCards(grid, [
    { label: "Total Invoices", icon: "fa-file-invoice-dollar", value: s.total.toLocaleString(), delta: { cls: "neutral", text: "—" }, foot: "all invoices" },
    { label: "Sales Invoices", icon: "fa-bag-shopping", value: s.salesCount.toLocaleString(), delta: { cls: "up", text: "Sales" }, foot: "issued to customers" },
    { label: "Purchase Invoices", icon: "fa-dolly", value: s.purchaseCount.toLocaleString(), delta: { cls: "neutral", text: "—" }, foot: "from suppliers" },
    { label: "Total Invoiced", icon: "fa-sack-dollar", value: formatMoney(s.totalInvoiced), delta: { cls: "neutral", text: "—" }, foot: "grand total" },
    { label: "Outstanding Balance", icon: "fa-hourglass-half", value: formatMoney(s.totalOutstanding), delta: { cls: s.totalOutstanding > 0 ? "down" : "up", text: s.totalOutstanding > 0 ? "Due" : "Clear" }, foot: "unpaid balances" }
  ]);
}

function setupToolbar() {
  document.getElementById("searchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    currentPage = 1;
    renderInvoicesTable();
  });
  document.getElementById("filterType").addEventListener("change", (e) => { filters.type = e.target.value; currentPage = 1; renderInvoicesTable(); });
  document.getElementById("filterPaymentStatus").addEventListener("change", (e) => { filters.paymentStatus = e.target.value; currentPage = 1; renderInvoicesTable(); });
  document.getElementById("filterDateFrom").addEventListener("change", (e) => { filters.dateFrom = e.target.value; currentPage = 1; renderInvoicesTable(); });
  document.getElementById("filterDateTo").addEventListener("change", (e) => { filters.dateTo = e.target.value; currentPage = 1; renderInvoicesTable(); });

  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    filters = { type: "", paymentStatus: "", dateFrom: "", dateTo: "" };
    searchQuery = "";
    document.getElementById("searchInput").value = "";
    document.getElementById("filterType").value = "";
    document.getElementById("filterPaymentStatus").value = "";
    document.getElementById("filterDateFrom").value = "";
    document.getElementById("filterDateTo").value = "";
    currentPage = 1;
    renderInvoicesTable();
  });

  document.getElementById("sortField").addEventListener("change", (e) => { sortState.field = e.target.value; currentPage = 1; renderInvoicesTable(); });
  document.getElementById("sortDirBtn").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const newDir = btn.dataset.dir === "asc" ? "desc" : "asc";
    btn.dataset.dir = newDir;
    sortState.dir = newDir;
    btn.innerHTML = `<i class="fas fa-arrow-${newDir === "asc" ? "down-short-wide" : "up-wide-short"}"></i>`;
    currentPage = 1;
    renderInvoicesTable();
  });
}

function getFilteredSortedInvoices() {
  let list = [...invoicesCache];

  if (searchQuery) {
    list = list.filter(i => [i.invoiceNumber, i.partyName].join(" ").toLowerCase().includes(searchQuery));
  }
  if (filters.type) list = list.filter(i => i.type === filters.type);
  if (filters.paymentStatus) list = list.filter(i => i.paymentStatus === filters.paymentStatus);
  if (filters.dateFrom) {
    const from = new Date(filters.dateFrom);
    list = list.filter(i => i.createdAt && (i.createdAt.toDate ? i.createdAt.toDate() : new Date(i.createdAt)) >= from);
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo); to.setHours(23, 59, 59, 999);
    list = list.filter(i => i.createdAt && (i.createdAt.toDate ? i.createdAt.toDate() : new Date(i.createdAt)) <= to);
  }

  const { field, dir } = sortState;
  list.sort((a, b) => {
    let av, bv;
    if (field === "createdAt") {
      av = a.createdAt ? (a.createdAt.toDate ? a.createdAt.toDate().getTime() : new Date(a.createdAt).getTime()) : 0;
      bv = b.createdAt ? (b.createdAt.toDate ? b.createdAt.toDate().getTime() : new Date(b.createdAt).getTime()) : 0;
    } else if (field === "invoiceNumber") {
      av = a.invoiceNumber || ""; bv = b.invoiceNumber || "";
      return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    } else {
      av = Number(a[field]) || 0; bv = Number(b[field]) || 0;
    }
    return dir === "asc" ? av - bv : bv - av;
  });

  return list;
}

function paginate(list) {
  const start = (currentPage - 1) * PAGE_SIZE;
  return list.slice(start, start + PAGE_SIZE);
}

function renderInvoicesTable() {
  const tbody = document.getElementById("invoicesTableBody");
  const table = document.getElementById("invoicesTable");
  const emptyState = document.getElementById("emptyState");
  const paginationEl = document.getElementById("pagination");
  const toolbarPanel = document.querySelector(".toolbar-panel");

  const filtered = getFilteredSortedInvoices();

  if (invoicesCache.length === 0) {
    if (table) { table.style.display = 'none'; table.hidden = true; }
    if (paginationEl) { paginationEl.style.display = 'none'; paginationEl.hidden = true; }
    if (toolbarPanel) { toolbarPanel.style.display = "none"; }
    if (emptyState) { emptyState.style.display = ''; emptyState.hidden = false; }
    document.getElementById("emptyStateTitle").textContent = "No invoices yet";
    document.getElementById("emptyStateText").textContent = "Create a manual invoice, or generate one from an existing sale or purchase.";
    document.getElementById("emptyStateAddBtn").hidden = false;
    tbody.innerHTML = "";
    renderStatistics();
    return;
  }

  if (toolbarPanel) { toolbarPanel.style.display = ""; }

  if (filtered.length === 0) {
    if (table) { table.style.display = 'none'; table.hidden = true; }
    if (paginationEl) { paginationEl.style.display = 'none'; paginationEl.hidden = true; }
    if (emptyState) { emptyState.style.display = ''; emptyState.hidden = false; }
    document.getElementById("emptyStateTitle").textContent = "No matching invoices";
    document.getElementById("emptyStateText").textContent = "Try adjusting your search or filters.";
    document.getElementById("emptyStateAddBtn").hidden = true;
    tbody.innerHTML = "";
    renderStatistics();
    return;
  }

  if (emptyState) { emptyState.style.display = 'none'; emptyState.hidden = true; }
  if (table) { table.style.display = ''; table.hidden = false; }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const pageItems = paginate(filtered);

  tbody.innerHTML = pageItems.map(inv => `
    <tr data-id="${inv.id}">
      <td class="cell-mono">${escapeHtml(inv.invoiceNumber)}</td>
      <td><span class="type-badge ${typeBadgeClass(inv.type)}">${inv.type === "Purchase" ? "Purchase" : "Sales"}</span></td>
      <td>${escapeHtml(inv.partyName)}</td>
      <td class="cell-muted">${formatDate(inv.date || inv.createdAt)}</td>
      <td class="cell-mono">${formatMoney(inv.grandTotal, inv.currency)}</td>
      <td class="cell-mono">${formatMoney(inv.amountPaid, inv.currency)}</td>
      <td class="cell-mono">${formatMoney(inv.balance, inv.currency)}</td>
      <td><span class="status-pill ${paymentStatusClass(inv.paymentStatus)}">${inv.paymentStatus}</span></td>
      <td>
        <div class="row-actions">
          <button class="row-action-btn" data-action="view" data-id="${inv.id}" aria-label="View invoice"><i class="fas fa-eye"></i></button>
          <button class="row-action-btn" data-action="edit" data-id="${inv.id}" aria-label="Edit invoice"><i class="fas fa-pen"></i></button>
          <button class="row-action-btn" data-action="print" data-id="${inv.id}" aria-label="Print invoice"><i class="fas fa-print"></i></button>
          <button class="row-action-btn" data-action="delete" data-id="${inv.id}" aria-label="Delete invoice"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll("[data-action='view']").forEach(btn => btn.addEventListener("click", () => openViewInvoiceModal(btn.dataset.id)));
  tbody.querySelectorAll("[data-action='edit']").forEach(btn => btn.addEventListener("click", () => openEditInvoiceModal(btn.dataset.id)));
  tbody.querySelectorAll("[data-action='print']").forEach(btn => btn.addEventListener("click", () => {
    const inv = invoicesCache.find(i => i.id === btn.dataset.id);
    if (inv) printInvoice(inv);
  }));
  tbody.querySelectorAll("[data-action='delete']").forEach(btn => btn.addEventListener("click", () => deleteInvoice(btn.dataset.id)));

  renderPagination(filtered.length, totalPages);
  renderStatistics();
}

function renderPagination(totalItems, totalPages) {
  const paginationEl = document.getElementById("pagination");
  const info = document.getElementById("paginationInfo");
  const controls = document.getElementById("paginationControls");

  if (paginationEl) { paginationEl.style.display = ''; paginationEl.hidden = false; }

  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, totalItems);
  info.textContent = `Showing ${start}–${end} of ${totalItems} invoices`;

  let html = `<button class="page-btn" id="prevPageBtn" ${currentPage === 1 ? "disabled" : ""}><i class="fas fa-chevron-left"></i></button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 1) {
      html += `<button class="page-btn ${i === currentPage ? "active" : ""}" data-page="${i}">${i}</button>`;
    } else if (Math.abs(i - currentPage) === 2) {
      html += `<span style="color:var(--gray-500); padding:0 4px;">…</span>`;
    }
  }
  html += `<button class="page-btn" id="nextPageBtn" ${currentPage === totalPages ? "disabled" : ""}><i class="fas fa-chevron-right"></i></button>`;
  controls.innerHTML = html;

  const prevBtn = document.getElementById("prevPageBtn");
  const nextBtn = document.getElementById("nextPageBtn");
  if (prevBtn) prevBtn.addEventListener("click", () => { currentPage--; renderInvoicesTable(); });
  if (nextBtn) nextBtn.addEventListener("click", () => { currentPage++; renderInvoicesTable(); });
  controls.querySelectorAll("[data-page]").forEach(btn => btn.addEventListener("click", () => { currentPage = Number(btn.dataset.page); renderInvoicesTable(); }));
}

let activeModalId = null;
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
  overlay.classList.remove("open");
  setTimeout(() => { modal.hidden = true; }, 220);
  activeModalId = null;
}

/* =========================================================
   CUSTOM COLUMNS (Excel-style)
   ========================================================= */

function setupAddColumnModal() {
  const openBtn = document.getElementById("addColumnBtn");
  const form = document.getElementById("addColumnForm");
  const nameInput = document.getElementById("customColumnName");
  if (!openBtn || !form || !nameInput) return;

  openBtn.addEventListener("click", () => {
    nameInput.value = "";
    nameInput.closest(".form-row").classList.remove("invalid");
    openModal("addColumnModal");
    setTimeout(() => nameInput.focus(), 240);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.closest(".form-row").classList.add("invalid");
      return;
    }
    if (customColumns.some(c => c.label.toLowerCase() === name.toLowerCase())) {
      showNotification("A column with that name already exists.", "fa-triangle-exclamation", true);
      return;
    }
    customColumnCounter++;
    const key = "col_" + customColumnCounter;
    customColumns.push({ key, label: name });
    lineItems.forEach(li => { if (!li.custom) li.custom = {}; li.custom[key] = ""; });
    closeModal();
    renderLineItemsHeader();
    renderLineItems();
    showNotification(`Column "${name}" added.`, "fa-circle-check");
  });
}

function removeCustomColumn(key) {
  customColumns = customColumns.filter(c => c.key !== key);
  lineItems.forEach(li => { if (li.custom) delete li.custom[key]; });
  renderLineItemsHeader();
  renderLineItems();
}

function renderLineItemsHeader() {
  const head = document.getElementById("lineItemsHead");
  if (!head) return;

  const customThs = customColumns.map(c => `
    <th class="li-custom">
      <span class="th-inner">
        ${escapeHtml(c.label)}
        <button type="button" class="th-remove" data-remove-col="${c.key}" title="Remove column" aria-label="Remove column">
          <i class="fas fa-xmark"></i>
        </button>
      </span>
    </th>
  `).join("");

  head.innerHTML = `
    <tr>
      <th class="li-product">Item / Description</th>
      <th class="li-qty">Qty</th>
      <th class="li-price">Unit Price</th>
      <th class="li-discount">Discount %</th>
      <th class="li-tax">Tax %</th>
      ${customThs}
      <th class="li-total">Line Total</th>
      <th class="li-remove"></th>
    </tr>
  `;

  head.querySelectorAll("[data-remove-col]").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.removeCol;
      const col = customColumns.find(c => c.key === key);
      if (!col) return;
      if (!confirm(`Remove column "${col.label}"? Any values entered will be lost.`)) return;
      removeCustomColumn(key);
    });
  });
}

/* =========================================================
   MANUAL INVOICE FORM
   ========================================================= */

function setupManualInvoiceForm() {
  document.querySelectorAll("#invoiceTypeToggle .type-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#invoiceTypeToggle .type-toggle-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      manualInvoiceType = btn.dataset.type;
      updatePartyLabels();
      clearSelectedParty();
    });
  });

  const partyInput = document.getElementById("partySearch");
  const resultsEl = document.getElementById("partyResults");

  partyInput.addEventListener("input", () => {
    const q = partyInput.value.trim().toLowerCase();
    document.getElementById("selectedPartyId").value = "";
    document.getElementById("selectedPartyChip").hidden = true;
    if (!q) { resultsEl.hidden = true; return; }

    const source = manualInvoiceType === "Purchase" ? suppliersCache : customersCache;
    const matches = source.filter(p => (p.name || "").toLowerCase().includes(q) || (p.phone || "").includes(q)).slice(0, 8);

    resultsEl.innerHTML = matches.length
      ? matches.map(p => `<div class="combo-item" data-id="${p.id}"><div>${escapeHtml(p.name)}</div><div class="combo-item-sub">${escapeHtml(p.phone || "")}</div></div>`).join("")
      : `<div class="combo-empty">No matches found.</div>`;
    resultsEl.hidden = false;

    resultsEl.querySelectorAll(".combo-item").forEach(item => {
      item.addEventListener("click", () => {
        const p = source.find(x => x.id === item.dataset.id);
        selectParty(p);
        resultsEl.hidden = true;
      });
    });
  });

  document.addEventListener("click", (e) => {
    if (!partyInput.contains(e.target) && !resultsEl.contains(e.target)) resultsEl.hidden = true;
  });

  document.getElementById("addLineBtn").addEventListener("click", () => {
    const item = { name: "", qty: 1, unitPrice: 0, discountPct: 0, taxPct: 0, custom: {} };
    customColumns.forEach(c => { item.custom[c.key] = ""; });
    lineItems.push(item);
    renderLineItems();
  });

  document.getElementById("fAmountPaid").addEventListener("input", updatePaymentSummary);
  document.getElementById("manualInvoiceForm").addEventListener("submit", handleManualInvoiceSubmit);

  renderLineItemsHeader();
}

function updatePartyLabels() {
  const isPurchase = manualInvoiceType === "Purchase";
  document.getElementById("partySectionTitle").textContent = isPurchase ? "Supplier" : "Customer";
  document.getElementById("partySearchLabel").innerHTML = (isPurchase ? "Supplier" : "Customer") + ' <span class="req">*</span>';
  document.getElementById("partySearch").placeholder = `Search ${isPurchase ? "supplier" : "customer"} by name or phone...`;
}

function selectParty(party) {
  selectedParty = party;
  document.getElementById("selectedPartyId").value = party.id;
  document.getElementById("partySearch").value = "";
  const chip = document.getElementById("selectedPartyChip");
  chip.hidden = false;
  chip.innerHTML = `<i class="fas fa-user"></i> ${escapeHtml(party.name)} <button type="button" id="clearPartyBtn" aria-label="Clear">&times;</button>`;
  document.getElementById("clearPartyBtn").addEventListener("click", clearSelectedParty);
}

function clearSelectedParty() {
  selectedParty = null;
  document.getElementById("selectedPartyId").value = "";
  document.getElementById("selectedPartyChip").hidden = true;
  document.getElementById("partySearch").value = "";
}

function openManualInvoiceModal() {
  editingInvoiceId = null;
  resetManualInvoiceForm();
  openModal("manualInvoiceModal");
}

async function openEditInvoiceModal(id) {
  try {
    const snap = await getDoc(invoiceDoc(id));
    if (!snap.exists()) { showNotification('Invoice not found.', 'fa-triangle-exclamation', true); return; }
    const inv = snap.data();
    editingInvoiceId = id;
    manualInvoiceType = inv.type || 'Sales';
    document.querySelectorAll("#invoiceTypeToggle .type-toggle-btn").forEach(b => b.classList.toggle('active', b.dataset.type === manualInvoiceType));
    updatePartyLabels();
    const partySource = manualInvoiceType === 'Purchase' ? suppliersCache : customersCache;
    const party = partySource.find(p => p.id === inv.partyId) || { id: inv.partyId || '', name: inv.partyName || '' };
    selectParty(party);
    document.getElementById('fInvoiceDate').value = inv.date ? (inv.date.toDate ? inv.date.toDate().toISOString().slice(0,10) : new Date(inv.date).toISOString().slice(0,10)) : todayInputValue();
    document.getElementById('fReference').value = inv.reference || '';

    customColumns = Array.isArray(inv.customColumns) ? inv.customColumns.map(c => ({ key: c.key, label: c.label })) : [];
    customColumnCounter = 0;
    customColumns.forEach(c => {
      const m = /^col_(\d+)$/.exec(c.key);
      if (m) customColumnCounter = Math.max(customColumnCounter, Number(m[1]));
    });

    lineItems = (inv.items || []).map(it => ({
      name: it.name || it.productName || '',
      qty: Number(it.qty || it.quantity || 0),
      unitPrice: Number(it.unitPrice || 0),
      discountPct: Number(it.discountPct || it.discountRate || 0),
      taxPct: Number(it.taxPct || it.taxRate || 0),
      custom: it.custom ? { ...it.custom } : {}
    }));
    lineItems.forEach(li => {
      if (!li.custom) li.custom = {};
      customColumns.forEach(c => { if (li.custom[c.key] == null) li.custom[c.key] = ""; });
    });

    renderLineItemsHeader();
    renderLineItems();
    document.getElementById('fPaymentMethod').value = inv.paymentMethod || '';
    document.getElementById('fAmountPaid').value = Number(inv.amountPaid || 0);
    document.getElementById('manualInvoiceSubmitBtn').textContent = 'Save Changes';
    openModal('manualInvoiceModal');
  } catch (err) {
    console.error('Open edit invoice failed:', err);
    showNotification(err.message || 'Could not open invoice for editing.', 'fa-triangle-exclamation', true);
  }
}

function resetManualInvoiceForm() {
  document.getElementById("manualInvoiceForm").reset();
  document.getElementById("manualInvoiceForm").querySelectorAll(".form-row").forEach(r => r.classList.remove("invalid"));
  manualInvoiceType = "Sales";
  document.querySelectorAll("#invoiceTypeToggle .type-toggle-btn").forEach(b => b.classList.toggle("active", b.dataset.type === "Sales"));
  updatePartyLabels();
  clearSelectedParty();
  document.getElementById("fInvoiceDate").value = todayInputValue();
  lineItems = [];
  customColumns = [];
  customColumnCounter = 0;
  renderLineItemsHeader();
  renderLineItems();
  document.getElementById("manualInvoiceSubmitBtn").disabled = false;
  document.getElementById("manualInvoiceSubmitBtn").textContent = "Generate Invoice";
}

function calculateLineTotal(item) {
  const gross = item.qty * item.unitPrice;
  const afterDiscount = gross - (gross * (item.discountPct / 100));
  const withTax = afterDiscount + (afterDiscount * (item.taxPct / 100));
  return round2(withTax);
}

function renderLineItems() {
  const body = document.getElementById("lineItemsBody");
  const emptyEl = document.getElementById("lineItemsEmpty");

  if (lineItems.length === 0) {
    body.innerHTML = "";
    emptyEl.classList.add("show");
    updatePaymentSummary();
    return;
  }
  emptyEl.classList.remove("show");

  body.innerHTML = lineItems.map((item, index) => {
    const lineTotal = calculateLineTotal(item);
    const customCells = customColumns.map(c => `
      <td class="li-custom">
        <input type="text" value="${escapeHtml(item.custom?.[c.key] || "")}" data-custom-column="${c.key}" data-index="${index}" placeholder="">
      </td>
    `).join("");
    return `
      <tr data-index="${index}">
        <td><input type="text" value="${escapeHtml(item.name)}" data-field="name" placeholder="Item name"></td>
        <td><input type="number" min="1" step="1" value="${item.qty}" data-field="qty"></td>
        <td><input type="number" min="0" step="0.01" value="${item.unitPrice}" data-field="unitPrice"></td>
        <td><input type="number" min="0" max="100" step="0.01" value="${item.discountPct}" data-field="discountPct"></td>
        <td><input type="number" min="0" step="0.01" value="${item.taxPct}" data-field="taxPct"></td>
        ${customCells}
        <td class="li-line-total">${formatMoney(lineTotal)}</td>
        <td><button type="button" class="li-remove-btn" aria-label="Remove"><i class="fas fa-trash"></i></button></td>
      </tr>
    `;
  }).join("");

  body.querySelectorAll("tr").forEach(row => {
    const index = Number(row.dataset.index);
    row.querySelectorAll("input[data-field]").forEach(input => {
      input.addEventListener("input", () => {
        const field = input.dataset.field;
        if (field === "name") {
          lineItems[index].name = input.value;
          return;
        }
        let value = Number(input.value);
        if (isNaN(value) || value < 0) value = 0;
        if (field === "qty" && value < 1) value = 1;
        if (field === "discountPct" && value > 100) value = 100;
        lineItems[index][field] = value;
        row.querySelector(".li-line-total").textContent = formatMoney(calculateLineTotal(lineItems[index]));
        updatePaymentSummary();
      });
    });
    row.querySelectorAll("input[data-custom-column]").forEach(input => {
      input.addEventListener("input", () => {
        const key = input.dataset.customColumn;
        if (!lineItems[index].custom) lineItems[index].custom = {};
        lineItems[index].custom[key] = input.value;
      });
    });
    row.querySelector(".li-remove-btn").addEventListener("click", () => {
      lineItems.splice(index, 1);
      renderLineItems();
    });
  });

  updatePaymentSummary();
}

function calculateInvoiceTotals() {
  let subtotal = 0, discountTotal = 0, taxTotal = 0;
  lineItems.forEach(item => {
    const gross = item.qty * item.unitPrice;
    const discountAmt = gross * (item.discountPct / 100);
    const afterDiscount = gross - discountAmt;
    const taxAmt = afterDiscount * (item.taxPct / 100);
    subtotal += gross; discountTotal += discountAmt; taxTotal += taxAmt;
  });
  const grandTotal = round2(subtotal - discountTotal + taxTotal);
  return { subtotal: round2(subtotal), discountTotal: round2(discountTotal), taxTotal: round2(taxTotal), grandTotal };
}

function updatePaymentSummary() {
  const totals = calculateInvoiceTotals();
  document.getElementById("totalSubtotal").textContent = formatMoney(totals.subtotal);
  document.getElementById("totalDiscount").textContent = formatMoney(totals.discountTotal);
  document.getElementById("totalTax").textContent = formatMoney(totals.taxTotal);
  document.getElementById("totalGrand").textContent = formatMoney(totals.grandTotal);

  const paidInput = document.getElementById("fAmountPaid");
  let paid = Number(paidInput.value) || 0;
  if (paid < 0) paid = 0;
  if (paid > totals.grandTotal) paid = totals.grandTotal;

  const balance = round2(totals.grandTotal - paid);
  document.getElementById("balanceDisplay").textContent = formatMoney(balance);

  let status = "Unpaid";
  if (totals.grandTotal > 0 && paid >= totals.grandTotal) status = "Paid";
  else if (paid > 0) status = "Partially Paid";

  const pill = document.getElementById("paymentStatusPill");
  pill.textContent = status;
  pill.className = "status-pill " + paymentStatusClass(status);
}

function validateManualInvoiceForm() {
  let valid = true;
  const partyRow = document.getElementById("partySearch").closest(".form-row");
  const paidRow = document.getElementById("fAmountPaid").closest(".form-row");
  partyRow.classList.remove("invalid");
  paidRow.classList.remove("invalid");

  if (!document.getElementById("selectedPartyId").value) { partyRow.classList.add("invalid"); valid = false; }
  if (lineItems.length === 0) { showNotification("Add at least one item before generating the invoice.", "fa-triangle-exclamation", true); valid = false; }

  const invalidItem = lineItems.find(li => !li.name.trim() || li.qty < 1 || li.unitPrice < 0 || li.discountPct < 0 || li.taxPct < 0);
  if (invalidItem) { showNotification("Every item needs a name and valid quantity/price.", "fa-triangle-exclamation", true); valid = false; }

  const totals = calculateInvoiceTotals();
  const paid = Number(document.getElementById("fAmountPaid").value) || 0;
  if (paid < 0 || paid > totals.grandTotal) { paidRow.classList.add("invalid"); valid = false; }

  return valid;
}

async function handleManualInvoiceSubmit(e) {
  e.preventDefault();
  if (isSubmittingManual) return;
  if (!validateManualInvoiceForm()) return;

  const submitBtn = document.getElementById("manualInvoiceSubmitBtn");
  isSubmittingManual = true;
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Saving...`;

  try {
    const totals = calculateInvoiceTotals();
    const amountPaid = round2(Number(document.getElementById("fAmountPaid").value) || 0);
    const balance = round2(totals.grandTotal - amountPaid);
    let paymentStatus = "Unpaid";
    if (totals.grandTotal > 0 && amountPaid >= totals.grandTotal) paymentStatus = "Paid";
    else if (amountPaid > 0) paymentStatus = "Partially Paid";

    const itemsSnapshot = lineItems.map(li => {
      const base = {
        name: li.name,
        qty: li.qty,
        unitPrice: li.unitPrice,
        discountPct: li.discountPct,
        taxPct: li.taxPct,
        lineTotal: calculateLineTotal(li)
      };
      if (customColumns.length && li.custom) {
        base.custom = {};
        customColumns.forEach(c => { base.custom[c.key] = li.custom[c.key] || ""; });
      }
      return base;
    });

    const invoicesColRef = bizCollection("invoices");
    const newInvoiceRef = doc(invoicesColRef);

    const invoiceNumber = await runTransaction(db, async (tx) => generateInvoiceNumber(tx, manualInvoiceType));

    const invoiceData = {
      invoiceNumber,
      type: manualInvoiceType,
      sourceCollection: null,
      sourceId: null,
      sourceNumber: null,
      partyType: manualInvoiceType === "Purchase" ? "supplier" : "customer",
      partyId: selectedParty.id,
      partyName: selectedParty.name,
      date: document.getElementById("fInvoiceDate").value,
      reference: document.getElementById("fReference").value.trim(),
      items: itemsSnapshot,
      customColumns: customColumns.map(c => ({ key: c.key, label: c.label })),
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      amountPaid,
      balance,
      paymentStatus,
      paymentMethod: document.getElementById("fPaymentMethod").value,
      currency: "PKR",
      manuallyCreated: true,
      ownerId: currentUser.uid,
      businessId: getBusinessId(),
      createdAt: serverTimestamp(),
      createdBy: currentUser.uid
    };

    if (editingInvoiceId) {
      const invRef = invoiceDoc(editingInvoiceId);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(invRef);
        if (!snap.exists()) throw new Error('Invoice no longer exists.');
        tx.update(invRef, Object.assign({}, invoiceData, { updatedAt: serverTimestamp(), invoiceNumber: snap.data().invoiceNumber }));
      });

      const updatedSnap = await getDoc(invoiceDoc(editingInvoiceId));
      if (updatedSnap.exists()) {
        const idx = invoicesCache.findIndex(i => i.id === updatedSnap.id);
        if (idx >= 0) invoicesCache[idx] = { id: updatedSnap.id, ...updatedSnap.data() };
        else invoicesCache.unshift({ id: updatedSnap.id, ...updatedSnap.data() });
      }

      showNotification('Invoice saved.', 'fa-circle-check');
      closeModal();
      editingInvoiceId = null;
      renderStatistics(); renderInvoicesTable();
      openViewInvoiceModal(updatedSnap.id);
    } else {
      await runTransaction(db, async (tx) => { tx.set(newInvoiceRef, invoiceData); });

      showNotification(`Invoice ${invoiceNumber} generated.`, "fa-circle-check");
      closeModal();
      const created = await getDoc(invoiceDoc(newInvoiceRef.id));
      if (created.exists() && !invoicesCache.find(i => i.id === created.id)) {
        invoicesCache.unshift({ id: created.id, ...created.data() });
      }
      renderStatistics();
      renderInvoicesTable();
      openViewInvoiceModal(created.id);
    }
  } catch (err) {
    console.error("Manual invoice failed:", err);
    showNotification(err.message || "Could not generate invoice. Please try again.", "fa-triangle-exclamation", true);
  } finally {
    isSubmittingManual = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Generate Invoice";
  }
}

async function deleteInvoice(id) {
  if (!confirm('Are you sure you want to delete this invoice? This action cannot be undone.')) return;
  try {
    const invSnap = await getDoc(invoiceDoc(id));
    if (!invSnap.exists()) { showNotification('Invoice not found.', 'fa-triangle-exclamation', true); return; }
    const inv = invSnap.data();

    await runTransaction(db, async (tx) => {
      const invRef = invoiceDoc(id);
      const current = await tx.get(invRef);
      if (!current.exists()) throw new Error('Invoice no longer exists.');

      if (inv.sourceCollection && inv.sourceId) {
        if (inv.sourceCollection === 'sales' || inv.sourceCollection === 'businesses_sales') {
          const candidateRefs = [doc(db, 'sales', inv.sourceId), saleDoc(inv.sourceId)];
          for (const r of candidateRefs) {
            try {
              const snap = await tx.get(r);
              if (snap.exists()) {
                tx.update(r, { invoiceId: null, invoiceNumber: null, updatedAt: serverTimestamp() });
                break;
              }
            } catch (e) { }
          }
        }

        if (inv.sourceCollection === 'purchases' || inv.sourceCollection === 'businesses_purchases') {
          const candidateRefs = [purchaseDoc(inv.sourceId), doc(db, 'purchases', inv.sourceId)];
          for (const r of candidateRefs) {
            try {
              const snap = await tx.get(r);
              if (snap.exists()) {
                tx.update(r, { invoiceId: null, invoiceNumber: null, updatedAt: serverTimestamp() });
                break;
              }
            } catch (e) { }
          }
        }
      }

      tx.delete(invRef);
    });

    if (inv.sourceCollection === 'purchases' && inv.sourceId) {
      const purchases = readLocal(LS_PURCHASES);
      const idx = purchases.findIndex(p => p.id === inv.sourceId);
      if (idx >= 0) {
        purchases[idx].invoiceId = null;
        purchases[idx].invoiceNumber = null;
        writeLocal(LS_PURCHASES, purchases);
      }
    }

    invoicesCache = invoicesCache.filter(i => i.id !== id);
    renderStatistics(); renderInvoicesTable();
    showNotification('Invoice deleted.', 'fa-circle-check');
  } catch (err) {
    console.error('Delete invoice failed:', err);
    showNotification(err.message || 'Could not delete invoice.', 'fa-triangle-exclamation', true);
  }
}

function setupGeneratePicker() {
  document.querySelectorAll("#pickerTypeToggle .type-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#pickerTypeToggle .type-toggle-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      pickerType = btn.dataset.pickerType;
      renderPickerList();
    });
  });
  document.getElementById("pickerSearch").addEventListener("input", renderPickerList);
}

async function openGeneratePickerModal() {
  document.getElementById("pickerSearch").value = "";
  pickerType = "sale";
  document.querySelectorAll("#pickerTypeToggle .type-toggle-btn").forEach(b => b.classList.toggle("active", b.dataset.pickerType === "sale"));
  openModal("generatePickerModal");
  await renderPickerList();
}

async function renderPickerList() {
  const listEl = document.getElementById("pickerList");
  listEl.innerHTML = `<div class="picker-empty"><span class="module-spinner" aria-hidden="true"></span> Loading...</div>`;
  const q = document.getElementById("pickerSearch").value.trim().toLowerCase();

  if (pickerType === "sale") {
    let sales = [];
    try {
      const snap = await getDocs(bizCollection("sales"));
      sales = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => !s.invoiceId);
    } catch (err) {
      console.error(err);
      listEl.innerHTML = `<div class="picker-empty">Could not load sales.</div>`;
      return;
    }
    if (q) sales = sales.filter(s => [s.saleNumber, s.customerName].join(" ").toLowerCase().includes(q));

    if (sales.length === 0) {
      listEl.innerHTML = `<div class="picker-empty">No un-invoiced sales found.</div>`;
      return;
    }

    listEl.innerHTML = sales.map(s => `
      <div class="picker-item" data-id="${s.id}">
        <div>
          <div class="picker-item-name">${escapeHtml(s.saleNumber)} — ${escapeHtml(s.customerName)}</div>
          <div class="picker-item-sub">${formatDate(s.createdAt)}</div>
        </div>
        <div class="picker-item-amount">${formatMoney(s.grandTotal, s.currency)}</div>
      </div>
    `).join("");

    listEl.querySelectorAll(".picker-item").forEach(item => {
      item.addEventListener("click", async () => {
        closeModal();
        try {
          const invoice = await generateInvoiceFromSale(item.dataset.id);
          if (invoice && !invoicesCache.find(i => i.id === invoice.id)) {
            invoicesCache.unshift(invoice);
          }
          renderStatistics(); renderInvoicesTable();
          showNotification(`Invoice ${invoice.invoiceNumber} generated.`, "fa-circle-check");
          openViewInvoiceModal(invoice.id);
        } catch (err) {
          showNotification(err.message || "Could not generate invoice.", "fa-triangle-exclamation", true);
        }
      });
    });
  } else {
    let purchases = readLocal(LS_PURCHASES).filter(p => !p.invoiceId && p.status !== "Cancelled");
    if (q) purchases = purchases.filter(p => [p.purchaseNumber, p.supplierName].join(" ").toLowerCase().includes(q));

    if (purchases.length === 0) {
      listEl.innerHTML = `<div class="picker-empty">No un-invoiced purchases found.</div>`;
      return;
    }

    listEl.innerHTML = purchases.map(p => `
      <div class="picker-item" data-id="${p.id}">
        <div>
          <div class="picker-item-name">${escapeHtml(p.purchaseNumber)} — ${escapeHtml(p.supplierName)}</div>
          <div class="picker-item-sub">${formatDate(p.date)}</div>
        </div>
        <div class="picker-item-amount">${formatMoney(p.grandTotal, p.currency)}</div>
      </div>
    `).join("");

    listEl.querySelectorAll(".picker-item").forEach(item => {
      item.addEventListener("click", async () => {
        closeModal();
        try {
          const invoice = await generateInvoiceFromPurchase(item.dataset.id);
          if (invoice && !invoicesCache.find(i => i.id === invoice.id)) {
            invoicesCache.unshift(invoice);
          }
          renderStatistics(); renderInvoicesTable();
          showNotification(`Invoice ${invoice.invoiceNumber} generated.`, "fa-circle-check");
          openViewInvoiceModal(invoice.id);
        } catch (err) {
          showNotification(err.message || "Could not generate invoice.", "fa-triangle-exclamation", true);
        }
      });
    });
  }
}

function getPartyDetail(invoice) {
  const source = invoice.partyType === "supplier" ? suppliersCache : customersCache;
  const party = source.find(p => p.id === invoice.partyId);
  if (!party) return { phone: "", address: "", email: "", taxNumber: "" };
  return {
    phone: party.phone || "",
    address: [party.address, party.city].filter(Boolean).join(", "),
    email: party.email || "",
    taxNumber: party.taxNumber || party.ntn || party.taxId || ""
  };
}

/* =========================================================
   PYROX BIZ — INVOICE TEMPLATE (CLEAN CLASSIC LAYOUT + SIGNATURE)
   ========================================================= */
function renderInvoiceTemplate(invoice) {
  const isPurchase = invoice.type === "Purchase";
  const detail = getPartyDetail(invoice);
  const dateStr = typeof invoice.date === "string"
    ? formatDate(invoice.date)
    : formatDate(invoice.date || invoice.createdAt);

  const companyName     = profileData?.businessName || "Pyrox Biz";
  const companyLogo     = profileData?.logo || "";
  const companyAddress  = profileData?.address || "";
  const companyPhone    = profileData?.phone || "";
  const companyEmail    = profileData?.email || "";
  const companyCurrency = profileData?.currency || "PKR";

  const currency = invoice.currency || companyCurrency;

  const customCols = Array.isArray(invoice.customColumns) ? invoice.customColumns : [];

  /* ------- Party detail (multi-line) ------- */
  const billToLines = [];
  if (invoice.partyName) billToLines.push(escapeHtml(invoice.partyName));
  if (detail.address) billToLines.push(escapeHtml(detail.address));
  if (detail.phone) billToLines.push(escapeHtml(detail.phone));
  if (detail.email) billToLines.push(escapeHtml(detail.email));
  if (detail.taxNumber) billToLines.push("Tax ID: " + escapeHtml(detail.taxNumber));

  /* ------- Business detail (multi-line) ------- */
  const bizLines = [
    companyAddress ? escapeHtml(companyAddress) : "",
    companyPhone ? escapeHtml(companyPhone) : "",
    companyEmail ? escapeHtml(companyEmail) : ""
  ].filter(Boolean).join("<br>");

  /* ------- Custom column headers ------- */
  const customHeaderCells = customCols.map(c =>
    `<th class="center">${escapeHtml(c.label)}</th>`
  ).join("");

  /* ------- Line item rows ------- */
  const itemRows = (invoice.items || []).map(it => {
    const qty = Number(it.qty || 0);
    const price = Number(it.unitPrice || 0);
    const total = Number(it.lineTotal || 0);

    const customCells = customCols.map(c => {
      const v = (it.custom && it.custom[c.key] != null) ? it.custom[c.key] : "";
      return `<td class="center">${escapeHtml(v)}</td>`;
    }).join("");

    return `
      <tr>
        <td>
          <div class="invoice-doc-item-main">${escapeHtml(it.name || "Item")}</div>
          ${it.sku ? `<div class="invoice-doc-item-sku">SKU: ${escapeHtml(it.sku)}</div>` : ""}
        </td>
        <td class="center">${qty}</td>
        <td class="right">${formatMoney(price, currency)}</td>
        <td class="center">${it.discountPct ?? 0}%</td>
        <td class="center">${it.taxPct ?? 0}%</td>
        ${customCells}
        <td class="right">${formatMoney(total, currency)}</td>
      </tr>
    `;
  }).join("");

  /* ------- Filler rows (keeps layout balanced) ------- */
  const MIN_ROWS = 5;
  const itemsCount = (invoice.items || []).length;
  const fillerCount = Math.max(0, MIN_ROWS - itemsCount);
  const fillerRows = Array.from({ length: fillerCount }).map(() => `
    <tr class="invoice-doc-filler">
      <td>&nbsp;</td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      ${customCols.map(() => "<td></td>").join("")}
      <td></td>
    </tr>
  `).join("");

  const emptyRow = `
    <tr>
      <td colspan="${6 + customCols.length}" class="invoice-doc-empty">
        No items in this invoice.
      </td>
    </tr>
  `;

  /* ------- Totals ------- */
  const subtotal   = Number(invoice.subtotal)     || 0;
  const discount   = Number(invoice.discountTotal) || 0;
  const tax        = Number(invoice.taxTotal)     || 0;
  const grandTotal = Number(invoice.grandTotal)   || 0;
  const amountPaid = Number(invoice.amountPaid)   || 0;
  const balance    = Number(invoice.balance)      || 0;

  const taxRatePct = subtotal > 0 ? ((tax / subtotal) * 100) : 0;

  return `
    <div class="invoice-doc">

      <div class="invoice-doc-title">INVOICE</div>

      <div class="invoice-doc-head">
        <div class="invoice-doc-brand-block">
          ${companyLogo ? `<img src="${escapeHtml(companyLogo)}" alt="Logo" class="invoice-doc-logo">` : ""}
          <div class="invoice-doc-brand">${escapeHtml(companyName)}</div>
          <div class="invoice-doc-brand-sub">
            ${bizLines || ""}
          </div>
        </div>

        <div class="invoice-doc-meta">
          <div class="invoice-doc-meta-row">
            <span class="label">Date:</span>
            <span class="value">${dateStr}</span>
          </div>
          <div class="invoice-doc-meta-row">
            <span class="label">Invoice #:</span>
            <span class="value"><strong>${escapeHtml(invoice.invoiceNumber || "—")}</strong></span>
          </div>
          ${invoice.reference ? `
            <div class="invoice-doc-meta-row">
              <span class="label">Ref:</span>
              <span class="value">${escapeHtml(invoice.reference)}</span>
            </div>
          ` : ""}

          <div class="invoice-doc-billto">
            <span class="label">BILL TO:</span>
            <div class="value">${billToLines.join("<br>") || "—"}</div>
          </div>
        </div>
      </div>

      <div class="invoice-doc-subtitle">
        ${isPurchase ? "PURCHASE ORDER DETAILS" : "ITEMS & SERVICES"}
      </div>

      <table class="invoice-doc-table">
        <thead>
          <tr>
            <th>Description</th>
            <th class="center">Qty</th>
            <th class="right">Unit Price</th>
            <th class="center">Disc %</th>
            <th class="center">Tax %</th>
            ${customHeaderCells}
            <th class="right">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${(itemRows || emptyRow)}
          ${fillerRows}
        </tbody>
      </table>

      <div class="invoice-doc-bottom">
        <div class="invoice-doc-notes">
          <div>
            ${invoice.notes ? escapeHtml(invoice.notes) : `Please make all checks payable to ${escapeHtml(companyName)}. If you have any questions concerning this invoice, contact us at ${escapeHtml(companyPhone || companyEmail || "the details above")}.`}
          </div>
          <span class="thanks">Thank you for your business!</span>

          <div class="invoice-doc-signature">
            <div class="invoice-doc-signature-line"></div>
            <div class="invoice-doc-signature-label">Authorized Signature</div>
            <div class="invoice-doc-signature-name">${escapeHtml(companyName)}</div>
          </div>
        </div>

        <div class="invoice-doc-totals">
          <div class="invoice-doc-total-row">
            <span class="label">Subtotal</span>
            <span class="value">${formatMoney(subtotal, currency)}</span>
          </div>
          <div class="invoice-doc-total-row">
            <span class="label">Tax Rate</span>
            <span class="value">${taxRatePct.toFixed(2)}%</span>
          </div>
          <div class="invoice-doc-total-row">
            <span class="label">Tax</span>
            <span class="value">${formatMoney(tax, currency)}</span>
          </div>
          ${discount > 0 ? `
            <div class="invoice-doc-total-row">
              <span class="label">Discount</span>
              <span class="value">− ${formatMoney(discount, currency)}</span>
            </div>
          ` : ""}
          <div class="invoice-doc-total-row">
            <span class="label">Amount Paid</span>
            <span class="value">${formatMoney(amountPaid, currency)}</span>
          </div>
          <div class="invoice-doc-total-row">
            <span class="label">Balance Due</span>
            <span class="value">${formatMoney(balance, currency)}</span>
          </div>
          <div class="invoice-doc-total-row grand">
            <span class="label">Total</span>
            <span class="value">${formatMoney(grandTotal, currency)}</span>
          </div>
        </div>
      </div>

      <div class="invoice-doc-footer"></div>
    </div>
  `;
}

function openViewInvoiceModal(invoiceId) {
  const invoice = invoicesCache.find(i => i.id === invoiceId);
  if (!invoice) return;
  window.__currentViewedInvoice = invoice;
  document.getElementById("viewInvoiceBody").innerHTML = renderInvoiceTemplate(invoice);
  openModal("viewInvoiceModal");
}

function printInvoice(invoice) {
  document.getElementById("printArea").innerHTML = renderInvoiceTemplate(invoice);
  window.print();
}