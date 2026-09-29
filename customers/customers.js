/* =========================================================
   MoeezFlow — Customers Module
   Firebase / Firestore
   Compatible with Sales Module
   With inline outstanding balance editing
   ========================================================= */

import { auth, db } from "../js/firebase.js";
import { renderMetricCards } from "../js/metric-cards.js";

import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";


/* =========================================================
   STATE
   ========================================================= */

let customers = [];

let currentPage = 1;
const PAGE_SIZE = 10;

let searchQuery = "";
let filters = {
  type: "",
  status: "",
  balance: ""
};

let editingCustomerId = null;
let pendingDeleteId = null;

let unsubscribeCustomers = null;
let unsubscribeSales = null;

let activeModalId = null;

// Map of customerId -> outstanding balance calculated from Sales.
// Only used for customers that DON'T have a manual balance flag.
let outstandingMap = {};

// Tracks which customer's outstanding balance is currently being edited inline
let editingBalanceCustomerId = null;


/* =========================================================
   HELPERS
   ========================================================= */

const $ = id => document.getElementById(id);

function number(value) {
  return Number(value) || 0;
}

function nowISO() {
  return new Date().toISOString();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function generateId() {
  return (
    "CUST-" +
    Date.now().toString(36).toUpperCase() +
    Math.floor(Math.random() * 1000)
  );
}

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric"
  });
}

function formatMoney(value) {
  return (
    "PKR " +
    number(value).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  );
}

function getInitials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);

  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function statusPillClass(status) {
  return status === "Active" ? "status-active" : "status-inactive";
}

function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function showNotification(message, icon = "fa-circle-check", isError = false) {
  const toast = $("toast");
  if (!toast) return;

  toast.classList.toggle("toast-error", !!isError);
  toast.innerHTML = `<i class="fas ${icon}"></i> ` + escapeHtml(message);
  toast.classList.add("show");

  clearTimeout(showNotification.timer);
  showNotification.timer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3200);
}


/* =========================================================
   FIRESTORE
   ========================================================= */

function customersCollection() {
  return collection(db, "customers");
}

function salesCollection() {
  return collection(db, "sales");
}


/* =========================================================
   LOAD CUSTOMERS (one-shot)
   ========================================================= */

async function loadCustomers() {
  const user = auth.currentUser;

  if (!user) {
    customers = [];
    return;
  }

  try {
    const q = query(
      customersCollection(),
      where("ownerId", "==", user.uid)
    );

    const snapshot = await getDocs(q);

    customers = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));

    renderStatistics();
    renderCustomers();

  } catch (error) {
    console.error("Could not load customers:", error);
    showNotification(
      "Could not load customers.",
      "fa-triangle-exclamation",
      true
    );
  }
}


/* =========================================================
   REALTIME CUSTOMERS
   ========================================================= */

function setupCustomersRealtime() {
  const user = auth.currentUser;
  if (!user) return;

  if (unsubscribeCustomers) {
    unsubscribeCustomers();
    unsubscribeCustomers = null;
  }

  const q = query(
    customersCollection(),
    where("ownerId", "==", user.uid)
  );

  unsubscribeCustomers = onSnapshot(
    q,
    snapshot => {
      // Replace the entire array — no merging, no overrides.
      // The Firestore document IS the source of truth now.
      customers = snapshot.docs.map(item => ({
        id: item.id,
        ...item.data()
      }));

      renderStatistics();
      renderCustomers();
    },
    error => {
      console.error("Customers realtime error:", error);
      showNotification(
        "Could not load customers.",
        "fa-triangle-exclamation",
        true
      );
    }
  );
}


/* =========================================================
   SALES BALANCES (fallback for non-manual customers)
   ========================================================= */

async function loadSalesBalances() {
  const user = auth.currentUser;
  outstandingMap = {};

  if (!user) return;

  try {
    const q = query(salesCollection(), where('ownerId', '==', user.uid));
    const snapshot = await getDocs(q);

    snapshot.docs.forEach(docItem => {
      const s = docItem.data();
      const cid = s.customerId;
      if (!cid) return;

      const bal = Number(s.balance) || 0;
      if (!outstandingMap[cid]) outstandingMap[cid] = 0;
      outstandingMap[cid] += bal;
    });

  } catch (error) {
    console.error('Could not load sales for balances:', error);
  }
}

