/* =========================================================
MoeezFlow - Products Module + Batch Management
Firebase SDK 12.1.0
========================================================= */

import { auth, db } from '../js/firebase.js';
import { renderMetricCards } from '../js/metric-cards.js';

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
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';

/* =========================================================
STATE
========================================================= */

let products = [];
let selectedIds = new Set();

let editingProductId = null;
let pendingDeleteId = null;
let confirmCallback = null;

let currentPage = 1;

const PAGE_SIZE = 10;

let searchQuery = '';

let filters = {
  category: '',
  status: '',
  stockStatus: ''
};

let sortState = {
  field: 'name',
  dir: 'asc'
};

let unsubscribeProducts = null;

/* =========================================================
BATCH STATE
========================================================= */

let currentBatchProductId = null;
let currentBatchProductName = '';
let batches = [];
let editingBatchId = null;
let confirmBatchDeleteId = null;

/* =========================================================
DOM HELPERS
========================================================= */

const $ = (id) => document.getElementById(id);

function on(id, event, handler) {
  const element = $(id);
  if (!element) return null;
  element.addEventListener(event, handler);
  return element;
}

function setHidden(id, hidden) {
  const element = $(id);
  if (element) element.hidden = hidden;
}

/* =========================================================
GENERAL HELPERS
========================================================= */

