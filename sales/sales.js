/* =========================================================
   MoeezFlow - Sales Module
   Firebase SDK 12.1.0
   + Batch Management Integration (FEFO)
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
  onSnapshot,
  runTransaction,
  orderBy
} from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';

let sales = [];
let products = [];
let customers = [];

let selectedCustomer = null;
let selectedSale = null;
let unsubscribeSales = null;

let currentPage = 1;
const PAGE_SIZE = 10;

let searchQuery = '';
let paymentFilter = '';
let saleStatusFilter = '';
let dateFrom = '';
let dateTo = '';

let sortField = 'createdAt';
let sortDirection = 'desc';

const $ = id => document.getElementById(id);

const number = value => Number(value) || 0;

function nowISO() {
  return new Date().toISOString();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function money(value) {
  return `PKR ${number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatDate(value) {
  if (!value) return '-';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return '-';

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric'
  });
}

function showNotification(message, icon = 'fa-circle-check') {
  const toast = $('toast');

  if (!toast) return;

  toast.innerHTML =
    `<i class="fas ${icon}"></i> ${escapeHtml(message)}`;

  toast.classList.add('show');

  clearTimeout(showNotification.timer);

  showNotification.timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3200);
}

/* =========================================================
   BATCH HELPERS (inline — FEFO consumption)
   ========================================================= */

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
      (sum, d) => sum + number(d.data().quantity),
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
 * Consume quantity from batches in FEFO order (earliest expiry first).
 * Skips expired batches. Throws if not enough available.
 * Returns array of consumed batch entries with batchBreakdown info.
 */
async function consumeBatchesFEFO(productId, quantity, options = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated.');

  const qty = number(quantity);
  if (qty <= 0) return [];

  const snap = await getDocs(getBatchesCollection(productId));

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const available = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(b => number(b.quantity) > 0)
    .filter(b => {
      const exp = toDateValue(b.expiryDate);
      return !exp || exp >= now;
    })
    .sort((a, b) => {
      const ea = toDateValue(a.expiryDate);
      const eb = toDateValue(b.expiryDate);
      if (!ea && !eb) return 0;
      if (!ea) return 1;
      if (!eb) return -1;
      return ea - eb;
    });

  const totalAvailable = available.reduce(
    (sum, b) => sum + number(b.quantity),
    0
  );

  if (totalAvailable < qty) {
    throw new Error(
      `Not enough stock for "${options.productName || productId}". ` +
      `Available: ${totalAvailable}, requested: ${qty}.`
    );
  }

  const consumed = [];
  let remaining = qty;

  for (const batch of available) {
    if (remaining <= 0) break;

    const batchQty = number(batch.quantity);
    const take = Math.min(batchQty, remaining);

    if (take <= 0) continue;

    const newQty = batchQty - take;

    await updateDoc(getBatchDoc(productId, batch.id), {
      quantity: newQty,
      updatedAt: nowISO()
    });

    consumed.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber || '',
      expiryDate: batch.expiryDate || '',
      quantity: take,
      remaining: newQty
    });

    remaining -= take;
  }

  await syncProductStockFromBatches(productId);
  return consumed;
}

/**
 * Restore quantities back into batches when a sale is returned.
 * Uses the stored batchBreakdown if available; otherwise restores
 * into the earliest batch or creates a "RETURNED-" batch.
 */
async function restoreBatchesFromReturn(productId, quantity, batchBreakdown = []) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated.');

  const qty = number(quantity);
  if (qty <= 0) return;

  const snap = await getDocs(getBatchesCollection(productId));
  const allBatches = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  let remaining = qty;

  // Prefer restoring into exact batches the sale came from
  if (Array.isArray(batchBreakdown) && batchBreakdown.length) {
    for (const entry of batchBreakdown) {
      if (remaining <= 0) break;
      if (!entry.batchId) continue;

      const target = allBatches.find(b => b.id === entry.batchId);
      if (!target) continue;

      const give = Math.min(number(entry.quantity), remaining);
      if (give <= 0) continue;

      const newQty = number(target.quantity) + give;
      await updateDoc(getBatchDoc(productId, target.id), {
        quantity: newQty,
        updatedAt: nowISO()
      });

      remaining -= give;
    }
  }

  // If no breakdown or not enough, restore into FEFO-earliest batch
  if (remaining > 0) {
    if (allBatches.length) {
      const earliest = [...allBatches].sort((a, b) => {
        const ea = toDateValue(a.expiryDate);
        const eb = toDateValue(b.expiryDate);
        if (!ea && !eb) return 0;
        if (!ea) return 1;
        if (!eb) return -1;
        return ea - eb;
      })[0];

      const newQty = number(earliest.quantity) + remaining;
      await updateDoc(getBatchDoc(productId, earliest.id), {
        quantity: newQty,
        updatedAt: nowISO()
      });
    } else {
      // No batches exist — create a "RETURNED" batch so nothing is lost
      await addDoc(getBatchesCollection(productId), {
        batchNumber: `RETURNED-${Date.now()}`,
        manufacturingDate: '',
        expiryDate: '',
        quantity: remaining,
        costPrice: 0,
        sellingPrice: 0,
        supplier: '',
        purchaseRef: '',
        notes: 'Auto-created from sale return',
        ownerId: user.uid,
        createdAt: nowISO(),
        updatedAt: nowISO()
      });
    }
  }

  await syncProductStockFromBatches(productId);
}

/* =========================================================
   FIRESTORE
   ========================================================= */

function productsCollection() {
  return collection(db, 'products');
}

function customersCollection() {
  return collection(db, 'customers');
}

function salesCollection() {
  return collection(db, 'sales');
}

/* =========================================================
   LOAD DATA
   ========================================================= */

