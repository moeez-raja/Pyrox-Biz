/* =========================================================
   MoeezFlow — Reports / FlowAI
   Premium Edition — Enhanced UX & Interactions
   Deterministic answers from Firestore records.
   No external AI APIs.
   ========================================================= */

import { auth, db } from "../js/firebase.js";
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

// =========================================================
// CONSTANTS & CONFIGURATION
// =========================================================

const LS = {
  purchases: "moeezflow_purchases",
  customers: "moeezflow_customers",
  suppliers: "moeezflow_suppliers",
  purchaseSuppliers: "moeezflow_purchase_suppliers",
  expenses: "moeezflow_expenses"
};

const CONFIG = {
  maxSuggestions: 12,
  initialSuggestions: 7,
  typingDelay: 350,
  toastDuration: 3200,
  copySuccessDuration: 1800,
  maxMessageHeight: 140,
  recentDaysThreshold: 45,
  stockLookbackDays: 30,
  maxListItems: 10,
  loaderMinDuration: 2000 // 2 seconds minimum loader display
};

// =========================================================
// STATE
// =========================================================

let currentUser = null;
let isProcessing = false;
let suggestionsState = {
  visible: CONFIG.initialSuggestions,
  expanded: false
};

const dataCache = {
  sales: [],
  purchases: [],
  customers: [],
  suppliers: [],
  products: [],
  expenses: [],
  errors: {},
  loadedAt: null
};

// =========================================================
// LOADER CONTROLS (with minimum display time)
// =========================================================

let loaderStartTime = null;
let loaderTimeout = null;

function showLoader() {
  const overlay = document.getElementById('loaderOverlay');
  if (overlay) {
    overlay.classList.add('active');
    loaderStartTime = Date.now();
  }
}

function hideLoader() {
  const overlay = document.getElementById('loaderOverlay');
  if (!overlay) return;

  // If loader hasn't been shown for minimum duration, wait
  if (loaderStartTime) {
    const elapsed = Date.now() - loaderStartTime;
    const remaining = CONFIG.loaderMinDuration - elapsed;
    
    if (remaining > 0) {
      // Wait for remaining time before hiding
      clearTimeout(loaderTimeout);
      loaderTimeout = setTimeout(() => {
        overlay.classList.remove('active');
        loaderStartTime = null;
      }, remaining);
      return;
    }
  }
  
  // Hide immediately if minimum time has passed
  overlay.classList.remove('active');
  loaderStartTime = null;
}

// =========================================================
// AUTH HELPERS
// =========================================================

function waitForAuth() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

// =========================================================
// DATA HELPERS
// =========================================================