function nowISO() {
  return new Date().toISOString();
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function formatMoney(value, currency = 'PKR') {
  const amount = number(value);
  return `${currency} ${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatDate(value) {
  if (!value) return '-';

  let date;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof value.toDate === 'function'
  ) {
    date = value.toDate();
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) return '-';

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric'
  });
}

function showNotification(message, icon = 'fa-circle-check') {
  const toast = $('toast');
  if (!toast) {
    console.log(message);
    return;
  }

  toast.innerHTML = `
    <i class="fas ${icon}"></i>
    ${escapeHtml(message)}
  `;

  toast.classList.add('show');

  clearTimeout(showNotification.timer);
  showNotification.timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3200);
}

/* =========================================================
CONFIRMATION MODAL
========================================================= */

function openConfirm({
  title = 'Are you sure?',
  heading = 'Confirm action',
  text = 'This action cannot be undone.',
  confirmLabel = 'Confirm',
  variant = 'default',
  onConfirm = null
} = {}) {
  const modal = $('confirmModal');
  if (!modal) {
    if (onConfirm) onConfirm();
    return;
  }

  const iconWrap = $('confirmModalIcon');
  const titleEl = $('confirmModalTitle');
  const headingEl = $('confirmModalHeading');
  const textEl = $('confirmModalText');
  const confirmBtn = $('confirmActionBtn');

  const iconMap = {
    default: { icon: 'fa-circle-question', cls: 'confirm-icon-info' },
    danger: { icon: 'fa-triangle-exclamation', cls: 'confirm-icon-danger' },
    warning: { icon: 'fa-circle-exclamation', cls: 'confirm-icon-warn' },
    info: { icon: 'fa-circle-info', cls: 'confirm-icon-info' }
  };

  const meta = iconMap[variant] || iconMap.default;

  if (titleEl) {
    titleEl.innerHTML = `<i class="fas ${meta.icon}"></i> ${escapeHtml(title)}`;
  }

  if (iconWrap) {
    iconWrap.className = `confirm-icon ${meta.cls}`;
    iconWrap.innerHTML = `<i class="fas ${meta.icon}"></i>`;
  }

  if (headingEl) headingEl.textContent = heading;
  if (textEl) textEl.textContent = text;

  if (confirmBtn) {
    confirmBtn.textContent = confirmLabel;
    confirmBtn.classList.remove('btn-danger', 'btn-solid');
    confirmBtn.classList.add(variant === 'danger' ? 'btn-danger' : 'btn-solid');
  }

  confirmCallback = onConfirm;

  modal.hidden = false;
  modal.classList.add('open');
}

function closeConfirm() {
  const modal = $('confirmModal');
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove('open');
  confirmCallback = null;
}

function handleConfirmAction() {
  const callback = confirmCallback;
  closeConfirm();
  if (typeof callback === 'function') callback();
}

/* =========================================================
FIRESTORE REFERENCES
========================================================= */

function getProductsCollection() {
  return collection(db, 'products');
}

function getProductDoc(id) {
  return doc(db, 'products', id);
}

function getBatchesCollection(productId) {
  return collection(db, 'products', productId, 'batches');
}

function getBatchDoc(productId, batchId) {
  return doc(db, 'products', productId, 'batches', batchId);
}

/* =========================================================
BATCH HELPERS
========================================================= */

function toDate(value) {
  if (!value) return null;
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    return value.toDate();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysUntilExpiry(expiry) {
  const d = toDate(expiry);
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

function getExpiryStatus(expiry, nearDays = 90) {
  const days = daysUntilExpiry(expiry);
  if (days === null) return { status: 'Unknown', days: null };
  if (days < 0) return { status: 'Expired', days };
  if (days <= nearDays) return { status: 'Near Expiry', days };
  return { status: 'Valid', days };
}

function expiryPillClass(status) {
  return {
    Expired: 'batch-pill-expired',
    'Near Expiry': 'batch-pill-near',
    Valid: 'batch-pill-valid',
    Unknown: 'batch-pill-unknown'
  }[status] || 'batch-pill-unknown';
}

async function listBatches(productId) {
  if (!productId) return [];
  const snap = await getDocs(getBatchesCollection(productId));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const da = toDate(a.expiryDate);
      const db_ = toDate(b.expiryDate);
      if (!da && !db_) return 0;
      if (!da) return 1;
      if (!db_) return -1;
      return da - db_;
    });
}

function normaliseBatch(data = {}) {
  return {
    batchNumber: String(data.batchNumber ?? '').trim(),
    manufacturingDate: data.manufacturingDate || '',
    expiryDate: data.expiryDate || '',
    quantity: number(data.quantity),
    costPrice: number(data.costPrice),
    sellingPrice: number(data.sellingPrice),
    supplier: String(data.supplier ?? '').trim(),
    purchaseRef: String(data.purchaseRef ?? '').trim(),
    notes: String(data.notes ?? '').trim()
  };
}

async function addBatchToFirestore(productId, data) {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in.');

  const payload = {
    ...normaliseBatch(data),
    ownerId: user.uid,
    createdAt: nowISO(),
    updatedAt: nowISO()
  };

  const ref = await addDoc(getBatchesCollection(productId), payload);
  return { id: ref.id, ...payload };
}

async function updateBatchInFirestore(productId, batchId, data) {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in.');

  const ref = getBatchDoc(productId, batchId);
  const snap = await getDocs(getBatchesCollection(productId));
  const target = snap.docs.find(d => d.id === batchId);
  if (!target) throw new Error('Batch not found.');
  const existing = target.data();
  if (existing.ownerId && existing.ownerId !== user.uid) {
    throw new Error('Permission denied.');
  }

  const payload = {
    ...normaliseBatch(data),
    updatedAt: nowISO()
  };

  await updateDoc(ref, payload);
  return { id: batchId, ...payload };
}

async function deleteBatchFromFirestore(productId, batchId) {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in.');

  const ref = getBatchDoc(productId, batchId);
  const snap = await getDocs(getBatchesCollection(productId));
  const target = snap.docs.find(d => d.id === batchId);
  if (!target) throw new Error('Batch not found.');
  const existing = target.data();
  if (existing.ownerId && existing.ownerId !== user.uid) {
    throw new Error('Permission denied.');
  }

  await deleteDoc(ref);
}

async function syncProductStockFromBatches(productId) {
  if (!productId) return 0;

  const list = await listBatches(productId);
  const total = list.reduce((sum, b) => sum + number(b.quantity), 0);

  await updateDoc(doc(db, 'products', productId), {
    stock: total,
    updatedAt: nowISO()
  });

  return total;
}

async function getBatchSummary(productId) {
  const list = await listBatches(productId);

  let total = 0;
  let expired = 0;
  let nearExpiry = 0;
  let valid = 0;

  for (const b of list) {
    const q = number(b.quantity);
    total += q;

    const { status } = getExpiryStatus(b.expiryDate);
    if (status === 'Expired') expired += q;
    else if (status === 'Near Expiry') nearExpiry += q;
    else if (status === 'Valid') valid += q;
  }

  return {
    batchCount: list.length,
    totalQuantity: total,
    expiredQty: expired,
    nearExpiryQty: nearExpiry,
    validQty: valid
  };
}

/* =========================================================
FIRESTORE - LOAD PRODUCTS
========================================================= */

async function loadProductsFromFirestore() {
  const user = auth.currentUser;

  if (!user) {
    products = [];
    renderProducts();
    return;
  }

  try {
    const productsQuery = query(
      getProductsCollection(),
      where('ownerId', '==', user.uid)
    );

    const snapshot = await getDocs(productsQuery);

    products = snapshot.docs.map(snapshotDoc => ({
      id: snapshotDoc.id,
      ...snapshotDoc.data()
    }));

    selectedIds.clear();
    currentPage = 1;

    renderProducts();
  } catch (error) {
    console.error('Could not load products:', error);

    if (error.code === 'permission-denied') {
      showNotification(
        'Permission denied. Check your Firestore rules.',
        'fa-triangle-exclamation'
      );
    } else {
      showNotification(
        'Could not load products.',
        'fa-triangle-exclamation'
      );
    }
  }
}

/* =========================================================
REALTIME SYNC
========================================================= */

function setupRealtimeSync() {
  const user = auth.currentUser;
  if (!user) return;

  if (unsubscribeProducts) {
    unsubscribeProducts();
    unsubscribeProducts = null;
  }

  const productsQuery = query(
    getProductsCollection(),
    where('ownerId', '==', user.uid)
  );

  unsubscribeProducts = onSnapshot(
    productsQuery,
    snapshot => {
      products = snapshot.docs.map(snapshotDoc => ({
        id: snapshotDoc.id,
        ...snapshotDoc.data()
      }));
      renderProducts();
    },
    error => {
      console.error('Realtime product sync failed:', error);
    }
  );
}

/* =========================================================
FIRESTORE - PRODUCT CRUD
========================================================= */

async function addProductToFirestore(product) {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in to add a product.');

  const record = {
    ...product,
    ownerId: user.uid,
    createdAt: product.createdAt || nowISO(),
    updatedAt: product.updatedAt || nowISO()
  };

  delete record.id;

  const reference = await addDoc(getProductsCollection(), record);
  return { id: reference.id, ...record };
}

async function updateProductInFirestore(id, data) {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in to update a product.');

  const existingProduct = products.find(p => p.id === id);
  if (!existingProduct) throw new Error('Product could not be found.');

  if (existingProduct.ownerId && existingProduct.ownerId !== user.uid) {
    throw new Error('You do not have permission to update this product.');
  }

  const record = { ...data, updatedAt: nowISO() };
  delete record.id;
  delete record.ownerId;

  await updateDoc(getProductDoc(id), record);
}

async function deleteProductFromFirestore(id) {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in to delete a product.');

  const existingProduct = products.find(p => p.id === id);
  if (!existingProduct) throw new Error('Product could not be found.');

  if (existingProduct.ownerId && existingProduct.ownerId !== user.uid) {
    throw new Error('You do not have permission to delete this product.');
  }

  await deleteDoc(getProductDoc(id));
}

/* =========================================================
STOCK STATUS
========================================================= */

function getStockStatus(stock, reorderLevel) {
  const quantity = number(stock);
  const reorder = number(reorderLevel);

  if (quantity <= 0) return 'Out of Stock';
  if (quantity <= reorder) return 'Low Stock';
  return 'In Stock';
}

function stockStatusClass(status) {
  return {
    'In Stock': 'stock-status-in-stock',
    'Low Stock': 'stock-status-low-stock',
    'Out of Stock': 'stock-status-out-of-stock'
  }[status] || 'stock-status-in-stock';
}

function statusPillClass(status) {
  return {
    Active: 'status-active',
    Inactive: 'status-inactive',
    Discontinued: 'status-discontinued'
  }[status] || 'status-active';
}

/* =========================================================
STATISTICS
========================================================= */

function calculateStatistics() {
  return {
    total: products.length,
    active: products.filter(p => p.status === 'Active').length,
    low: products.filter(p =>
      getStockStatus(p.stock, p.reorderLevel) === 'Low Stock'
    ).length,
    out: products.filter(p =>
      getStockStatus(p.stock, p.reorderLevel) === 'Out of Stock'
    ).length,
    stockValue: products.reduce(
      (sum, p) => sum + number(p.costPrice) * number(p.stock),
      0
    ),
    potentialProfit: products.reduce(
      (sum, p) =>
        sum +
        (number(p.sellingPrice) - number(p.costPrice)) * number(p.stock),
      0
    )
  };
}

function showStatisticsLoading() {
  const grid = $('statsGrid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="loading-state">
      <span class="module-spinner" aria-hidden="true"></span>
      Loading metrics...
    </div>
  `;
}

function renderStatistics() {
  const grid = $('statsGrid');
  if (!grid) return;

  const s = calculateStatistics();

  const metrics = [
    {
      label: 'Total Products',
      icon: 'fa-cube',
      value: s.total,
      delta: { cls: 'neutral', icon: 'fa-minus', text: '—' },
      foot: 'all products'
    },
    {
      label: 'Active Products',
      icon: 'fa-circle-check',
      value: s.active,
      delta: { cls: 'up', icon: 'fa-arrow-trend-up', text: 'Active' },
      foot: 'currently active'
    },
    {
      label: 'Low Stock',
      icon: 'fa-triangle-exclamation',
      value: s.low,
      delta: { cls: 'down', icon: 'fa-arrow-trend-down', text: 'Low' },
      foot: 'needs restocking'
    },
    {
      label: 'Out of Stock',
      icon: 'fa-ban',
      value: s.out,
      delta: { cls: 'down', icon: 'fa-arrow-trend-down', text: 'Out' },
      foot: 'unavailable'
    },
    {
      label: 'Total Stock Value',
      icon: 'fa-sack-dollar',
      value: `PKR ${Math.round(s.stockValue).toLocaleString()}`,
      delta: { cls: 'neutral', icon: 'fa-minus', text: '—' },
      foot: 'current inventory'
    },
    {
      label: 'Potential Stock Profit',
      icon: 'fa-chart-pie',
      value: `PKR ${Math.round(s.potentialProfit).toLocaleString()}`,
      delta: { cls: 'up', icon: 'fa-arrow-trend-up', text: 'Potential' },
      foot: 'if all sold'
    }
  ];

  renderMetricCards(grid, metrics);
}

/* =========================================================
FILTER OPTIONS
========================================================= */

function refreshFilterOptions() {
  const unique = field =>
    [...new Set(products.map(p => p[field]).filter(Boolean))].sort((a, b) =>
      String(a).localeCompare(String(b))
    );

  fillSelect('filterCategory', unique('category'), 'All Categories');

  ['category', 'brand', 'supplier', 'location'].forEach(field => {
    const list = $(`${field}Options`);
    if (!list) return;
    list.innerHTML = unique(field)
      .map(value => `<option value="${escapeHtml(value)}"></option>`)
      .join('');
  });
}

function fillSelect(id, values, label) {
  const select = $(id);
  if (!select) return;

  const current = select.value;

  select.innerHTML =
    `<option value="">${escapeHtml(label)}</option>` +
    values
      .map(
        value =>
          `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`
      )
      .join('');

  if (values.includes(current)) select.value = current;
}

/* =========================================================
SEARCH / FILTER / SORT
========================================================= */

function getFilteredSortedProducts() {
  let list = [...products];

  if (searchQuery) {
    list = list.filter(product => {
      const text = [
        product.name,
        product.sku,
        product.barcode,
        product.brand,
        product.category,
        product.supplier
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return text.includes(searchQuery);
    });
  }

  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;

    if (key === 'stockStatus') {
      list = list.filter(
        p => getStockStatus(p.stock, p.reorderLevel) === value
      );
    } else {
      list = list.filter(p => String(p[key] ?? '') === String(value));
    }
  }

  const { field, dir } = sortState;

  list.sort((a, b) => {
    let left = a[field];
    let right = b[field];

    if (field === 'name') {
      left = String(left || '').toLowerCase();
      right = String(right || '').toLowerCase();

      return dir === 'asc'
        ? left.localeCompare(right)
        : right.localeCompare(left);
    }

    if (field === 'createdAt' || field === 'updatedAt') {
      left = convertDateToTime(left);
      right = convertDateToTime(right);
    } else {
      left = number(left);
      right = number(right);
    }

    return dir === 'asc' ? left - right : right - left;
  });

  return list;
}

function convertDateToTime(value) {
  if (!value) return 0;

  if (
    typeof value === 'object' &&
    value !== null &&
    typeof value.toDate === 'function'
  ) {
    return value.toDate().getTime();
  }

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/* =========================================================
RENDER PRODUCTS
========================================================= */

function renderProducts() {
  const tbody = $('productsTableBody');
  if (!tbody) return;

  refreshFilterOptions();

  const table = $('productsTable');
  const emptyState = $('emptyState');
  const pagination = $('pagination');
  const toolbar = document.querySelector('.toolbar-panel');

  const filtered = getFilteredSortedProducts();

  if (products.length > 0) {
    if (emptyState) {
      emptyState.style.display = 'none';
      emptyState.hidden = true;
    }

    if (table) {
      table.style.display = '';
      table.hidden = false;
    }

    if (toolbar) toolbar.style.display = '';

    if (pagination) {
      pagination.style.display = '';
      pagination.hidden = false;
    }

    if (filtered.length === 0) {
      if (table) {
        table.style.display = 'none';
        table.hidden = true;
      }

      if (emptyState) {
        emptyState.style.display = '';
        emptyState.hidden = false;
        if ($('emptyStateTitle'))
          $('emptyStateTitle').textContent = 'No matching products';
        if ($('emptyStateText'))
          $('emptyStateText').textContent =
            'Try adjusting your search or filters.';
        setHidden('emptyStateAddBtn', false);
      }

      tbody.innerHTML = '';
      renderStatistics();
      updateBulkBar();
      return;
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    currentPage = Math.min(currentPage, totalPages);

    const start = (currentPage - 1) * PAGE_SIZE;
    const end = currentPage * PAGE_SIZE;
    const page = filtered.slice(start, end);

    tbody.innerHTML = page
      .map(product => {
        const stockStatus = getStockStatus(
          product.stock,
          product.reorderLevel
        );

        const imageHtml = product.image
          ? `<img class="product-thumb" src="${escapeHtml(product.image)}" alt="">`
          : '';

        return `
          <tr data-id="${escapeHtml(product.id)}">
            <td>
              <input
                class="row-select"
                type="checkbox"
                data-id="${escapeHtml(product.id)}"
                ${selectedIds.has(product.id) ? 'checked' : ''}
              >
            </td>
            <td>
              ${imageHtml}
              <strong>${escapeHtml(product.name)}</strong>
              <small>${escapeHtml(product.sku || '-')}</small>
            </td>
            <td>${escapeHtml(product.category || '-')}</td>
            <td>${formatMoney(product.sellingPrice, product.currency || 'PKR')}</td>
            <td>${number(product.stock)}</td>
            <td>
              <span class="status-pill ${stockStatusClass(stockStatus)}">
                ${stockStatus}
              </span>
            </td>
            <td>
              <span class="status-pill ${statusPillClass(product.status)}">
                ${escapeHtml(product.status || 'Active')}
              </span>
            </td>
            <td>${formatDate(product.updatedAt || product.createdAt)}</td>
            <td>
              <button
                type="button"
                class="table-action table-action-batches"
                data-action="batches"
                data-id="${escapeHtml(product.id)}"
                aria-label="Manage batches"
                title="Manage batches"
              >
                <i class="fas fa-layer-group"></i>
              </button>
              <button
                type="button"
                class="table-action"
                data-action="edit"
                data-id="${escapeHtml(product.id)}"
                aria-label="Edit product"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M4 20h4L19 9l-4-4L4 16v4Z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>
                  <path d="m14 6 4 4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                </svg>
              </button>
              <button
                type="button"
                class="table-action"
                data-action="delete"
                data-id="${escapeHtml(product.id)}"
                aria-label="Delete product"
              >
                <i class="fas fa-trash"></i>
              </button>
            </td>
          </tr>
        `;
      })
      .join('');

    renderPagination(totalPages, filtered.length);
    renderStatistics();
    updateBulkBar();
    updateSelectAllState();
  } else {
    if (table) {
      table.style.display = 'none';
      table.hidden = true;
    }

    if (pagination) {
      pagination.style.display = 'none';
      pagination.hidden = true;
    }

    if (emptyState) {
      emptyState.style.display = '';
      emptyState.hidden = false;
      if ($('emptyStateTitle'))
        $('emptyStateTitle').textContent = 'No products yet';
      if ($('emptyStateText'))
        $('emptyStateText').textContent =
          'Add your first product to start managing your inventory and sales.';
      setHidden('emptyStateAddBtn', false);
    }

    if (toolbar) toolbar.style.display = 'none';

    tbody.innerHTML = '';
    renderStatistics();
    updateBulkBar();
  }
}

/* =========================================================
PAGINATION
========================================================= */

function renderPagination(totalPages, total) {
  const pagination = $('pagination');
  if (!pagination) return;

  pagination.style.display = '';
  pagination.hidden = false;

  pagination.innerHTML = `
    <button type="button" data-page="prev" ${currentPage === 1 ? 'disabled' : ''}>
      Previous
    </button>
    <span>Page ${currentPage} of ${totalPages} (${total})</span>
    <button type="button" data-page="next" ${currentPage === totalPages ? 'disabled' : ''}>
      Next
    </button>
  `;
}

/* =========================================================
FORM HELPERS
========================================================= */

function formField(name) {
  return document.querySelector(
    `#productForm [name="${name}"], #${name}`
  );
}

function setFormValue(name, value) {
  const field = formField(name);
  if (field) field.value = value == null ? '' : value;
}

/* =========================================================
READ FORM
----------------------------------------------------------
Batch-only fields (batchNumber, manufacturingDate, expiryDate)
are NO LONGER part of the product.
========================================================= */

function readForm() {
  const fields = [
    'name','sku','barcode','description','category','brand','status',
    'costPrice','sellingPrice','wholesalePrice','taxRate','discount','currency',
    'stock','minimumStock','maximumStock','reorderLevel','unit','location',
    'supplier','supplierSku','genericName','strength','packSize',
    'manufacturer','image','notes'
  ];

  const numericFields = new Set([
    'costPrice','sellingPrice','wholesalePrice','taxRate','discount',
    'stock','minimumStock','maximumStock','reorderLevel'
  ]);

  const result = {};

  fields.forEach(name => {
    const field = formField(name);

    if (!field) {
      result[name] = numericFields.has(name) ? 0 : '';
      return;
    }

    if (numericFields.has(name)) {
      result[name] = number(field.value);
    } else {
      result[name] = field.value.trim();
    }
  });

  return result;
}

/* =========================================================
RESET FORM
========================================================= */

function resetProductForm() {
  const form = $('productForm');
  if (form) form.reset();

  editingProductId = null;

  setFormValue('status', 'Active');
  setFormValue('currency', 'PKR');
  setFormValue('stock', 0);

  updateImagePreview('');
}

/* =========================================================
ADD PRODUCT MODAL
========================================================= */

function openAddProductModal() {
  if (!auth.currentUser) {
    showNotification(
      'Please sign in before adding a product.',
      'fa-circle-info'
    );
    return;
  }

  resetProductForm();

  if ($('productModalTitle'))
    $('productModalTitle').textContent = 'Add Product';
  if ($('productFormSubmitBtn'))
    $('productFormSubmitBtn').textContent = 'Add Product';

  openModal('productModal');

  setTimeout(() => formField('name')?.focus(), 0);
}

/* =========================================================
EDIT PRODUCT
========================================================= */

function editProduct(id) {
  const product = products.find(item => item.id === id);
  if (!product) return;

  const user = auth.currentUser;

  if (!user || (product.ownerId && product.ownerId !== user.uid)) {
    showNotification(
      'You do not have permission to edit this product.',
      'fa-triangle-exclamation'
    );
    return;
  }

  editingProductId = id;

  Object.entries(product).forEach(([name, value]) => {
    if (name === 'id' || name === 'ownerId') return;
    if (name === 'batchNumber' || name === 'manufacturingDate' || name === 'expiryDate') return;
    setFormValue(name, value);
  });

  if ($('productModalTitle'))
    $('productModalTitle').textContent = 'Edit Product';
  if ($('productFormSubmitBtn'))
    $('productFormSubmitBtn').textContent = 'Save Changes';

  updateImagePreview(product.image || '');

  openModal('productModal');
}

/* =========================================================
MODALS
========================================================= */

function openModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.hidden = false;
  modal.classList.add('open');
}

function closeModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove('open');
}

function updateImagePreview(url) {
  const preview = $('productImagePreview');
  if (!preview) return;

  preview.src = url || '';
  preview.hidden = !url;
}

/* =========================================================
SAVE PRODUCT
----------------------------------------------------------
Product stock is now derived from batches. When saving a
product:
  - If it already has batches → do NOT let the client
    overwrite stock; recompute from batches after save.
  - If it has no batches → allow client stock (legacy
    manual stock still works, but 0 is the natural default).
========================================================= */

async function performSave(data) {
  const form = $('productForm');
  const submitButton = form?.querySelector('[type="submit"]');
  const submitLabel = editingProductId ? 'Save Changes' : 'Add Product';

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.innerHTML =
      '<span class="module-spinner" aria-hidden="true"></span> Saving...';
  }

  try {
    let savedId = editingProductId;

    if (editingProductId) {
      // Preserve existing stock on the client-side payload;
      // it will be re-synced from batches below if batches exist.
      const existing = products.find(p => p.id === editingProductId);
      if (existing) {
        data.stock = number(existing.stock);
      }
      await updateProductInFirestore(editingProductId, data);
      showNotification('Product updated successfully.');
    } else {
      // New product: start stock at 0, batches will fill it in.
      data.stock = 0;
      const created = await addProductToFirestore({
        ...data,
        createdAt: nowISO(),
        updatedAt: nowISO()
      });
      savedId = created.id;
      showNotification('Product added successfully.');
    }

    // If this product has any batches, recompute stock from them
    // so the displayed value never conflicts with batch totals.
    if (savedId) {
      try {
        const list = await listBatches(savedId);
        if (list.length > 0) {
          await syncProductStockFromBatches(savedId);
        }
      } catch (syncError) {
        console.warn('Could not sync product stock from batches:', syncError);
      }
    }

    closeModal('productModal');
    resetProductForm();
  } catch (error) {
    console.error('Saving product failed:', error);

    if (error.code === 'permission-denied') {
      showNotification(
        'Permission denied. Check your Firestore rules.',
        'fa-triangle-exclamation'
      );
    } else {
      showNotification(
        error.message || 'Could not save product.',
        'fa-triangle-exclamation'
      );
    }
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.innerHTML = submitLabel;
    }
  }
}

