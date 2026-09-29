/* =========================================================
   MoeezFlow — Expenses Module
   Firestore-backed: businesses/{uid}/expenses
   Same auth/ownership pattern as sales.js / invoices.js.
   No Inventory dependency anywhere in this file.
   ========================================================= */
import { auth, db } from "../js/firebase.js";
import { renderMetricCards } from "../js/metric-cards.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  runTransaction,
  serverTimestamp,
  addDoc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
// ============================================================
// DIRECT FIRESTORE TEST - Add this temporarily
// ============================================================
async function directFirestoreTest() {
  console.log('=== DIRECT FIRESTORE TEST ===');
  try {
    // Test 1: Check if we can get the current user
    const user = auth.currentUser;
    console.log('Current user from auth:', user?.uid);
    
    if (!user) {
      console.error('No user!');
      return;
    }
    
    const uid = user.uid;
    console.log('Testing with UID:', uid);
    
    // Test 2: Try to write a test document
    console.log('Attempting to write test document...');
    const testCollection = collection(db, "businesses", uid, "expenses");
    const testData = {
      title: "TEST DOCUMENT",
      amount: 99.99,
      ownerId: uid,
      date: new Date().toISOString().slice(0, 10),
      paymentStatus: "Unpaid",
      paymentMethod: "Cash",
      createdAt: new Date().toISOString()
    };
    console.log('Test data:', testData);
    
    const docRef = await addDoc(testCollection, testData);
    console.log('✅ WRITE SUCCESS! Document ID:', docRef.id);
    
    // Test 3: Try to read it back
    console.log('Attempting to read test document...');
    const readDoc = await getDoc(docRef);
    if (readDoc.exists()) {
      console.log('✅ READ SUCCESS! Data:', readDoc.data());
    } else {
      console.log('Document not found after write!');
    }
    
  } catch (err) {
    console.error('❌ TEST FAILED:', err);
    console.error('Error code:', err.code);
    console.error('Error message:', err.message);
    console.error('Full error:', err);
  }
}

// Call the test immediately
directFirestoreTest();

// ============================================================
// DEBUG: Check Firebase and Auth initialization
// ============================================================
console.log('=== EXPENSES MODULE LOADED ===');
console.log('Firebase db:', !!db);
console.log('Firebase auth:', !!auth);

/* ---------------------------------------------------------
   AUTH / BUSINESS CONTEXT (identical pattern to sales.js)
   --------------------------------------------------------- */

let currentUser = null;
let businessId = null;
let authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => {
    console.log('Auth state changed in expenses module:', {
      isAuthenticated: !!user,
      uid: user?.uid,
      email: user?.email
    });
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
  const path = `businesses/${getBusinessId()}/${name}`;
  console.log('bizCollection path:', path);
  return collection(db, "businesses", getBusinessId(), name); 
}
function bizDoc(name, id) { 
  const path = `businesses/${getBusinessId()}/${name}/${id}`;
  console.log('bizDoc path:', path);
  return doc(db, "businesses", getBusinessId(), name, id); 
}

/* ---------------------------------------------------------
   EXPENSE CATEGORIES
   --------------------------------------------------------- */

const CATEGORIES = [
  "Rent", "Electricity", "Water", "Internet", "Salaries", "Transport", "Fuel",
  "Office Supplies", "Repairs & Maintenance", "Marketing", "Taxes",
  "Bank Charges", "Software/Subscriptions", "Telephone", "Other"
];

/* ---------------------------------------------------------
   EXPENSE DATA STRUCTURE (reference only)
   ---------------------------------------------------------
{
  id: "", title: "", category: "", amount: 0, date: "",
  amountPaid: 0, remaining: 0, paymentStatus: "Unpaid",
  paymentMethod: "Cash", payee: "", reference: "", notes: "",
  ownerId: "", createdAt: <Timestamp>, updatedAt: <Timestamp>
}
--------------------------------------------------------- */

/* ---------------------------------------------------------
   STATE
   --------------------------------------------------------- */

let expensesCache = [];

let currentPage = 1;
const PAGE_SIZE = 10;

let searchQuery = "";
let filters = { category: "", paymentStatus: "", paymentMethod: "", dateFrom: "", dateTo: "", amountMin: "", amountMax: "" };
let sortState = { field: "date", dir: "desc" };