function setupSalesRealtimeForCustomers() {
  const user = auth.currentUser;
  if (!user) return;

  if (unsubscribeSales) {
    unsubscribeSales();
    unsubscribeSales = null;
  }

  const q = query(salesCollection(), where('ownerId', '==', user.uid));

  unsubscribeSales = onSnapshot(
    q,
    snapshot => {
      outstandingMap = {};

      snapshot.docs.forEach(docItem => {
        const s = docItem.data();
        const cid = s.customerId;
        if (!cid) return;

        const bal = Number(s.balance) || 0;
        if (!outstandingMap[cid]) outstandingMap[cid] = 0;
        outstandingMap[cid] += bal;
      });

      // Re-render — but getStoredCustomerBalance() ignores outstandingMap
      // for customers flagged as manually balanced.
      renderCustomers();
      renderStatistics();
    },
    error => {
      console.error('Sales realtime (for balances) error:', error);
    }
  );
}


/* =========================================================
   OUTSTANDING BALANCE — single source of truth
   ========================================================= */

/**
 * Returns the balance to display for a customer.
 *
 * Priority:
 *   1. If the customer has been manually balanced (hasManualBalance flag
 *      set in Firestore), use customer.outstandingBalance.
 *   2. Otherwise, use the sales-derived balance if available.
 *   3. Otherwise, fall back to customer.outstandingBalance.
 */
function getStoredCustomerBalance(customer) {
  if (!customer) return 0;

  if (customer.hasManualBalance === true) {
    return number(customer.outstandingBalance);
  }

  if (outstandingMap && outstandingMap[customer.id] != null) {
    return Number(outstandingMap[customer.id]) || 0;
  }

  return number(customer.outstandingBalance);
}

async function getCustomerOutstandingBalance(customerId) {
  if (!customerId) return 0;
  const customer = customers.find(c => c.id === customerId);
  return getStoredCustomerBalance(customer);
}

function getCustomerTransactionHistory(customerId) {
  return [];
}

function getCustomerTotals(customerId) {
  const customer = customers.find(item => item.id === customerId);

  if (!customer) {
    return {
      totalSales: 0,
      totalPaid: 0,
      lastTransactionDate: null
    };
  }

  return {
    totalSales: number(customer.totalSales),
    totalPaid: number(customer.totalPaid),
    lastTransactionDate: customer.lastTransactionDate || null
  };
}


/* =========================================================
   UPDATE OUTSTANDING BALANCE
   ========================================================= */

async function updateCustomerOutstandingBalance(customerId, newBalance) {
  const user = auth.currentUser;

  if (!user) {
    showNotification("Please sign in first.", "fa-triangle-exclamation", true);
    return false;
  }

  const value = Number(newBalance);

  if (Number.isNaN(value) || value < 0) {
    showNotification(
      "Enter a valid non-negative amount.",
      "fa-triangle-exclamation",
      true
    );
    return false;
  }

  // Optimistic local update — mark the customer as manually balanced
  // and set the balance. This is picked up immediately by getStoredCustomerBalance.
  const existing = customers.find(c => c.id === customerId);
  const previousBalance = existing ? existing.outstandingBalance : undefined;
  const previousManualFlag = existing ? existing.hasManualBalance : undefined;

  if (existing) {
    existing.outstandingBalance = value;
    existing.hasManualBalance = true;
  }

  renderStatistics();
  renderCustomers();

  try {
    const reference = doc(db, "customers", customerId);

    await updateDoc(reference, {
      outstandingBalance: value,
      hasManualBalance: true,
      updatedAt: nowISO()
    });

    return true;
  } catch (error) {
    console.error("Could not update outstanding balance:", error);

    // Roll back the optimistic change
    if (existing) {
      existing.outstandingBalance = previousBalance;
      existing.hasManualBalance = previousManualFlag;
    }

    showNotification(
      "Could not update outstanding balance.",
      "fa-triangle-exclamation",
      true
    );

    renderStatistics();
    renderCustomers();

    return false;
  }
}


/* =========================================================
   INITIALIZE
   ========================================================= */

function initializeCustomers() {
  const emptyState = $("emptyState");
  if (emptyState) {
    emptyState.style.display = 'none';
    emptyState.hidden = true;
  }

  setupSidebar();
  setupNavigation();
  setupToolbar();
  setupModals();
  setupCustomerForm();
  setupCustomerButtons();
  setupDeleteButton();

  auth.onAuthStateChanged(async user => {
    if (!user) {
      customers = [];
      renderStatistics();
      renderCustomers();
      return;
    }

    try {
      await loadCustomers();
      setupCustomersRealtime();
      await loadSalesBalances();
      setupSalesRealtimeForCustomers();
    } catch (error) {
      console.error("Customer initialization failed:", error);
      showNotification(
        "Could not initialize Customers.",
        "fa-triangle-exclamation",
        true
      );
    }
  });
}