function saveProduct(event) {
  event.preventDefault();

  const form = $('productForm');
  if (!form) return;

  if (!form.reportValidity()) return;

  const data = readForm();

  if (!data.name) {
    showNotification(
      'Product name is required.',
      'fa-triangle-exclamation'
    );
    return;
  }

  if (!auth.currentUser) {
    showNotification('Please sign in first.', 'fa-circle-info');
    return;
  }

  const productName = data.name;

  if (editingProductId) {
    openConfirm({
      title: 'Save changes?',
      heading: `Update "${productName}"?`,
      text:
        'Your changes will be saved and applied immediately to this product.',
      confirmLabel: 'Save Changes',
      variant: 'info',
      onConfirm: () => performSave(data)
    });
  } else {
    openConfirm({
      title: 'Add new product?',
      heading: `Create "${productName}"?`,
      text:
        'This product will be added to your inventory right away. Add batches to set its stock.',
      confirmLabel: 'Add Product',
      variant: 'info',
      onConfirm: () => performSave(data)
    });
  }
}

/* =========================================================
DELETE PRODUCT
========================================================= */

function requestDelete(id) {
  const product = products.find(item => item.id === id);
  if (!product) return;

  const user = auth.currentUser;

  if (!user || (product.ownerId && product.ownerId !== user.uid)) {
    showNotification(
      'You do not have permission to delete this product.',
      'fa-triangle-exclamation'
    );
    return;
  }

  pendingDeleteId = id;

  const name = product.name || 'this product';

  if ($('deleteModalTitle')) {
    $('deleteModalTitle').innerHTML =
      `<i class="fas fa-trash"></i> Delete Product?`;
  }

  const deleteBody = document.querySelector('#deleteModal .confirm-body p');
  if (deleteBody) {
    deleteBody.innerHTML = `
      You are about to permanently delete
      <span class="highlight">${escapeHtml(name)}</span>.
      This action cannot be undone.
    `;
  }

  openModal('deleteModal');
}