function readLocal(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function mergeById(lists) {
  const map = new Map();
  lists.flat().forEach((item) => {
    if (!item || item.id == null) return;
    if (!map.has(String(item.id))) map.set(String(item.id), item);
  });
  return [...map.values()];
}

function mapDocs(snapshot) {
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchOwned(name, uid) {
  const snap = await getDocs(
    query(collection(db, name), where("ownerId", "==", uid))
  );
  return mapDocs(snap);
}

async function fetchBusinessOwned(name, uid) {
  const snap = await getDocs(
    query(
      collection(db, "businesses", uid, name),
      where("ownerId", "==", uid)
    )
  );
  return mapDocs(snap);
}

async function loadCollection(key, name, uid) {
  const buckets = [];
  try {
    buckets.push(await fetchOwned(name, uid));
  } catch (err) {
    console.warn(`FlowAI: top-level ${name} failed`, err);
  }
  try {
    buckets.push(await fetchBusinessOwned(name, uid));
  } catch (err) {
    console.warn(`FlowAI: businesses/${uid}/${name} failed`, err);
  }

  const merged = mergeById(buckets);
  dataCache[key] = merged;
  dataCache.errors[key] = name !== "expenses" && buckets.length === 0;
  return merged;
}

async function loadAllData() {
  const uid = currentUser?.uid;
  if (!uid) throw new Error("Not signed in.");

  dataCache.errors = {};

  await Promise.all([
    loadCollection("sales", "sales", uid),
    loadCollection("purchases", "purchases", uid),
    loadCollection("customers", "customers", uid),
    loadCollection("suppliers", "suppliers", uid),
    loadCollection("products", "products", uid),
    loadCollection("expenses", "expenses", uid)
  ]);

  dataCache.purchases = mergeById([
    dataCache.purchases,
    readLocal(LS.purchases)
  ]);
  dataCache.customers = mergeById([
    dataCache.customers,
    readLocal(LS.customers)
  ]);
  dataCache.suppliers = mergeById([
    dataCache.suppliers,
    readLocal(LS.suppliers),
    readLocal(LS.purchaseSuppliers)
  ]);
  dataCache.expenses = mergeById([
    dataCache.expenses,
    readLocal(LS.expenses)
  ]);

  dataCache.errors.expenses = false;
  dataCache.loadedAt = new Date();
}

// =========================================================
// DATA TRANSFORM HELPERS
// =========================================================

function toDateSafe(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  if (typeof value === "object" && typeof value.seconds === "number") {
    return new Date(value.seconds * 1000);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function recordDate(record) {
  return toDateSafe(record.createdAt) || toDateSafe(record.date) || toDateSafe(record.updatedAt);
}

function monthRange(offsetFromNow) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offsetFromNow, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offsetFromNow + 1, 1);
  const label = start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return { start, end, label };
}

function inRange(date, range) {
  return !!date && date >= range.start && date < range.end;
}

function money(n, currency) {
  const val = Number(n) || 0;
  return (currency || "PKR") + " " + val.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function pct(part, whole) {
  if (!whole) return "0%";
  return Math.round((part / whole) * 100) + "%";
}

function sum(list, fn) {
  return list.reduce((s, x) => s + (Number(fn(x)) || 0), 0);
}

function groupSum(list, keyFn, valueFn, labelFn) {
  const map = new Map();
  list.forEach((item) => {
    const key = keyFn(item);
    if (key === undefined || key === null || key === "") return;
    if (!map.has(key)) {
      map.set(key, { key, label: labelFn ? labelFn(item) : key, total: 0, count: 0 });
    }
    const entry = map.get(key);
    entry.total += Number(valueFn(item)) || 0;
    entry.count += 1;
  });
  return [...map.values()].sort((a, b) => b.total - a.total);
}

// =========================================================
// HTML HELPERS
// =========================================================

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function listHtml(rows, maxItems = CONFIG.maxListItems) {
  const items = rows.slice(0, maxItems);
  return `<ul>${items.map((r) => `<li><span class="li-label">${escapeHtml(r.label)}</span><span class="li-value">${escapeHtml(r.value)}</span></li>`).join("")}</ul>`;
}

function findProduct(productId) {
  return dataCache.products.find((p) => p.id === productId);
}

function isActiveSale(sale) {
  const status = sale.saleStatus || sale.status;
  return status !== "Returned";
}

function isActivePurchase(p) {
  return p.status !== "Cancelled";
}

function itemName(item) {
  return item.name || item.productName || "";
}

function itemQty(item) {
  return Number(item.qty ?? item.quantity) || 0;
}

function itemLineTotal(item) {
  return Number(item.lineTotal ?? item.total) || 0;
}

function productUnitCost(product) {
  if (!product) return null;
  if (product.costPrice != null && product.costPrice !== "") return Number(product.costPrice) || 0;
  if (product.purchasePrice != null && product.purchasePrice !== "") return Number(product.purchasePrice) || 0;
  return null;
}

function noData(key, label) {
  if (dataCache.errors[key]) {
    return `I couldn't load your ${label} from Firestore. Tap <strong>Refresh Data</strong> and make sure you're signed in.`;
  }
  return `I don't have any ${label} recorded yet for this account.`;
}

// =========================================================
// BUSINESS LOGIC — INTENT HANDLERS
// =========================================================

const NO_SALES = () => noData("sales", "sales");
const NO_PURCHASES = () => noData("purchases", "purchases");
const NO_PRODUCTS = () => noData("products", "products");
const NO_EXPENSES = () => noData("expenses", "expenses");

function activeSales() {
  return dataCache.sales.filter(isActiveSale);
}

function activePurchases() {
  return dataCache.purchases.filter(isActivePurchase);
}

function salesInMonth(offset) {
  const range = monthRange(offset);
  return activeSales().filter((s) => inRange(recordDate(s), range));
}

function purchasesInMonth(offset) {
  const range = monthRange(offset);
  return activePurchases().filter((p) => inRange(recordDate(p), range));
}

// --- Sales Intents ---

function intentSalesThisMonth() {
  if (!dataCache.sales.length) return NO_SALES();
  const range = monthRange(0);
  const sales = salesInMonth(0);
  const total = sum(sales, (s) => s.grandTotal);
  const count = sales.length;
  const avg = count ? total / count : 0;
  return `In <strong>${range.label}</strong>, you've made <span class="figure">${count}</span> sale${count === 1 ? "" : "s"} totaling <span class="figure">${money(total)}</span>, averaging <span class="figure">${money(avg)}</span> per sale.`;
}

function intentSalesVsLastMonth() {
  if (!dataCache.sales.length) return NO_SALES();
  const thisR = monthRange(0);
  const lastR = monthRange(-1);
  const thisTotal = sum(salesInMonth(0), (s) => s.grandTotal);
  const lastTotal = sum(salesInMonth(-1), (s) => s.grandTotal);
  const diff = thisTotal - lastTotal;
  const dir = diff > 0 ? "up 📈" : diff < 0 ? "down 📉" : "flat ➡️";
  const changePct = lastTotal ? Math.abs(Math.round((diff / lastTotal) * 100)) : thisTotal > 0 ? 100 : 0;
  return `Sales in <strong>${thisR.label}</strong> are <span class="figure">${money(thisTotal)}</span> vs <span class="figure">${money(lastTotal)}</span> in ${lastR.label} — <strong>${dir}${dir !== "flat ➡️" ? " " + changePct + "%" : ""}</strong>.`;
}

function intentBestSalesDay() {
  if (!dataCache.sales.length) return NO_SALES();
  const byDay = groupSum(activeSales(), (s) => {
    const d = recordDate(s);
    return d ? d.toDateString() : null;
  }, (s) => s.grandTotal);
  if (!byDay.length) return NO_SALES();
  const top = byDay[0];
  return `🏆 Your best sales day so far was <strong>${escapeHtml(top.label)}</strong>, with <span class="figure">${money(top.total)}</span> across ${top.count} sale${top.count === 1 ? "" : "s"}.`;
}

function intentHighestValueSale() {
  if (!dataCache.sales.length) return NO_SALES();
  const top = [...dataCache.sales].sort((a, b) => (Number(b.grandTotal) || 0) - (Number(a.grandTotal) || 0))[0];
  return `💎 Your highest-value sale is <strong>${escapeHtml(top.saleNumber || top.id)}</strong> to <strong>${escapeHtml(top.customerName || "Walk-in")}</strong>, worth <span class="figure">${money(top.grandTotal, top.currency)}</span>.`;
}

function intentBestCustomerBySales() {
  if (!dataCache.sales.length) return NO_SALES();
  const byCustomer = groupSum(activeSales(), (s) => s.customerId || s.customerName, (s) => s.grandTotal, (s) => s.customerName || "Walk-in");
  if (!byCustomer.length) return NO_SALES();
  const top = byCustomer[0];
  const rows = byCustomer.slice(0, 5).map((c) => ({ label: c.label, value: money(c.total) }));
  return `👑 Your best customer is <strong>${escapeHtml(top.label)}</strong>, with <span class="figure">${money(top.total)}</span> across ${top.count} order${top.count === 1 ? "" : "s"}.${listHtml(rows)}`;
}

function intentTopSellingProducts() {
  if (!dataCache.sales.length) return NO_SALES();
  const items = activeSales().flatMap((s) => s.items || []);
  const byProduct = groupSum(items, (it) => it.productId || itemName(it), (it) => itemQty(it), (it) => itemName(it));
  if (!byProduct.length) return NO_SALES();
  const rows = byProduct.slice(0, 5).map((p) => ({ label: p.label, value: `${p.total} units` }));
  return `📦 Your top-selling products by quantity:${listHtml(rows)}`;
}

function intentTopRevenueProducts() {
  if (!dataCache.sales.length) return NO_SALES();
  const items = activeSales().flatMap((s) => s.items || []);
  const byProduct = groupSum(items, (it) => it.productId || itemName(it), (it) => itemLineTotal(it), (it) => itemName(it));
  if (!byProduct.length) return NO_SALES();
  const rows = byProduct.slice(0, 5).map((p) => ({ label: p.label, value: money(p.total) }));
  return `💰 Products generating the most sales revenue:${listHtml(rows)}`;
}

function intentPaymentStatusBreakdown() {
  if (!dataCache.sales.length) return NO_SALES();
  const active = activeSales();
  const paid = active.filter((s) => s.paymentStatus === "Paid").length;
  const partial = active.filter((s) => s.paymentStatus === "Partially Paid").length;
  const unpaid = active.filter((s) => s.paymentStatus === "Unpaid" || !s.paymentStatus).length;
  const total = active.length;
  return `💳 Out of ${total} sales: <strong>Paid</strong> ${pct(paid, total)} (${paid}), <strong>Partially Paid</strong> ${pct(partial, total)} (${partial}), <strong>Unpaid</strong> ${pct(unpaid, total)} (${unpaid}).`;
}

function intentCustomersHighestOutstanding() {
  if (!dataCache.sales.length) return NO_SALES();
  const byCustomer = groupSum(dataCache.sales.filter((s) => (Number(s.balance) || 0) > 0), (s) => s.customerId || s.customerName, (s) => s.balance, (s) => s.customerName || "Walk-in");
  if (!byCustomer.length) return `✅ No customers currently have an outstanding balance — everything's settled.`;
  const rows = byCustomer.slice(0, 5).map((c) => ({ label: c.label, value: money(c.total) }));
  return `📋 Customers with the highest outstanding balances:${listHtml(rows)}`;
}

function intentCustomersUnpaidLatest() {
  if (!dataCache.sales.length) return NO_SALES();
  const byCustomerLatest = new Map();
  [...dataCache.sales]
    .sort((a, b) => (recordDate(b) || 0) - (recordDate(a) || 0))
    .forEach((s) => {
      const key = s.customerId || s.customerName;
      if (key && !byCustomerLatest.has(key)) byCustomerLatest.set(key, s);
    });
  const unpaidLatest = [...byCustomerLatest.values()].filter((s) => (Number(s.balance) || 0) > 0);
  if (!unpaidLatest.length) return `✅ Every customer's most recent sale is fully paid.`;
  const rows = unpaidLatest.slice(0, 8).map((s) => ({
    label: s.customerName || "Walk-in",
    value: `${s.saleNumber || s.id} — ${money(s.balance)} due`
  }));
  return `⚠️ Customers whose latest sale isn't fully paid:${listHtml(rows)}`;
}

// --- Purchases Intents ---

function intentPurchasesThisMonth() {
  if (!dataCache.purchases.length) return NO_PURCHASES();
  const range = monthRange(0);
  const purchases = purchasesInMonth(0);
  const total = sum(purchases, (p) => p.grandTotal);
  return `In <strong>${range.label}</strong>, you've made <span class="figure">${purchases.length}</span> purchase${purchases.length === 1 ? "" : "s"} totaling <span class="figure">${money(total)}</span>.`;
}

function intentPurchasesVsLastMonth() {
  if (!dataCache.purchases.length) return NO_PURCHASES();
  const thisR = monthRange(0);
  const lastR = monthRange(-1);
  const thisTotal = sum(purchasesInMonth(0), (p) => p.grandTotal);
  const lastTotal = sum(purchasesInMonth(-1), (p) => p.grandTotal);
  const diff = thisTotal - lastTotal;
  const dir = diff > 0 ? "up 📈" : diff < 0 ? "down 📉" : "flat ➡️";
  const changePct = lastTotal ? Math.abs(Math.round((diff / lastTotal) * 100)) : thisTotal > 0 ? 100 : 0;
  return `Purchases in <strong>${thisR.label}</strong> are <span class="figure">${money(thisTotal)}</span> vs <span class="figure">${money(lastTotal)}</span> in ${lastR.label} — <strong>${dir}${dir !== "flat ➡️" ? " " + changePct + "%" : ""}</strong>.`;
}

function intentTopSupplierByPurchase() {
  if (!dataCache.purchases.length) return NO_PURCHASES();
  const bySupplier = groupSum(activePurchases(), (p) => p.supplierId || p.supplierName, (p) => p.grandTotal, (p) => p.supplierName || "Supplier");
  if (!bySupplier.length) return NO_PURCHASES();
  const top = bySupplier[0];
  const rows = bySupplier.slice(0, 5).map((s) => ({ label: s.label, value: money(s.total) }));
  return `🏭 You've purchased the most from <strong>${escapeHtml(top.label)}</strong>, totaling <span class="figure">${money(top.total)}</span>.${listHtml(rows)}`;
}

function intentTopPurchasedProducts() {
  if (!dataCache.purchases.length) return NO_PURCHASES();
  const items = activePurchases().flatMap((p) => p.items || []);
  const byProduct = groupSum(items, (it) => it.productId || itemName(it), (it) => itemQty(it), (it) => itemName(it));
  if (!byProduct.length) return NO_PURCHASES();
  const rows = byProduct.slice(0, 5).map((p) => ({ label: p.label, value: `${p.total} units` }));
  return `📦 Products you've purchased the most:${listHtml(rows)}`;
}

function intentLargestPurchase() {
  if (!dataCache.purchases.length) return NO_PURCHASES();
  const top = [...dataCache.purchases].sort((a, b) => (Number(b.grandTotal) || 0) - (Number(a.grandTotal) || 0))[0];
  return `💎 Your largest purchase is <strong>${escapeHtml(top.purchaseNumber || top.id)}</strong> from <strong>${escapeHtml(top.supplierName || "Supplier")}</strong>, worth <span class="figure">${money(top.grandTotal, top.currency)}</span>.`;
}

function intentSuppliersHighestOutstanding() {
  if (!dataCache.purchases.length) return NO_PURCHASES();
  const bySupplier = groupSum(dataCache.purchases.filter((p) => (Number(p.balance) || 0) > 0), (p) => p.supplierId || p.supplierName, (p) => p.balance, (p) => p.supplierName || "Supplier");
  if (!bySupplier.length) return `✅ No suppliers currently have an outstanding balance from you.`;
  const rows = bySupplier.slice(0, 5).map((s) => ({ label: s.label, value: money(s.total) }));
  return `📋 Suppliers you owe the most:${listHtml(rows)}`;
}

function intentTotalPaidSuppliers() {
  if (!dataCache.purchases.length) return NO_PURCHASES();
  const total = sum(activePurchases(), (p) => p.amountPaid);
  return `💰 You've paid suppliers a total of <span class="figure">${money(total)}</span> across all recorded purchases.`;
}

function intentTotalOwedSuppliers() {
  if (!dataCache.purchases.length) return NO_PURCHASES();
  const total = sum(activePurchases(), (p) => p.balance);
  return `⚠️ You currently owe suppliers a total of <span class="warn-figure">${money(total)}</span> across all outstanding purchases.`;
}

// --- Profit Intents ---

function computeCOGS(salesList) {
  if (!dataCache.products.length) return null;
  let matched = 0;
  let total = 0;
  salesList.forEach((s) => {
    (s.items || []).forEach((it) => {
      const cost = productUnitCost(findProduct(it.productId));
      if (cost == null) return;
      total += cost * itemQty(it);
      matched++;
    });
  });
  return matched > 0 ? total : null;
}

function computeProfit(range) {
  const salesInRange = activeSales().filter((s) => !range || inRange(recordDate(s), range));
  const salesTotal = sum(salesInRange, (s) => s.grandTotal);
  const cogs = computeCOGS(salesInRange);
  const purchasesTotal = sum(activePurchases().filter((p) => !range || inRange(recordDate(p), range)), (p) => p.grandTotal);
  const expensesTotal = sum(dataCache.expenses.filter((e) => !range || inRange(toDateSafe(e.date || e.createdAt), range)), (e) => e.amount);
  const cogsAvailable = cogs !== null;
  const costBasis = cogsAvailable ? cogs : purchasesTotal;
  return {
    salesTotal,
    cogs: costBasis,
    cogsAvailable,
    purchasesTotal,
    expensesTotal,
    profit: salesTotal - costBasis - expensesTotal
  };
}

function intentProfitThisMonth() {
  if (!dataCache.sales.length && !dataCache.purchases.length) return NO_SALES();
  const range = monthRange(0);
  const p = computeProfit(range);
  const note = p.cogsAvailable
    ? "using product cost prices where available"
    : "using purchase totals as cost (product cost prices were not available)";
  return `📈 Estimated profit for <strong>${range.label}</strong> is <span class="figure">${money(p.profit)}</span> (${note}). Sales ${money(p.salesTotal)} − cost ${money(p.cogs)} − expenses ${money(p.expensesTotal)}.`;
}

function intentProfitVsLastMonth() {
  if (!dataCache.sales.length && !dataCache.purchases.length) return NO_SALES();
  const thisP = computeProfit(monthRange(0));
  const lastP = computeProfit(monthRange(-1));
  const diff = thisP.profit - lastP.profit;
  const dir = diff > 0 ? "up 📈" : diff < 0 ? "down 📉" : "flat ➡️";
  return `📊 Estimated profit is <span class="figure">${money(thisP.profit)}</span> this month vs <span class="figure">${money(lastP.profit)}</span> last month — <strong>${dir}</strong> by ${money(Math.abs(diff))}.`;
}

function productProfitBreakdown() {
  if (!dataCache.products.length || !dataCache.sales.length) return null;
  const map = new Map();
  activeSales().flatMap((s) => s.items || []).forEach((it) => {
    const product = findProduct(it.productId);
    const cost = productUnitCost(product);
    if (cost == null) return;
    const key = it.productId || itemName(it);
    if (!map.has(key)) map.set(key, { name: itemName(it) || (product && product.name) || key, qty: 0, revenue: 0, cost: 0 });
    const entry = map.get(key);
    const qty = itemQty(it);
    entry.qty += qty;
    entry.revenue += itemLineTotal(it);
    entry.cost += cost * qty;
  });
  const rows = [...map.values()].map((r) => ({ ...r, profit: r.revenue - r.cost }));
  return rows.length ? rows : null;
}

function intentMostProfitableProducts() {
  const rows = productProfitBreakdown();
  if (!rows) return `I need both sales line items and product cost prices to rank profitable products.`;
  const top = [...rows].sort((a, b) => b.profit - a.profit).slice(0, 5).map((r) => ({ label: r.name, value: money(r.profit) }));
  return `🏆 Most profitable products (revenue − cost):${listHtml(top)}`;
}

function intentLowestProfitProducts() {
  const rows = productProfitBreakdown();
  if (!rows) return `I need both sales line items and product cost prices to rank least profitable products.`;
  const low = [...rows].sort((a, b) => a.profit - b.profit).slice(0, 5).map((r) => ({ label: r.name, value: money(r.profit) }));
  return `📉 Lowest-profit products (revenue − cost):${listHtml(low)}`;
}

function intentWhyProfitLow() {
  if (!dataCache.sales.length) return NO_SALES();
  const thisP = computeProfit(monthRange(0));
  const lastP = computeProfit(monthRange(-1));
  const factors = [];
  const salesDiff = thisP.salesTotal - lastP.salesTotal;
  if (salesDiff < 0) factors.push({ label: "Sales revenue dropped", value: money(Math.abs(salesDiff)) + " lower than last month" });
  const purchaseDiff = thisP.purchasesTotal - lastP.purchasesTotal;
  if (purchaseDiff > 0) factors.push({ label: "Purchase costs increased", value: money(purchaseDiff) + " higher than last month" });
  const discountTotal = sum(salesInMonth(0), (s) => s.discountTotal || s.discount);
  if (discountTotal > 0) factors.push({ label: "Discounts given this month", value: money(discountTotal) });
  const outstanding = sum(dataCache.sales, (s) => s.balance);
  if (outstanding > 0) factors.push({ label: "Cash tied up in unpaid sales", value: money(outstanding) });
  if (thisP.expensesTotal > 0) factors.push({ label: "Expenses this month", value: money(thisP.expensesTotal) });
  if (!factors.length) {
    return `Based on recorded totals, profit is not clearly down this month. Sales are ${money(thisP.salesTotal)} vs ${money(lastP.salesTotal)} last month.`;
  }
  return `🔍 Here's what's affecting profit this month:${listHtml(factors)}`;
}

// --- Customer Intents ---

function intentBestCustomers() {
  return intentBestCustomerBySales();
}

function intentCustomersOutstanding() {
  return intentCustomersHighestOutstanding();
}

function intentWhoOwesMost() {
  if (!dataCache.sales.length) return NO_SALES();
  const byCustomer = groupSum(dataCache.sales.filter((s) => (Number(s.balance) || 0) > 0), (s) => s.customerId || s.customerName, (s) => s.balance, (s) => s.customerName || "Walk-in");
  if (!byCustomer.length) return `✅ No one owes you money right now — all sales are settled.`;
  const top = byCustomer[0];
  return `👤 <strong>${escapeHtml(top.label)}</strong> owes you the most, with <span class="warn-figure">${money(top.total)}</span> outstanding.`;
}

function intentCustomersNotPurchasedRecently() {
  if (!dataCache.sales.length) return NO_SALES();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.recentDaysThreshold);
  const lastByCustomer = new Map();
  dataCache.sales.forEach((s) => {
    const d = recordDate(s);
    if (!d) return;
    const key = s.customerId || s.customerName;
    const prev = lastByCustomer.get(key);
    if (!prev || d > prev.date) lastByCustomer.set(key, { name: s.customerName || "Walk-in", date: d });
  });
  const stale = [...lastByCustomer.values()].filter((c) => c.date < cutoff);
  if (!stale.length) return `All your customers have purchased within the last ${CONFIG.recentDaysThreshold} days.`;
  const rows = stale.slice(0, 8).map((c) => ({
    label: c.name,
    value: c.date.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" })
  }));
  return `⏰ Customers who haven't purchased in the last ${CONFIG.recentDaysThreshold} days:${listHtml(rows)}`;
}

// --- Supplier Intents ---

function intentTopSuppliers() {
  return intentTopSupplierByPurchase();
}

function intentSpentPerSupplier() {
  if (!dataCache.purchases.length) return NO_PURCHASES();
  const bySupplier = groupSum(activePurchases(), (p) => p.supplierId || p.supplierName, (p) => p.grandTotal, (p) => p.supplierName || "Supplier");
  const rows = bySupplier.slice(0, 10).map((s) => ({ label: s.label, value: money(s.total) }));
  return `💰 Total spent per supplier:${listHtml(rows)}`;
}

// --- Inventory Intents ---

function getStockStatus(stock, reorderLevel) {
  const s = Number(stock) || 0;
  const r = Number(reorderLevel) || 0;
  if (s <= 0) return "Out of Stock";
  if (r > 0 && s <= r) return "Low Stock";
  return "In Stock";
}

function reorderOf(p) {
  return p.reorderLevel || p.minStock || p.minimumStock;
}

function intentLowStock() {
  if (!dataCache.products.length) return NO_PRODUCTS();
  const low = dataCache.products.filter((p) => getStockStatus(p.stock, reorderOf(p)) !== "In Stock");
  if (!low.length) return `All your products are sufficiently stocked — nothing is low or out of stock right now.`;
  const rows = low.slice(0, 10).map((p) => ({
    label: p.name,
    value: `${getStockStatus(p.stock, reorderOf(p))} (${Number(p.stock) || 0} left)`
  }));
  return `📦 Products low or out of stock:${listHtml(rows)}`;
}

function intentHighestStockValue() {
  if (!dataCache.products.length) return NO_PRODUCTS();
  const rows = dataCache.products
    .map((p) => ({
      label: p.name,
      value: (productUnitCost(p) || 0) * (Number(p.stock) || 0)
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map((r) => ({ label: r.label, value: money(r.value) }));
  return `💰 Products with the highest stock value (cost × quantity):${listHtml(rows)}`;
}

function intentRestockSuggestions() {
  if (!dataCache.products.length) return NO_PRODUCTS();
  const needs = dataCache.products.filter((p) => getStockStatus(p.stock, reorderOf(p)) !== "In Stock");
  if (!needs.length) return `Nothing needs restocking right now — all stock levels look healthy.`;
  const rows = needs.slice(0, 10).map((p) => {
    const target = Number(p.maximumStock) || Number(p.minimumStock) || Number(p.reorderLevel) * 2 || 0;
    const suggestedQty = Math.max(target - (Number(p.stock) || 0), 0);
    return {
      label: p.name,
      value: suggestedQty > 0 ? `Order ~${suggestedQty} ${p.unit || "units"}` : "Restock needed"
    };
  });
  return `🔄 Products I'd suggest restocking:${listHtml(rows)}`;
}

function intentFastestSellingProducts() {
  if (!dataCache.sales.length) return NO_SALES();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.stockLookbackDays);
  const recentItems = activeSales()
    .filter((s) => recordDate(s) && recordDate(s) >= cutoff)
    .flatMap((s) => s.items || []);
  if (!recentItems.length) return `No sales in the last ${CONFIG.stockLookbackDays} days to measure velocity from.`;
  const byProduct = groupSum(recentItems, (it) => it.productId || itemName(it), (it) => itemQty(it), (it) => itemName(it));
  const rows = byProduct.slice(0, 5).map((p) => {
    const product = findProduct(p.key);
    const stockNote = product ? ` — ${Number(product.stock) || 0} left in stock` : "";
    return { label: p.label, value: `${p.total} units in ${CONFIG.stockLookbackDays} days${stockNote}` };
  });
  return `⚡ Fastest-selling products (last ${CONFIG.stockLookbackDays} days):${listHtml(rows)}`;
}

function intentNotSellingProducts() {
  if (!dataCache.products.length) return NO_PRODUCTS();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.stockLookbackDays);
  const recentlySoldIds = new Set(
    dataCache.sales
      .filter((s) => recordDate(s) && recordDate(s) >= cutoff)
      .flatMap((s) => s.items || [])
      .map((it) => it.productId)
      .filter(Boolean)
  );
  const notSelling = dataCache.products.filter((p) => p.status !== "Discontinued" && !recentlySoldIds.has(p.id));
  if (!notSelling.length) return `Every active product has sold within the last ${CONFIG.stockLookbackDays} days.`;
  const rows = notSelling.slice(0, 10).map((p) => ({
    label: p.name,
    value: `${Number(p.stock) || 0} in stock, no sales in ${CONFIG.stockLookbackDays} days`
  }));
  return `❄️ Products with no sales in the last ${CONFIG.stockLookbackDays} days:${listHtml(rows)}`;
}

// --- Expenses Intents ---

function intentExpensesThisMonth() {
  if (!dataCache.expenses.length) return NO_EXPENSES();
  const range = monthRange(0);
  const total = sum(dataCache.expenses.filter((e) => inRange(toDateSafe(e.date || e.createdAt), range)), (e) => e.amount);
  return `💸 Total expenses in <strong>${range.label}</strong>: <span class="figure">${money(total)}</span>.`;
}

function intentExpensesVsLastMonth() {
  if (!dataCache.expenses.length) return NO_EXPENSES();
  const thisTotal = sum(dataCache.expenses.filter((e) => inRange(toDateSafe(e.date || e.createdAt), monthRange(0))), (e) => e.amount);
  const lastTotal = sum(dataCache.expenses.filter((e) => inRange(toDateSafe(e.date || e.createdAt), monthRange(-1))), (e) => e.amount);
  const dir = thisTotal > lastTotal ? "up 📈" : thisTotal < lastTotal ? "down 📉" : "flat ➡️";
  return `💳 Expenses are <span class="figure">${money(thisTotal)}</span> this month vs <span class="figure">${money(lastTotal)}</span> last month — <strong>${dir}</strong>.`;
}

function intentExpenseTopCategory() {
  if (!dataCache.expenses.length) return NO_EXPENSES();
  const byCategory = groupSum(dataCache.expenses, (e) => e.category || "Other", (e) => e.amount, (e) => e.category || "Other");
  const top = byCategory[0];
  return `📊 Your biggest expense category is <strong>${escapeHtml(top.label)}</strong>, totaling <span class="figure">${money(top.total)}</span>.`;
}

function intentBiggestExpenses() {
  if (!dataCache.expenses.length) return NO_EXPENSES();
  const rows = [...dataCache.expenses]
    .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
    .slice(0, 5)
    .map((e) => ({ label: e.category || e.note || e.description || "Expense", value: money(e.amount) }));
  return `💵 Your biggest individual expenses:${listHtml(rows)}`;
}

function intentExpensesIncreasing() {
  if (!dataCache.expenses.length) return NO_EXPENSES();
  const thisByCat = groupSum(dataCache.expenses.filter((e) => inRange(toDateSafe(e.date || e.createdAt), monthRange(0))), (e) => e.category || "Other", (e) => e.amount, (e) => e.category || "Other");
  const lastByCat = groupSum(dataCache.expenses.filter((e) => inRange(toDateSafe(e.date || e.createdAt), monthRange(-1))), (e) => e.category || "Other", (e) => e.amount, (e) => e.category || "Other");
  const lastMap = new Map(lastByCat.map((c) => [c.key, c.total]));
  const increases = thisByCat.map((c) => ({ label: c.label, diff: c.total - (lastMap.get(c.key) || 0) })).filter((c) => c.diff > 0).sort((a, b) => b.diff - a.diff);
  if (!increases.length) return `No expense categories have increased compared to last month.`;
  const rows = increases.slice(0, 5).map((c) => ({ label: c.label, value: "+" + money(c.diff) }));
  return `📈 Expense categories that increased vs last month:${listHtml(rows)}`;
}

function intentExpensesProfitImpact() {
  if (!dataCache.expenses.length) return NO_EXPENSES();
  const p = computeProfit(monthRange(0));
  return `📊 This month's expenses (${money(p.expensesTotal)}) reduce estimated profit from ${money(p.salesTotal - p.cogs)} down to <span class="figure">${money(p.profit)}</span>.`;
}

// --- Help ---

const HELP_MESSAGE = () => `I wasn't sure how to answer that. Try asking about sales, purchases, profit, customers, suppliers, inventory, payments, or expenses — or tap a suggestion below.`;

// =========================================================
// INTENT REGISTRY
// =========================================================

const INTENTS = [
  { id: "sales_this_month", phrases: ["how are my sales this month", "sales performing this month", "sales this month", "how are my sales"], handler: intentSalesThisMonth },
  { id: "sales_vs_last_month", phrases: ["sales compare with last month", "sales vs last month", "compare sales"], handler: intentSalesVsLastMonth },
  { id: "best_sales_day", phrases: ["best sales day"], handler: intentBestSalesDay },
  { id: "highest_value_sale", phrases: ["highest-value sale", "highest value sale", "biggest sale"], handler: intentHighestValueSale },
  { id: "best_customer_sales", phrases: ["best customer by sales", "best customer"], handler: intentBestCustomerBySales },
  { id: "top_selling_products", phrases: ["what are my top-selling products", "what are my top selling products", "top-selling products", "top selling products", "best selling products"], handler: intentTopSellingProducts },
  { id: "top_revenue_products", phrases: ["most sales revenue", "generated the most sales revenue", "highest revenue products"], handler: intentTopRevenueProducts },
  { id: "payment_status_breakdown", phrases: ["paid, partially paid", "percentage of sales are paid", "payment status", "how many sales are paid"], handler: intentPaymentStatusBreakdown },
  { id: "customers_highest_outstanding", phrases: ["customers have the highest outstanding", "highest outstanding balances", "outstanding balances"], handler: intentCustomersHighestOutstanding },
  { id: "customers_unpaid_latest", phrases: ["not paid their latest sales", "unpaid latest sale"], handler: intentCustomersUnpaidLatest },
  { id: "purchases_this_month", phrases: ["purchases this month", "how are my purchases"], handler: intentPurchasesThisMonth },
  { id: "purchases_vs_last_month", phrases: ["purchases compare with last month", "purchases vs last month"], handler: intentPurchasesVsLastMonth },
  { id: "top_supplier_purchase", phrases: ["which supplier do i buy the most from", "supplier do i buy the most from", "supplier did i purchase the most", "top supplier"], handler: intentTopSupplierByPurchase },
  { id: "top_purchased_products", phrases: ["products did i purchase the most", "most purchased products"], handler: intentTopPurchasedProducts },
  { id: "largest_purchase", phrases: ["largest purchase", "biggest purchase"], handler: intentLargestPurchase },
  { id: "suppliers_highest_outstanding", phrases: ["suppliers have the highest outstanding", "suppliers outstanding"], handler: intentSuppliersHighestOutstanding },
  { id: "total_paid_suppliers", phrases: ["how much have i paid suppliers", "paid suppliers"], handler: intentTotalPaidSuppliers },
  { id: "total_owed_suppliers", phrases: ["how much do i currently owe suppliers", "owe suppliers"], handler: intentTotalOwedSuppliers },
  { id: "profit_this_month", phrases: ["how much profit did i make", "profit did i make this month", "profit this month", "how much profit"], handler: intentProfitThisMonth },
  { id: "profit_vs_last_month", phrases: ["profit compare with last month", "profit vs last month"], handler: intentProfitVsLastMonth },
  { id: "most_profitable_products", phrases: ["most profitable products"], handler: intentMostProfitableProducts },
  { id: "lowest_profit_products", phrases: ["lowest profit", "least profitable"], handler: intentLowestProfitProducts },
  { id: "why_profit_low", phrases: ["why is my profit low", "affecting my profit", "profit low"], handler: intentWhyProfitLow },
  { id: "best_customers", phrases: ["who are my best customers", "best customers"], handler: intentBestCustomers },
  { id: "customers_outstanding", phrases: ["customers have outstanding balances", "who has outstanding"], handler: intentCustomersOutstanding },
  { id: "who_owes_most", phrases: ["who owes me the most", "owes me the most"], handler: intentWhoOwesMost },
  { id: "customers_purchased_most", phrases: ["customers have purchased the most"], handler: intentBestCustomerBySales },
  { id: "customers_not_recent", phrases: ["not purchased recently", "haven't purchased recently"], handler: intentCustomersNotPurchasedRecently },
  { id: "top_suppliers", phrases: ["who are my top suppliers", "top suppliers"], handler: intentTopSuppliers },
  { id: "suppliers_purchase_most", phrases: ["suppliers do i purchase the most from"], handler: intentTopSuppliers },
  { id: "spent_per_supplier", phrases: ["how much have i spent with each supplier", "spent with each supplier"], handler: intentSpentPerSupplier },
  { id: "low_stock", phrases: ["low in stock", "low stock"], handler: intentLowStock },
  { id: "fastest_selling", phrases: ["selling fastest", "fastest selling"], handler: intentFastestSellingProducts },
  { id: "not_selling", phrases: ["not selling", "not selling products"], handler: intentNotSellingProducts },
  { id: "highest_stock_value", phrases: ["highest stock value"], handler: intentHighestStockValue },
  { id: "restock", phrases: ["which products should i restock", "should i restock", "restock"], handler: intentRestockSuggestions },
  { id: "expenses_this_month", phrases: ["spend on expenses this month", "expenses this month"], handler: intentExpensesThisMonth },
  { id: "expenses_vs_last_month", phrases: ["expenses compare with last month", "expenses vs last month"], handler: intentExpensesVsLastMonth },
  { id: "expense_top_category", phrases: ["category costs me the most", "top expense category"], handler: intentExpenseTopCategory },
  { id: "biggest_expenses", phrases: ["what are my biggest expenses", "biggest expenses"], handler: intentBiggestExpenses },
  { id: "expenses_increasing", phrases: ["expenses are increasing", "expenses increasing"], handler: intentExpensesIncreasing },
  { id: "expenses_profit_impact", phrases: ["expenses affecting my profit", "how are expenses affecting"], handler: intentExpensesProfitImpact }
];

// =========================================================
// INTENT MATCHING ENGINE
// =========================================================

function matchIntent(message) {
  const lower = message.toLowerCase().trim();
  let best = null;
  let bestLen = 0;
  for (const intent of INTENTS) {
    for (const phrase of intent.phrases) {
      if (lower.includes(phrase) && phrase.length > bestLen) {
        best = intent;
        bestLen = phrase.length;
      }
    }
  }
  if (best) return best;
  let bestScore = 0;
  for (const intent of INTENTS) {
    const words = new Set(intent.phrases.join(" ").split(/\s+/));
    let score = 0;
    words.forEach((w) => {
      if (w.length > 3 && lower.includes(w)) score++;
    });
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }
  return bestScore >= 2 ? best : null;
}

// =========================================================
// UI CONTROLS
// =========================================================

function setStatus(text) {
  const el = document.getElementById("chatStatus");
  if (!el) return;
  el.innerHTML = `<span class="status-dot"></span> ${escapeHtml(text)}`;
}

function setControlsEnabled(enabled) {
  const input = document.getElementById("chatInput");
  const sendBtn = document.getElementById("chatSendBtn");
  if (input) input.disabled = !enabled;
  if (sendBtn) sendBtn.disabled = !enabled;
  document.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.disabled = !enabled;
  });
}

function showNotification(message, icon, isError) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.classList.toggle("toast-error", !!isError);
  toast.innerHTML = `<i class="fas ${icon || "fa-circle-check"}"></i> ${escapeHtml(message)}`;
  toast.classList.add("show");
  clearTimeout(showNotification._t);
  showNotification._t = setTimeout(() => toast.classList.remove("show"), CONFIG.toastDuration);
}

