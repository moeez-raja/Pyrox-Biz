/* =========================================================
   MoeezFlow — Suppliers Module
   Now with Firebase support, cross-module search, and balance editing
   ========================================================= */

import { auth, db } from "../js/firebase.js";
import { renderMetricCards } from "../js/metric-cards.js";
import {
  collection,
  addDoc,
  query,
  where,
  getDocs,
  onSnapshot,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

/* ---------------------------------------------------------
   STATE
   --------------------------------------------------------- */

let suppliers = [];
let currentPage = 1;
const PAGE_SIZE = 10;
let searchQuery = "";
let filters = { type: "", status: "", payable: "" };
let editingSupplierId = null;
let pendingDeleteId = null;
let unsubscribeSuppliers = null;
let editingBalanceSupplierId = null;

/* ---------------------------------------------------------
   FIRESTORE DATA ACCESS
   --------------------------------------------------------- */

function getSuppliersCollection() {
  return collection(db, 'suppliers');
}

// Load suppliers from Firestore with realtime listener
function loadSuppliers() {
  const user = auth.currentUser;
  if (!user) {
    suppliers = [];
    renderSuppliers();
    return;
  }

  // Clean up previous listener
  if (unsubscribeSuppliers) {
    unsubscribeSuppliers();
    unsubscribeSuppliers = null;
  }

  const q = query(
    getSuppliersCollection(),
    where('ownerId', '==', user.uid)
  );

  unsubscribeSuppliers = onSnapshot(q, (snapshot) => {
    suppliers = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    renderSuppliers();
    renderStatistics();
  }, (error) => {
    console.error('Error loading suppliers:', error);
    showNotification('Failed to load suppliers', 'fa-exclamation-circle', true);
  });
}

// Save single supplier (add or update)
async function saveSupplierToFirestore(supplierData, isEdit = false) {
  const user = auth.currentUser;
  if (!user) {
    showNotification('Please login first', 'fa-exclamation-circle', true);
    return null;
  }

  try {
    if (isEdit && editingSupplierId) {
      // Update existing supplier
      const docRef = doc(db, 'suppliers', editingSupplierId);
      await updateDoc(docRef, {
        ...supplierData,
        updatedAt: serverTimestamp()
      });
      return editingSupplierId;
    } else {
      // Add new supplier
      const docRef = await addDoc(getSuppliersCollection(), {
        ...supplierData,
        ownerId: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      return docRef.id;
    }
  } catch (error) {
    console.error('Error saving supplier:', error);
    showNotification('Failed to save supplier. Please try again.', 'fa-exclamation-circle', true);
    return null;
  }
}

// Delete supplier from Firestore
async function deleteSupplierFromFirestore(id) {
  const user = auth.currentUser;
  if (!user) return false;

  try {
    const docRef = doc(db, 'suppliers', id);
    await deleteDoc(docRef);
    return true;
  } catch (error) {
    console.error('Error deleting supplier:', error);
    showNotification('Failed to delete supplier', 'fa-exclamation-circle', true);
    return false;
  }
}

// Update supplier opening balance directly
async function updateSupplierBalance(id, newBalance) {
  const user = auth.currentUser;
  if (!user) {
    showNotification('Please login first', 'fa-exclamation-circle', true);
    return false;
  }

  try {
    const docRef = doc(db, 'suppliers', id);
    await updateDoc(docRef, {
      openingBalance: Number(newBalance) || 0,
      updatedAt: serverTimestamp()
    });
    return true;
  } catch (error) {
    console.error('Error updating supplier balance:', error);
    showNotification('Failed to update balance', 'fa-exclamation-circle', true);
    return false;
  }
}

// Get supplier by ID - EXPORT THIS for other modules
export async function getSupplierById(supplierId) {
  const user = auth.currentUser;
  if (!user) return null;

  try {
    const docRef = doc(db, 'suppliers', supplierId);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() };
    }
    return null;
  } catch (error) {
    console.error('Error getting supplier:', error);
    return null;
  }
}

// Search suppliers - EXPORT THIS for other modules
export async function searchSuppliers(searchTerm) {
  const user = auth.currentUser;
  if (!user) return [];

  try {
    const q = query(
      getSuppliersCollection(),
      where('ownerId', '==', user.uid)
    );
    const snapshot = await getDocs(q);
    
    const term = searchTerm.toLowerCase().trim();
    return snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(supplier => {
        const name = (supplier.name || '').toLowerCase();
        const company = (supplier.company || '').toLowerCase();
        const phone = (supplier.phone || '').toLowerCase();
        const email = (supplier.email || '').toLowerCase();
        const id = (supplier.id || '').toLowerCase();
        return name.includes(term) || 
               company.includes(term) ||
               phone.includes(term) || 
               email.includes(term) || 
               id.includes(term);
      });
  } catch (error) {
    console.error('Error searching suppliers:', error);
    return [];
  }
}

/* ---------------------------------------------------------
   FUTURE: OUTSTANDING PAYABLE / PURCHASE HISTORY
   --------------------------------------------------------- */

function calculateOutstandingPayable(supplierId) {
  // Will be connected to purchases module later
  return 0;
}

function getSupplierPurchaseHistory(supplierId) {
  // Will be connected to purchases module later
  return [];
}

function getSupplierTotals(supplierId) {
  return { totalPurchases: 0, totalPaid: 0, lastPurchaseDate: null };
}

/* ---------------------------------------------------------
   INITIALIZE
   --------------------------------------------------------- */

async function initializeSuppliers() {
  // Setup UI
  setupSidebar();
  setupNavigation();
  setupToolbar();
  setupModals();
  setupSupplierForm();

  document.getElementById("openAddSupplierBtn").addEventListener("click", openAddSupplierModal);
  document.getElementById("emptyStateAddBtn").addEventListener("click", openAddSupplierModal);

  // Check auth and load data
  const user = auth.currentUser;
  if (user) {
    loadSuppliers();
  } else {
    // Auth listener
    auth.onAuthStateChanged((user) => {
      if (user) {
        loadSuppliers();
      } else {
        suppliers = [];
        renderSuppliers();
        renderStatistics();
        showNotification('Please login to manage suppliers', 'fa-exclamation-circle', true);
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", initializeSuppliers);

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
    // Handle logout
    import('https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js')
      .then(({ signOut }) => {
        signOut(auth).then(() => {
          window.location.href = "../auth/login.html";
        });
      });
  });
}

/* ---------------------------------------------------------
   HELPERS
   --------------------------------------------------------- */

function generateId() {
  return "SUPP-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
}

function nowISO() { return new Date().toISOString(); }

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

function formatMoney(n) {
  const val = Number(n) || 0;
  return "PKR " + val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function getInitials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function showNotification(message, icon, isError) {
  const toast = document.getElementById("toast");
  toast.classList.toggle("toast-error", !!isError);
  toast.innerHTML = `<i class="fas ${icon || "fa-circle-check"}"></i> ${escapeHtml(message)}`;
  toast.classList.add("show");
  clearTimeout(showNotification._t);
  showNotification._t = setTimeout(() => toast.classList.remove("show"), 3200);
}

function statusPillClass(status) {
  return status === "Active" ? "status-active" : "status-inactive";
}

function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* ---------------------------------------------------------
   STATISTICS
   --------------------------------------------------------- */

function calculateStatistics() {
  const total = suppliers.length;
  const active = suppliers.filter(s => s.status === "Active").length;
  const inactive = suppliers.filter(s => s.status === "Inactive").length;

  const totalPayable = suppliers.reduce((sum, s) => sum + calculateOutstandingPayable(s.id), 0);

  return { total, active, inactive, totalPayable };
}

function renderStatistics() {
  const s = calculateStatistics();
  const grid = document.getElementById("statsGrid");

  const activePct = s.total ? Math.round((s.active / s.total) * 100) : 0;

  renderMetricCards(grid, [
    { label: "Total Suppliers", icon: "fa-handshake", value: s.total.toLocaleString(), delta: { cls: "neutral", text: "—" }, foot: "all suppliers" },
    { label: "Active Suppliers", icon: "fa-circle-check", value: s.active.toLocaleString(), delta: { cls: "up", text: `${activePct}%` }, foot: "currently active" },
    { label: "Inactive Suppliers", icon: "fa-circle-xmark", value: s.inactive.toLocaleString(), delta: { cls: s.inactive > 0 ? "down" : "neutral", text: s.inactive > 0 ? "Inactive" : "—" }, foot: "not in use" },
    { label: "Outstanding Payables", icon: "fa-sack-dollar", value: formatMoney(s.totalPayable), delta: { cls: s.totalPayable > 0 ? "down" : "up", text: s.totalPayable > 0 ? "Due" : "Clear" }, foot: "balances owed" }
  ]);
}

/* ---------------------------------------------------------
   FILTER OPTIONS (city datalist)
   --------------------------------------------------------- */

function refreshFilterOptions() {
  const cities = [...new Set(suppliers.map(s => s.city).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  document.getElementById("cityOptions").innerHTML = cities.map(c => `<option value="${escapeHtml(c)}"></option>`).join("");
}

/* ---------------------------------------------------------
   SEARCH / FILTER
   --------------------------------------------------------- */

function setupToolbar() {
  document.getElementById("searchInput").addEventListener("input", (e) => {
    searchSuppliersLocal(e.target.value);
  });

  document.getElementById("filterType").addEventListener("change", (e) => {
    filterSuppliers({ type: e.target.value });
  });
  document.getElementById("filterStatus").addEventListener("change", (e) => {
    filterSuppliers({ status: e.target.value });
  });
  document.getElementById("filterPayable").addEventListener("change", (e) => {
    filterSuppliers({ payable: e.target.value });
  });

  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    filters = { type: "", status: "", payable: "" };
    searchQuery = "";
    document.getElementById("searchInput").value = "";
    document.getElementById("filterType").value = "";
    document.getElementById("filterStatus").value = "";
    document.getElementById("filterPayable").value = "";
    currentPage = 1;
    renderSuppliers();
  });
}

function searchSuppliersLocal(query) {
  searchQuery = (query || "").trim().toLowerCase();
  currentPage = 1;
  renderSuppliers();
}

function filterSuppliers(partialFilters) {
  filters = { ...filters, ...partialFilters };
  currentPage = 1;
  renderSuppliers();
}

function getFilteredSuppliers() {
  let list = [...suppliers];

  if (searchQuery) {
    list = list.filter(s => {
      const haystack = [s.name, s.company, s.phone, s.email, s.city].join(" ").toLowerCase();
      return haystack.includes(searchQuery);
    });
  }

  if (filters.type) list = list.filter(s => s.type === filters.type);
  if (filters.status) list = list.filter(s => s.status === filters.status);

  if (filters.payable === "has") {
    list = list.filter(s => calculateOutstandingPayable(s.id) > 0);
  } else if (filters.payable === "none") {
    list = list.filter(s => calculateOutstandingPayable(s.id) <= 0);
  }

  list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return list;
}

function paginate(list) {
  const start = (currentPage - 1) * PAGE_SIZE;
  return list.slice(start, start + PAGE_SIZE);
}

/* ---------------------------------------------------------
   RENDER TABLE
   --------------------------------------------------------- */

function renderSuppliers() {
  refreshFilterOptions();

  const tbody = document.getElementById("suppliersTableBody");
  const table = document.getElementById("suppliersTable");
  const emptyState = document.getElementById("emptyState");
  const paginationEl = document.getElementById("pagination");
  const toolbarPanel = document.querySelector(".toolbar-panel");

  const filtered = getFilteredSuppliers();

  // NO SUPPLIERS AT ALL
  if (suppliers.length === 0) {
    if (table) { table.style.display = 'none'; table.hidden = true; }
    if (paginationEl) { paginationEl.style.display = 'none'; paginationEl.hidden = true; }
    if (toolbarPanel) { toolbarPanel.style.display = "none"; }
    if (emptyState) { emptyState.style.display = ''; emptyState.hidden = false; }
    document.getElementById("emptyStateTitle").textContent = "No suppliers yet";
    document.getElementById("emptyStateText").textContent = "Add your first supplier to start tracking purchases and payables.";
    document.getElementById("emptyStateAddBtn").hidden = false;
    tbody.innerHTML = "";
    return;
  }

  if (toolbarPanel) { toolbarPanel.style.display = ""; }

  // NO MATCHING SUPPLIERS
  if (filtered.length === 0) {
    if (table) { table.style.display = 'none'; table.hidden = true; }
    if (paginationEl) { paginationEl.style.display = 'none'; paginationEl.hidden = true; }
    if (emptyState) { emptyState.style.display = ''; emptyState.hidden = false; }
    document.getElementById("emptyStateTitle").textContent = "No matching suppliers";
    document.getElementById("emptyStateText").textContent = "Try adjusting your search or filters.";
    document.getElementById("emptyStateAddBtn").hidden = true;
    tbody.innerHTML = "";
    return;
  }

  // SUPPLIERS EXIST AND MATCH - SHOW THEM
  if (emptyState) { emptyState.style.display = 'none'; emptyState.hidden = true; }
  if (table) { table.style.display = ''; table.hidden = false; }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const pageItems = paginate(filtered);

  tbody.innerHTML = pageItems.map(s => {
    const payable = calculateOutstandingPayable(s.id);
    const totals = getSupplierTotals(s.id);
    return `
      <tr data-id="${s.id}">
        <td>
          <div class="supplier-cell">
            <div class="supplier-avatar">${getInitials(s.name)}</div>
            <div>
              <div class="supplier-cell-name">${escapeHtml(s.name)}</div>
              <div class="supplier-cell-sub">${escapeHtml(s.type || "—")}</div>
            </div>
          </div>
        </td>
        <td>${escapeHtml(s.company || "—")}</td>
        <td class="cell-mono">${escapeHtml(s.phone)}</td>
        <td>${escapeHtml(s.email || "—")}</td>
        <td>${escapeHtml(s.city || "—")}</td>
        <td>
          ${payable > 0
            ? `<span class="status-pill status-has-balance">${formatMoney(payable)}</span>`
            : `<span class="status-pill status-no-balance">${formatMoney(0)}</span>`}
        </td>
        <td><span class="status-pill ${statusPillClass(s.status)}">${s.status}</span></td>
        <td class="cell-muted">${formatDate(totals.lastPurchaseDate)}</td>
        <td>
          <div class="row-actions">
            <button class="row-action-btn" data-action="view" data-id="${s.id}" aria-label="View supplier"><i class="fas fa-eye"></i></button>
            <button class="row-action-btn" data-action="edit" data-id="${s.id}" aria-label="Edit supplier"><i class="fas fa-pen"></i></button>
            <button class="row-action-btn danger" data-action="delete" data-id="${s.id}" aria-label="Delete supplier"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === "view") viewSupplier(id);
      if (action === "edit") editSupplier(id);
      if (action === "delete") openDeleteConfirmation(id);
    });
  });

  renderPagination(filtered.length, totalPages);
}

function renderPagination(totalItems, totalPages) {
  const paginationEl = document.getElementById("pagination");
  const info = document.getElementById("paginationInfo");
  const controls = document.getElementById("paginationControls");

  if (paginationEl) { paginationEl.style.display = ''; paginationEl.hidden = false; }

  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, totalItems);
  info.textContent = `Showing ${start}–${end} of ${totalItems} suppliers`;

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
  if (prevBtn) prevBtn.addEventListener("click", () => { currentPage--; renderSuppliers(); });
  if (nextBtn) nextBtn.addEventListener("click", () => { currentPage++; renderSuppliers(); });

  controls.querySelectorAll("[data-page]").forEach(btn => {
    btn.addEventListener("click", () => { currentPage = Number(btn.dataset.page); renderSuppliers(); });
  });
}

/* ---------------------------------------------------------
   ADD / EDIT / DELETE SUPPLIER
   --------------------------------------------------------- */

async function addSupplier(data) {
  const supplierData = {
    ...data,
    id: generateId() // We'll use this as a display ID
  };
  const id = await saveSupplierToFirestore(supplierData, false);
  if (id) {
    showNotification('Supplier added successfully!', 'fa-circle-check');
  }
  return id;
}

async function updateSupplier(id, data) {
  const success = await saveSupplierToFirestore(data, true);
  if (success) {
    showNotification('Supplier updated successfully!', 'fa-circle-check');
  }
  return success;
}

async function deleteSupplier(id) {
  const success = await deleteSupplierFromFirestore(id);
  if (success) {
    showNotification('Supplier deleted successfully.', 'fa-trash');
  }
  return success;
}

function editSupplier(id) {
  openEditSupplierModal(id);
}

/* ---------------------------------------------------------
   ADD / EDIT MODAL
   --------------------------------------------------------- */

function openAddSupplierModal() {
  editingSupplierId = null;
  document.getElementById("supplierFormTitle").innerHTML = '<i class="fas fa-handshake"></i> Add Supplier';
  document.getElementById("supplierFormSubmitBtn").textContent = "Add Supplier";
  resetSupplierForm();
  openModal("supplierFormModal");
}

function openEditSupplierModal(id) {
  const supplier = suppliers.find(s => s.id === id);
  if (!supplier) return;

  editingSupplierId = id;
  document.getElementById("supplierFormTitle").innerHTML = '<i class="fas fa-pen"></i> Edit Supplier';
  document.getElementById("supplierFormSubmitBtn").textContent = "Save Changes";
  resetSupplierForm();
  fillSupplierForm(supplier);
  openModal("supplierFormModal");
}

function resetSupplierForm() {
  const form = document.getElementById("supplierForm");
  form.reset();
  form.querySelectorAll(".form-row").forEach(row => row.classList.remove("invalid"));
  document.getElementById("supplierId").value = "";
  document.getElementById("fType").value = "Manufacturer";
  document.getElementById("fStatus").value = "Active";
  document.getElementById("fOpeningBalance").value = "0";
}

function fillSupplierForm(s) {
  document.getElementById("supplierId").value = s.id;
  document.getElementById("fName").value = s.name || "";
  document.getElementById("fCompany").value = s.company || "";
  document.getElementById("fPhone").value = s.phone || "";
  document.getElementById("fEmail").value = s.email || "";
  document.getElementById("fAddress").value = s.address || "";
  document.getElementById("fCity").value = s.city || "";
  document.getElementById("fTaxNumber").value = s.taxNumber || "";
  document.getElementById("fType").value = s.type || "Manufacturer";
  document.getElementById("fStatus").value = s.status || "Active";
  document.getElementById("fOpeningBalance").value = s.openingBalance ?? 0;
  document.getElementById("fNotes").value = s.notes || "";
}

function setupSupplierForm() {
  document.getElementById("supplierForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = validateSupplierForm();
    if (!result.valid) return;

    const data = result.data;

    if (editingSupplierId) {
      await updateSupplier(editingSupplierId, data);
    } else {
      await addSupplier(data);
    }

    closeModal();
    currentPage = 1;
    // Data will auto-update via listener
  });
}

function validateSupplierForm() {
  const rows = {
    name: document.getElementById("fName"),
    phone: document.getElementById("fPhone"),
    email: document.getElementById("fEmail"),
    openingBalance: document.getElementById("fOpeningBalance")
  };

  Object.values(rows).forEach(field => field.closest(".form-row").classList.remove("invalid"));

  let valid = true;
  function markInvalid(field) { field.closest(".form-row").classList.add("invalid"); valid = false; }

  const name = rows.name.value.trim();
  if (!name) markInvalid(rows.name);

  const phone = rows.phone.value.trim();
  if (!phone) markInvalid(rows.phone);

  const email = rows.email.value.trim();
  if (email && !isValidEmail(email)) markInvalid(rows.email);

  const openingBalanceRaw = rows.openingBalance.value;
  if (openingBalanceRaw !== "" && Number(openingBalanceRaw) < 0) markInvalid(rows.openingBalance);

  if (!valid) return { valid: false };

  const data = {
    name,
    company: document.getElementById("fCompany").value.trim(),
    phone,
    email,
    address: document.getElementById("fAddress").value.trim(),
    city: document.getElementById("fCity").value.trim(),
    taxNumber: document.getElementById("fTaxNumber").value.trim(),
    type: document.getElementById("fType").value,
    status: document.getElementById("fStatus").value,
    openingBalance: Number(openingBalanceRaw) || 0,
    notes: document.getElementById("fNotes").value.trim()
  };

  return { valid: true, data };
}

/* ---------------------------------------------------------
   VIEW SUPPLIER DETAILS
   --------------------------------------------------------- */

function viewSupplier(id) {
  const s = suppliers.find(x => x.id === id);
  if (!s) return;

  const payable = calculateOutstandingPayable(s.id);
  const totals = getSupplierTotals(s.id);
  const history = getSupplierPurchaseHistory(s.id);
  const isEditingBalance = editingBalanceSupplierId === id;

  const body = document.getElementById("viewSupplierBody");
  body.innerHTML = `
    <div class="detail-header">
      <div class="detail-avatar">${getInitials(s.name)}</div>
      <div>
        <div class="detail-header-name">${escapeHtml(s.name)}</div>
        <div class="detail-header-sub">${escapeHtml(s.company || "No company")} &nbsp;·&nbsp; <span class="status-pill ${statusPillClass(s.status)}">${s.status}</span></div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Contact Information</div>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-item-label">Phone</span><span class="detail-item-value mono">${escapeHtml(s.phone)}</span></div>
        <div class="detail-item"><span class="detail-item-label">Email</span><span class="detail-item-value">${escapeHtml(s.email || "—")}</span></div>
        <div class="detail-item"><span class="detail-item-label">Type</span><span class="detail-item-value">${escapeHtml(s.type || "—")}</span></div>
        <div class="detail-item"><span class="detail-item-label">Address</span><span class="detail-item-value">${escapeHtml(s.address || "—")}</span></div>
        <div class="detail-item"><span class="detail-item-label">City</span><span class="detail-item-value">${escapeHtml(s.city || "—")}</span></div>
        <div class="detail-item"><span class="detail-item-label">Tax / NTN Number</span><span class="detail-item-value mono">${escapeHtml(s.taxNumber || "—")}</span></div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Financial Summary</div>
      <div class="detail-financial-grid">
        <div class="detail-financial-card">
          <div class="detail-financial-label">Opening Balance</div>
          <div class="detail-financial-value" id="balanceDisplay">${formatMoney(s.openingBalance)}</div>
          ${isEditingBalance ? `
            <div class="balance-edit-wrap">
              <input type="number" id="balanceInput" min="0" step="0.01" value="${Number(s.openingBalance) || 0}" aria-label="Opening balance">
              <div class="balance-edit-actions">
                <button type="button" class="btn btn-solid btn-sm" id="saveBalanceBtn"><i class="fas fa-check"></i> Save</button>
                <button type="button" class="btn btn-ghost btn-sm" id="cancelBalanceBtn" aria-label="Cancel"><i class="fas fa-xmark"></i></button>
              </div>
            </div>
          ` : `
            <button type="button" class="balance-edit-trigger" id="editBalanceBtn">
              <i class="fas fa-pen"></i> Edit Balance
            </button>
          `}
        </div>
        <div class="detail-financial-card"><div class="detail-financial-label">Total Purchases</div><div class="detail-financial-value">${formatMoney(totals.totalPurchases)}</div></div>
        <div class="detail-financial-card"><div class="detail-financial-label">Total Paid</div><div class="detail-financial-value">${formatMoney(totals.totalPaid)}</div></div>
        <div class="detail-financial-card"><div class="detail-financial-label">Outstanding Payable</div><div class="detail-financial-value">${formatMoney(payable)}</div></div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Recent Purchase History</div>
      ${history.length === 0
        ? `<div class="empty-state-inline"><i class="fas fa-receipt"></i><span>No purchase history available. This will populate once the Purchases module is connected.</span></div>`
        : `<div class="txn-list">${history.map(t => `<div class="txn-row"><span>${escapeHtml(t.label)}</span><span class="cell-mono">${formatMoney(t.amount)}</span></div>`).join("")}</div>`}
    </div>

    ${s.notes ? `
    <div class="detail-section">
      <div class="detail-section-title">Notes</div>
      <p class="detail-notes">${escapeHtml(s.notes)}</p>
    </div>` : ""}
  `;

  document.getElementById("viewEditBtn").onclick = () => {
    closeModal();
    setTimeout(() => openEditSupplierModal(id), 220);
  };

  // Wire up balance editing
  if (isEditingBalance) {
    wireUpBalanceEditor(id);
  } else {
    const editBalanceBtn = document.getElementById("editBalanceBtn");
    if (editBalanceBtn) {
      editBalanceBtn.onclick = () => {
        editingBalanceSupplierId = id;
        viewSupplier(id); // re-render with editor open
      };
    }
  }

  openModal("viewSupplierModal");
}

function wireUpBalanceEditor(supplierId) {
  const input = document.getElementById("balanceInput");
  const saveBtn = document.getElementById("saveBalanceBtn");
  const cancelBtn = document.getElementById("cancelBalanceBtn");

  if (!input || !saveBtn || !cancelBtn) return;

  setTimeout(() => { input.focus(); input.select(); }, 100);

  const doSave = async () => {
    const newBalance = Number(input.value);
    if (isNaN(newBalance) || newBalance < 0) {
      input.style.borderColor = "var(--danger)";
      input.focus();
      return;
    }

    const original = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    const ok = await updateSupplierBalance(supplierId, newBalance);

    saveBtn.disabled = false;
    saveBtn.innerHTML = original;

    if (ok) {
      editingBalanceSupplierId = null;
      showNotification('Balance updated successfully!', 'fa-circle-check');
      viewSupplier(supplierId); // re-render with updated value
    }
  };

  saveBtn.onclick = doSave;

  cancelBtn.onclick = () => {
    editingBalanceSupplierId = null;
    viewSupplier(supplierId);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelBtn.click();
    }
  });

  input.addEventListener("input", () => {
    input.style.borderColor = "";
  });
}

/* ---------------------------------------------------------
   DELETE CONFIRMATION
   --------------------------------------------------------- */

function openDeleteConfirmation(id) {
  const s = suppliers.find(x => x.id === id);
  if (!s) return;
  pendingDeleteId = id;
  document.getElementById("deleteConfirmText").textContent =
    `Deleting "${s.name}" will remove them from your current supplier list. This cannot be undone.`;
  openModal("deleteConfirmModal");
}

document.getElementById("confirmDeleteBtn").addEventListener("click", async () => {
  if (!pendingDeleteId) return;
  await deleteSupplier(pendingDeleteId);
  pendingDeleteId = null;
  closeModal();
  currentPage = 1;
  // Data will auto-update via listener
});

/* ---------------------------------------------------------
   MODAL SYSTEM (generic)
   --------------------------------------------------------- */

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

  const firstInput = modal.querySelector("input:not([type=hidden]), select, textarea");
  if (firstInput) setTimeout(() => firstInput.focus(), 150);
}

function closeModal() {
  if (!activeModalId) return;
  const modal = document.getElementById(activeModalId);
  const overlay = document.getElementById("modalOverlay");

  modal.classList.remove("open");
  overlay.classList.remove("open");

  setTimeout(() => { modal.hidden = true; }, 220);
  activeModalId = null;
  editingBalanceSupplierId = null;
}