let editingExpenseId = null;
let pendingDeleteId = null;
let isSubmitting = false; // duplicate-submission guard

/* ---------------------------------------------------------
   INIT
   --------------------------------------------------------- */

async function initializeExpenses() {
  console.log('initializeExpenses() started');
  try {
    setupSidebar();
    setupNavigation();
    setupToolbar();
    setupModals();
    setupExpenseForm();
    setupDeleteConfirmation();

    const addBtn = document.getElementById("openAddExpenseBtn");
    const emptyAddBtn = document.getElementById("emptyStateAddBtn");
    
    if (addBtn) addBtn.addEventListener("click", openAddExpenseModal);
    if (emptyAddBtn) emptyAddBtn.addEventListener("click", openAddExpenseModal);

    console.log('Waiting for auth...');
    await authReady;
    console.log('Auth ready. Current user:', currentUser);
    
    if (!currentUser) {
      console.error('No authenticated user!');
      showNotification("You must be signed in to view expenses.", "fa-lock", true);
      return;
    }

    console.log('=== EXPENSES DEBUG ===');
    console.log('Current user:', currentUser);
    console.log('User UID:', currentUser?.uid);
    console.log('Business ID:', businessId);
    console.log('Collection path:', `businesses/${currentUser?.uid}/expenses`);
    console.log('======================');

    await loadExpensesIntoCache();
    renderStatistics();
    renderExpensesTable();
    console.log('initializeExpenses() completed successfully');
  } catch (err) {
    console.error("Initialization error:", err);
    showNotification("Failed to initialize expenses module. Please refresh.", "fa-triangle-exclamation", true);
  }
}

document.addEventListener("DOMContentLoaded", initializeExpenses);

/* ---------------------------------------------------------
   SIDEBAR / NAV
   --------------------------------------------------------- */

function setupSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const openBtn = document.getElementById("menuToggle");
  const closeBtn = document.getElementById("sidebarClose");
  if (!sidebar || !overlay || !openBtn || !closeBtn) return;
  
  function open() { sidebar.classList.add("open"); overlay.classList.add("open"); openBtn.setAttribute("aria-expanded", "true"); }
  function close() { sidebar.classList.remove("open"); overlay.classList.remove("open"); openBtn.setAttribute("aria-expanded", "false"); }
  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  window.addEventListener("resize", () => { if (window.innerWidth > 860) close(); });
}