async function confirmDelete() {
  if (!pendingDeleteId) return;

  const id = pendingDeleteId;
  const button = $('confirmDeleteBtn');

  if (button) {
    button.disabled = true;
    button.innerHTML =
      '<span class="module-spinner" aria-hidden="true"></span> Deleting...';
  }

  try {
    await deleteProductFromFirestore(id);
    selectedIds.delete(id);
    showNotification('Product deleted successfully.');
  } catch (error) {
    console.error('Deleting product failed:', error);

    if (error.code === 'permission-denied') {
      showNotification(
        'Permission denied. Check your Firestore rules.',
        'fa-triangle-exclamation'
      );
    } else {
      showNotification(
        error.message || 'Could not delete product.',
        'fa-triangle-exclamation'
      );
    }
  } finally {
    pendingDeleteId = null;

    if (button) {
      button.disabled = false;
      button.innerHTML = 'Delete';
    }

    closeModal('deleteModal');
  }
}

/* =========================================================
TOOLBAR
========================================================= */

function setupToolbar() {
  on('searchInput', 'input', event => {
    searchQuery = event.target.value.trim().toLowerCase();
    currentPage = 1;
    renderProducts();
  });

  ['filterCategory', 'filterStatus', 'filterStockStatus'].forEach(id => {
    on(id, 'change', event => {
      const key = id.replace('filter', '');
      const filterKey = key.charAt(0).toLowerCase() + key.slice(1);

      filters[filterKey] = event.target.value;
      currentPage = 1;
      renderProducts();
    });
  });

  on('clearFiltersBtn', 'click', () => {
    filters = { category: '', status: '', stockStatus: '' };
    searchQuery = '';

    ['searchInput', 'filterCategory', 'filterStatus', 'filterStockStatus']
      .forEach(id => {
        if ($(id)) $(id).value = '';
      });

    currentPage = 1;
    renderProducts();
  });

  on('sortField', 'change', event => {
    sortState.field = event.target.value;
    currentPage = 1;
    renderProducts();
  });

  on('sortDirBtn', 'click', event => {
    const button = event.currentTarget;
    sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    button.dataset.dir = sortState.dir;

    const icon = button.querySelector('i');
    if (icon) {
      icon.className =
        sortState.dir === 'asc'
          ? 'fas fa-arrow-down-short-wide'
          : 'fas fa-arrow-up-wide-short';
    }

    currentPage = 1;
    renderProducts();
  });
}