/* =========================================================
   CUSTOMER BUTTONS
   ========================================================= */

function setupCustomerButtons() {
  const addButton = $("openAddCustomerBtn");
  if (addButton) addButton.addEventListener("click", openAddCustomerModal);

  const emptyButton = $("emptyStateAddBtn");
  if (emptyButton) emptyButton.addEventListener("click", openAddCustomerModal);
}


/* =========================================================
   SIDEBAR
   ========================================================= */

function setupSidebar() {
  const sidebar = $("sidebar");
  const overlay = $("sidebarOverlay");
  const openBtn = $("menuToggle");
  const closeBtn = $("sidebarClose");

  if (!sidebar || !overlay || !openBtn || !closeBtn) return;

  function openSidebar() {
    sidebar.classList.add("open");
    overlay.classList.add("open");
    openBtn.setAttribute("aria-expanded", "true");
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    overlay.classList.remove("open");
    openBtn.setAttribute("aria-expanded", "false");
  }

  openBtn.addEventListener("click", openSidebar);
  closeBtn.addEventListener("click", closeSidebar);
  overlay.addEventListener("click", closeSidebar);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeSidebar();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 860) closeSidebar();
  });
}


/* =========================================================
   NAVIGATION
   ========================================================= */

function setupNavigation() {
  const logout = $("logoutBtn");
  if (!logout) return;

  logout.addEventListener("click", async event => {
    event.preventDefault();

    try {
      const { signOut } = await import(
        "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js"
      );

      await signOut(auth);
      window.location.href = "../auth/login.html";
    } catch (error) {
      console.error("Logout failed:", error);
      showNotification(
        "Could not logout.",
        "fa-triangle-exclamation",
        true
      );
    }
  });
}


/* =========================================================
   STATISTICS
   ========================================================= */

function calculateStatistics() {
  const total = customers.length;
  const active = customers.filter(c => c.status === "Active").length;

  const balances = customers.map(c => getStoredCustomerBalance(c));

  const withBalance = balances.filter(b => b > 0).length;

  const totalOutstanding = balances.reduce((sum, b) => sum + b, 0);

  return { total, active, withBalance, totalOutstanding };
}


function renderStatistics() {
  const grid = $("statsGrid");
  if (!grid) return;

  const statistics = calculateStatistics();
  const activePct = statistics.total
    ? Math.round((statistics.active / statistics.total) * 100)
    : 0;

  renderMetricCards(grid, [
    { label: "Total Customers", icon: "fa-user-group", value: statistics.total.toLocaleString(), delta: { cls: "neutral", text: "—" }, foot: "all customers" },
    { label: "Active Customers", icon: "fa-user-check", value: statistics.active.toLocaleString(), delta: { cls: "up", text: `${activePct}%` }, foot: "currently active" },
    { label: "Outstanding Balance", icon: "fa-triangle-exclamation", value: statistics.withBalance.toLocaleString(), delta: { cls: statistics.withBalance > 0 ? "down" : "neutral", text: statistics.withBalance > 0 ? "Due" : "Clear" }, foot: "customers with balance" },
    { label: "Total Outstanding Amount", icon: "fa-sack-dollar", value: formatMoney(statistics.totalOutstanding), delta: { cls: statistics.totalOutstanding > 0 ? "down" : "up", text: statistics.totalOutstanding > 0 ? "Due" : "Clear" }, foot: "receivables" }
  ]);
}


/* =========================================================
   FILTER OPTIONS
   ========================================================= */

function refreshFilterOptions() {
  const cityOptions = $("cityOptions");
  if (!cityOptions) return;

  const cities = [
    ...new Set(customers.map(c => c.city).filter(Boolean))
  ].sort((a, b) => a.localeCompare(b));

  cityOptions.innerHTML = cities
    .map(city => `<option value="${escapeHtml(city)}"></option>`)
    .join("");
}


/* =========================================================
   TOOLBAR
   ========================================================= */