function setupNavigation() {
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      showNotification("Logout is a placeholder — auth not connected yet.", "fa-arrow-right-from-bracket");
    });
  }
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
function money(n) {
  const val = Number(n) || 0;
  return "PKR " + val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function toDateSafe(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}
function formatDate(value) {
  const d = toDateSafe(value);
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}
function todayInputValue() { return new Date().toISOString().slice(0, 10); }

function showNotification(message, icon, isError) {
  const toast = document.getElementById("toast");
  if (!toast) return;
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

function isSameDay(date, ref) {
  return date && date.getFullYear() === ref.getFullYear() && date.getMonth() === ref.getMonth() && date.getDate() === ref.getDate();
}
function isSameMonth(date, ref) {
  return date && date.getFullYear() === ref.getFullYear() && date.getMonth() === ref.getMonth();
}

/* ---------------------------------------------------------
   FIRESTORE LOAD
   --------------------------------------------------------- */

async function loadExpensesIntoCache() {
  console.log('loadExpensesIntoCache() started');
  const loadingEl = document.getElementById("loadingState");
  if (loadingEl) loadingEl.hidden = false;
  try {
    // Debug the path we're trying to access
    const businessId = getBusinessId();
    console.log('Attempting to read from businesses collection with ID:', businessId);
    console.log('Full collection path:', `businesses/${businessId}/expenses`);
    
    const expensesRef = bizCollection("expenses");
    console.log('Collection reference:', expensesRef);
    
    const q = query(expensesRef, orderBy("date", "desc"));
    console.log('Query created:', q);
    
    console.log('Executing Firestore query...');
    const snap = await getDocs(q);
    console.log('Query executed. Snapshot size:', snap.size);
    
    expensesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log('Expenses loaded into cache:', expensesCache.length, 'expenses');
    
    if (expensesCache.length > 0) {
      console.log('First expense sample:', expensesCache[0]);
    }
  } catch (err) {
    console.error("Failed to load expenses:", err);
    console.error('Error code:', err.code);
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
    showNotification("Could not load expenses. Check your connection and try again.", "fa-triangle-exclamation", true);
  } finally {
    if (loadingEl) loadingEl.hidden = true;
    console.log('loadExpensesIntoCache() completed');
  }
}

/* ---------------------------------------------------------
   OVERVIEW STATISTICS
   --------------------------------------------------------- */

function calculateStatistics() {
  const now = new Date();
  const thisMonthTotal = expensesCache
    .filter(e => isSameMonth(toDateSafe(e.date), now))
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const todayTotal = expensesCache
    .filter(e => isSameDay(toDateSafe(e.date), now))
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const unpaidTotal = expensesCache
    .filter(e => e.paymentStatus !== "Paid")
    .reduce((sum, e) => sum + (Number(e.remaining) || 0), 0);
  const largest = expensesCache.reduce((max, e) => (Number(e.amount) || 0) > (Number(max?.amount) || 0) ? e : max, null);
  const count = expensesCache.length;

  return { thisMonthTotal, todayTotal, unpaidTotal, largest, count };
}

function renderStatistics() {
  const grid = document.getElementById("statsGrid");
  if (!grid) return;
  
  const s = calculateStatistics();

  renderMetricCards(grid, [
    { label: "This Month", icon: "fa-calendar-days", value: money(s.thisMonthTotal), delta: { cls: "neutral", text: "—" }, foot: "current month" },
    { label: "Today", icon: "fa-sun", value: money(s.todayTotal), delta: { cls: "neutral", text: "—" }, foot: "today" },
    { label: "Unpaid Expenses", icon: "fa-hourglass-half", value: money(s.unpaidTotal), delta: { cls: s.unpaidTotal > 0 ? "down" : "up", text: s.unpaidTotal > 0 ? "Due" : "Clear" }, foot: "still outstanding" },
    { label: "Largest Expense", icon: "fa-arrow-trend-up", value: s.largest ? money(s.largest.amount) : money(0), delta: { cls: "neutral", text: "—" }, foot: "highest recorded" },
    { label: "Number of Expenses", icon: "fa-wallet", value: s.count.toLocaleString(), delta: { cls: "neutral", text: "—" }, foot: "all expenses" }
  ]);
}

/* ---------------------------------------------------------
   FILTER OPTIONS
   --------------------------------------------------------- */

function refreshFilterOptions() {
  const select = document.getElementById("filterCategory");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">All Categories</option>` + CATEGORIES.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if (CATEGORIES.includes(current)) select.value = current;
}

/* ---------------------------------------------------------
   TOOLBAR: SEARCH / FILTER / SORT
   --------------------------------------------------------- */

function setupToolbar() {
  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      currentPage = 1; renderExpensesTable();
    });
  }

  const filterCategory = document.getElementById("filterCategory");
  if (filterCategory) filterCategory.addEventListener("change", (e) => { filters.category = e.target.value; currentPage = 1; renderExpensesTable(); });
  
  const filterPaymentStatus = document.getElementById("filterPaymentStatus");
  if (filterPaymentStatus) filterPaymentStatus.addEventListener("change", (e) => { filters.paymentStatus = e.target.value; currentPage = 1; renderExpensesTable(); });
  
  const filterPaymentMethod = document.getElementById("filterPaymentMethod");
  if (filterPaymentMethod) filterPaymentMethod.addEventListener("change", (e) => { filters.paymentMethod = e.target.value; currentPage = 1; renderExpensesTable(); });
  
  const filterDateFrom = document.getElementById("filterDateFrom");
  if (filterDateFrom) filterDateFrom.addEventListener("change", (e) => { filters.dateFrom = e.target.value; currentPage = 1; renderExpensesTable(); });
  
  const filterDateTo = document.getElementById("filterDateTo");
  if (filterDateTo) filterDateTo.addEventListener("change", (e) => { filters.dateTo = e.target.value; currentPage = 1; renderExpensesTable(); });
  
  const filterAmountMin = document.getElementById("filterAmountMin");
  if (filterAmountMin) filterAmountMin.addEventListener("input", (e) => { filters.amountMin = e.target.value; currentPage = 1; renderExpensesTable(); });
  
  const filterAmountMax = document.getElementById("filterAmountMax");
  if (filterAmountMax) filterAmountMax.addEventListener("input", (e) => { filters.amountMax = e.target.value; currentPage = 1; renderExpensesTable(); });

  const clearFiltersBtn = document.getElementById("clearFiltersBtn");
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener("click", () => {
      filters = { category: "", paymentStatus: "", paymentMethod: "", dateFrom: "", dateTo: "", amountMin: "", amountMax: "" };
      searchQuery = "";
      document.getElementById("searchInput").value = "";
      document.getElementById("filterCategory").value = "";
      document.getElementById("filterPaymentStatus").value = "";
      document.getElementById("filterPaymentMethod").value = "";
      document.getElementById("filterDateFrom").value = "";
      document.getElementById("filterDateTo").value = "";
      document.getElementById("filterAmountMin").value = "";
      document.getElementById("filterAmountMax").value = "";
      currentPage = 1;
      renderExpensesTable();
    });
  }

  const sortField = document.getElementById("sortField");
  if (sortField) sortField.addEventListener("change", (e) => { sortState.field = e.target.value; currentPage = 1; renderExpensesTable(); });
  
  const sortDirBtn = document.getElementById("sortDirBtn");
  if (sortDirBtn) {
    sortDirBtn.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      const newDir = btn.dataset.dir === "asc" ? "desc" : "asc";
      btn.dataset.dir = newDir;
      sortState.dir = newDir;
      btn.innerHTML = `<i class="fas fa-arrow-${newDir === "asc" ? "down-short-wide" : "up-wide-short"}"></i>`;
      currentPage = 1;
      renderExpensesTable();
    });
  }
}