async function loadCustomers() {
  const user = auth.currentUser;

  if (!user) return;

  try {
    const q = query(
      customersCollection(),
      where('ownerId', '==', user.uid)
    );

    const snapshot = await getDocs(q);

    customers = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));
  } catch (error) {
    console.error('Could not load customers:', error);
    showNotification(
      'Could not load customers.',
      'fa-triangle-exclamation'
    );
  }
}

async function loadProducts() {
  const user = auth.currentUser;

  if (!user) return;

  try {
    const q = query(
      productsCollection(),
      where('ownerId', '==', user.uid)
    );

    const snapshot = await getDocs(q);

    products = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));
  } catch (error) {
    console.error('Could not load products:', error);
    showNotification(
      'Could not load products.',
      'fa-triangle-exclamation'
    );
  }
}

function setupSalesRealtime() {
  const user = auth.currentUser;

  if (!user) return;

  if (unsubscribeSales) {
    unsubscribeSales();
    unsubscribeSales = null;
  }

  const q = query(
    salesCollection(),
    where('ownerId', '==', user.uid)
  );

  unsubscribeSales = onSnapshot(
    q,
    snapshot => {
      sales = snapshot.docs.map(item => ({
        id: item.id,
        ...item.data()
      }));

      renderSales();
      renderStatistics();
    },
    error => {
      console.error('Sales realtime error:', error);

      showNotification(
        'Could not load sales.',
        'fa-triangle-exclamation'
      );
    }
  );
}

/* =========================================================
   CUSTOMER SEARCH
   ========================================================= */

function setupCustomerSearch() {
  on('customerSearch', 'input', event => {
    const text = event.target.value.trim().toLowerCase();

    selectedCustomer = null;
    $('selectedCustomerId').value = '';

    const results = $('customerResults');

    if (!results) return;

    if (!text) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }

    const matches = customers.filter(customer => {
      const value = [
        customer.name,
        customer.phone,
        customer.email,
        customer.company
      ]
        .join(' ')
        .toLowerCase();

      return value.includes(text);
    });

    results.innerHTML = matches
      .slice(0, 10)
      .map(customer => `
        <div
          class="combo-result"
          data-customer-id="${customer.id}"
          style="padding:10px;cursor:pointer;"
        >
          <strong>${escapeHtml(customer.name || 'Unnamed')}</strong>
          <small>
            ${escapeHtml(customer.phone || customer.company || '')}
          </small>
        </div>
      `)
      .join('');

    results.hidden = matches.length === 0;
  });

  on('customerResults', 'click', event => {
    const result = event.target.closest('[data-customer-id]');

    if (!result) return;

    const customer = customers.find(
      item => item.id === result.dataset.customerId
    );

    if (!customer) return;

    selectedCustomer = customer;

    $('customerSearch').value = customer.name || '';
    $('selectedCustomerId').value = customer.id;

    const results = $('customerResults');

    if (results) results.hidden = true;

    const chip = $('selectedCustomerChip');

    if (chip) {
      chip.hidden = false;
      chip.innerHTML = `
        <strong>${escapeHtml(customer.name || '')}</strong>
        ${customer.phone ? ` · ${escapeHtml(customer.phone)}` : ''}
      `;
    }
  });
}

/* =========================================================
   SALE NUMBER
   ========================================================= */

function generateSaleNumber() {
  const now = new Date();

  const date =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');

  const countToday = sales.filter(sale => {
    if (!sale.createdAt) return false;

    const saleDate = new Date(sale.createdAt);

    return (
      saleDate.getFullYear() === now.getFullYear() &&
      saleDate.getMonth() === now.getMonth() &&
      saleDate.getDate() === now.getDate()
    );
  }).length + 1;

  return `SAL-${date}-${String(countToday).padStart(4, '0')}`;
}

/* =========================================================
   PRODUCT PICKER
   ========================================================= */

function openProductPicker(row) {
  const modal = $('productPickerModal');

  if (!modal) return;

  modal.dataset.targetRow = row;

  $('productPickerSearch').value = '';

  renderProductPicker('');

  openModal('productPickerModal');

  setTimeout(() => {
    $('productPickerSearch')?.focus();
  }, 50);
}

function renderProductPicker(search = '') {
  const list = $('productPickerList');

  if (!list) return;

  const text = search.toLowerCase();

  const available = products.filter(product => {
    if (product.status === 'Discontinued') return false;

    const searchable = [
      product.name,
      product.sku,
      product.barcode,
      product.brand
    ]
      .join(' ')
      .toLowerCase();

    return searchable.includes(text);
  });

  if (!available.length) {
    list.innerHTML = `
      <div style="padding:20px;text-align:center;">
        No products found.
      </div>
    `;
    return;
  }

  list.innerHTML = available
    .map(product => `
      <div
        class="product-picker-item"
        data-product-id="${product.id}"
        style="padding:12px;border-bottom:1px solid #eee;cursor:pointer;"
      >
        <strong>${escapeHtml(product.name)}</strong>
        <div>
          SKU: ${escapeHtml(product.sku || '-')}
          · Stock: ${number(product.stock)}
          · ${money(product.sellingPrice)}
        </div>
      </div>
    `)
    .join('');
}

function selectProduct(productId) {
  const product = products.find(item => item.id === productId);

  if (!product) return;

  const rowIndex =
    Number($('productPickerModal').dataset.targetRow);

  const row = document.querySelector(
    `.sale-line[data-row="${rowIndex}"]`
  );

  if (!row) return;

  row.dataset.productId = product.id;

  row.querySelector('.line-product-name').textContent =
    product.name;

  row.querySelector('.line-stock-value').textContent =
    number(product.stock);

  const priceInput = row.querySelector('.line-price');

  if (priceInput) {
    priceInput.value = number(product.sellingPrice).toFixed(2);
  }

  calculateTotals();

  closeModal('productPickerModal');
}