// =========================================================
// SUGGESTIONS — Enhanced with Show More/Fewer
// =========================================================

const ALL_QUESTIONS = [
  "How are my sales this month?",
  "How do my sales compare with last month?",
  "What was my best sales day?",
  "What was my highest-value sale?",
  "Who is my best customer by sales?",
  "What are my top-selling products?",
  "Which products generated the most sales revenue?",
  "What percentage of my sales are paid, partially paid, and unpaid?",
  "Which customers have the highest outstanding balances?",
  "Which customers have not paid their latest sales?",
  "How are my purchases this month?",
  "How do my purchases compare with last month?",
  "Which supplier did I purchase the most from?",
  "Which products did I purchase the most?",
  "What was my largest purchase?",
  "Which suppliers have the highest outstanding balances?",
  "How much have I paid to suppliers?",
  "How much do I currently owe suppliers?",
  "How much profit did I make this month?",
  "How does my profit compare with last month?",
  "What are my most profitable products?",
  "Which products generate the most revenue?",
  "Which products have the lowest profit?",
  "Why is my profit low this month?",
  "What is affecting my profit the most?",
  "Who are my best customers?",
  "Which customers have outstanding balances?",
  "Who owes me the most?",
  "Which customers have purchased the most?",
  "Which customers have not purchased recently?",
  "Who are my top suppliers?",
  "Which suppliers do I purchase the most from?",
  "Which suppliers have outstanding balances?",
  "How much have I spent with each supplier?",
  "Which products are low in stock?",
  "Which products are selling the fastest?",
  "Which products are not selling?",
  "Which products have the highest stock value?",
  "Which products should I consider restocking?",
  "How much did I spend on expenses this month?",
  "How do my expenses compare with last month?",
  "What category costs me the most?",
  "What are my biggest expenses?",
  "Which expenses are increasing?",
  "How are my expenses affecting my profit?"
];