function getFilteredSortedExpenses() {
  let list = [...expensesCache];

  if (searchQuery) {
    list = list.filter(e => [e.title, e.payee, e.reference].join(" ").toLowerCase().includes(searchQuery));
  }
  if (filters.category) list = list.filter(e => e.category === filters.category);
  if (filters.paymentStatus) list = list.filter(e => e.paymentStatus === filters.paymentStatus);
  if (filters.paymentMethod) list = list.filter(e => e.paymentMethod === filters.paymentMethod);
  if (filters.dateFrom) { const from = new Date(filters.dateFrom); list = list.filter(e => toDateSafe(e.date) >= from); }
  if (filters.dateTo) { const to = new Date(filters.dateTo); to.setHours(23, 59, 59, 999); list = list.filter(e => toDateSafe(e.date) <= to); }
  if (filters.amountMin !== "") list = list.filter(e => (Number(e.amount) || 0) >= Number(filters.amountMin));
  if (filters.amountMax !== "") list = list.filter(e => (Number(e.amount) || 0) <= Number(filters.amountMax));

  const { field, dir } = sortState;
  list.sort((a, b) => {
    let av, bv;
    if (field === "date") { av = toDateSafe(a.date)?.getTime() || 0; bv = toDateSafe(b.date)?.getTime() || 0; }
    else if (field === "title") { av = (a.title || "").toLowerCase(); bv = (b.title || "").toLowerCase(); return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av); }
    else { av = Number(a[field]) || 0; bv = Number(b[field]) || 0; }
    return dir === "asc" ? av - bv : bv - av;
  });

  return list;
}

function paginate(list) {
  const start = (currentPage - 1) * PAGE_SIZE;
  return list.slice(start, start + PAGE_SIZE);
}

/* ---------------------------------------------------------
   RENDER TABLE
   --------------------------------------------------------- */