/* =========================================================
   LINE ITEMS
   ========================================================= */

let lineCounter = 0;

function addLineItem() {
  const body = $('lineItemsBody');

  if (!body) return;

  const rowId = lineCounter++;

  const row = document.createElement('tr');

  row.className = 'sale-line';
  row.dataset.row = rowId;

  row.innerHTML = `
    <td>
      <button
        type="button"
        class="btn btn-outline btn-sm choose-product"
      >
        Select Product
      </button>

      <div class="line-product-name"></div>
    </td>

    <td>
      <span class="line-stock-value">0</span>
    </td>

    <td>
      <input
        type="number"
        class="line-qty"
        min="1"
        step="1"
        value="1"
      >
    </td>

    <td>
      <input
        type="number"
        class="line-price"
        min="0"
        step="0.01"
        value="0"
      >
    </td>

    <td>
      <input
        type="number"
        class="line-discount"
        min="0"
        max="100"
        step="0.01"
        value="0"
      >
    </td>

    <td>
      <input
        type="number"
        class="line-tax"
        min="0"
        max="100"
        step="0.01"
        value="0"
      >
    </td>

    <td>
      <strong class="line-total">0.00</strong>
    </td>

    <td>
      <button
        type="button"
        class="table-action remove-line"
        aria-label="Remove"
      >
        <i class="fas fa-trash"></i>
      </button>
    </td>
  `;

  body.appendChild(row);

  $('lineItemsEmpty').hidden = true;

  calculateTotals();
}

function getLineItems() {
  return [...document.querySelectorAll('.sale-line')]
    .map(row => {
      const product = products.find(
        item => item.id === row.dataset.productId
      );

      if (!product) return null;

      const quantity = number(
        row.querySelector('.line-qty')?.value
      );

      const unitPrice = number(
        row.querySelector('.line-price')?.value
      );

      const discountRate = number(
        row.querySelector('.line-discount')?.value
      );

      const taxRate = number(
        row.querySelector('.line-tax')?.value
      );

      const gross = quantity * unitPrice;

      const discountAmount =
        gross * discountRate / 100;

      const afterDiscount =
        gross - discountAmount;

      const taxAmount =
        afterDiscount * taxRate / 100;

      const total =
        afterDiscount + taxAmount;

      return {
        productId: product.id,
        productName: product.name || '',
        sku: product.sku || '',
        quantity,
        unitPrice,
        discountRate,
        discountAmount,
        taxRate,
        taxAmount,
        total
      };
    })
    .filter(Boolean);
}

function calculateTotals() {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;

  document.querySelectorAll('.sale-line').forEach(row => {
    const quantity = number(
      row.querySelector('.line-qty')?.value
    );

    const price = number(
      row.querySelector('.line-price')?.value
    );

    const discountRate = number(
      row.querySelector('.line-discount')?.value
    );

    const taxRate = number(
      row.querySelector('.line-tax')?.value
    );

    const gross = quantity * price;

    const discountAmount =
      gross * discountRate / 100;

    const taxable =
      gross - discountAmount;

    const taxAmount =
      taxable * taxRate / 100;

    const total =
      taxable + taxAmount;

    subtotal += gross;
    discount += discountAmount;
    tax += taxAmount;

    const totalElement =
      row.querySelector('.line-total');

    if (totalElement) {
      totalElement.textContent =
        total.toFixed(2);
    }
  });

  const grandTotal =
    subtotal - discount + tax;

  $('totalSubtotal').textContent =
    subtotal.toFixed(2);

  $('totalDiscount').textContent =
    discount.toFixed(2);

  $('totalTax').textContent =
    tax.toFixed(2);

  $('totalGrand').textContent =
    grandTotal.toFixed(2);

  updatePaymentStatus();
}

function updatePaymentStatus() {
  const grandTotal = number(
    $('totalGrand')?.textContent
  );

  const paid = number(
    $('fAmountPaid')?.value
  );

  const balance =
    Math.max(0, grandTotal - paid);

  $('balanceDisplay').textContent =
    balance.toFixed(2);

  let status = 'Unpaid';

  if (paid >= grandTotal && grandTotal > 0) {
    status = 'Paid';
  } else if (paid > 0) {
    status = 'Partially Paid';
  }

  const pill = $('paymentStatusPill');

  if (pill) {
    pill.textContent = status;
  }
}

/* =========================================================
   CREATE SALE — BATCH-AWARE (FEFO)
   ---------------------------------------------------------
   For each line:
     • If product has batches → consume FEFO, record breakdown
     • Else → legacy path: decrement product.stock directly
   ========================================================= */