/* =========================================================
MODALS SETUP
========================================================= */

function setupModals() {
  on('openAddProductBtn', 'click', openAddProductModal);
  on('emptyStateAddBtn', 'click', openAddProductModal);

  on('productForm', 'submit', saveProduct);

  on('closeProductModal', 'click', () => closeModal('productModal'));

  on('cancelProductBtn', 'click', () => {
    const form = $('productForm');
    const dirty = form && form.querySelector('input[name="name"]')?.value;

    if (dirty) {
      openConfirm({
        title: 'Discard changes?',
        heading: 'Discard product details?',
        text: 'Any unsaved changes will be lost.',
        confirmLabel: 'Discard',
        variant: 'danger',
        onConfirm: () => {
          resetProductForm();
          closeModal('productModal');
        }
      });
    } else {
      resetProductForm();
      closeModal('productModal');
    }
  });

  on('cancelDeleteBtn', 'click', () => {
    pendingDeleteId = null;
    closeModal('deleteModal');
  });

  on('confirmDeleteBtn', 'click', confirmDelete);

  on('cancelConfirmBtn', 'click', closeConfirm);
  on('closeConfirmModal', 'click', closeConfirm);
  on('confirmActionBtn', 'click', handleConfirmAction);

  document.querySelectorAll('[data-close-modal]').forEach(button => {
    button.addEventListener('click', () => {
      closeModal(button.dataset.closeModal);
    });
  });

  document.addEventListener('click', event => {
    if (event.target.classList.contains('modal')) {
      if (event.target.id === 'confirmModal') closeConfirm();
      else closeModal(event.target.id);
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    closeModal('productModal');
    closeModal('deleteModal');
    closeConfirm();
  });
}

/* =========================================================
IMAGE UPLOAD
========================================================= */

function setupImageUpload() {
  on('productImageInput', 'change', event => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > 750 * 1024) {
      showNotification(
        'Image is too large. Please choose an image under 750 KB.',
        'fa-triangle-exclamation'
      );
      event.target.value = '';
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      setFormValue('image', reader.result);
      updateImagePreview(reader.result);
    };

    reader.readAsDataURL(file);
  });

  on('image', 'input', event => updateImagePreview(event.target.value));
}