function renderExpensesTable() {
  refreshFilterOptions();

  const tbody = document.getElementById("expensesTableBody");
  const table = document.getElementById("expensesTable");
  const emptyState = document.getElementById("emptyState");
  const paginationEl = document.getElementById("pagination");
  const toolbarPanel = document.querySelector(".toolbar-panel");

  const filtered = getFilteredSortedExpenses();

  if (expensesCache.length === 0) {
    if (table) table.hidden = true;
    if (paginationEl) paginationEl.hidden = true;
    if (toolbarPanel) toolbarPanel.style.display = "none";
    if (emptyState) emptyState.hidden = false;
    const emptyTitle = document.getElementById("emptyStateTitle");
    const emptyText = document.getElementById("emptyStateText");
    const emptyBtn = document.getElementById("emptyStateAddBtn");
    if (emptyTitle) emptyTitle.textContent = "No expenses yet";
    if (emptyText) emptyText.textContent = "Add your first expense to start tracking business spending.";
    if (emptyBtn) emptyBtn.hidden = false;
    if (tbody) tbody.innerHTML = "";
    renderStatistics();
    return;
  }

  if (toolbarPanel) toolbarPanel.style.display = "";

  if (filtered.length === 0) {
    if (table) table.hidden = true;
    if (paginationEl) paginationEl.hidden = true;
    if (emptyState) emptyState.hidden = false;
    const emptyTitle = document.getElementById("emptyStateTitle");
    const emptyText = document.getElementById("emptyStateText");
    const emptyBtn = document.getElementById("emptyStateAddBtn");
    if (emptyTitle) emptyTitle.textContent = "No matching expenses";
    if (emptyText) emptyText.textContent = "Try adjusting your search or filters.";
    if (emptyBtn) emptyBtn.hidden = true;
    if (tbody) tbody.innerHTML = "";
    renderStatistics();
    return;
  }

  if (emptyState) emptyState.hidden = true;
  if (table) table.hidden = false;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const pageItems = paginate(filtered);

  if (tbody) {
    tbody.innerHTML = pageItems.map(e => `
      <tr data-id="${e.id}">
        <td class="cell-muted">${formatDate(e.date)}</td>
        <td>
          <div class="expense-cell-title">${escapeHtml(e.title)}</div>
          ${e.payee ? `<div class="expense-cell-sub">${escapeHtml(e.payee)}</div>` : ""}
        </td>
        <td>${escapeHtml(e.category)}</td>
        <td class="cell-mono">${money(e.amount)}</td>
        <td class="cell-mono">${money(e.amountPaid)}</td>
        <td class="cell-mono">${money(e.remaining)}</td>
        <td><span class="status-pill ${paymentStatusClass(e.paymentStatus)}">${e.paymentStatus}</span></td>
        <td>${escapeHtml(e.paymentMethod)}</td>
        <td>
          <div class="row-actions">
            <button class="row-action-btn" data-action="view" data-id="${e.id}" aria-label="View expense"><i class="fas fa-eye"></i></button>
            <button class="row-action-btn" data-action="edit" data-id="${e.id}" aria-label="Edit expense"><i class="fas fa-pen"></i></button>
            <button class="row-action-btn danger" data-action="delete" data-id="${e.id}" aria-label="Delete expense"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>
    `).join("");

    tbody.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        if (action === "view") viewExpense(id);
        if (action === "edit") openEditExpenseModal(id);
        if (action === "delete") openDeleteConfirmation(id);
      });
    });
  }

  if (paginationEl) renderPagination(filtered.length, totalPages);
  renderStatistics();
}