function setupToolbar() {
  const search = $("searchInput");
  if (search) {
    search.addEventListener("input", event => {
      searchQuery = event.target.value.trim().toLowerCase();
      currentPage = 1;
      renderCustomers();
    });
  }

  const type = $("filterType");
  if (type) {
    type.addEventListener("change", event => {
      filters.type = event.target.value;
      currentPage = 1;
      renderCustomers();
    });
  }

  const status = $("filterStatus");
  if (status) {
    status.addEventListener("change", event => {
      filters.status = event.target.value;
      currentPage = 1;
      renderCustomers();
    });
  }

  const balance = $("filterBalance");
  if (balance) {
    balance.addEventListener("change", event => {
      filters.balance = event.target.value;
      currentPage = 1;
      renderCustomers();
    });
  }

  const clear = $("clearFiltersBtn");
  if (clear) {
    clear.addEventListener("click", () => {
      filters = { type: "", status: "", balance: "" };
      searchQuery = "";

      if ($("searchInput")) $("searchInput").value = "";
      if ($("filterType")) $("filterType").value = "";
      if ($("filterStatus")) $("filterStatus").value = "";
      if ($("filterBalance")) $("filterBalance").value = "";

      currentPage = 1;
      renderCustomers();
    });
  }
}


/* =========================================================
   FILTER CUSTOMERS
   ========================================================= */

function getFilteredCustomers() {
  let list = [...customers];

  if (searchQuery) {
    list = list.filter(c => {
      const haystack = [c.name, c.company, c.phone, c.email, c.city]
        .join(" ").toLowerCase();
      return haystack.includes(searchQuery);
    });
  }

  if (filters.type) list = list.filter(c => c.type === filters.type);
  if (filters.status) list = list.filter(c => c.status === filters.status);

  if (filters.balance === "has") {
    list = list.filter(c => getStoredCustomerBalance(c) > 0);
  }

  if (filters.balance === "none") {
    list = list.filter(c => getStoredCustomerBalance(c) <= 0);
  }

  list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return list;
}


/* =========================================================
   RENDER CUSTOMERS
   ========================================================= */