function setupSuggestions() {
  const wrap = document.getElementById("suggestions");
  if (!wrap) return;

  const showAll = suggestionsState.expanded;
  const visibleCount = showAll ? ALL_QUESTIONS.length : CONFIG.initialSuggestions;
  const visibleQuestions = ALL_QUESTIONS.slice(0, visibleCount);

  let html = visibleQuestions.map(
    (q) => `<button type="button" class="suggestion-chip">${escapeHtml(q)}</button>`
  ).join("");

  if (ALL_QUESTIONS.length > CONFIG.initialSuggestions) {
    const btnText = showAll ? 'Show Fewer ↑' : `Show More (${ALL_QUESTIONS.length - CONFIG.initialSuggestions} more) ↓`;
    html += `<button type="button" class="show-more-btn" id="toggleSuggestionsBtn">${btnText}</button>`;
  }

  wrap.innerHTML = html;

  wrap.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      if (!chip.disabled && !isProcessing) {
        sendMessage(chip.textContent.trim());
      }
    });
  });

  const toggleBtn = document.getElementById("toggleSuggestionsBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      suggestionsState.expanded = !suggestionsState.expanded;
      suggestionsState.visible = suggestionsState.expanded ? ALL_QUESTIONS.length : CONFIG.initialSuggestions;
      setupSuggestions();
      wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
}