function renderPagination(totalItems, totalPages) {
  const paginationEl = document.getElementById("pagination");
  const info = document.getElementById("paginationInfo");
  const controls = document.getElementById("paginationControls");
  
  if (!paginationEl) return;
  paginationEl.hidden = false;
  
  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, totalItems);
  if (info) info.textContent = `Showing ${start}–${end} of ${totalItems} expenses`;

  let html = `<button class="page-btn" id="prevPageBtn" ${currentPage === 1 ? "disabled" : ""}><i class="fas fa-chevron-left"></i></button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 1) {
      html += `<button class="page-btn ${i === currentPage ? "active" : ""}" data-page="${i}">${i}</button>`;
    } else if (Math.abs(i - currentPage) === 2) {
      html += `<span style="color:var(--gray-500); padding:0 4px;">…</span>`;
    }
  }
  html += `<button class="page-btn" id="nextPageBtn" ${currentPage === totalPages ? "disabled" : ""}><i class="fas fa-chevron-right"></i></button>`;
  if (controls) controls.innerHTML = html;

  const prevBtn = document.getElementById("prevPageBtn");
  const nextBtn = document.getElementById("nextPageBtn");
  if (prevBtn) prevBtn.addEventListener("click", () => { currentPage--; renderExpensesTable(); });
  if (nextBtn) nextBtn.addEventListener("click", () => { currentPage++; renderExpensesTable(); });
  if (controls) controls.querySelectorAll("[data-page]").forEach(btn => btn.addEventListener("click", () => { currentPage = Number(btn.dataset.page); renderExpensesTable(); }));
}

/* ---------------------------------------------------------
   GENERIC MODAL SYSTEM
   --------------------------------------------------------- */

let activeModalId = null;
function setupModals() {
  const overlay = document.getElementById("modalOverlay");
  document.querySelectorAll("[data-close-modal]").forEach(btn => btn.addEventListener("click", () => closeModal()));
  if (overlay) overlay.addEventListener("click", () => closeModal());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && activeModalId) closeModal(); });
}
function openModal(id) {
  const modal = document.getElementById(id);
  const overlay = document.getElementById("modalOverlay");
  if (!modal) return;
  modal.hidden = false;
  if (overlay) overlay.classList.add("open");
  requestAnimationFrame(() => modal.classList.add("open"));
  activeModalId = id;
  const firstInput = modal.querySelector("input:not([type=hidden]), select, textarea");
  if (firstInput) setTimeout(() => firstInput.focus(), 150);
}
function closeModal() {
  if (!activeModalId) return;
  const modal = document.getElementById(activeModalId);
  const overlay = document.getElementById("modalOverlay");
  if (modal) modal.classList.remove("open");
  if (overlay) overlay.classList.remove("open");
  setTimeout(() => { if (modal) modal.hidden = true; }, 220);
  activeModalId = null;
}

/* ---------------------------------------------------------
   ADD / EDIT EXPENSE FORM
   --------------------------------------------------------- */

function setupExpenseForm() {
  const amountInput = document.getElementById("fAmount");
  const paidInput = document.getElementById("fAmountPaid");
  const form = document.getElementById("expenseForm");
  
  if (amountInput) amountInput.addEventListener("input", updatePaymentSummary);
  if (paidInput) paidInput.addEventListener("input", updatePaymentSummary);
  if (form) form.addEventListener("submit", handleExpenseFormSubmit);
}

function openAddExpenseModal() {
  editingExpenseId = null;
  const title = document.getElementById("expenseFormTitle");
  const submitBtn = document.getElementById("expenseFormSubmitBtn");
  if (title) title.innerHTML = '<i class="fas fa-receipt"></i> Add Expense';
  if (submitBtn) submitBtn.textContent = "Add Expense";
  resetExpenseForm();
  openModal("expenseFormModal");
}

function openEditExpenseModal(id) {
  const expense = expensesCache.find(e => e.id === id);
  if (!expense) return;
  editingExpenseId = id;
  const title = document.getElementById("expenseFormTitle");
  const submitBtn = document.getElementById("expenseFormSubmitBtn");
  if (title) title.innerHTML = '<i class="fas fa-pen"></i> Edit Expense';
  if (submitBtn) submitBtn.textContent = "Save Changes";
  resetExpenseForm();
  fillExpenseForm(expense);
  openModal("expenseFormModal");
}

function resetExpenseForm() {
  const form = document.getElementById("expenseForm");
  if (form) form.reset();
  document.querySelectorAll(".form-row").forEach(row => row.classList.remove("invalid"));
  const idField = document.getElementById("expenseId");
  if (idField) idField.value = "";
  const dateField = document.getElementById("fDate");
  if (dateField) dateField.value = todayInputValue();
  const methodField = document.getElementById("fPaymentMethod");
  if (methodField) methodField.value = "Cash";
  updatePaymentSummary();
}

function fillExpenseForm(e) {
  const idField = document.getElementById("expenseId");
  const titleField = document.getElementById("fTitle");
  const categoryField = document.getElementById("fCategory");
  const amountField = document.getElementById("fAmount");
  const dateField = document.getElementById("fDate");
  const paidField = document.getElementById("fAmountPaid");
  const methodField = document.getElementById("fPaymentMethod");
  const payeeField = document.getElementById("fPayee");
  const refField = document.getElementById("fReference");
  const notesField = document.getElementById("fNotes");
  
  if (idField) idField.value = e.id;
  if (titleField) titleField.value = e.title || "";
  if (categoryField) categoryField.value = e.category || "";
  if (amountField) amountField.value = e.amount ?? "";
  if (dateField) dateField.value = e.date || todayInputValue();
  if (paidField) paidField.value = e.amountPaid ?? 0;
  if (methodField) methodField.value = e.paymentMethod || "Cash";
  if (payeeField) payeeField.value = e.payee || "";
  if (refField) refField.value = e.reference || "";
  if (notesField) notesField.value = e.notes || "";
  updatePaymentSummary();
}

function updatePaymentSummary() {
  const amount = Number(document.getElementById("fAmount")?.value) || 0;
  let paid = Number(document.getElementById("fAmountPaid")?.value) || 0;
  if (paid < 0) paid = 0;
  if (paid > amount) paid = amount;

  const remaining = round2(amount - paid);
  const remainingDisplay = document.getElementById("remainingDisplay");
  if (remainingDisplay) remainingDisplay.textContent = money(remaining);

  let status = "Unpaid";
  if (amount > 0 && paid >= amount) status = "Paid";
  else if (paid > 0) status = "Partially Paid";

  const pill = document.getElementById("paymentStatusPill");
  if (pill) {
    pill.textContent = status;
    pill.className = "status-pill " + paymentStatusClass(status);
  }
}

function validateExpenseForm() {
  let valid = true;
  const titleRow = document.getElementById("fTitle")?.closest(".form-row");
  const categoryRow = document.getElementById("fCategory")?.closest(".form-row");
  const amountRow = document.getElementById("fAmount")?.closest(".form-row");
  const dateRow = document.getElementById("fDate")?.closest(".form-row");
  const paidRow = document.getElementById("fAmountPaid")?.closest(".form-row");

  [titleRow, categoryRow, amountRow, dateRow, paidRow].forEach(r => { if (r) r.classList.remove("invalid"); });

  const title = document.getElementById("fTitle")?.value.trim();
  if (!title && titleRow) { titleRow.classList.add("invalid"); valid = false; }

  const category = document.getElementById("fCategory")?.value;
  if (!category && categoryRow) { categoryRow.classList.add("invalid"); valid = false; }

  const amount = Number(document.getElementById("fAmount")?.value);
  if (!amount || amount <= 0) { if (amountRow) amountRow.classList.add("invalid"); valid = false; }

  const date = document.getElementById("fDate")?.value;
  if (!date && dateRow) { dateRow.classList.add("invalid"); valid = false; }

  const amountPaid = Number(document.getElementById("fAmountPaid")?.value) || 0;
  if (amountPaid < 0 || (amount > 0 && amountPaid > amount)) { if (paidRow) paidRow.classList.add("invalid"); valid = false; }

  return valid;
}

async function handleExpenseFormSubmit(e) {
  e.preventDefault();
  if (isSubmitting) return;
  if (!validateExpenseForm()) return;

  const submitBtn = document.getElementById("expenseFormSubmitBtn");
  isSubmitting = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Saving...`;
  }

  try {
    console.log('=== SAVING EXPENSE ===');
    console.log('Current user UID:', currentUser?.uid);
    
    const amount = round2(Number(document.getElementById("fAmount")?.value));
    let amountPaid = round2(Number(document.getElementById("fAmountPaid")?.value) || 0);
    if (amountPaid > amount) amountPaid = amount;
    const remaining = round2(amount - amountPaid);

    let paymentStatus = "Unpaid";
    if (amount > 0 && amountPaid >= amount) paymentStatus = "Paid";
    else if (amountPaid > 0) paymentStatus = "Partially Paid";

    const data = {
      title: document.getElementById("fTitle")?.value.trim() || "",
      category: document.getElementById("fCategory")?.value || "",
      amount,
      date: document.getElementById("fDate")?.value || new Date().toISOString().slice(0, 10),
      amountPaid,
      remaining,
      paymentStatus,
      paymentMethod: document.getElementById("fPaymentMethod")?.value || "Cash",
      payee: document.getElementById("fPayee")?.value.trim() || "",
      reference: document.getElementById("fReference")?.value.trim() || "",
      notes: document.getElementById("fNotes")?.value.trim() || "",
      ownerId: currentUser.uid
    };

    console.log('Data being saved:', data);
    console.log('Collection path:', `businesses/${currentUser.uid}/expenses`);

    if (editingExpenseId) {
      console.log('Updating expense with ID:', editingExpenseId);
      await updateDoc(bizDoc("expenses", editingExpenseId), { ...data, updatedAt: serverTimestamp() });
      showNotification("Expense updated successfully.", "fa-circle-check");
    } else {
      console.log('Creating new expense...');
      const docRef = await addDoc(bizCollection("expenses"), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      console.log('Expense created with ID:', docRef.id);
      showNotification("Expense added successfully.", "fa-circle-check");
    }

    closeModal();
    await loadExpensesIntoCache();
    currentPage = 1;
    renderStatistics();
    renderExpensesTable();
  } catch (err) {
    console.error("Save expense failed:", err);
    console.error('Error code:', err.code);
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
    showNotification(err.message || "Could not save expense. Please try again.", "fa-triangle-exclamation", true);
  } finally {
    isSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = editingExpenseId ? "Save Changes" : "Add Expense";
    }
  }
}