/* =========================================================
TABLE EVENTS
========================================================= */

function setupTableEvents() {
  const table = $('productsTable');
  if (!table) return;

  table.addEventListener('click', event => {
    const action = event.target.closest('[data-action]');

    if (action) {
      const id = action.dataset.id;

      if (action.dataset.action === 'batches') {
        const product = products.find(p => p.id === id);
        if (!product) return;

        const user = auth.currentUser;
        if (!user || (product.ownerId && product.ownerId !== user.uid)) {
          showNotification(
            'You do not have permission to manage this product.',
            'fa-triangle-exclamation'
          );
          return;
        }

        openBatchManager(id, product.name);
      } else if (action.dataset.action === 'edit') {
        editProduct(id);
      } else if (action.dataset.action === 'delete') {
        requestDelete(id);
      }

      return;
    }

    const pageButton = event.target.closest('[data-page]');
    if (pageButton) {
      if (pageButton.disabled) return;

      if (pageButton.dataset.page === 'next') currentPage++;
      else currentPage--;

      renderProducts();
    }
  });

  table.addEventListener('change', event => {
    if (!event.target.matches('.row-select')) return;

    const id = event.target.dataset.id;

    if (event.target.checked) selectedIds.add(id);
    else selectedIds.delete(id);

    updateBulkBar();
    updateSelectAllState();
  });
}

/* =========================================================
SELECT ALL
========================================================= */

function updateSelectAllState() {
  const checkbox = $('selectAllCheckbox');
  if (!checkbox) return;

  const filtered = getFilteredSortedProducts();

  if (!filtered.length) {
    checkbox.checked = false;
    checkbox.indeterminate = false;
    return;
  }

  const selectedCount = filtered.filter(p =>
    selectedIds.has(p.id)
  ).length;

  checkbox.checked = selectedCount === filtered.length;
  checkbox.indeterminate =
    selectedCount > 0 && selectedCount < filtered.length;
}

function setupSelectAll() {
  on('selectAllCheckbox', 'change', event => {
    const filtered = getFilteredSortedProducts();

    if (event.target.checked) {
      filtered.forEach(p => selectedIds.add(p.id));
    } else {
      filtered.forEach(p => selectedIds.delete(p.id));
    }

    updateBulkBar();
    renderProducts();
  });
}

/* =========================================================
BULK BAR
========================================================= */

function updateBulkBar() {
  const bulkBar = $('bulkBar');
  const selectedCount = $('selectedCount');

  if (!bulkBar) return;

  const count = selectedIds.size;

  bulkBar.hidden = count === 0;

  if (selectedCount) selectedCount.textContent = `${count} selected`;
}

function clearSelection() {
  selectedIds.clear();
  updateBulkBar();
  renderProducts();
}

function bulkDeleteProducts() {
  if (!selectedIds.size) return;

  const count = selectedIds.size;

  openConfirm({
    title: 'Delete selected products?',
    heading: `Delete ${count} product${count === 1 ? '' : 's'}?`,
    text:
      'These products will be permanently removed from your inventory. This cannot be undone.',
    confirmLabel: `Delete ${count}`,
    variant: 'danger',
    onConfirm: async () => {
      const ids = [...selectedIds];
      const button = $('bulkDeleteBtn');

      if (button) button.disabled = true;

      try {
        for (const id of ids) {
          await deleteProductFromFirestore(id);
        }

        selectedIds.clear();
        showNotification('Selected products deleted successfully.');
      } catch (error) {
        console.error('Bulk delete failed:', error);
        showNotification(
          error.message || 'Could not delete selected products.',
          'fa-triangle-exclamation'
        );
      } finally {
        if (button) button.disabled = false;
        updateBulkBar();
      }
    }
  });
}

function setupBulkActions() {
  on('clearSelectionBtn', 'click', clearSelection);
  on('bulkDeleteBtn', 'click', bulkDeleteProducts);
}

/* =========================================================
BATCH MANAGER — OPEN / CLOSE
========================================================= */

async function openBatchManager(productId, productName) {
  if (!auth.currentUser) {
    showNotification('Please sign in first.', 'fa-circle-info');
    return;
  }

  currentBatchProductId = productId;
  currentBatchProductName = productName || '';

  const modal = $('batchModal');
  if (!modal) {
    showNotification('Batch modal missing from HTML.', 'fa-triangle-exclamation');
    console.error('batchModal element not found.');
    return;
  }

  const title = $('batchModalTitle');
  if (title) {
    title.innerHTML = `<i class="fas fa-layer-group"></i> Batches · ${escapeHtml(
      currentBatchProductName || 'Product'
    )}`;
  }

  resetBatchForm();
  modal.hidden = false;
  modal.classList.add('open');

  await refreshBatchList();
}