function renderCustomers() {
  refreshFilterOptions();

  const tbody = $("customersTableBody");
  const table = $("customersTable");
  const emptyState = $("emptyState");
  const pagination = $("pagination");
  const toolbarPanel = document.querySelector(".toolbar-panel");

  if (!tbody) return;

  const filtered = getFilteredCustomers();

  if (customers.length === 0) {
    if (table) { table.style.display = 'none'; table.hidden = true; }
    if (pagination) { pagination.style.display = 'none'; pagination.hidden = true; }
    if (toolbarPanel) toolbarPanel.style.display = "none";
    if (emptyState) { emptyState.style.display = ''; emptyState.hidden = false; }
    if ($("emptyStateTitle")) $("emptyStateTitle").textContent = "No customers yet";
    if ($("emptyStateText")) $("emptyStateText").textContent = "Add your first customer to start tracking sales and balances.";
    if ($("emptyStateAddBtn")) $("emptyStateAddBtn").hidden = false;

    tbody.innerHTML = "";
    renderStatistics();
    return;
  }

  if (toolbarPanel) toolbarPanel.style.display = "";

  if (filtered.length === 0) {
    if (table) { table.style.display = 'none'; table.hidden = true; }
    if (pagination) { pagination.style.display = 'none'; pagination.hidden = true; }
    if (emptyState) { emptyState.style.display = ''; emptyState.hidden = false; }
    if ($("emptyStateTitle")) $("emptyStateTitle").textContent = "No matching customers";
    if ($("emptyStateText")) $("emptyStateText").textContent = "Try adjusting your search or filters.";
    if ($("emptyStateAddBtn")) $("emptyStateAddBtn").hidden = true;

    tbody.innerHTML = "";
    renderStatistics();
    return;
  }

  if (emptyState) { emptyState.style.display = 'none'; emptyState.hidden = true; }
  if (table) { table.style.display = ''; table.hidden = false; }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);

  tbody.innerHTML = pageItems.map(customer => {
    const balance = getStoredCustomerBalance(customer);
    const totals = getCustomerTotals(customer.id);

    return `
      <tr data-id="${customer.id}">
        <td>
          <div class="customer-cell">
            <div class="customer-avatar">${getInitials(customer.name)}</div>
            <div>
              <div class="customer-cell-name">${escapeHtml(customer.name)}</div>
              <div class="customer-cell-sub">${escapeHtml(customer.type || "—")}</div>
            </div>
          </div>
        </td>
        <td>${escapeHtml(customer.company || "—")}</td>
        <td class="cell-mono">${escapeHtml(customer.phone || "—")}</td>
        <td>${escapeHtml(customer.email || "—")}</td>
        <td>${escapeHtml(customer.city || "—")}</td>
        <td>
          ${balance > 0
            ? `<span class="status-pill status-has-balance">${formatMoney(balance)}</span>`
            : `<span class="status-pill status-no-balance">${formatMoney(0)}</span>`
          }
        </td>
        <td>
          <span class="status-pill ${statusPillClass(customer.status)}">
            ${escapeHtml(customer.status || "Active")}
          </span>
        </td>
        <td class="cell-muted">${formatDate(totals.lastTransactionDate)}</td>
        <td>
          <div class="row-actions">
            <button class="row-action-btn" data-action="view" data-id="${customer.id}" aria-label="View customer">
              <i class="fas fa-eye"></i>
            </button>
            <button class="row-action-btn" data-action="edit" data-id="${customer.id}" aria-label="Edit customer">
              <i class="fas fa-pen"></i>
            </button>
            <button class="row-action-btn danger" data-action="delete" data-id="${customer.id}" aria-label="Delete customer">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll("[data-action]").forEach(button => {
    button.addEventListener("click", () => {
      const id = button.dataset.id;
      const action = button.dataset.action;

      if (action === "view") viewCustomer(id);
      if (action === "edit") editCustomer(id);
      if (action === "delete") openDeleteConfirmation(id);
    });
  });

  renderPagination(filtered.length, totalPages);
  renderStatistics();
}


/* =========================================================
   PAGINATION
   ========================================================= */

function renderPagination(totalItems, totalPages) {
  const pagination = $("pagination");
  const info = $("paginationInfo");
  const controls = $("paginationControls");

  if (!pagination || !info || !controls) return;

  pagination.style.display = '';
  pagination.hidden = false;

  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, totalItems);

  info.textContent = `Showing ${start}–${end} of ${totalItems} customers`;

  let html = `
    <button class="page-btn" id="prevPageBtn" ${currentPage === 1 ? "disabled" : ""} aria-label="Previous page">
      <i class="fas fa-chevron-left"></i>
    </button>
  `;

  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 1) {
      html += `<button class="page-btn ${i === currentPage ? "active" : ""}" data-page="${i}">${i}</button>`;
    } else if (Math.abs(i - currentPage) === 2) {
      html += `<span style="color:var(--gray-500);padding:0 4px;">…</span>`;
    }
  }

  html += `
    <button class="page-btn" id="nextPageBtn" ${currentPage === totalPages ? "disabled" : ""} aria-label="Next page">
      <i class="fas fa-chevron-right"></i>
    </button>
  `;

  controls.innerHTML = html;

  const previous = $("prevPageBtn");
  const next = $("nextPageBtn");

  if (previous) {
    previous.addEventListener("click", () => {
      if (currentPage > 1) { currentPage--; renderCustomers(); }
    });
  }

  if (next) {
    next.addEventListener("click", () => {
      if (currentPage < totalPages) { currentPage++; renderCustomers(); }
    });
  }

  controls.querySelectorAll("[data-page]").forEach(button => {
    button.addEventListener("click", () => {
      currentPage = Number(button.dataset.page);
      renderCustomers();
    });
  });
}


/* =========================================================
   ADD CUSTOMER
   ========================================================= */

async function addCustomer(data) {
  const user = auth.currentUser;

  if (!user) {
    showNotification("Please sign in first.", "fa-triangle-exclamation", true);
    return null;
  }

  const openingBalance = number(data.openingBalance);

  const customerData = {
    ownerId: user.uid,
    ...data,
    openingBalance,
    outstandingBalance: openingBalance,
    // If opening balance is non-zero, mark as manually balanced so the
    // value is respected instead of the sales-derived default.
    hasManualBalance: openingBalance > 0,
    totalSales: 0,
    totalPaid: 0,
    lastTransactionDate: null,
    createdAt: nowISO(),
    updatedAt: nowISO()
  };

  try {
    const reference = await addDoc(customersCollection(), customerData);

    return {
      id: reference.id,
      ...customerData
    };
  } catch (error) {
    console.error("Add customer failed:", error);
    throw error;
  }
}


/* =========================================================
   UPDATE CUSTOMER
   ========================================================= */

async function updateCustomer(id, data) {
  const user = auth.currentUser;

  if (!user) throw new Error("Please sign in first.");

  const reference = doc(db, "customers", id);
  await updateDoc(reference, {
    ...data,
    updatedAt: nowISO()
  });
}


/* =========================================================
   DELETE CUSTOMER
   ========================================================= */

async function deleteCustomer(id) {
  const user = auth.currentUser;

  if (!user) throw new Error("Please sign in first.");

  const reference = doc(db, "customers", id);
  await deleteDoc(reference);
}


/* =========================================================
   EDIT CUSTOMER
   ========================================================= */

function editCustomer(id) {
  openEditCustomerModal(id);
}


/* =========================================================
   ADD MODAL
   ========================================================= */

function openAddCustomerModal() {
  editingCustomerId = null;

  const title = $("customerFormTitle");
  if (title) title.innerHTML = '<i class="fas fa-user-plus"></i> Add Customer';

  const submit = $("customerFormSubmitBtn");
  if (submit) submit.textContent = "Add Customer";

  resetCustomerForm();
  openModal("customerFormModal");
}


/* =========================================================
   EDIT MODAL
   ========================================================= */

function openEditCustomerModal(id) {
  const customer = customers.find(item => item.id === id);
  if (!customer) return;

  editingCustomerId = id;

  const title = $("customerFormTitle");
  if (title) title.innerHTML = '<i class="fas fa-pen"></i> Edit Customer';

  const submit = $("customerFormSubmitBtn");
  if (submit) submit.textContent = "Save Changes";

  resetCustomerForm();
  fillCustomerForm(customer);
  openModal("customerFormModal");
}


/* =========================================================
   RESET FORM
   ========================================================= */

function resetCustomerForm() {
  const form = $("customerForm");
  if (!form) return;

  form.reset();
  form.querySelectorAll(".form-row").forEach(row => row.classList.remove("invalid"));

  if ($("customerId")) $("customerId").value = "";
  if ($("fType")) $("fType").value = "Individual";
  if ($("fStatus")) $("fStatus").value = "Active";
  if ($("fOpeningBalance")) $("fOpeningBalance").value = "";
}


/* =========================================================
   FILL FORM
   ========================================================= */

function fillCustomerForm(customer) {
  if ($("customerId")) $("customerId").value = customer.id;
  if ($("fName")) $("fName").value = customer.name || "";
  if ($("fCompany")) $("fCompany").value = customer.company || "";
  if ($("fPhone")) $("fPhone").value = customer.phone || "";
  if ($("fEmail")) $("fEmail").value = customer.email || "";
  if ($("fAddress")) $("fAddress").value = customer.address || "";
  if ($("fCity")) $("fCity").value = customer.city || "";
  if ($("fTaxNumber")) $("fTaxNumber").value = customer.taxNumber || "";
  if ($("fType")) $("fType").value = customer.type || "Individual";
  if ($("fStatus")) $("fStatus").value = customer.status || "Active";
  if ($("fOpeningBalance")) $("fOpeningBalance").value = customer.openingBalance ?? "";
  if ($("fNotes")) $("fNotes").value = customer.notes || "";
}


/* =========================================================
   CUSTOMER FORM
   ========================================================= */

function setupCustomerForm() {
  const form = $("customerForm");
  if (!form) {
    console.warn("MoeezFlow Customers: #customerForm not found.");
    return;
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();

    const result = validateCustomerForm();
    if (!result.valid) return;

    const submitButton = $("customerFormSubmitBtn");

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = editingCustomerId ? "Saving..." : "Adding...";
    }

    try {
      if (editingCustomerId) {
        await updateCustomer(editingCustomerId, result.data);
        showNotification("Customer updated successfully.");
      } else {
        await addCustomer(result.data);
        showNotification("Customer added successfully.");
      }

      closeModal();
      currentPage = 1;
    } catch (error) {
      console.error("Customer save failed:", error);
      showNotification(
        error.message || "Could not save customer.",
        "fa-triangle-exclamation",
        true
      );
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = editingCustomerId ? "Save Changes" : "Add Customer";
      }
    }
  });
}


/* =========================================================
   VALIDATE FORM
   ========================================================= */

function validateCustomerForm() {
  const fields = {
    name: $("fName"),
    phone: $("fPhone"),
    email: $("fEmail"),
    openingBalance: $("fOpeningBalance")
  };

  Object.values(fields).filter(Boolean).forEach(field => {
    const row = field.closest(".form-row");
    if (row) row.classList.remove("invalid");
  });

  let valid = true;

  function markInvalid(field) {
    const row = field.closest(".form-row");
    if (row) row.classList.add("invalid");
    valid = false;
  }

  const name = fields.name?.value.trim() || "";
  if (!name) markInvalid(fields.name);

  const phone = fields.phone?.value.trim() || "";
  if (!phone) markInvalid(fields.phone);

  const email = fields.email?.value.trim() || "";
  if (email && !isValidEmail(email)) markInvalid(fields.email);

  const openingBalanceRaw = fields.openingBalance?.value || "";
  if (openingBalanceRaw !== "" && number(openingBalanceRaw) < 0) {
    markInvalid(fields.openingBalance);
  }

  if (!valid) {
    showNotification(
      "Please correct the highlighted fields.",
      "fa-triangle-exclamation",
      true
    );
    return { valid: false };
  }

  const data = {
    name,
    company: $("fCompany")?.value.trim() || "",
    phone,
    email,
    address: $("fAddress")?.value.trim() || "",
    city: $("fCity")?.value.trim() || "",
    taxNumber: $("fTaxNumber")?.value.trim() || "",
    type: $("fType")?.value || "Individual",
    status: $("fStatus")?.value || "Active",
    openingBalance: number(openingBalanceRaw),
    notes: $("fNotes")?.value.trim() || ""
  };

  return { valid: true, data };
}


/* =========================================================
   VIEW CUSTOMER
   ========================================================= */

function viewCustomer(id) {
  const customer = customers.find(item => item.id === id);
  if (!customer) return;

  const balance = getStoredCustomerBalance(customer);
  const totals = getCustomerTotals(customer.id);
  const history = getCustomerTransactionHistory(customer.id);
  const isEditingBalance = editingBalanceCustomerId === id;

  const body = $("viewCustomerBody");
  if (!body) return;

  body.innerHTML = `
    <div class="detail-header">
      <div class="detail-avatar">${getInitials(customer.name)}</div>
      <div>
        <div class="detail-header-name">${escapeHtml(customer.name)}</div>
        <div class="detail-header-sub">
          ${escapeHtml(customer.company || "No company")}
          &nbsp;·&nbsp;
          <span class="status-pill ${statusPillClass(customer.status)}">
            ${escapeHtml(customer.status || "Active")}
          </span>
        </div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Contact Information</div>
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-item-label">Phone</span>
          <span class="detail-item-value mono">${escapeHtml(customer.phone || "—")}</span>
        </div>
        <div class="detail-item">
          <span class="detail-item-label">Email</span>
          <span class="detail-item-value">${escapeHtml(customer.email || "—")}</span>
        </div>
        <div class="detail-item">
          <span class="detail-item-label">Type</span>
          <span class="detail-item-value">${escapeHtml(customer.type || "—")}</span>
        </div>
        <div class="detail-item">
          <span class="detail-item-label">Address</span>
          <span class="detail-item-value">${escapeHtml(customer.address || "—")}</span>
        </div>
        <div class="detail-item">
          <span class="detail-item-label">City</span>
          <span class="detail-item-value">${escapeHtml(customer.city || "—")}</span>
        </div>
        <div class="detail-item">
          <span class="detail-item-label">Tax / NTN Number</span>
          <span class="detail-item-value mono">${escapeHtml(customer.taxNumber || "—")}</span>
        </div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Financial Summary</div>
      <div class="detail-financial-grid">
        <div class="detail-financial-card">
          <div class="detail-financial-label">Total Sales</div>
          <div class="detail-financial-value">${formatMoney(totals.totalSales)}</div>
        </div>
        <div class="detail-financial-card">
          <div class="detail-financial-label">Total Paid</div>
          <div class="detail-financial-value">${formatMoney(totals.totalPaid)}</div>
        </div>
        <div class="detail-financial-card">
          <div class="detail-financial-label">Outstanding Balance</div>
          <div class="detail-financial-value" id="balanceDisplay">${formatMoney(balance)}</div>
          ${isEditingBalance ? `
            <div class="balance-edit-wrap">
              <input type="number" id="balanceInput" min="0" step="0.01" value="${Number(balance) || 0}" aria-label="Outstanding balance">
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
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Recent Transactions</div>
      ${history.length === 0 ? `
        <div class="empty-state-inline">
          <i class="fas fa-receipt"></i>
          <span>No transactions yet. Transactions will appear once Sales, Invoices and Payments are connected.</span>
        </div>
      ` : `
        <div class="txn-list">
          ${history.map(t => `
            <div class="txn-row">
              <span>${escapeHtml(t.label)}</span>
              <span class="cell-mono">${formatMoney(t.amount)}</span>
            </div>
          `).join("")}
        </div>
      `}
    </div>

    ${customer.notes ? `
      <div class="detail-section">
        <div class="detail-section-title">Notes</div>
        <p class="detail-notes">${escapeHtml(customer.notes)}</p>
      </div>
    ` : ""}
  `;

  const editButton = $("viewEditBtn");
  if (editButton) {
    editButton.onclick = () => {
      closeModal();
      setTimeout(() => openEditCustomerModal(id), 220);
    };
  }

  if (isEditingBalance) {
    wireUpBalanceEditor(id);
  } else {
    const editBalanceBtn = $("editBalanceBtn");
    if (editBalanceBtn) {
      editBalanceBtn.onclick = () => {
        editingBalanceCustomerId = id;
        viewCustomer(id);
      };
    }
  }

  openModal("viewCustomerModal");
}


/* =========================================================
   INLINE BALANCE EDITOR
   ========================================================= */

function wireUpBalanceEditor(customerId) {
  const input = $("balanceInput");
  const saveBtn = $("saveBalanceBtn");
  const cancelBtn = $("cancelBalanceBtn");

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

    const ok = await updateCustomerOutstandingBalance(customerId, newBalance);

    saveBtn.disabled = false;
    saveBtn.innerHTML = original;

    if (ok) {
      editingBalanceCustomerId = null;
      showNotification('Outstanding balance updated successfully!', 'fa-circle-check');
      viewCustomer(customerId);
    }
  };

  saveBtn.onclick = doSave;

  cancelBtn.onclick = () => {
    editingBalanceCustomerId = null;
    viewCustomer(customerId);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doSave(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelBtn.click(); }
  });

  input.addEventListener("input", () => {
    input.style.borderColor = "";
  });
}