/* ---------------------------------------------------------
   VIEW EXPENSE DETAILS
   --------------------------------------------------------- */

function viewExpense(id) {
  const e = expensesCache.find(x => x.id === id);
  if (!e) return;

  const body = document.getElementById("viewExpenseBody");
  if (!body) return;
  
  body.innerHTML = `
    <div class="detail-header">
      <div class="detail-header-name">${escapeHtml(e.title)}</div>
      <div class="detail-header-sub">${escapeHtml(e.category)} · ${formatDate(e.date)} &nbsp;·&nbsp; <span class="status-pill ${paymentStatusClass(e.paymentStatus)}">${e.paymentStatus}</span></div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Payment</div>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-item-label">Amount</span><span class="detail-item-value mono">${money(e.amount)}</span></div>
        <div class="detail-item"><span class="detail-item-label">Amount Paid</span><span class="detail-item-value mono">${money(e.amountPaid)}</span></div>
        <div class="detail-item"><span class="detail-item-label">Remaining</span><span class="detail-item-value mono">${money(e.remaining)}</span></div>
        <div class="detail-item"><span class="detail-item-label">Payment Method</span><span class="detail-item-value">${escapeHtml(e.paymentMethod)}</span></div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Additional Information</div>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-item-label">Payee / Vendor</span><span class="detail-item-value">${escapeHtml(e.payee || "—")}</span></div>
        <div class="detail-item"><span class="detail-item-label">Reference</span><span class="detail-item-value mono">${escapeHtml(e.reference || "—")}</span></div>
      </div>
    </div>

    ${e.notes ? `
    <div class="detail-section">
      <div class="detail-section-title">Notes</div>
      <p class="detail-notes">${escapeHtml(e.notes)}</p>
    </div>` : ""}

    <div class="detail-section">
      <div class="detail-section-title">Dates</div>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-item-label">Created</span><span class="detail-item-value">${formatDate(e.createdAt)}</span></div>
        <div class="detail-item"><span class="detail-item-label">Last Updated</span><span class="detail-item-value">${formatDate(e.updatedAt)}</span></div>
      </div>
    </div>
  `;

  const editBtn = document.getElementById("viewEditBtn");
  if (editBtn) {
    editBtn.onclick = () => {
      closeModal();
      setTimeout(() => openEditExpenseModal(id), 220);
    };
  }

  openModal("viewExpenseModal");
}