function closeBatchManager() {
  const modal = $('batchModal');
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove('open');
  currentBatchProductId = null;
  currentBatchProductName = '';
  batches = [];
  editingBatchId = null;
}

/* =========================================================
BATCH MANAGER — RENDER LIST
========================================================= */

async function refreshBatchList() {
  if (!currentBatchProductId) return;

  const tbody = $('batchTableBody');
  const empty = $('batchEmptyState');
  const summaryEl = $('batchSummary');
  const table = $('batchTable');

  try {
    batches = await listBatches(currentBatchProductId);
  } catch (error) {
    console.error('Failed to load batches:', error);
    showNotification('Could not load batches.', 'fa-triangle-exclamation');
    return;
  }

  if (summaryEl) {
    const summary = await getBatchSummary(currentBatchProductId);
    summaryEl.innerHTML = `
      <div class="batch-summary-item">
        <span class="batch-summary-label">Batches</span>
        <span class="batch-summary-value">${summary.batchCount}</span>
      </div>
      <div class="batch-summary-item">
        <span class="batch-summary-label">Total Qty</span>
        <span class="batch-summary-value">${summary.totalQuantity}</span>
      </div>
      <div class="batch-summary-item">
        <span class="batch-summary-label">Valid</span>
        <span class="batch-summary-value batch-valid">${summary.validQty}</span>
      </div>
      <div class="batch-summary-item">
        <span class="batch-summary-label">Near Expiry</span>
        <span class="batch-summary-value batch-near">${summary.nearExpiryQty}</span>
      </div>
      <div class="batch-summary-item">
        <span class="batch-summary-label">Expired</span>
        <span class="batch-summary-value batch-expired">${summary.expiredQty}</span>
      </div>
    `;
  }

  if (!batches.length) {
    if (table) table.style.display = 'none';
    if (empty) empty.hidden = false;
    if (tbody) tbody.innerHTML = '';
    return;
  }

  if (table) table.style.display = '';
  if (empty) empty.hidden = true;

  const sorted = [...batches].sort((a, b) => {
    const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
    const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
    return ea - eb;
  });

  const firstAvailableId = sorted.find(
    b =>
      number(b.quantity) > 0 &&
      getExpiryStatus(b.expiryDate).status !== 'Expired'
  )?.id;

  if (tbody) {
    tbody.innerHTML = sorted
      .map(b => {
        const qty = number(b.quantity);
        const { status } = getExpiryStatus(b.expiryDate);
        const isFEFO = b.id === firstAvailableId;

        return `
          <tr data-batch-id="${escapeHtml(b.id)}">
            <td>
              <strong>${escapeHtml(b.batchNumber || '—')}</strong>
              ${isFEFO ? '<span class="fefo-badge" title="Next to be sold (FEFO)">FEFO</span>' : ''}
            </td>
            <td>${formatDate(b.manufacturingDate)}</td>
            <td>${formatDate(b.expiryDate)}</td>
            <td>
              <span class="status-pill ${expiryPillClass(status)}">${status}</span>
            </td>
            <td>${qty}</td>
            <td>${escapeHtml(b.supplier || '—')}</td>
            <td class="batch-row-actions">
              <button type="button" class="table-action" data-batch-action="edit" data-batch-id="${escapeHtml(b.id)}" aria-label="Edit batch">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 20h4L19 9l-4-4L4 16v4Z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>
                  <path d="m14 6 4 4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                </svg>
              </button>
              <button type="button" class="table-action" data-batch-action="delete" data-batch-id="${escapeHtml(b.id)}" aria-label="Delete batch">
                <i class="fas fa-trash"></i>
              </button>
            </td>
          </tr>
        `;
      })
      .join('');
  }
}

/* =========================================================
BATCH FORM
========================================================= */

function resetBatchForm() {
  editingBatchId = null;

  const form = $('batchForm');
  if (form) form.reset();

  const title = $('batchFormTitle');
  if (title) title.textContent = 'Add Batch';

  const submit = $('batchFormSubmitBtn');
  if (submit) submit.textContent = 'Add Batch';
}

function readBatchForm() {
  const get = id => {
    const el = $(id);
    return el ? el.value.trim() : '';
  };

  return {
    batchNumber: get('batchNumberInput'),
    manufacturingDate: get('batchManufacturingInput'),
    expiryDate: get('batchExpiryInput'),
    quantity: Number(get('batchQuantityInput')) || 0,
    costPrice: Number(get('batchCostPriceInput')) || 0,
    sellingPrice: Number(get('batchSellingPriceInput')) || 0,
    supplier: get('batchSupplierInput'),
    purchaseRef: get('batchPurchaseRefInput'),
    notes: get('batchNotesInput')
  };
}

function fillBatchForm(batch) {
  const set = (id, value) => {
    const el = $(id);
    if (el) el.value = value == null ? '' : value;
  };

  set('batchNumberInput', batch.batchNumber);
  set('batchManufacturingInput', batch.manufacturingDate);
  set('batchExpiryInput', batch.expiryDate);
  set('batchQuantityInput', batch.quantity);
  set('batchCostPriceInput', batch.costPrice);
  set('batchSellingPriceInput', batch.sellingPrice);
  set('batchSupplierInput', batch.supplier);
  set('batchPurchaseRefInput', batch.purchaseRef);
  set('batchNotesInput', batch.notes);
}

async function saveBatch(event) {
  event.preventDefault();
  if (!currentBatchProductId) return;

  const form = $('batchForm');
  if (!form) return;
  if (!form.reportValidity()) return;

  const data = readBatchForm();

  if (!data.batchNumber) {
    showNotification('Batch number is required.', 'fa-triangle-exclamation');
    return;
  }

  if (!data.expiryDate) {
    showNotification('Expiry date is required for medicines.', 'fa-triangle-exclamation');
    return;
  }

  const submit = $('batchFormSubmitBtn');
  const wasEditing = !!editingBatchId;

  if (submit) {
    submit.disabled = true;
    submit.innerHTML = '<span class="module-spinner" aria-hidden="true"></span> Saving...';
  }

  try {
    if (wasEditing) {
      await updateBatchInFirestore(currentBatchProductId, editingBatchId, data);
      showNotification('Batch updated.');
    } else {
      await addBatchToFirestore(currentBatchProductId, data);
      showNotification('Batch added.');
    }

    await syncProductStockFromBatches(currentBatchProductId);

    resetBatchForm();
    await refreshBatchList();
  } catch (error) {
    console.error('Save batch failed:', error);
    if (error.code === 'permission-denied') {
      showNotification('Permission denied. Check Firestore rules.', 'fa-triangle-exclamation');
    } else {
      showNotification(error.message || 'Could not save batch.', 'fa-triangle-exclamation');
    }
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = wasEditing ? 'Save Changes' : 'Add Batch';
    }
  }
}