// =========================================================
// CHAT SETUP (WITH RESTRICTED INPUT)
// =========================================================

function setupChat() {
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  if (!form || !input) return;

  // Disable the textarea - users can only use suggestion chips
  input.disabled = true;
  input.placeholder = "Please select a question from the suggestions below";
  input.style.opacity = "0.6";
  input.style.cursor = "not-allowed";

  // Remove any event listeners that might allow typing
  input.addEventListener("input", (e) => {
    e.preventDefault();
    input.value = "";
    showNotification("Please select a question from the suggestions below", "fa-info-circle");
  });

  input.addEventListener("keydown", (e) => {
    e.preventDefault();
  });

  // Block form submission entirely (only chips trigger messages)
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    showNotification("Please click a suggestion chip to ask a question", "fa-info-circle");
  });

  const messages = document.getElementById("chatMessages");
  if (messages) {
    messages.addEventListener("click", (e) => {
      const btn = e.target.closest(".copy-btn");
      if (!btn) return;
      const bubble = btn.closest(".chat-bubble-wrap")?.querySelector(".chat-bubble");
      if (!bubble) return;
      
      const text = bubble.innerText;
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add("copied");
        const original = btn.innerHTML;
        btn.innerHTML = `<i class="fas fa-check"></i> Copied!`;
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = original;
        }, CONFIG.copySuccessDuration);
      }).catch(() => {
        const range = document.createRange();
        range.selectNode(bubble);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.execCommand('copy');
        window.getSelection().removeAllRanges();
        showNotification("Copied to clipboard!", "fa-copy");
      });
    });
  }
}