/* ---------------------------------------------------------
   DELETE CONFIRMATION
   --------------------------------------------------------- */

function setupDeleteConfirmation() {
  const confirmBtn = document.getElementById("confirmDeleteBtn");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", async () => {
      if (!pendingDeleteId) return;
      const btn = document.getElementById("confirmDeleteBtn");
      btn.disabled = true;
      btn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Deleting...`;

      try {
        console.log('Deleting expense with ID:', pendingDeleteId);
        const e = expensesCache.find(x => x.id === pendingDeleteId);
        await deleteDoc(bizDoc("expenses", pendingDeleteId));
        pendingDeleteId = null;
        closeModal();
        await loadExpensesIntoCache();
        currentPage = 1;
        renderStatistics();
        renderExpensesTable();
        showNotification(`"${e ? e.title : "Expense"}" deleted.`, "fa-trash");
      } catch (err) {
        console.error("Delete expense failed:", err);
        console.error('Error code:', err.code);
        console.error('Error message:', err.message);
        showNotification(err.message || "Could not delete expense. Please try again.", "fa-triangle-exclamation", true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Delete";
      }
    });
  }
}

function openDeleteConfirmation(id) {
  const e = expensesCache.find(x => x.id === id);
  if (!e) return;
  pendingDeleteId = id;
  const confirmText = document.getElementById("deleteConfirmText");
  if (confirmText) {
    confirmText.textContent = `Deleting "${e.title}" will remove it permanently. This cannot be undone.`;
  }
  openModal("deleteConfirmModal");
}