/* =========================================================
   DELETE
   ========================================================= */

function openDeleteConfirmation(id) {
  const customer = customers.find(item => item.id === id);
  if (!customer) return;

  pendingDeleteId = id;

  const text = $("deleteConfirmText");
  if (text) {
    text.textContent = `Deleting "${customer.name}" will remove them from your current customer list. This cannot be undone.`;
  }

  openModal("deleteConfirmModal");
}


/* =========================================================
   DELETE BUTTON
   ========================================================= */

function setupDeleteButton() {
  const button = $("confirmDeleteBtn");
  if (!button) return;

  button.addEventListener("click", async () => {
    if (!pendingDeleteId) return;

    const customer = customers.find(item => item.id === pendingDeleteId);

    button.disabled = true;

    try {
      await deleteCustomer(pendingDeleteId);

      const name = customer?.name || "Customer";
      pendingDeleteId = null;
      closeModal();
      currentPage = 1;

      showNotification(`"${name}" deleted.`, "fa-trash");
    } catch (error) {
      console.error("Delete customer failed:", error);
      showNotification(
        error.message || "Could not delete customer.",
        "fa-triangle-exclamation",
        true
      );
    } finally {
      button.disabled = false;
    }
  });
}


/* =========================================================
   MODAL SYSTEM
   ========================================================= */