async function createSale(event) {
  event.preventDefault();

  const user = auth.currentUser;

  if (!user) {
    showNotification(
      'Please sign in first.',
      'fa-triangle-exclamation'
    );
    return;
  }

  if (!selectedCustomer) {
    showNotification(
      'Please select a customer.',
      'fa-triangle-exclamation'
    );
    return;
  }

  const items = getLineItems();

  if (!items.length) {
    showNotification(
      'Please add at least one product.',
      'fa-triangle-exclamation'
    );
    return;
  }

  const grandTotal = number(
    $('totalGrand')?.textContent
  );

  const amountPaid = number(
    $('fAmountPaid')?.value
  );

  if (amountPaid < 0 || amountPaid > grandTotal) {
    showNotification(
      'Invalid payment amount.',
      'fa-triangle-exclamation'
    );
    return;
  }

  // Pre-check stock for both paths
  for (const item of items) {
    const product = products.find(
      p => p.id === item.productId
    );

    if (!product) {
      showNotification(
        `Product "${item.productName}" no longer exists.`,
        'fa-triangle-exclamation'
      );
      return;
    }

    const hasBatches = await productHasBatches(item.productId);

    if (hasBatches) {
      // For batch products, we rely on consumeBatchesFEFO to enforce availability
      // (it checks non-expired quantity)
      continue;
    }

    if (number(product.stock) < item.quantity) {
      showNotification(
        `Not enough stock for ${item.productName}.`,
        'fa-triangle-exclamation'
      );
      return;
    }
  }

  const paymentStatus =
    amountPaid >= grandTotal && grandTotal > 0
      ? 'Paid'
      : amountPaid > 0
        ? 'Partially Paid'
        : 'Unpaid';

  const balance =
    grandTotal - amountPaid;

  const saleNumber =
    generateSaleNumber();

  const submitButton =
    $('saleSubmitBtn');

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';
  }

  const saleRef = doc(salesCollection());

  try {
    // 1) Batch consumption FIRST (or legacy stock decrement)
    //    We do this before writing the sale doc so we fail early
    //    if stock isn't available.
    const itemsWithBatchInfo = [];

    for (const item of items) {
      const hasBatches = await productHasBatches(item.productId);

      if (hasBatches) {
        const consumed = await consumeBatchesFEFO(item.productId, item.quantity, {
          productName: item.productName
        });

        itemsWithBatchInfo.push({
          ...item,
          batchBreakdown: consumed
        });
      } else {
        // Legacy path: decrement stock inside the transaction below
        itemsWithBatchInfo.push({
          ...item,
          batchBreakdown: []
        });
      }
    }

    // 2) Save sale doc + decrement legacy stock inside a transaction
    await runTransaction(db, async transaction => {

      // We only need to touch stock inside the transaction for legacy products
      const legacyItems = itemsWithBatchInfo.filter(it => !it.batchBreakdown.length);

      if (legacyItems.length) {
        const productRefs = legacyItems.map(
          item => doc(db, 'products', item.productId)
        );

        const productSnapshots = [];

        for (const reference of productRefs) {
          const snapshot =
            await transaction.get(reference);

          productSnapshots.push(snapshot);
        }

        productSnapshots.forEach(
          (snapshot, index) => {

            if (!snapshot.exists()) {
              throw new Error(
                `Product ${legacyItems[index].productName} no longer exists.`
              );
            }

            const current =
              snapshot.data();

            const newStock =
              number(current.stock) -
              legacyItems[index].quantity;

            if (newStock < 0) {
              throw new Error(
                `Not enough stock for ${legacyItems[index].productName}.`
              );
            }

            transaction.update(
              productRefs[index],
              {
                stock: newStock,
                updatedAt: nowISO()
              }
            );
          }
        );
      }

      transaction.set(
        saleRef,
        {
          ownerId: user.uid,

          saleNumber,

          customerId: selectedCustomer.id,
          customerName: selectedCustomer.name || '',
          customerPhone: selectedCustomer.phone || '',

          items: itemsWithBatchInfo,

          subtotal: number(
            $('totalSubtotal')?.textContent
          ),

          discount: number(
            $('totalDiscount')?.textContent
          ),
          discountTotal: number(
            $('totalDiscount')?.textContent
          ),

          tax: number(
            $('totalTax')?.textContent
          ),
          taxTotal: number(
            $('totalTax')?.textContent
          ),

          grandTotal,

          amountPaid,

          balance,

          paymentMethod:
            $('fPaymentMethod')?.value || 'Cash',

          currency: $('fCurrency')?.value || 'PKR',

          paymentStatus,

          saleStatus: 'Completed',

          returnedItems: [],

          createdAt: nowISO(),
          updatedAt: nowISO()
        }
      );
    });

    showNotification(
      `Sale ${saleNumber} created successfully.`
    );

    closeModal('createSaleModal');

    resetSaleForm();

    await loadProducts();

    try {
      const redirectUrl = `../invoices/invoices.html?generate=sale&id=${saleRef.id}`;
      window.location.href = redirectUrl;
      return;
    } catch (redirErr) {
      console.warn('Could not redirect to invoices for auto-generation:', redirErr);
    }

  } catch (error) {
    console.error('Create sale failed:', error);

    showNotification(
      error.message || 'Could not create sale.',
      'fa-triangle-exclamation'
    );

  } finally {

    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Complete Sale';
    }
  }
}

/* =========================================================
   SALES TABLE
   ========================================================= */

function getFilteredSales() {
  let list = [...sales];

  if (searchQuery) {
    list = list.filter(sale => {

      const text = [
        sale.saleNumber,
        sale.customerName,
        sale.customerPhone
      ]
        .join(' ')
        .toLowerCase();

      return text.includes(searchQuery);
    });
  }

  if (paymentFilter) {
    list = list.filter(
      sale => sale.paymentStatus === paymentFilter
    );
  }

  if (saleStatusFilter) {
    list = list.filter(
      sale => sale.saleStatus === saleStatusFilter
    );
  }

  if (dateFrom) {
    list = list.filter(
      sale =>
        String(sale.createdAt || '').slice(0, 10) >=
        dateFrom
    );
  }

  if (dateTo) {
    list = list.filter(
      sale =>
        String(sale.createdAt || '').slice(0, 10) <=
        dateTo
    );
  }

  list.sort((a, b) => {

    let left = a[sortField];
    let right = b[sortField];

    if (sortField === 'saleNumber') {
      left = String(left || '');
      right = String(right || '');

      return sortDirection === 'asc'
        ? left.localeCompare(right)
        : right.localeCompare(left);
    }

    left = number(left);
    right = number(right);

    if (sortField === 'createdAt') {
      left = new Date(a.createdAt || 0).getTime();
      right = new Date(b.createdAt || 0).getTime();
    }

    return sortDirection === 'asc'
      ? left - right
      : right - left;
  });

  return list;
}