// =========================================================
// MESSAGE RENDERING (WITHOUT AI AVATAR)
// =========================================================

function appendUserMessage(text) {
  const messages = document.getElementById("chatMessages");
  if (!messages) return;
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg-user";
  const initial = (currentUser?.email || "U").charAt(0).toUpperCase();
  div.innerHTML = `
    <div class="chat-avatar user">${escapeHtml(initial)}</div>
    <div class="chat-bubble-wrap">
      <div class="chat-bubble">${escapeHtml(text)}</div>
      <div class="chat-timestamp">${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</div>
    </div>
  `;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function appendTypingIndicator() {
  const messages = document.getElementById("chatMessages");
  if (!messages) return;
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg-ai";
  div.id = "typingIndicator";
  div.innerHTML = `
    <div class="chat-bubble-wrap" style="margin-left: 0;">
      <div class="chat-bubble">
        <div class="chat-typing"><span></span><span></span><span></span></div>
      </div>
    </div>
  `;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

function appendAiMessage(html) {
  const messages = document.getElementById("chatMessages");
  if (!messages) return;
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg-ai";
  div.innerHTML = `
    <div class="chat-bubble-wrap" style="margin-left: 0;">
      <div class="chat-bubble">${html}</div>
      <div class="chat-msg-actions">
        <button type="button" class="copy-btn"><i class="fas fa-copy"></i> Copy</button>
      </div>
      <div class="chat-timestamp">${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</div>
    </div>
  `;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

// =========================================================
// SEND MESSAGE — Core Logic (WITH 2 SECOND MINIMUM LOADER)
// =========================================================

async function sendMessage(text) {
  if (isProcessing) return;
  isProcessing = true;

  // Show loader with minimum display time
  showLoader();

  const input = document.getElementById("chatInput");
  const sendBtn = document.getElementById("chatSendBtn");
  if (input) input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;

  appendUserMessage(text);
  appendTypingIndicator();

  await new Promise((resolve) => setTimeout(resolve, CONFIG.typingDelay));

  let answer;
  try {
    if (!dataCache.loadedAt) {
      answer = `⏳ I'm still connecting to your business data — tap <strong>Refresh Data</strong> if this takes more than a few seconds.`;
    } else {
      const intent = matchIntent(text);
      answer = intent ? intent.handler() : HELP_MESSAGE();
    }
  } catch (err) {
    console.error("FlowAI calculation error:", err);
    answer = `❌ Something went wrong while calculating that. Please try Refresh Data, then ask again.`;
  }

  // Hide loader (will wait for minimum 2 seconds if needed)
  hideLoader();

  // Wait for loader to finish if minimum time hasn't elapsed
  await new Promise((resolve) => {
    const checkLoader = () => {
      const overlay = document.getElementById('loaderOverlay');
      if (!overlay || !overlay.classList.contains('active')) {
        resolve();
      } else {
        setTimeout(checkLoader, 100);
      }
    };
    setTimeout(checkLoader, 50);
  });

  removeTypingIndicator();
  appendAiMessage(answer);

  // Keep input disabled - users can only use suggestion chips
  if (input) {
    input.disabled = true;
    input.value = "";
  }
  if (sendBtn) sendBtn.disabled = false;

  isProcessing = false;
}

// =========================================================
// DATA REFRESH
// =========================================================

async function refreshData() {
  setStatus("📡 Reading your Firestore records...");
  setControlsEnabled(false);

  try {
    await loadAllData();
    const bits = [
      `${dataCache.sales.length} sales`,
      `${dataCache.purchases.length} purchases`,
      `${dataCache.products.length} products`,
      `${dataCache.customers.length} customers`,
      `${dataCache.suppliers.length} suppliers`,
      `${dataCache.expenses.length} expenses`
    ];
    setStatus(`✅ Connected — ${bits.join(", ")}`);
    return true;
  } catch (err) {
    console.error("Failed to load data:", err);
    setStatus("⚠️ Could not load data");
    showNotification("Could not load your business data. Check that you are signed in.", "fa-triangle-exclamation", true);
    return false;
  } finally {
    setControlsEnabled(true);
  }
}

// =========================================================
// SIDEBAR & NAVIGATION
// =========================================================

function setupSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const openBtn = document.getElementById("menuToggle");
  const closeBtn = document.getElementById("sidebarClose");
  if (!sidebar || !overlay || !openBtn || !closeBtn) return;

  const open = () => {
    sidebar.classList.add("open");
    overlay.classList.add("open");
    openBtn.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
  };

  const close = () => {
    sidebar.classList.remove("open");
    overlay.classList.remove("open");
    openBtn.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
  };

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", close);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 860) close();
  });
}