function setupModals() {
  const overlay = $("modalOverlay");

  document.querySelectorAll("[data-close-modal]").forEach(button => {
    button.addEventListener("click", () => {
      const modal = button.closest(".modal");
      if (modal) closeModal(modal.id);
      else closeModal();
    });
  });

  if (overlay) {
    overlay.addEventListener("click", () => {
      document.querySelectorAll(".modal.open").forEach(modal => {
        closeModal(modal.id);
      });
    });
  }

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && activeModalId) closeModal();
  });
}


function openModal(id) {
  const modal = $(id);
  const overlay = $("modalOverlay");

  if (!modal) {
    console.warn(`MoeezFlow Customers: modal #${id} not found.`);
    return;
  }

  modal.hidden = false;
  modal.classList.add("open");
  if (overlay) overlay.classList.add("open");

  activeModalId = id;

  const firstInput = modal.querySelector("input:not([type=hidden]), select, textarea");
  if (firstInput) setTimeout(() => firstInput.focus(), 150);
}


function closeModal(id = null) {
  const modalId = id || activeModalId;
  if (!modalId) return;

  const modal = $(modalId);
  const overlay = $("modalOverlay");

  if (modal) {
    modal.classList.remove("open");
    setTimeout(() => { modal.hidden = true; }, 220);
  }

  const remaining = document.querySelectorAll(".modal.open");
  if (remaining.length <= 1 && overlay) overlay.classList.remove("open");

  if (activeModalId === modalId) activeModalId = null;

  editingBalanceCustomerId = null;
}


/* =========================================================
   START
   ========================================================= */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeCustomers, { once: true });
} else {
  initializeCustomers();
}