function renderSales() {
  const tbody = $('salesTableBody');

  if (!tbody) return;

  const filtered = getFilteredSales();

  const table = $('salesTable');
  const empty = $('emptyState');
  const pagination = $('pagination');

  if (sales.length === 0) {
    if (table) { table.style.display = 'none'; table.hidden = true; }
    if (pagination) { pagination.style.display = 'none'; pagination.hidden = true; }
    if (empty) { empty.style.display = ''; empty.hidden = false; }
    if ($('emptyStateTitle')) $('emptyStateTitle').textContent = 'No sales yet';
    if ($('emptyStateText')) $('emptyStateText').textContent = 'Create your first sale to start tracking revenue.';
    tbody.innerHTML = '';
    renderStatistics();
    return;
  }

  if (filtered.length === 0) {
    if (table) { table.style.display = 'none'; table.hidden = true; }
    if (pagination) { pagination.style.display = 'none'; pagination.hidden = true; }
    if (empty) { empty.style.display = ''; empty.hidden = false; }
    if ($('emptyStateTitle')) $('emptyStateTitle').textContent = 'No matching sales';
    if ($('emptyStateText')) $('emptyStateText').textContent = 'Try adjusting your search or filters.';
    tbody.innerHTML = '';
    renderStatistics();
    return;
  }

  if (table) { table.style.display = ''; table.hidden = false; }
  if (empty) { empty.style.display = 'none'; empty.hidden = true; }
  if (pagination) { pagination.style.display = ''; pagination.hidden = false; }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const page = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  tbody.innerHTML = page.map(sale => {

    const itemsCount = Array.isArray(sale.items)
      ? sale.items.reduce((sum, item) => sum + number(item.quantity), 0)
      : 0;

    return `
      <tr data-sale-id="${sale.id}">
        <td><strong>${escapeHtml(sale.saleNumber || '-')}</strong></td>
        <td>${escapeHtml(sale.customerName || 'Walk-in')}</td>
        <td>${formatDate(sale.createdAt)}</td>
        <td>${itemsCount}</td>
        <td><strong>${money(sale.grandTotal)}</strong></td>
        <td>${money(sale.amountPaid)}</td>
        <td>${money(sale.balance)}</td>
        <td><span class="status-pill">${escapeHtml(sale.paymentStatus || 'Unpaid')}</span></td>
        <td><span class="status-pill">${escapeHtml(sale.saleStatus || 'Completed')}</span></td>
        <td class="col-actions">
          <button type="button" class="table-action" data-action="view" data-id="${sale.id}" title="View"><i class="fas fa-eye"></i></button>
          ${sale.saleStatus !== 'Returned' ? `<button type="button" class="table-action" data-action="return" data-id="${sale.id}" title="Return"><i class="fas fa-rotate-left"></i></button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  renderPagination(totalPages, filtered.length);
  renderStatistics();
}

function renderPagination(totalPages, total) {
  const pagination = $('pagination');

  if (!pagination) return;

  pagination.style.display = '';
  pagination.hidden = false;

  $('paginationInfo').textContent =
    `Page ${currentPage} of ${totalPages} (${total} sales)`;

  let buttonsHtml = '';
  
  buttonsHtml += `
    <button
      class="btn btn-ghost btn-sm pagination-btn"
      data-page="prev"
      ${currentPage === 1 ? 'disabled' : ''}
    >
      <i class="fas fa-chevron-left"></i> Previous
    </button>
  `;
  
  let startPage = Math.max(1, currentPage - 2);
  let endPage = Math.min(totalPages, currentPage + 2);
  
  if (endPage - startPage < 4) {
    if (startPage === 1) {
      endPage = Math.min(totalPages, startPage + 4);
    } else if (endPage === totalPages) {
      startPage = Math.max(1, endPage - 4);
    }
  }
  
  if (startPage > 1) {
    buttonsHtml += `<button class="btn btn-ghost btn-sm pagination-btn" data-page="1">1</button>`;
    if (startPage > 2) {
      buttonsHtml += `<button class="btn btn-ghost btn-sm pagination-btn" disabled>...</button>`;
    }
  }
  
  for (let i = startPage; i <= endPage; i++) {
    buttonsHtml += `
      <button 
        class="btn ${i === currentPage ? 'btn-primary' : 'btn-ghost'} btn-sm pagination-btn" 
        data-page="${i}"
      >
        ${i}
      </button>
    `;
  }
  
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      buttonsHtml += `<button class="btn btn-ghost btn-sm pagination-btn" disabled>...</button>`;
    }
    buttonsHtml += `<button class="btn btn-ghost btn-sm pagination-btn" data-page="${totalPages}">${totalPages}</button>`;
  }
  
  buttonsHtml += `
    <button
      class="btn btn-ghost btn-sm pagination-btn"
      data-page="next"
      ${currentPage === totalPages ? 'disabled' : ''}
    >
      Next <i class="fas fa-chevron-right"></i>
    </button>
  `;

  $('paginationControls').innerHTML = buttonsHtml;
}

/* =========================================================
   STATISTICS
   ========================================================= */