function setupNavigation() {
  const logoutBtn = document.getElementById("logoutBtn");
  if (!logoutBtn) return;

  logoutBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await signOut(auth);
      showNotification("Logging out...", "fa-sign-out");
      setTimeout(() => {
        window.location.href = "../auth/login.html";
      }, 500);
    } catch (err) {
      console.error(err);
      showNotification("Unable to log out. Please try again.", "fa-circle-exclamation", true);
    }
  });
}

// =========================================================
// TOPBAR SCROLL SHADOW
// =========================================================

function setupTopbarScroll() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;

  const handleScroll = () => {
    if (window.scrollY > 10) {
      topbar.classList.add("scrolled");
    } else {
      topbar.classList.remove("scrolled");
    }
  };

  window.addEventListener("scroll", handleScroll);
  handleScroll();
}

// =========================================================
// INITIALIZATION
// =========================================================

async function initializeReports() {
  setupSidebar();
  setupNavigation();
  setupChat();
  setupTopbarScroll();
  setupSuggestions();

  setControlsEnabled(false);

  const refreshBtn = document.getElementById("refreshDataBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      const ok = await refreshData();
      if (ok) {
        showNotification("✅ Data refreshed successfully!", "fa-rotate");
        setupSuggestions();
      }
    });
  }

  currentUser = await waitForAuth();
  if (!currentUser) {
    window.location.href = "../auth/login.html";
    return;
  }

  const ok = await refreshData();
  if (ok) {
    appendAiMessage(`
      👋 <strong>Hello!</strong> I'm your FlowAI assistant.
      <br><br>
      I'm connected to your account and currently see:
      <ul>
        <li><span class="li-label">Sales</span> <span class="li-value">${dataCache.sales.length} records</span></li>
        <li><span class="li-label">Purchases</span> <span class="li-value">${dataCache.purchases.length} records</span></li>
        <li><span class="li-label">Products</span> <span class="li-value">${dataCache.products.length} items</span></li>
        <li><span class="li-label">Customers</span> <span class="li-value">${dataCache.customers.length} people</span></li>
        <li><span class="li-label">Suppliers</span> <span class="li-value">${dataCache.suppliers.length} vendors</span></li>
        <li><span class="li-label">Expenses</span> <span class="li-value">${dataCache.expenses.length} entries</span></li>
      </ul>
      <br>
      💡 <strong>Try asking:</strong> <em>"How are my sales this month?"</em> or tap a suggestion below.
    `);
  }

  // Focus is not needed since input is disabled
}

// =========================================================
// BOOTSTRAP
// =========================================================

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeReports);
} else {
  initializeReports();
}