function editBatch(batchId) {
  const batch = batches.find(b => b.id === batchId);
  if (!batch) return;

  editingBatchId = batchId;
  fillBatchForm(batch);

  const title = $('batchFormTitle');
  if (title) title.textContent = 'Edit Batch';

  const submit = $('batchFormSubmitBtn');
  if (submit) submit.textContent = 'Save Changes';

  const input = $('batchNumberInput');
  if (input) input.focus();
}

function requestDeleteBatch(batchId) {
  const batch = batches.find(b => b.id === batchId);
  if (!batch) return;

  confirmBatchDeleteId = batchId;

  const modal = $('batchDeleteModal');
  const body = $('batchDeleteText');

  if (body) {
    body.innerHTML = `Delete batch <span class="highlight">${escapeHtml(
      batch.batchNumber || 'this batch'
    )}</span>? This cannot be undone.`;
  }

  if (modal) {
    modal.hidden = false;
    modal.classList.add('open');
  }
}

async function confirmDeleteBatch() {
  if (!confirmBatchDeleteId || !currentBatchProductId) return;

  const btn = $('confirmBatchDeleteBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="module-spinner" aria-hidden="true"></span> Deleting...';
  }

  try {
    await deleteBatchFromFirestore(currentBatchProductId, confirmBatchDeleteId);
    await syncProductStockFromBatches(currentBatchProductId);
    showNotification('Batch deleted.');
  } catch (error) {
    console.error('Delete batch failed:', error);
    showNotification(error.message || 'Could not delete batch.', 'fa-triangle-exclamation');
  } finally {
    confirmBatchDeleteId = null;

    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Delete';
    }

    const modal = $('batchDeleteModal');
    if (modal) {
      modal.hidden = true;
      modal.classList.remove('open');
    }

    await refreshBatchList();
  }
}

function cancelBatchDelete() {
  confirmBatchDeleteId = null;
  const modal = $('batchDeleteModal');
  if (modal) {
    modal.hidden = true;
    modal.classList.remove('open');
  }
}

/* =========================================================
BATCH UI WIRE-UP
========================================================= */

function setupBatchUI() {
  const form = $('batchForm');
  if (form) form.addEventListener('submit', saveBatch);

  const table = $('batchTable');
  if (table) {
    table.addEventListener('click', event => {
      const btn = event.target.closest('[data-batch-action]');
      if (!btn) return;
      const id = btn.dataset.batchId;
      if (btn.dataset.batchAction === 'edit') editBatch(id);
      else if (btn.dataset.batchAction === 'delete') requestDeleteBatch(id);
    });
  }

  on('closeBatchModal', 'click', closeBatchManager);

  on('cancelBatchFormBtn', 'click', () => {
    resetBatchForm();
  });

  on('confirmBatchDeleteBtn', 'click', confirmDeleteBatch);
  on('cancelBatchDeleteX', 'click', cancelBatchDelete);
  on('cancelBatchDeleteBtn', 'click', cancelBatchDelete);

  document.addEventListener('click', event => {
    if (event.target.classList && event.target.classList.contains('modal')) {
      if (event.target.id === 'batchModal') closeBatchManager();
      if (event.target.id === 'batchDeleteModal') cancelBatchDelete();
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const batchModal = $('batchModal');
      if (batchModal && !batchModal.hidden) closeBatchManager();

      const delModal = $('batchDeleteModal');
      if (delModal && !delModal.hidden) cancelBatchDelete();
    }
  });
}

/* =========================================================
SIDEBAR
========================================================= */

function setupSidebar() {
  const sidebar = $('sidebar');
  const overlay = $('sidebarOverlay');
  const openButton = $('menuToggle');
  const closeButton = $('sidebarClose');

  if (!sidebar || !overlay || !openButton || !closeButton) return;

  const closeSidebar = () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
    openButton.setAttribute('aria-expanded', 'false');
  };

  openButton.addEventListener('click', () => {
    sidebar.classList.add('open');
    overlay.classList.add('open');
    openButton.setAttribute('aria-expanded', 'true');
  });

  closeButton.addEventListener('click', closeSidebar);
  overlay.addEventListener('click', closeSidebar);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeSidebar();
  });
}

/* =========================================================
NAVIGATION / LOGOUT
========================================================= */

function setupNavigation() {
  on('logoutBtn', 'click', event => {
    event.preventDefault();

    openConfirm({
      title: 'Log out?',
      heading: 'Sign out of MoeezFlow?',
      text: 'You will need to sign in again to access your products.',
      confirmLabel: 'Log Out',
      variant: 'warning',
      onConfirm: async () => {
        try {
          const { signOut } = await import(
            'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js'
          );

          await signOut(auth);
          showNotification('Logged out successfully.');

          setTimeout(() => {
            window.location.href = '../auth/login.html';
          }, 600);
        } catch (error) {
          console.error('Logout failed:', error);
          showNotification('Could not log out.', 'fa-triangle-exclamation');
        }
      }
    });
  });
}

/* =========================================================
AUTH STATE
========================================================= */

function setupAuthListener() {
  auth.onAuthStateChanged(user => {
    if (unsubscribeProducts) {
      unsubscribeProducts();
      unsubscribeProducts = null;
    }

    if (!user) {
      products = [];
      selectedIds.clear();
      renderProducts();
      return;
    }

    loadProductsFromFirestore()
      .then(() => setupRealtimeSync())
      .catch(error => {
        console.error('Initial load failed:', error);
      });
  });
}

/* =========================================================
INITIALIZE
========================================================= */

function initializeProducts() {
  showStatisticsLoading();

  const emptyState = $('emptyState');
  if (emptyState) {
    emptyState.style.display = 'none';
    emptyState.hidden = true;
  }

  setupSidebar();
  setupNavigation();
  setupToolbar();
  setupModals();
  setupTableEvents();
  setupSelectAll();
  setupBulkActions();
  setupImageUpload();
  setupBatchUI();
  setupAuthListener();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeProducts, {
    once: true
  });
} else {
  initializeProducts();
}