function renderStatistics() {
  const grid = $('statsGrid');

  if (!grid) return;

  const totalSales = sales.length;

  const revenue = sales.reduce(
    (sum, sale) => sum + number(sale.grandTotal),
    0
  );

  const paid = sales.reduce(
    (sum, sale) => sum + number(sale.amountPaid),
    0
  );

  const outstanding = sales.reduce(
    (sum, sale) => sum + number(sale.balance),
    0
  );

  const paidPct = revenue ? Math.round((paid / revenue) * 100) : 0;
  const outstandingPct = revenue ? Math.round((outstanding / revenue) * 100) : 0;

  renderMetricCards(grid, [
    {
      label: 'Total Sales',
      icon: 'fa-bag-shopping',
      value: Number(totalSales).toLocaleString(),
      delta: { cls: 'neutral', text: '—' },
      foot: 'all recorded sales'
    },
    {
      label: 'Revenue',
      icon: 'fa-chart-pie',
      value: money(revenue),
      delta: { cls: revenue >= 0 ? 'up' : 'down', text: 'All time' },
      foot: 'gross from sales'
    },
    {
      label: 'Paid',
      icon: 'fa-circle-check',
      value: money(paid),
      delta: { cls: 'up', text: `${paidPct}%` },
      foot: 'collected'
    },
    {
      label: 'Outstanding',
      icon: 'fa-clock',
      value: money(outstanding),
      delta: { cls: outstanding > 0 ? 'down' : 'neutral', text: `${outstandingPct}%` },
      foot: 'uncollected balances'
    }
  ]);
}

/* =========================================================
   SALE DETAILS
   ========================================================= */

function viewSale(id) {
  const sale = sales.find(item => item.id === id);

  if (!sale) return;

  selectedSale = sale;

  const body = $('saleDetailsBody');

  if (!body) return;

  body.innerHTML = `
    <div class="sale-details">

      <h4>${escapeHtml(sale.saleNumber || '-')}</h4>

      <p><strong>Customer:</strong> ${escapeHtml(sale.customerName || 'Walk-in')}</p>

      <p><strong>Date:</strong> ${formatDate(sale.createdAt)}</p>

      <hr>

      <table class="line-items-table">

        <thead>
          <tr>
            <th>Product</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Total</th>
          </tr>
        </thead>

        <tbody>
          ${(sale.items || []).map(item => `
            <tr>
              <td>${escapeHtml(item.productName)}</td>
              <td>${number(item.quantity)}</td>
              <td>${money(item.unitPrice)}</td>
              <td>${money(item.total)}</td>
            </tr>
          `).join('')}
        </tbody>

      </table>

      <div class="totals-section">

        <div class="totals-row"><span>Subtotal</span><strong>${money(sale.subtotal)}</strong></div>

        <div class="totals-row"><span>Discount</span><strong>${money(sale.discount)}</strong></div>

        <div class="totals-row"><span>Tax</span><strong>${money(sale.tax)}</strong></div>

        <div class="totals-row totals-grand"><span>Grand Total</span><strong>${money(sale.grandTotal)}</strong></div>

        <div class="totals-row"><span>Paid</span><strong>${money(sale.amountPaid)}</strong></div>

        <div class="totals-row"><span>Balance</span><strong>${money(sale.balance)}</strong></div>

      </div>

    </div>
  `;

  openModal('saleDetailsModal');
}

/* =========================================================
   RETURNS — BATCH-AWARE
   ========================================================= */

function openReturnModal(id) {
  const sale = sales.find(item => item.id === id);

  if (!sale) return;

  selectedSale = sale;

  const body = $('returnItemsBody');

  if (!body) return;

  body.innerHTML = (sale.items || []).map((item, index) => {

    const returned = number(item.returnedQuantity);
    const remaining = Math.max(0, number(item.quantity) - returned);

    return `
      <tr data-return-index="${index}" data-product-id="${item.productId}">
        <td>${escapeHtml(item.productName)}</td>
        <td>${number(item.quantity)}</td>
        <td>${returned}</td>
        <td>
          <input
            type="number"
            class="return-qty"
            min="0"
            max="${remaining}"
            value="0"
            data-index="${index}"
          >
        </td>
        <td><strong class="refund-amount">0.00</strong></td>
      </tr>
    `;
  }).join('');

  $('returnReason').value = '';

  calculateRefund();

  closeModal('saleDetailsModal');
  openModal('returnModal');
}

function calculateRefund() {
  if (!selectedSale) return;

  let refund = 0;

  document.querySelectorAll('.return-qty').forEach(input => {

    const index = Number(input.dataset.index);
    const item = selectedSale.items[index];
    const quantity = number(input.value);
    const amount = quantity * number(item.unitPrice);

    refund += amount;

    const row = input.closest('tr');
    const refundElement = row?.querySelector('.refund-amount');

    if (refundElement) {
      refundElement.textContent = amount.toFixed(2);
    }
  });

  $('returnTotalRefund').textContent = refund.toFixed(2);
}

async function processReturn(event) {
  event.preventDefault();

  if (!selectedSale) return;

  const reason = $('returnReason')?.value.trim();

  if (!reason) {
    showNotification(
      'Please provide a return reason.',
      'fa-triangle-exclamation'
    );
    return;
  }

  const returnRows = [...document.querySelectorAll('.return-qty')];

  const returns = returnRows.map(input => {
    const index = Number(input.dataset.index);
    const quantity = number(input.value);
    return { index, quantity };
  }).filter(item => item.quantity > 0);

  if (!returns.length) {
    showNotification(
      'Select at least one item to return.',
      'fa-triangle-exclamation'
    );
    return;
  }

  const user = auth.currentUser;
  if (!user) return;

  const button = $('returnSubmitBtn');

  if (button) {
    button.disabled = true;
    button.textContent = 'Processing...';
  }

  try {
    // 1) Update the sale doc + legacy stock restoration inside a transaction
    //    (batch restoration is handled separately below, outside the tx,
    //    because batches live in a subcollection.)
    const legacyRestorePlan = [];

    await runTransaction(db, async transaction => {

      const saleRef = doc(db, 'sales', selectedSale.id);
      const saleSnapshot = await transaction.get(saleRef);

      if (!saleSnapshot.exists()) {
        throw new Error('Sale no longer exists.');
      }

      const saleData = saleSnapshot.data();
      const updatedItems = [...(saleData.items || [])];

      let refundAmount = 0;

      for (const returnItem of returns) {
        const item = updatedItems[returnItem.index];
        if (!item) continue;

        const alreadyReturned = number(item.returnedQuantity);
        const remaining = number(item.quantity) - alreadyReturned;

        if (returnItem.quantity > remaining) {
          throw new Error(
            `Invalid return quantity for ${item.productName}.`
          );
        }

        const hasBatches = await productHasBatches(item.productId);

        if (!hasBatches) {
          // Legacy path — restore directly inside transaction
          const productRef = doc(db, 'products', item.productId);
          const productSnapshot = await transaction.get(productRef);

          if (!productSnapshot.exists()) {
            throw new Error(`Product ${item.productName} no longer exists.`);
          }

          const product = productSnapshot.data();

          transaction.update(productRef, {
            stock: number(product.stock) + returnItem.quantity,
            updatedAt: nowISO()
          });
        } else {
          // Batch products — restore outside transaction
          legacyRestorePlan.push({
            productId: item.productId,
            quantity: returnItem.quantity,
            batchBreakdown: item.batchBreakdown || []
          });
        }

        updatedItems[returnItem.index] = {
          ...item,
          returnedQuantity: alreadyReturned + returnItem.quantity
        };
      }

      const allReturned = updatedItems.every(item =>
        number(item.returnedQuantity) >= number(item.quantity)
      );

      for (const r of returns) {
        const idx = r.index;
        const returnQty = number(r.quantity);
        const origItem = saleData.items[idx];
        if (!origItem) continue;

        const itemTotal = number(origItem.total) || 0;
        const itemQty = number(origItem.quantity) || 1;
        const perUnit = itemQty > 0 ? itemTotal / itemQty : 0;

        refundAmount += perUnit * returnQty;
      }

      refundAmount = Number(refundAmount) || 0;

      const previousBalance = Number(saleData.balance) || (Number(saleData.grandTotal) - Number(saleData.amountPaid) || 0);
      const newBalance = Math.max(0, previousBalance - refundAmount);

      transaction.update(saleRef, {
        items: updatedItems,
        saleStatus: allReturned ? 'Returned' : 'Partially Returned',
        returnReason: reason,
        returnedAt: nowISO(),
        updatedAt: nowISO(),
        balance: newBalance
      });
    });

    // 2) Restore batch quantities (outside the transaction)
    for (const plan of legacyRestorePlan) {
      try {
        await restoreBatchesFromReturn(
          plan.productId,
          plan.quantity,
          plan.batchBreakdown
        );
      } catch (batchErr) {
        console.error('Batch restore failed for', plan.productId, batchErr);
      }
    }

    showNotification('Return processed successfully.');

    closeModal('returnModal');

    await loadProducts();

  } catch (error) {
    console.error('Return failed:', error);

    showNotification(
      error.message || 'Could not process return.',
      'fa-triangle-exclamation'
    );

  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Confirm Return';
    }
  }
}

/* =========================================================
   MODALS
   ========================================================= */

function openModal(id) {
  const modal = $(id);

  if (!modal) return;

  modal.hidden = false;
  modal.classList.add('open');

  const overlay = $('modalOverlay');

  if (overlay) {
    overlay.classList.add('open');
  }
}

function closeModal(id) {
  const modal = $(id);

  if (!modal) return;

  modal.hidden = true;
  modal.classList.remove('open');

  const openModals = document.querySelectorAll('.modal.open');

  if (!openModals.length) {
    const overlay = $('modalOverlay');

    if (overlay) {
      overlay.classList.remove('open');
    }
  }
}

function resetSaleForm() {
  const form = $('saleForm');

  if (form) form.reset();

  selectedCustomer = null;

  if ($('selectedCustomerId')) $('selectedCustomerId').value = '';

  if ($('selectedCustomerChip')) {
    $('selectedCustomerChip').hidden = true;
    $('selectedCustomerChip').innerHTML = '';
  }

  if ($('lineItemsBody')) $('lineItemsBody').innerHTML = '';
  if ($('lineItemsEmpty')) $('lineItemsEmpty').hidden = false;

  lineCounter = 0;

  $('totalSubtotal').textContent = '0.00';
  $('totalDiscount').textContent = '0.00';
  $('totalTax').textContent = '0.00';
  $('totalGrand').textContent = '0.00';
  $('balanceDisplay').textContent = '0.00';
  $('paymentStatusPill').textContent = 'Unpaid';
}

/* =========================================================
   TOOLBAR
   ========================================================= */

function setupToolbar() {
  on('searchInput', 'input', event => {
    searchQuery = event.target.value.trim().toLowerCase();
    currentPage = 1;
    renderSales();
  });

  on('filterPaymentStatus', 'change', event => {
    paymentFilter = event.target.value;
    currentPage = 1;
    renderSales();
  });

  on('filterSaleStatus', 'change', event => {
    saleStatusFilter = event.target.value;
    currentPage = 1;
    renderSales();
  });

  on('filterDateFrom', 'change', event => {
    dateFrom = event.target.value;
    currentPage = 1;
    renderSales();
  });

  on('filterDateTo', 'change', event => {
    dateTo = event.target.value;
    currentPage = 1;
    renderSales();
  });

  on('clearFiltersBtn', 'click', () => {
    searchQuery = '';
    paymentFilter = '';
    saleStatusFilter = '';
    dateFrom = '';
    dateTo = '';

    ['searchInput', 'filterPaymentStatus', 'filterSaleStatus', 'filterDateFrom', 'filterDateTo']
      .forEach(id => { if ($(id)) $(id).value = ''; });

    currentPage = 1;
    renderSales();
  });

  on('sortField', 'change', event => {
    sortField = event.target.value;
    currentPage = 1;
    renderSales();
  });

  on('sortDirBtn', 'click', event => {
    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    event.currentTarget.dataset.dir = sortDirection;
    renderSales();
  });
}

/* =========================================================
   EVENTS
   ========================================================= */

function on(id, event, handler) {
  const element = $(id);

  if (!element) {
    console.warn(`MoeezFlow Sales: #${id} not found.`);
    return;
  }

  element.addEventListener(event, handler);
}

function setupEvents() {
  on('openCreateSaleBtn', 'click', () => {
    if (!auth.currentUser) {
      showNotification('Please sign in first.', 'fa-triangle-exclamation');
      return;
    }
    resetSaleForm();
    openModal('createSaleModal');
    addLineItem();
  });

  on('emptyStateAddBtn', 'click', () => {
    resetSaleForm();
    openModal('createSaleModal');
    addLineItem();
  });

  on('addLineBtn', 'click', addLineItem);

  on('saleForm', 'submit', createSale);

  on('fAmountPaid', 'input', updatePaymentStatus);

  on('productPickerSearch', 'input', event => renderProductPicker(event.target.value));

  on('productPickerList', 'click', event => {
    const item = event.target.closest('[data-product-id]');
    if (!item) return;
    selectProduct(item.dataset.productId);
  });

  on('lineItemsBody', 'click', event => {
    const choose = event.target.closest('.choose-product');

    if (choose) {
      const row = choose.closest('.sale-line');
      openProductPicker(row.dataset.row);
      return;
    }

    const remove = event.target.closest('.remove-line');

    if (remove) {
      remove.closest('.sale-line')?.remove();

      const hasLines = document.querySelectorAll('.sale-line').length > 0;
      $('lineItemsEmpty').hidden = hasLines;

      calculateTotals();
    }
  });

  on('lineItemsBody', 'input', calculateTotals);

  on('returnItemsBody', 'input', calculateRefund);

  on('returnForm', 'submit', processReturn);

  on('openReturnBtn', 'click', () => {
    if (selectedSale) openReturnModal(selectedSale.id);
  });

  const salesTable = $('salesTable');

  if (salesTable) {
    salesTable.addEventListener('click', event => {
      const action = event.target.closest('[data-action]');

      if (action) {
        const id = action.dataset.id;

        if (action.dataset.action === 'view') viewSale(id);
        if (action.dataset.action === 'return') openReturnModal(id);

        return;
      }
    });
  }

  const paginationControls = $('paginationControls');
  if (paginationControls) {
    paginationControls.addEventListener('click', function(event) {
      const pageBtn = event.target.closest('.pagination-btn');
      if (!pageBtn) return;
      if (pageBtn.disabled) return;

      const pageValue = pageBtn.dataset.page;
      const filtered = getFilteredSales();
      const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

      if (pageValue === 'next' && currentPage < totalPages) {
        currentPage++;
      } else if (pageValue === 'prev' && currentPage > 1) {
        currentPage--;
      } else if (!isNaN(pageValue)) {
        currentPage = parseInt(pageValue);
      }

      renderSales();
    });
  }

  document.querySelectorAll('[data-close-modal]').forEach(button => {
    button.addEventListener('click', () => {
      const modal = button.closest('.modal');
      if (modal) closeModal(modal.id);
    });
  });

  on('modalOverlay', 'click', () => {
    document.querySelectorAll('.modal.open').forEach(modal => {
      closeModal(modal.id);
    });
  });
}

/* =========================================================
   SIDEBAR
   ========================================================= */

function setupSidebar() {
  const sidebar = $('sidebar');
  const overlay = $('sidebarOverlay');
  const menu = $('menuToggle');
  const close = $('sidebarClose');

  if (!sidebar || !overlay || !menu || !close) return;

  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
    menu.setAttribute('aria-expanded', 'false');
  }

  menu.addEventListener('click', () => {
    sidebar.classList.add('open');
    overlay.classList.add('open');
    menu.setAttribute('aria-expanded', 'true');
  });

  close.addEventListener('click', closeSidebar);
  overlay.addEventListener('click', closeSidebar);
}

/* =========================================================
   LOGOUT
   ========================================================= */

function setupLogout() {
  on('logoutBtn', 'click', async event => {
    event.preventDefault();

    try {
      const { signOut } = await import(
        'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js'
      );

      await signOut(auth);
      window.location.href = '../auth/login.html';

    } catch (error) {
      console.error('Logout failed:', error);
      showNotification('Could not logout.', 'fa-triangle-exclamation');
    }
  });
}

/* =========================================================
   INITIALIZE
   ========================================================= */

async function initializeSales() {
  const emptyState = $('emptyState');
  if (emptyState) {
    emptyState.style.display = 'none';
    emptyState.hidden = true;
  }

  setupSidebar();
  setupLogout();
  setupToolbar();
  setupEvents();
  setupCustomerSearch();

  auth.onAuthStateChanged(async user => {
    if (!user) {
      sales = [];
      products = [];
      customers = [];

      renderSales();
      renderStatistics();

      return;
    }

    try {
      await Promise.all([
        loadCustomers(),
        loadProducts()
      ]);

      setupSalesRealtime();

    } catch (error) {
      console.error('Sales initialization failed:', error);
      showNotification('Could not initialize Sales.', 'fa-triangle-exclamation');
    }
  });
}

/* =========================================================
   START
   ========================================================= */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSales, { once: true });
} else {
  initializeSales();
}