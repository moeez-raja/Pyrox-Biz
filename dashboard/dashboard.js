/* =========================================================
   Pyrox Biz Dashboard — Firebase Auth + Firestore
   Membership flow (pending / payment_submitted / approved / rejected)
   ========================================================= */

import { auth, db } from "../js/firebase.js";
import { renderMetricCards } from "../js/metric-cards.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
  collection,
  query,
  where,
  getDocs,
  onSnapshot,
  orderBy,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

/* ---------------------------------------------------------
   DEMO FALLBACK SERIES
   --------------------------------------------------------- */

const salesSeries = {
  "7d":  [3200, 4100, 2800, 5200, 4700, 6100, 5800],
  "30d": [2200, 3100, 2600, 4200, 3900, 4700, 5200, 3400, 4100, 4800, 5300, 4600,
          3900, 5100, 5600, 4200, 3800, 4900, 5400, 6100, 5700, 4300, 3900, 5200,
          5800, 6200, 5900, 6400, 6800, 7100],
  "12m": [82000, 91000, 87500, 96000, 102000, 98500, 110000, 115000, 108000,
          121000, 126000, 132000]
};

/* ---------------------------------------------------------
   PLAN CATALOG
   --------------------------------------------------------- */

const PLAN_CATALOG = {
  monthly: {
    id: 'monthly',
    name: 'Monthly',
    price: 3499,
    currency: 'PKR',
    durationMonths: 1,
    label: 'PKR 3,499 / month'
  },
  yearly: {
    id: 'yearly',
    name: 'Yearly',
    price: 34990,
    currency: 'PKR',
    durationMonths: 12,
    label: 'PKR 34,990 / year',
    savings: 6998,
    savingsLabel: 'Save PKR 6,998 (2 months free)'
  }
};

/* ---------------------------------------------------------
   PAYMENT METHODS
   --------------------------------------------------------- */

const PAYMENT_METHODS = {
  easypaisa: {
    id: 'easypaisa',
    label: 'Easypaisa',
    accountNumber: '0300-1234567',
    accountName: 'Pyrox Biz (Pvt) Ltd',
    instructions: 'Send the exact amount to the Easypaisa account above. Then enter the transaction ID below for verification.'
  },
  jazzcash: {
    id: 'jazzcash',
    label: 'JazzCash',
    accountNumber: '0300-1234567',
    accountName: 'Pyrox Biz (Pvt) Ltd',
    instructions: 'Send the exact amount to the JazzCash account above. Then enter the transaction ID below for verification.'
  },
  usdt: {
    id: 'usdt',
    label: 'USDT',
    walletAddress: '0xYOUR-WALLET-ADDRESS-HERE',
    network: 'BEP-20 / ERC-20',
    instructions: 'Send the exact amount in USDT to the wallet address above. Then enter the transaction hash below for verification.'
  }
};

/* ---------------------------------------------------------
   STATE
   --------------------------------------------------------- */

let productsData = [];
let salesData = [];
let customersData = [];
let purchasesData = [];
let suppliersData = [];
let expensesData = [];

let productsUnsub = null;
let salesUnsub = null;
let customersUnsub = null;
let purchasesUnsub = null;
let suppliersUnsub = null;
let expensesUnsub = null;
let membershipUnsub = null;

let purchasesLoaded = false;
let purchasesError = null;
let expensesLoaded = false;
let expensesError = null;

let dashboardDataReady = false;
let currentChartRange = '30d';
let currentSPTab = 'all';

let membership = null;
let membershipLoaded = false;
let dashboardUnlocked = false;
let selectedPlanId = 'monthly';
let selectedMethodId = null;

const initialSnapshotCollections = new Set();
const requiredSnapshotCollections = new Set([
  "products", "sales", "customers", "suppliers", "purchases", "expenses"
]);

const _initialized = {
  search: false,
  modals: false,
  range: false,
  spTabs: false,
  membership: false
};

/* ---------------------------------------------------------
   DEBOUNCE
   --------------------------------------------------------- */

function debounce(fn, ms = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------------------------------------------------
   INITIAL SNAPSHOT READY
   --------------------------------------------------------- */

function markInitialSnapshotReady(collectionName) {
  initialSnapshotCollections.add(collectionName);
  if (initialSnapshotCollections.size < requiredSnapshotCollections.size) return;
  dashboardDataReady = true;
  scheduleRender();
}

const scheduleRender = debounce(() => {
  if (!dashboardUnlocked) return;
  safeRun(renderMetrics);
  safeRun(renderSalesPurchasesFeed);
  safeRun(renderLowStock);
  safeRun(renderRecentActivity);
  safeRun(() => updateSalesChart(currentChartRange));
  if (scheduleRender._notifRender) safeRun(scheduleRender._notifRender);
}, 120);

function safeRun(fn) {
  try { fn(); } catch (e) { console.error(`[${fn.name || 'anon'}]`, e); }
}

/* ---------------------------------------------------------
   FIRESTORE REFS
   --------------------------------------------------------- */

function productsCollection()   { return collection(db, 'products'); }
function salesCollection()      { return collection(db, 'sales'); }
function customersCollection()  { return collection(db, 'customers'); }
function purchasesCollection()  { return collection(db, 'purchases'); }
function suppliersCollection()  { return collection(db, 'suppliers'); }
function expensesCollection(uid) { return collection(db, `businesses/${uid}/expenses`); }

function membershipDocRef(uid) {
  return doc(db, 'businesses', uid, 'membership', 'profile');
}

/* ---------------------------------------------------------
   NORMALIZERS
   --------------------------------------------------------- */

function normalizeSaleDoc(d) {
  const data = { id: d.id, ...d.data() };
  if (data.createdAt && typeof data.createdAt.toDate === 'function') data.createdAt = data.createdAt.toDate().toISOString();
  if (data.updatedAt && typeof data.updatedAt.toDate === 'function') data.updatedAt = data.updatedAt.toDate().toISOString();
  if (!data.createdAt) {
    if (data.date && typeof data.date.toDate === 'function') data.createdAt = data.date.toDate().toISOString();
    else if (data.date) data.createdAt = data.date;
    else if (data.timestamp && typeof data.timestamp.toDate === 'function') data.createdAt = data.timestamp.toDate().toISOString();
    else if (data.timestamp) data.createdAt = data.timestamp;
  }
  return data;
}

function normalizePurchaseDoc(d) {
  const data = { id: d.id, ...d.data() };
  if (data.createdAt && typeof data.createdAt.toDate === 'function') data.createdAt = data.createdAt.toDate().toISOString();
  if (data.updatedAt && typeof data.updatedAt.toDate === 'function') data.updatedAt = data.updatedAt.toDate().toISOString();
  if (!data.createdAt && data.date) {
    data.createdAt = typeof data.date.toDate === 'function' ? data.date.toDate().toISOString() : data.date;
  }
  return data;
}

function normalizeExpenseDoc(d) {
  const data = { id: d.id, ...d.data() };
  if (data.date && typeof data.date.toDate === 'function') data.date = data.date.toDate().toISOString();
  if (data.createdAt && typeof data.createdAt.toDate === 'function') data.createdAt = data.createdAt.toDate().toISOString();
  if (data.updatedAt && typeof data.updatedAt.toDate === 'function') data.updatedAt = data.updatedAt.toDate().toISOString();
  return data;
}

function normalizeMembershipStatus(raw) {
  if (!raw) return 'pending';
  const s = String(raw).trim().toLowerCase();
  if (s === 'approved' || s === 'active') return 'approved';
  if (s === 'rejected' || s === 'declined') return 'rejected';
  if (s === 'payment_submitted' || s === 'under_review' || s === 'submitted' || s === 'review') return 'payment_submitted';
  if (s === 'expired') return 'expired';
  if (s === 'pending' || s === 'awaiting') return 'pending';
  return s;
}

/* ---------------------------------------------------------
   LOADERS
   --------------------------------------------------------- */

async function loadProductsFromFirestore() {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const q = query(productsCollection(), where('ownerId', '==', user.uid));
    const snap = await getDocs(q);
    productsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { console.error('Load products failed', e); }
  return productsData;
}

async function loadSalesFromFirestore() {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const q = query(salesCollection(), where('ownerId', '==', user.uid));
    const snap = await getDocs(q);
    salesData = snap.docs.map(normalizeSaleDoc).sort((a, b) =>
      (new Date(b.createdAt || 0)).getTime() - (new Date(a.createdAt || 0)).getTime()
    );
  } catch (e) { console.error('Load sales failed', e); }
  return salesData;
}

async function loadCustomersFromFirestore() {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const q = query(customersCollection(), where('ownerId', '==', user.uid));
    const snap = await getDocs(q);
    customersData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { console.error('Load customers failed', e); }
  return customersData;
}

async function loadSuppliersFromFirestore() {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const q = query(suppliersCollection(), where('ownerId', '==', user.uid));
    const snap = await getDocs(q);
    suppliersData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { console.error('Load suppliers failed', e); }
  return suppliersData;
}

async function loadPurchasesFromFirestore() {
  const user = auth.currentUser;
  if (!user) { purchasesData = []; purchasesLoaded = false; return []; }
  purchasesError = null;
  try {
    const q = query(purchasesCollection(), where('ownerId', '==', user.uid));
    const snap = await getDocs(q);
    purchasesData = snap.docs.map(normalizePurchaseDoc);
    purchasesLoaded = true;
  } catch (e) {
    console.error('Load purchases failed', e);
    purchasesError = e; purchasesLoaded = true; purchasesData = [];
  }
  return purchasesData;
}

async function loadExpensesFromFirestore() {
  const user = auth.currentUser;
  if (!user) { expensesData = []; expensesLoaded = false; return []; }
  expensesError = null;
  try {
    const q = query(expensesCollection(user.uid));
    const snap = await getDocs(q);
    expensesData = snap.docs.map(normalizeExpenseDoc);
    expensesLoaded = true;
  } catch (e) {
    console.error('Load expenses failed', e);
    expensesError = e; expensesLoaded = true; expensesData = [];
  }
  return expensesData;
}

/* ---------------------------------------------------------
   REALTIME LISTENERS
   --------------------------------------------------------- */

function setupRealtimeListeners(uid) {
  if (productsUnsub) productsUnsub();
  productsUnsub = onSnapshot(
    query(productsCollection(), where('ownerId', '==', uid)),
    snap => {
      productsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      markInitialSnapshotReady("products");
      scheduleRender();
    },
    err => { console.error('Realtime products error:', err); markInitialSnapshotReady("products"); }
  );

  if (salesUnsub) salesUnsub();
  salesUnsub = onSnapshot(
    query(salesCollection(), where('ownerId', '==', uid)),
    snap => {
      salesData = snap.docs.map(normalizeSaleDoc).sort((a, b) =>
        (new Date(b.createdAt || 0)).getTime() - (new Date(a.createdAt || 0)).getTime()
      );
      markInitialSnapshotReady("sales");
      scheduleRender();
    },
    err => { console.error('Realtime sales error:', err); markInitialSnapshotReady("sales"); }
  );

  if (customersUnsub) customersUnsub();
  customersUnsub = onSnapshot(
    query(customersCollection(), where('ownerId', '==', uid)),
    snap => {
      customersData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      markInitialSnapshotReady("customers");
      scheduleRender();
    },
    err => { console.error('Realtime customers error:', err); markInitialSnapshotReady("customers"); }
  );

  if (suppliersUnsub) suppliersUnsub();
  suppliersUnsub = onSnapshot(
    query(suppliersCollection(), where('ownerId', '==', uid)),
    snap => {
      suppliersData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      markInitialSnapshotReady("suppliers");
      scheduleRender();
    },
    err => { console.error('Realtime suppliers error:', err); markInitialSnapshotReady("suppliers"); }
  );

  if (purchasesUnsub) purchasesUnsub();
  purchasesUnsub = onSnapshot(
    query(purchasesCollection(), where('ownerId', '==', uid)),
    snap => {
      purchasesError = null; purchasesLoaded = true;
      purchasesData = snap.docs.map(normalizePurchaseDoc);
      markInitialSnapshotReady("purchases");
      scheduleRender();
    },
    err => {
      console.error('Realtime purchases error:', err);
      purchasesError = err; purchasesLoaded = true; purchasesData = [];
      markInitialSnapshotReady("purchases");
      scheduleRender();
    }
  );

  if (expensesUnsub) expensesUnsub();
  expensesUnsub = onSnapshot(
    query(expensesCollection(uid)),
    snap => {
      expensesError = null; expensesLoaded = true;
      expensesData = snap.docs.map(normalizeExpenseDoc);
      markInitialSnapshotReady("expenses");
      scheduleRender();
    },
    err => {
      console.error('Realtime expenses error:', err);
      expensesError = err; expensesLoaded = true; expensesData = [];
      markInitialSnapshotReady("expenses");
      scheduleRender();
    }
  );
}

/* ---------------------------------------------------------
   MEMBERSHIP LISTENER
   --------------------------------------------------------- */

function setupMembershipListener(uid) {
  if (membershipUnsub) membershipUnsub();

  const primaryRef = membershipDocRef(uid);

  membershipUnsub = onSnapshot(
    primaryRef,
    async (snap) => {
      membershipLoaded = true;

      if (snap.exists()) {
        const data = snap.data() || {};
        membership = {
          id: snap.id,
          ...data,
          status: normalizeMembershipStatus(data.status),
          submissions: Array.isArray(data.submissions) ? data.submissions : []
        };
        console.log('[membership] profile:', membership, '→ effective:', getEffectiveStatus());
        applyMembershipState();
        return;
      }

      try {
        const colRef = collection(db, 'businesses', uid, 'membership');
        const colSnap = await getDocs(colRef);
        if (!colSnap.empty) {
          const d = colSnap.docs[0];
          const data = d.data() || {};
          membership = {
            id: d.id,
            ...data,
            status: normalizeMembershipStatus(data.status),
            submissions: Array.isArray(data.submissions) ? data.submissions : []
          };
          console.log('[membership] fallback doc id =', d.id, membership, '→ effective:', getEffectiveStatus());
        } else {
          membership = { status: 'pending', uid, submissions: [] };
          console.log('[membership] no doc found, treating as pending');
          ensureMembershipDoc(uid);
        }
      } catch (e) {
        console.error('[membership] fallback read error:', e);
        membership = { status: 'pending', uid, submissions: [] };
      }

      applyMembershipState();
    },
    (err) => {
      console.error('[membership] snapshot error:', err);
      membershipLoaded = true;
      membership = { status: 'pending', uid, submissions: [] };
      applyMembershipState();
    }
  );
}

async function ensureMembershipDoc(uid) {
  try {
    const ref = membershipDocRef(uid);
    const snap = await getDoc(ref);
    if (snap.exists()) return;
    await setDoc(ref, {
      uid,
      status: 'pending',
      planId: null,
      submissions: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } catch (e) {
    console.warn('Could not ensure membership doc:', e?.message || e);
  }
}

/* ---------------------------------------------------------
   MEMBERSHIP STATE
   --------------------------------------------------------- */

function getEffectiveStatus() {
  const status = membership?.status || 'pending';
  if (status === 'approved' && membership?.expiresAt) {
    const exp = membership.expiresAt?.toDate
      ? membership.expiresAt.toDate()
      : new Date(membership.expiresAt);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() < Date.now()) {
      return 'expired';
    }
  }
  return status;
}

function applyMembershipState() {
  const effective = getEffectiveStatus();
  dashboardUnlocked = (effective === 'approved');

  console.log('[apply] effective:', effective, 'unlocked:', dashboardUnlocked);

  const content    = document.getElementById('dashboardContent');
  const banner     = document.getElementById('membershipBanner');
  const lock       = document.getElementById('membershipLock');
  const upgradeBtn = document.getElementById('upgradePlanBtn');
  const pill       = document.getElementById('membershipPill');
  const pillText   = document.getElementById('membershipPillText');

  if (upgradeBtn) {
    upgradeBtn.hidden = false;
    upgradeBtn.style.display = '';
    if (dashboardUnlocked) {
      upgradeBtn.innerHTML = '<i class="fas fa-crown"></i><span>Manage Plan</span>';
    } else {
      upgradeBtn.innerHTML = '<i class="fas fa-crown"></i><span>Upgrade Plan</span>';
    }
  }

  if (dashboardUnlocked) {
    if (content) {
      content.classList.remove('locked');
      content.style.filter = '';
      content.style.opacity = '';
      content.style.pointerEvents = '';
      content.style.userSelect = '';
    }

    if (lock) {
      lock.hidden = true;
      lock.style.display = 'none';
      lock.setAttribute('aria-hidden', 'true');
    }

    if (banner) {
      banner.hidden = true;
      banner.style.display = 'none';
    }

    if (pill) {
      pill.hidden = false;
      pill.style.display = '';
      pill.className = 'membership-pill status-paid';
    }
    if (pillText) pillText.textContent = 'Active';

    dashboardDataReady = dashboardDataReady || true;
    scheduleRender();
    renderSubscriptionHistory();
    return;
  }

  // ---- LOCKED ----
  if (content) content.classList.add('locked');
  if (lock) {
    lock.hidden = false;
    lock.style.display = '';
    lock.removeAttribute('aria-hidden');
  }
  if (banner) { banner.hidden = false; banner.style.display = ''; }

  const copy = {
    pending: {
      bannerIcon: 'fa-lock',
      title: 'Membership pending',
      sub: 'Your account is awaiting approval. Upgrade your plan to unlock the dashboard.',
      lockIcon: 'fa-lock',
      lockTitle: 'Dashboard locked',
      lockMsg: 'Your membership is pending. Choose a plan and submit payment to unlock the dashboard.',
      pillClass: 'status-pending',
      pillText: 'Pending'
    },
    payment_submitted: {
      bannerIcon: 'fa-hourglass-half',
      title: 'Payment under review',
      sub: 'We received your payment. An admin will approve it shortly.',
      lockIcon: 'fa-hourglass-half',
      lockTitle: 'Payment under review',
      lockMsg: 'Your payment has been submitted and is being reviewed. The dashboard will unlock once approved.',
      pillClass: 'status-partial',
      pillText: 'Under review'
    },
    under_review: {
      bannerIcon: 'fa-hourglass-half',
      title: 'Payment under review',
      sub: 'An admin is reviewing your payment.',
      lockIcon: 'fa-hourglass-half',
      lockTitle: 'Payment under review',
      lockMsg: 'Your payment is being reviewed by an admin. Please check back shortly.',
      pillClass: 'status-partial',
      pillText: 'Under review'
    },
    rejected: {
      bannerIcon: 'fa-circle-xmark',
      title: 'Payment rejected',
      sub: 'Your last payment was rejected. Please submit new payment details.',
      lockIcon: 'fa-circle-xmark',
      lockTitle: 'Payment rejected',
      lockMsg: 'Your previous payment was rejected. Please submit a new payment to continue.',
      pillClass: 'status-overdue',
      pillText: 'Rejected'
    },
    expired: {
      bannerIcon: 'fa-clock',
      title: 'Membership expired',
      sub: 'Your membership has expired. Renew to restore dashboard access.',
      lockIcon: 'fa-clock',
      lockTitle: 'Membership expired',
      lockMsg: 'Your plan has expired. Please renew to unlock the dashboard again.',
      pillClass: 'status-overdue',
      pillText: 'Expired'
    }
  };

  const c = copy[effective] || copy.pending;

  const bannerIcon  = document.getElementById('membershipBannerIcon');
  const bannerTitle = document.getElementById('membershipBannerTitle');
  const bannerSub   = document.getElementById('membershipBannerSub');
  const bannerCta   = document.getElementById('membershipBannerCta');
  const lockIcon    = document.getElementById('lockIcon');
  const lockTitle   = document.getElementById('lockTitle');
  const lockMsg     = document.getElementById('lockMessage');
  const lockPill    = document.getElementById('lockStatusPill');

  if (bannerIcon)  bannerIcon.innerHTML   = `<i class="fas ${c.bannerIcon}"></i>`;
  if (bannerTitle) bannerTitle.textContent = c.title;
  if (bannerSub)   bannerSub.textContent   = c.sub;
  if (lockIcon)    lockIcon.innerHTML      = `<i class="fas ${c.lockIcon}"></i>`;
  if (lockTitle)   lockTitle.textContent   = c.lockTitle;
  if (lockMsg)     lockMsg.textContent     = c.lockMsg;
  if (lockPill)    lockPill.innerHTML      = `<span class="status-pill ${c.pillClass}"><span class="dot"></span>${c.pillText}</span>`;

  if (pill) {
    pill.hidden = false;
    pill.style.display = '';
    pill.className = `membership-pill ${c.pillClass}`;
  }
  if (pillText) pillText.textContent = c.pillText;

  const disableCta = (effective === 'payment_submitted' || effective === 'under_review');
  if (bannerCta) {
    bannerCta.disabled = disableCta;
    bannerCta.innerHTML = disableCta
      ? '<i class="fas fa-hourglass-half"></i> Awaiting review'
      : '<i class="fas fa-crown"></i> Upgrade Plan';
  }

  renderSubscriptionHistory();
}

/* ---------------------------------------------------------
   CALCULATIONS
   --------------------------------------------------------- */

function calculateTotalPurchases(purchases) {
  return (purchases || [])
    .filter(p => p.status !== "Cancelled")
    .reduce((s, p) => s + (Number(p.grandTotal) || Number(p.amount) || 0), 0);
}

function calculateTotalExpenses(expenses) {
  if (!expenses || expenses.length === 0) return 0;
  return expenses.reduce((s, e) => s + (Number(e.amount) || Number(e.total) || 0), 0);
}

function calculateProfit(totalSales, totalPurchases, totalExpenses) {
  return totalSales - totalPurchases - totalExpenses;
}

function getSalesForPeriod(startDate, endDate) {
  if (!salesData || salesData.length === 0) return 0;
  return salesData
    .filter(s => {
      if (!s.createdAt) return false;
      const d = new Date(s.createdAt);
      if (Number.isNaN(d.getTime())) return false;
      return d >= startDate && d < endDate;
    })
    .reduce((s, x) => s + (Number(x.grandTotal) || Number(x.amount) || 0), 0);
}

function getTodaySales() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  return getSalesForPeriod(today, tomorrow);
}

function getYesterdaySales() {
  const now = new Date();
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return getSalesForPeriod(y, t);
}

function getThisMonthSales() {
  const now = new Date();
  return getSalesForPeriod(new Date(now.getFullYear(), now.getMonth(), 1),
                           new Date(now.getFullYear(), now.getMonth() + 1, 1));
}

function getLastMonthSales() {
  const now = new Date();
  return getSalesForPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1),
                           new Date(now.getFullYear(), now.getMonth(), 1));
}

function calculatePercentageChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / previous) * 100;
}

function getPurchasesForPeriod(startDate, endDate) {
  if (!purchasesData || purchasesData.length === 0) return 0;
  return purchasesData
    .filter(p => {
      if (!p.createdAt && !p.date) return false;
      const d = new Date(p.createdAt || p.date);
      if (Number.isNaN(d.getTime())) return false;
      return d >= startDate && d < endDate;
    })
    .reduce((s, x) => s + (Number(x.grandTotal) || Number(x.amount) || 0), 0);
}

function getThisMonthPurchases() {
  const now = new Date();
  return getPurchasesForPeriod(new Date(now.getFullYear(), now.getMonth(), 1),
                                new Date(now.getFullYear(), now.getMonth() + 1, 1));
}

function getLastMonthPurchases() {
  const now = new Date();
  return getPurchasesForPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1),
                                new Date(now.getFullYear(), now.getMonth(), 1));
}

function getExpensesForPeriod(startDate, endDate) {
  if (!expensesData || expensesData.length === 0) return 0;
  return expensesData
    .filter(e => {
      if (!e.date && !e.createdAt) return false;
      const d = new Date(e.date || e.createdAt);
      if (Number.isNaN(d.getTime())) return false;
      return d >= startDate && d < endDate;
    })
    .reduce((s, x) => s + (Number(x.amount) || Number(x.total) || 0), 0);
}

function getThisMonthExpenses() {
  const now = new Date();
  return getExpensesForPeriod(new Date(now.getFullYear(), now.getMonth(), 1),
                               new Date(now.getFullYear(), now.getMonth() + 1, 1));
}

function getLastMonthExpenses() {
  const now = new Date();
  return getExpensesForPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1),
                               new Date(now.getFullYear(), now.getMonth(), 1));
}

/* ---------------------------------------------------------
   FORMATTERS
   --------------------------------------------------------- */

const PKR = new Intl.NumberFormat('en-PK', {
  style: 'currency', currency: 'PKR', maximumFractionDigits: 0
});

function formatCurrency(n) {
  return PKR.format(Number(n) || 0);
}

function formatCompactCurrency(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(0)}k`;
  return String(Math.round(v));
}

function formatMoneyCompact(value) {
  return "PKR " + new Intl.NumberFormat("en-US", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(Number(value) || 0);
}

function statusClass(status) {
  const map = {
    Paid: "status-paid",
    Pending: "status-pending",
    Partial: "status-partial",
    "Partially Paid": "status-partial",
    Unpaid: "status-unpaid",
    Overdue: "status-overdue",
    Completed: "status-paid",
    Cancelled: "status-overdue"
  };
  return map[status] || "status-pending";
}

function stockStatus(current, min) {
  if (current <= min * 0.5) return { label: "Critical", cls: "status-critical" };
  if (current <= min) return { label: "Low", cls: "status-low" };
  return { label: "In Stock", cls: "status-instock" };
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '-';
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function getInitials(name) {
  if (!name) return "—";
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0] ? p[0].toUpperCase() : '').join('') || "—";
}

/* ---------------------------------------------------------
   TIME-BASED GREETING
   --------------------------------------------------------- */

function setTimeBasedGreeting() {
  const now = new Date();
  const hour = now.getHours();

  let greeting = 'Good morning';
  let sub = "Let's make today count — here's your business at a glance.";

  if (hour >= 12 && hour < 17) {
    greeting = 'Good afternoon';
    sub = "Here's how your business is performing this afternoon.";
  } else if (hour >= 17 && hour < 21) {
    greeting = 'Good evening';
    sub = "Here's your business snapshot for the evening.";
  } else if (hour >= 21 || hour < 5) {
    greeting = 'Good night';
    sub = "Burning the midnight oil? Here's your business at a glance.";
  }

  const g = document.getElementById('greetingText');
  const s = document.getElementById('greetingSub');
  if (g) g.textContent = greeting;
  if (s) s.textContent = sub;
}

/* ---------------------------------------------------------
   SAFE TIME
   --------------------------------------------------------- */

function safeTime(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'object' && typeof c.toDate === 'function') {
      try {
        const t = c.toDate().getTime();
        if (!Number.isNaN(t)) return t;
      } catch (_) {}
    }
    if (typeof c === 'object' && typeof c.seconds === 'number') {
      const t = c.seconds * 1000;
      if (!Number.isNaN(t)) return t;
    }
    if (typeof c === 'number') {
      if (!Number.isNaN(c)) return c;
      continue;
    }
    const t = new Date(c).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
}

/* ---------------------------------------------------------
   TOASTS + RIPPLE
   --------------------------------------------------------- */

function showToast(message, icon = "fa-circle-check", duration = 3200) {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<i class="fas ${icon}"></i> ${escapeHtml(message)}`;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("removing");
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
  }, duration);
  if (stack.children.length > 5) stack.firstChild.remove();
}

function setupRippleEffects() {
  document.querySelectorAll('.btn-with-ripple').forEach(btn => {
    btn.addEventListener('click', function(e) {
      const rect = this.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const ripple = document.createElement('span');
      ripple.className = 'ripple-effect';
      const size = Math.max(rect.width, rect.height);
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = (x - size / 2) + 'px';
      ripple.style.top = (y - size / 2) + 'px';
      this.appendChild(ripple);
      setTimeout(() => { if (ripple.parentNode) ripple.remove(); }, 600);
    });
  });
}

/* =========================================================
   AUTH + BOOT
   ========================================================= */

function clearAllPlaceholders() {
  const chartTotal = document.getElementById("chartTotal");
  if (chartTotal) chartTotal.textContent = "";
  const chartGrowth = document.getElementById("chartGrowth");
  if (chartGrowth) {
    chartGrowth.innerHTML = "";
    chartGrowth.className = 'stat-change';
  }
}

function applyUserIdentity(user) {
  const name = user.displayName || (user.email ? user.email.split('@')[0] : 'there');
  const first = name.split(/\s+/)[0];
  const profileName = document.getElementById('profileName');
  const avatar = document.getElementById('avatarInitials');
  const welcomeName = document.getElementById('welcomeName');
  if (profileName) profileName.textContent = name;
  if (avatar) avatar.textContent = getInitials(name);
  if (welcomeName) welcomeName.textContent = first;

  const fullNameInput = document.getElementById('payFullName');
  if (fullNameInput && user.displayName) fullNameInput.value = user.displayName;
}

async function initializeDashboardAfterAuth(user) {
  console.log("Authenticated user:", user.email);

  applyUserIdentity(user);
  setTimeBasedGreeting();
  setInterval(setTimeBasedGreeting, 60_000);

  setupSidebar();
  setupNavigation();
  setupProfileDropdown();
  setupNotifications();
  setupSearch();
  setupModals();
  setupMembershipModal();
  setupRangeSelector();
  setupSPTabs();
  setupTopbarScroll();
  setupScrollAnimations();
  setupRippleEffects();

  purchasesLoaded = false;  purchasesError = null;
  expensesLoaded = false;   expensesError = null;
  dashboardDataReady = false;
  initialSnapshotCollections.clear();
  renderSalesPurchasesFeed();

  console.log('[boot] starting membership listener for uid:', user.uid);
  setupMembershipListener(user.uid);

  const fallbackTimer = setTimeout(() => {
    if (!dashboardDataReady) {
      dashboardDataReady = true;
      scheduleRender();
    }
  }, 6000);

  try {
    await loadAllData();
    setupRealtimeListeners(user.uid);
  } catch (error) {
    console.error('Dashboard init failed:', error);
    showToast('Could not load dashboard data. Please refresh.', 'fa-circle-exclamation');
    clearTimeout(fallbackTimer);
    dashboardDataReady = true;
    scheduleRender();
  }
}

async function loadAllData() {
  await Promise.all([
    loadProductsFromFirestore(),
    loadSalesFromFirestore(),
    loadCustomersFromFirestore(),
    loadSuppliersFromFirestore(),
    loadPurchasesFromFirestore(),
    loadExpensesFromFirestore()
  ]);
}

document.addEventListener("DOMContentLoaded", () => {
  clearAllPlaceholders();
  setTimeBasedGreeting();
  onAuthStateChanged(auth, (user) => {
    if (!user) { window.location.href = "../auth/login.html"; return; }
    initializeDashboardAfterAuth(user);
  });
});

/* ---------------------------------------------------------
   SIDEBAR / TOPBAR / SCROLL
   --------------------------------------------------------- */

function setupSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const openBtn = document.getElementById("menuToggle");
  const closeBtn = document.getElementById("sidebarClose");
  if (!sidebar || !overlay || !openBtn || !closeBtn) return;

  function open() {
    sidebar.classList.add("open");
    overlay.classList.add("open");
    openBtn.setAttribute("aria-expanded", "true");
  }
  function close() {
    sidebar.classList.remove("open");
    overlay.classList.remove("open");
    openBtn.setAttribute("aria-expanded", "false");
  }
  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  window.addEventListener("resize", () => { if (window.innerWidth > 860) close(); });
}

function setupTopbarScroll() {
  const topbar = document.getElementById("topbar");
  if (!topbar) return;
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        const s = window.pageYOffset || document.documentElement.scrollTop;
        if (s > 20) topbar.classList.add("topbar-scrolled");
        else topbar.classList.remove("topbar-scrolled");
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
}

const scrollObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      requestAnimationFrame(() => entry.target.classList.add("visible"));
      scrollObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.15, rootMargin: "0px 0px -30px 0px" });

function setupScrollAnimations() {
  document.querySelectorAll('.scroll-fade-up, .scroll-fade-left, .scroll-scale-pop')
    .forEach(el => scrollObserver.observe(el));
}

function setupNavigation() {
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      if (link.id === "logoutBtn") { e.preventDefault(); handleLogout(); }
    });
  });
}

async function handleLogout() {
  try {
    await signOut(auth);
    window.location.href = "../auth/login.html";
  } catch (error) {
    console.error("Logout error:", error);
    showToast("Unable to log out. Please try again.", "fa-circle-exclamation");
  }
}

function setupProfileDropdown() {
  const btn = document.getElementById("profileBtn");
  const panel = document.getElementById("profilePanel");
  const logout2 = document.getElementById("logoutBtn2");
  if (!btn || !panel) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !panel.hidden;
    closeAllDropdowns();
    if (!isOpen) {
      panel.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    }
  });
  if (logout2) {
    logout2.addEventListener("click", (e) => {
      e.preventDefault();
      handleLogout();
      panel.hidden = true;
    });
  }
  document.addEventListener("click", () => {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
}

function closeAllDropdowns() {
  const profilePanel = document.getElementById("profilePanel");
  const notifPanel = document.getElementById("notifPanel");
  const profileBtn = document.getElementById("profileBtn");
  const notifBtn = document.getElementById("notifBtn");
  const results = document.getElementById("searchResults");
  if (profilePanel) profilePanel.hidden = true;
  if (notifPanel) notifPanel.hidden = true;
  if (profileBtn) profileBtn.setAttribute("aria-expanded", "false");
  if (notifBtn) notifBtn.setAttribute("aria-expanded", "false");
  if (results) results.hidden = true;
}

function setupNotifications() {
  const btn = document.getElementById("notifBtn");
  const panel = document.getElementById("notifPanel");
  const list = document.getElementById("notifList");
  const markAll = document.getElementById("markAllRead");
  const dot = document.getElementById("notifDot");
  if (!btn || !panel || !list || !markAll || !dot) return;

  const READ_KEY = 'pyroxbiz.readNotifs';
  let readSet = new Set();
  try { readSet = new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]')); } catch (_) {}

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return `n${h}`;
  }

  function buildNotifications() {
    const notifs = [];
    const low = (productsData || []).filter(p => {
      const stock = Number(p.stock) || 0;
      const min = Number(p.reorderLevel || p.minStock || p.minimumStock) || 0;
      return stock <= min;
    });
    if (low.length) notifs.push({ icon: 'fa-triangle-exclamation', title: `${low.length} products are low on stock`, time: 'Now' });

    const outstandingByCustomer = {};
    (salesData || []).forEach(s => {
      const cid = s.customerId; if (!cid) return;
      outstandingByCustomer[cid] = (outstandingByCustomer[cid] || 0) + (Number(s.balance) || 0);
    });
    const customersWithOutstanding = Object.values(outstandingByCustomer).filter(v => v > 0).length;
    if (customersWithOutstanding) notifs.push({ icon: 'fa-circle-exclamation', title: `${customersWithOutstanding} customers have outstanding balances`, time: 'Now' });

    const recentSalesCount = (salesData || []).filter(s => {
      if (!s.createdAt) return false;
      const t = new Date(s.createdAt).getTime();
      if (Number.isNaN(t)) return false;
      return (Date.now() - t) < 1000 * 60 * 60 * 24;
    }).length;
    if (recentSalesCount) notifs.push({ icon: 'fa-cart-plus', title: `${recentSalesCount} new sales today`, time: 'Today' });

    const eff = getEffectiveStatus();
    if (eff === 'approved') {
      notifs.push({ icon: 'fa-circle-check', title: 'Membership active', time: 'Now' });
    } else if (eff === 'rejected') {
      notifs.push({ icon: 'fa-circle-xmark', title: 'Payment rejected — resubmit needed', time: 'Now' });
    }

    return notifs.map(n => {
      const id = hash(n.title);
      return { ...n, id, unread: !readSet.has(id) };
    });
  }

  function render() {
    const notifs = buildNotifications();
    if (!notifs.length) {
      list.innerHTML = `<li class="notif-item"><span class="notif-icon"><i class="fas fa-bell-slash"></i></span><span><div class="notif-title">You're all caught up</div><div class="notif-time">No new notifications</div></span></li>`;
      dot.style.display = 'none';
      dot.textContent = '0';
      return;
    }
    list.innerHTML = notifs.map(n => `
      <li class="notif-item ${n.unread ? 'unread' : ''}">
        <span class="notif-icon"><i class="fas ${n.icon}"></i></span>
        <span>
          <div class="notif-title">${escapeHtml(n.title)}</div>
          <div class="notif-time">${escapeHtml(n.time)}</div>
        </span>
      </li>
    `).join('');
    const unreadCount = notifs.filter(n => n.unread).length;
    dot.style.display = unreadCount > 0 ? 'flex' : 'none';
    dot.textContent = unreadCount;
  }

  render();
  scheduleRender._notifRender = render;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !panel.hidden;
    closeAllDropdowns();
    if (!isOpen) {
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      render();
    }
  });
  markAll.addEventListener('click', () => {
    buildNotifications().forEach(n => readSet.add(n.id));
    try { localStorage.setItem(READ_KEY, JSON.stringify([...readSet])); } catch (_) {}
    dot.style.display = 'none';
    dot.textContent = '0';
    render();
    showToast('All notifications marked as read.');
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
}

/* =========================================================
   MEMBERSHIP / SUBSCRIPTION MODAL
   ========================================================= */

function setupMembershipModal() {
  if (_initialized.membership) return;
  _initialized.membership = true;

  const openBtns = [
    document.getElementById('upgradePlanBtn'),
    document.getElementById('lockUpgradeBtn'),
    document.getElementById('membershipBannerCta')
  ].filter(Boolean);

  openBtns.forEach(btn => {
    btn.addEventListener('click', () => openSubscriptionModal());
  });

  document.querySelectorAll('.sub-tab').forEach(tab => {
    tab.addEventListener('click', () => switchSubTab(tab.dataset.subtab));
  });

  document.querySelectorAll('.plan-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const radio = card.querySelector('.plan-radio');
      if (radio) radio.checked = true;
      selectedPlanId = card.dataset.plan || 'monthly';
      updateSavingsNote();
    });
  });
  const def = document.querySelector('.plan-card[data-plan="monthly"]');
  if (def) def.classList.add('selected');
  updateSavingsNote();

  document.getElementById('subContinueBtn')?.addEventListener('click', () => {
    const chosen = document.querySelector('input[name="planChoice"]:checked');
    selectedPlanId = chosen ? chosen.value : selectedPlanId;
    goToPaymentStep();
  });

  document.getElementById('subBackBtn')?.addEventListener('click', () => {
    document.getElementById('subStepPayment').hidden = true;
    document.getElementById('subStepSuccess').hidden = true;
    document.getElementById('subStepPlan').hidden = false;
    const pane = document.querySelector('.modal-subscription .sub-pane');
    if (pane) pane.scrollTop = 0;
  });

  document.querySelectorAll('.method-card').forEach(card => {
    card.addEventListener('click', () => {
      selectPaymentMethod(card.dataset.method);
    });
  });

  const form = document.getElementById('paymentProofForm');
  if (form) form.addEventListener('submit', handlePaymentSubmit);

  document.getElementById('subViewHistoryBtn')?.addEventListener('click', () => {
    switchSubTab('history');
  });

  document.getElementById('lockRefreshBtn')?.addEventListener('click', async () => {
    const user = auth.currentUser;
    if (!user) return;
    const snap = await getDoc(membershipDocRef(user.uid));
    if (snap.exists()) {
      const data = snap.data() || {};
      membership = {
        id: snap.id,
        ...data,
        status: normalizeMembershipStatus(data.status),
        submissions: Array.isArray(data.submissions) ? data.submissions : []
      };
      console.log('[refresh] membership:', membership, '→ effective:', getEffectiveStatus());
      applyMembershipState();
      showToast('Membership status refreshed.', 'fa-rotate-right');
    } else {
      showToast('No membership record yet.', 'fa-circle-info');
    }
  });
}

function switchSubTab(tabName) {
  document.querySelectorAll('.sub-tab').forEach(t => {
    const active = t.dataset.subtab === tabName;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const plans = document.getElementById('subPanePlans');
  const history = document.getElementById('subPaneHistory');
  if (plans) plans.hidden = (tabName !== 'plans');
  if (history) history.hidden = (tabName !== 'history');

  if (tabName === 'history') renderSubscriptionHistory();

  const pane = document.querySelector('.modal-subscription .sub-pane');
  if (pane) pane.scrollTop = 0;
}

function selectPaymentMethod(methodId) {
  if (!PAYMENT_METHODS[methodId]) return;
  selectedMethodId = methodId;

  document.querySelectorAll('.method-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.method === methodId);
  });

  const methodInput = document.getElementById('payMethod');
  if (methodInput) methodInput.value = methodId;

  renderPaymentInstructions(methodId);
}

function renderPaymentInstructions(methodId) {
  const panel = document.getElementById('instructionsPanel');
  if (!panel) return;
  const cfg = PAYMENT_METHODS[methodId];
  if (!cfg) {
    panel.innerHTML = `
      <div class="instructions-placeholder">
        <i class="fas fa-hand-pointer"></i>
        <p>Select a payment method above</p>
      </div>
    `;
    return;
  }

  if (methodId === 'usdt') {
    panel.innerHTML = `
      <div class="instr-title"><i class="fab fa-bitcoin"></i> ${escapeHtml(cfg.label)} Instructions</div>
      <div class="instr-row">
        <div class="instr-label">Wallet Address</div>
        <div class="instr-value">${escapeHtml(cfg.walletAddress)}</div>
      </div>
      <div class="instr-row">
        <div class="instr-label">Network</div>
        <div class="instr-value">${escapeHtml(cfg.network)}</div>
      </div>
      <div class="instr-info"><i class="fas fa-info-circle"></i> Send the exact amount in USDT</div>
      <div class="instr-note">${escapeHtml(cfg.instructions)}</div>
    `;
    return;
  }

  panel.innerHTML = `
    <div class="instr-title"><i class="fas fa-mobile-alt"></i> ${escapeHtml(cfg.label)} Instructions</div>
    <div class="instr-row">
      <div class="instr-label">Account Number</div>
      <div class="instr-value">${escapeHtml(cfg.accountNumber)}</div>
    </div>
    <div class="instr-row">
      <div class="instr-label">Account Name</div>
      <div class="instr-value">${escapeHtml(cfg.accountName)}</div>
    </div>
    <div class="instr-info"><i class="fas fa-info-circle"></i> Send the exact amount shown above</div>
    <div class="instr-note">${escapeHtml(cfg.instructions)}</div>
  `;
}

function updateSavingsNote() {
  const note = document.getElementById('subSavingsNote');
  if (!note) return;
  if (selectedPlanId === 'yearly') {
    note.innerHTML = `<i class="fas fa-piggy-bank"></i> Yearly plan saves you <strong>PKR 6,998</strong> — that's 2 months free.`;
    note.classList.add('accent');
  } else {
    note.innerHTML = `<i class="fas fa-circle-info"></i> Switch to Yearly and save <strong>PKR 6,998</strong> — 2 months free.`;
    note.classList.remove('accent');
  }
}

function openSubscriptionModal() {
  switchSubTab('plans');

  document.getElementById('subStepPlan').hidden = false;
  document.getElementById('subStepPayment').hidden = true;
  document.getElementById('subStepSuccess').hidden = true;

  const form = document.getElementById('paymentProofForm');
  if (form) {
    form.reset();
    form.querySelectorAll('.form-row').forEach(r => r.classList.remove('invalid'));
  }

  selectedMethodId = null;
  document.querySelectorAll('.method-card').forEach(c => c.classList.remove('selected'));
  const methodInput = document.getElementById('payMethod');
  if (methodInput) methodInput.value = '';
  renderPaymentInstructions(null);

  selectedPlanId = 'monthly';
  const monthlyRadio = document.querySelector('input[name="planChoice"][value="monthly"]');
  if (monthlyRadio) monthlyRadio.checked = true;
  document.querySelectorAll('.plan-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.plan === 'monthly');
  });
  updateSavingsNote();

  renderSubscriptionHistory();

  openModal('modalSubscription');
}

function goToPaymentStep() {
  const plan = PLAN_CATALOG[selectedPlanId] || PLAN_CATALOG.monthly;

  const planNameEl = document.getElementById('paymentPlanName');
  const planAmtEl  = document.getElementById('paymentPlanAmount');
  const amtInput   = document.getElementById('payAmount');

  if (planNameEl) planNameEl.textContent = plan.name;
  if (planAmtEl)  planAmtEl.textContent  = `PKR ${plan.price.toLocaleString('en-US')}`;
  if (amtInput)   amtInput.value         = plan.price;

  document.getElementById('subStepPlan').hidden = true;
  document.getElementById('subStepSuccess').hidden = true;
  document.getElementById('subStepPayment').hidden = false;

  setTimeout(() => {
    const first = document.getElementById('payFullName');
    if (first) {
      try { first.focus({ preventScroll: true }); }
      catch (_) { first.focus(); }
    }
    const pane = document.querySelector('.modal-subscription .sub-pane');
    if (pane) pane.scrollTo({ top: 0, behavior: 'smooth' });
  }, 150);
}

async function handlePaymentSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;

  let valid = true;
  form.querySelectorAll('.form-row').forEach(row => {
    const field = row.querySelector('input, select, textarea');
    if (!field) return;
    row.classList.remove('invalid');
    if (field.hasAttribute('required')) {
      const val = (field.value || '').trim();
      if (!val) { row.classList.add('invalid'); valid = false; }
      if (field.type === 'number' && Number(val) < 0) { row.classList.add('invalid'); valid = false; }
    }
  });

  if (!selectedMethodId) {
    showToast('Please select a payment method.', 'fa-circle-exclamation');
    valid = false;
  }

  if (!valid) return;

  const user = auth.currentUser;
  if (!user) { showToast('You must be signed in.', 'fa-circle-exclamation'); return; }

  const plan = PLAN_CATALOG[selectedPlanId] || PLAN_CATALOG.monthly;
  const method = PAYMENT_METHODS[selectedMethodId];

  const submissionEntry = {
    planId: plan.id,
    planName: plan.name,
    amount: Number(document.getElementById('payAmount').value) || plan.price,
    currency: plan.currency,
    method: selectedMethodId,
    methodLabel: method.label,
    txnId: document.getElementById('payTxnId').value.trim(),
    paymentDate: document.getElementById('payDate').value || '',
    fullName: document.getElementById('payFullName').value.trim(),
    phone: document.getElementById('payPhone').value.trim(),
    note: (document.getElementById('payNote').value || '').trim(),
    status: 'payment_submitted',
    submittedAt: new Date().toISOString()
  };

  const submitBtn = document.getElementById('subSubmitPaymentBtn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…'; }

  try {
    const ref = membershipDocRef(user.uid);
    const snap = await getDoc(ref);

    const baseUpdate = {
      uid: user.uid,
      status: 'payment_submitted',
      planId: plan.id,
      planName: plan.name,
      planPrice: plan.price,
      planDurationMonths: plan.durationMonths,
      submissions: arrayUnion(submissionEntry),
      submittedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    if (snap.exists()) {
      await updateDoc(ref, baseUpdate);
    } else {
      await setDoc(ref, {
        uid: user.uid,
        status: 'pending',
        submissions: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      await updateDoc(ref, baseUpdate);
    }

    const localSubs = Array.isArray(membership?.submissions) ? [...membership.submissions] : [];
    localSubs.push(submissionEntry);
    membership = {
      ...(membership || {}),
      uid: user.uid,
      status: 'payment_submitted',
      planId: plan.id,
      planName: plan.name,
      planPrice: plan.price,
      planDurationMonths: plan.durationMonths,
      submissions: localSubs
    };

    applyMembershipState();

    document.getElementById('subStepPayment').hidden = true;
    document.getElementById('subStepSuccess').hidden = false;
    showToast('Payment submitted for review.', 'fa-paper-plane');
  } catch (err) {
    console.error('Payment submit failed:', err);
    if (err.code === 'permission-denied') {
      showToast('Permission denied. Please try again.', 'fa-circle-exclamation');
    } else {
      showToast('Could not submit payment. Please try again.', 'fa-circle-exclamation');
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit for Review';
    }
  }
}

function statusPillForSubmission(status) {
  switch (status) {
    case 'approved': return { cls: 'status-paid', label: 'Approved' };
    case 'rejected': return { cls: 'status-overdue', label: 'Rejected' };
    case 'payment_submitted':
    case 'under_review': return { cls: 'status-partial', label: 'Under review' };
    case 'pending':
    default: return { cls: 'status-pending', label: 'Pending' };
  }
}

function renderSubscriptionHistory() {
  const list = document.getElementById('subHistoryList');
  const countEl = document.getElementById('subHistoryCount');
  if (!list) return;

  const subs = Array.isArray(membership?.submissions) ? membership.submissions.slice() : [];

  subs.sort((a, b) => {
    const ta = new Date(a.submittedAt || 0).getTime() || 0;
    const tb = new Date(b.submittedAt || 0).getTime() || 0;
    return tb - ta;
  });

  if (countEl) countEl.textContent = String(subs.length);

  if (!subs.length) {
    list.innerHTML = `
      <div class="history-empty">
        <i class="fas fa-receipt"></i>
        <p>No submissions yet</p>
        <span>Your payment history will appear here after you submit a plan.</span>
      </div>
    `;
    return;
  }

  list.innerHTML = subs.map(s => {
    const pill = statusPillForSubmission(s.status);
    const planName = s.planName || (PLAN_CATALOG[s.planId]?.name) || '—';
    const methodLabel = s.methodLabel || (PAYMENT_METHODS[s.method]?.label) || s.method || '—';
    const amount = Number(s.amount) || 0;
    const when = s.submittedAt
      ? new Date(s.submittedAt).toLocaleString('en-US', {
          month: 'short', day: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        })
      : '—';

    return `
      <div class="history-item">
        <div class="history-item-top">
          <span class="history-plan">${escapeHtml(planName)}</span>
          <span class="status-pill ${pill.cls}">
            <span class="dot"></span>${pill.label}
          </span>
        </div>
        <div class="history-item-rows">
          <div><span>Amount</span><strong>${formatCurrency(amount)}</strong></div>
          <div><span>Method</span><strong>${escapeHtml(methodLabel)}</strong></div>
          <div><span>Txn ID</span><strong class="mono">${escapeHtml(s.txnId || '—')}</strong></div>
          <div><span>Submitted</span><strong>${escapeHtml(when)}</strong></div>
        </div>
        ${s.note ? `<div class="history-item-note"><i class="fas fa-note-sticky"></i> ${escapeHtml(s.note)}</div>` : ''}
      </div>
    `;
  }).join('');
}

/* =========================================================
   SEARCH
   ========================================================= */

function setupSearch() {
  if (_initialized.search) return;
  _initialized.search = true;

  const input = document.getElementById("globalSearch");
  const results = document.getElementById("searchResults");
  if (!input || !results) return;

  let searchTimeout = null;

  function getResultIcon(type) {
    const m = { Product:'fa-cube', Sale:'fa-bag-shopping', Customer:'fa-user-group', Supplier:'fa-handshake', Purchase:'fa-dolly', Invoice:'fa-file-invoice-dollar', Expense:'fa-wallet' };
    return m[type] || 'fa-circle';
  }
  function getResultColor(type) {
    const m = {
      'Product':  '#6366F1',
      'Sale':     '#059669',
      'Customer': '#8B5CF6',
      'Supplier': '#14B8A6',
      'Purchase': '#E11D48',
      'Invoice':  '#F59E0B',
      'Expense':  '#F97316'
    };
    return m[type] || '#64748B';
  }
  function getModuleUrl(type, id, label, queryStr) {
    const base = '../';
    const map = {
      'Product': `${base}products/products.html`,
      'Sale': `${base}sales/sales.html`,
      'Customer': `${base}customers/customers.html`,
      'Supplier': `${base}suppliers/suppliers.html`,
      'Purchase': `${base}purchases/purchases.html`,
      'Invoice': `${base}invoices/invoices.html`,
      'Expense': `${base}expenses/expenses.html`
    };
    const url = map[type];
    if (!url) return '#';
    return `${url}?id=${encodeURIComponent(id)}&highlight=${encodeURIComponent(label)}&search=${encodeURIComponent(queryStr)}&from=dashboard`;
  }

  function findMatch(type, id) {
    const arr = {
      Product: productsData, Sale: salesData, Customer: customersData,
      Supplier: suppliersData, Purchase: purchasesData, Expense: expensesData
    }[type] || [];
    return arr.find(x => String(x.id) === String(id));
  }

  function performSearch(queryStr) {
    if (!queryStr || queryStr.length < 1) { results.hidden = true; return []; }
    const q = queryStr.toLowerCase().trim();
    const matches = [];

    (productsData || []).forEach(item => {
      const name = (item.name || '').toLowerCase();
      const sku = (item.sku || '').toLowerCase();
      const category = (item.category || '').toLowerCase();
      if (name.includes(q) || sku.includes(q) || category.includes(q)) {
        const stock = Number(item.stock) || 0;
        const minStock = Number(item.reorderLevel || item.minStock || item.minimumStock) || 0;
        matches.push({
          id: item.id, label: item.name || 'Unnamed Product', tag: 'Product',
          subtitle: `${sku ? `SKU: ${item.sku} | ` : ''}Stock: ${stock}${minStock > 0 ? ` (Min: ${minStock})` : ''}`,
          type: 'Product', relevance: name.includes(q) ? 1 : (sku.includes(q) ? 2 : 3)
        });
      }
    });

    (customersData || []).forEach(item => {
      const name = (item.name || '').toLowerCase();
      const phone = (item.phone || '').toLowerCase();
      const email = (item.email || '').toLowerCase();
      const id = (item.id || item.customerId || '').toLowerCase();
      if (name.includes(q) || phone.includes(q) || email.includes(q) || id.includes(q)) {
        const balance = Number(item.balance) || 0;
        matches.push({
          id: item.id || item.customerId, label: item.name || 'Unnamed Customer', tag: 'Customer',
          subtitle: `${item.phone ? `📱 ${item.phone}` : ''}${item.email ? ` | ✉️ ${item.email}` : ''} | Balance: ${formatCurrency(balance)}`,
          type: 'Customer', relevance: name.includes(q) ? 1 : (id.includes(q) ? 1 : (phone.includes(q) ? 2 : 3))
        });
      }
    });

    (suppliersData || []).forEach(item => {
      const name = (item.name || '').toLowerCase();
      const phone = (item.phone || '').toLowerCase();
      const email = (item.email || '').toLowerCase();
      const id = (item.id || item.supplierId || '').toLowerCase();
      if (name.includes(q) || phone.includes(q) || email.includes(q) || id.includes(q)) {
        const balance = Number(item.balance) || 0;
        matches.push({
          id: item.id || item.supplierId, label: item.name || 'Unnamed Supplier', tag: 'Supplier',
          subtitle: `${item.phone ? `📱 ${item.phone}` : ''}${item.email ? ` | ✉️ ${item.email}` : ''} | Balance: ${formatCurrency(balance)}`,
          type: 'Supplier', relevance: name.includes(q) ? 1 : (id.includes(q) ? 1 : (phone.includes(q) ? 2 : 3))
        });
      }
    });

    (salesData || []).forEach(item => {
      const saleNum = (item.saleNumber || item.invoiceNumber || item.invoice || item.id || '').toLowerCase();
      const customerName = (item.customerName || item.customer || '').toLowerCase();
      if (saleNum.includes(q) || customerName.includes(q)) {
        matches.push({
          id: item.id, label: item.saleNumber || item.invoiceNumber || item.invoice || 'Sale #' + item.id, tag: 'Sale',
          subtitle: `${item.customerName || 'Walk-in'} | ${formatCurrency(Number(item.grandTotal) || 0)} ${item.paymentStatus ? '| ' + item.paymentStatus : ''}`,
          type: 'Sale', relevance: saleNum.includes(q) ? 1 : 2
        });
      }
    });

    (purchasesData || []).forEach(item => {
      const purchaseNum = (item.purchaseNumber || item.id || '').toLowerCase();
      const supplierName = (item.supplierName || item.supplier || '').toLowerCase();
      if (purchaseNum.includes(q) || supplierName.includes(q)) {
        matches.push({
          id: item.id, label: item.purchaseNumber || 'Purchase #' + item.id, tag: 'Purchase',
          subtitle: `${item.supplierName || 'Unknown Supplier'} | ${formatCurrency(Number(item.grandTotal) || Number(item.amount) || 0)} ${item.paymentStatus ? '| ' + item.paymentStatus : ''}`,
          type: 'Purchase', relevance: purchaseNum.includes(q) ? 1 : 2
        });
      }
    });

    (expensesData || []).forEach(item => {
      const expenseNum = (item.expenseNumber || item.id || '').toLowerCase();
      const category = (item.category || item.expenseCategory || '').toLowerCase();
      const description = (item.description || item.note || '').toLowerCase();
      if (expenseNum.includes(q) || category.includes(q) || description.includes(q)) {
        matches.push({
          id: item.id, label: item.expenseNumber || category || 'Expense #' + item.id, tag: 'Expense',
          subtitle: `${category || 'General'} | ${formatCurrency(Number(item.amount) || Number(item.total) || 0)}`,
          type: 'Expense', relevance: expenseNum.includes(q) ? 1 : (category.includes(q) ? 2 : 3)
        });
      }
    });

    matches.sort((a, b) => a.relevance - b.relevance || a.label.localeCompare(b.label));
    return matches.slice(0, 12);
  }

  function renderResults(matches, queryStr) {
    if (!matches || matches.length === 0) {
      results.innerHTML = `<div class="search-empty">
        <i class="fas fa-search" style="font-size:1.2rem;margin-bottom:8px;display:block;color:var(--gray-400);"></i>
        No results found for "<strong>${escapeHtml(queryStr)}</strong>"
      </div>`;
      results.hidden = false;
      return;
    }

    const grouped = {};
    matches.forEach(m => { (grouped[m.type] = grouped[m.type] || []).push(m); });

    const order = ['Product', 'Customer', 'Supplier', 'Sale', 'Purchase', 'Invoice', 'Expense'];
    let html = '', count = 0;
    order.forEach(type => {
      const items = grouped[type] || [];
      if (items.length > 0) {
        html += `<div class="search-section-header">${type}s</div>`;
        items.forEach(match => {
          if (count < 12) {
            const color = getResultColor(type);
            html += `<div class="search-results-item" data-type="${type}" data-id="${escapeHtml(String(match.id))}">
              <span class="search-item-icon" style="color:${color};"><i class="fas ${getResultIcon(type)}"></i></span>
              <div class="search-item-content">
                <div class="search-item-label">${escapeHtml(match.label)}</div>
                ${match.subtitle ? `<div class="search-item-subtitle">${escapeHtml(match.subtitle)}</div>` : ''}
              </div>
              <span class="search-item-tag" style="background:${color}20;color:${color};">${match.tag}</span>
              <span class="search-item-detail-btn"><i class="fas fa-chevron-right"></i></span>
            </div>`;
            count++;
          }
        });
      }
    });
    results.innerHTML = html;
    results.hidden = false;

    results.querySelectorAll('.search-results-item').forEach(el => {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        const type = this.dataset.type;
        const id = this.dataset.id;
        const data = findMatch(type, id);
        if (data) renderDetailView({ type, id, label: data.name || data.saleNumber || data.purchaseNumber || data.id, data });
      });
    });
  }

  function renderDetailView(match) {
    const data = match.data;
    let rows = '';
    if (match.type === 'Product') {
      rows = `
        <div class="search-detail-row"><span class="search-detail-label">Name</span><span class="search-detail-value"><strong>${escapeHtml(data.name || '-')}</strong></span></div>
        <div class="search-detail-row"><span class="search-detail-label">SKU</span><span class="search-detail-value">${escapeHtml(data.sku || '-')}</span></div>
        <div class="search-detail-row"><span class="search-detail-label">Stock</span><span class="search-detail-value">${Number(data.stock) || 0}</span></div>
        <div class="search-detail-row"><span class="search-detail-label">Price</span><span class="search-detail-value">${formatCurrency(Number(data.price) || 0)}</span></div>`;
    } else if (match.type === 'Sale' || match.type === 'Purchase') {
      rows = `
        <div class="search-detail-row"><span class="search-detail-label">ID</span><span class="search-detail-value"><strong>${escapeHtml(data.saleNumber || data.purchaseNumber || data.id || '-')}</strong></span></div>
        <div class="search-detail-row"><span class="search-detail-label">Party</span><span class="search-detail-value">${escapeHtml(data.customerName || data.supplierName || 'Walk-in')}</span></div>
        <div class="search-detail-row"><span class="search-detail-label">Amount</span><span class="search-detail-value">${formatCurrency(Number(data.grandTotal) || Number(data.amount) || 0)}</span></div>
        <div class="search-detail-row"><span class="search-detail-label">Status</span><span class="search-detail-value"><span class="status-pill ${statusClass(data.paymentStatus || data.status || 'Unpaid')}">${escapeHtml(data.paymentStatus || data.status || 'Unpaid')}</span></span></div>`;
    } else {
      rows = `<div class="search-detail-row"><span class="search-detail-label">${escapeHtml(match.type)}</span><span class="search-detail-value"><strong>${escapeHtml(match.label)}</strong></span></div>`;
    }

    results.innerHTML = `<div class="search-detail-container">
      <div class="search-detail-header">
        <button class="search-back-btn"><i class="fas fa-arrow-left"></i> Back</button>
        <span class="search-detail-type" style="color:${getResultColor(match.type)};">
          <i class="fas ${getResultIcon(match.type)}"></i> ${match.type}
        </span>
      </div>
      <div class="search-detail-content">${rows}</div>
      <div class="search-detail-actions">
        <button class="search-detail-open" data-url="${getModuleUrl(match.type, match.id, match.label, '')}">
          <i class="fas fa-arrow-right"></i> Open in ${match.type}s
        </button>
      </div>
    </div>`;
    results.hidden = false;

    results.querySelector('.search-back-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      const queryStr = input.value.trim();
      if (queryStr) renderResults(performSearch(queryStr), queryStr);
      else results.hidden = true;
    });
    results.querySelector('.search-detail-open').addEventListener('click', function() {
      const url = this.dataset.url;
      if (url && url !== '#') {
        showToast(`Opening ${match.type}...`, 'fa-arrow-right');
        setTimeout(() => { window.location.href = url; }, 300);
      }
    });
  }

  function handleSearch() {
    const queryStr = input.value.trim();
    if (searchTimeout) clearTimeout(searchTimeout);
    if (!queryStr) { results.hidden = true; return; }
    results.innerHTML = `<div class="search-loading"><i class="fas fa-spinner fa-spin"></i>Searching...</div>`;
    results.hidden = false;
    searchTimeout = setTimeout(() => renderResults(performSearch(queryStr), queryStr), 200);
  }

  input.addEventListener('input', handleSearch);
  input.addEventListener('focus', function() {
    if (this.value.trim()) renderResults(performSearch(this.value.trim()), this.value.trim());
  });
  document.addEventListener('click', function(e) {
    if (!input.contains(e.target) && !results.contains(e.target)) results.hidden = true;
  });
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { results.hidden = true; this.blur(); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); this.focus(); this.select(); }
  });
  const shortcutHint = document.querySelector('.search-kbd');
  if (shortcutHint) {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    shortcutHint.textContent = isMac ? '⌘K' : 'Ctrl+K';
  }
}

/* =========================================================
   METRICS
   ========================================================= */

function metricDelta(current, previous) {
  const change = calculatePercentageChange(current, previous);
  const up = change >= 0;
  return {
    change,
    up,
    text: `${up ? '+' : ''}${change.toFixed(1)}%`,
    cls: change === 0 ? 'neutral' : (up ? 'up' : 'down')
  };
}

function renderMetrics() {
  const grid = document.getElementById("metricsGrid");
  if (!grid) return;
  if (!dashboardDataReady) return;
  if (!dashboardUnlocked) return;

  const totalSales = (salesData || []).reduce((s, x) => s + (Number(x.grandTotal) || Number(x.amount) || 0), 0);
  const totalPurchases = calculateTotalPurchases(purchasesData);
  const totalExpenses = calculateTotalExpenses(expensesData);
  const profit = calculateProfit(totalSales, totalPurchases, totalExpenses);
  const inventoryValue = (productsData || []).reduce((s, p) => s + (Number(p.costPrice) || 0) * (Number(p.stock) || 0), 0);

  const todaySales = getTodaySales();
  const todayDelta = metricDelta(todaySales, getYesterdaySales());

  const monthDelta   = metricDelta(getThisMonthSales(),     getLastMonthSales());
  const purDelta     = metricDelta(getThisMonthPurchases(), getLastMonthPurchases());
  const expDelta     = metricDelta(getThisMonthExpenses(),  getLastMonthExpenses());

  const prevProfit = calculateProfit(getLastMonthSales(), getLastMonthPurchases(), getLastMonthExpenses());
  const profitDelta = metricDelta(profit, prevProfit);

  const metrics = [
    { key: 'sales',     label: 'Total Sales',  icon: 'fa-bag-shopping',   value: formatCurrency(totalSales),     delta: monthDelta,  compare: 'vs. last month' },
    { key: 'today',     label: "Today's Sales", icon: 'fa-sun',           value: formatCurrency(todaySales),     delta: todayDelta,  compare: 'vs. yesterday' },
    { key: 'purchases', label: 'Purchases',    icon: 'fa-dolly',          value: purchasesError ? '—' : formatCurrency(totalPurchases), delta: purDelta, compare: purchasesError ? 'Could not load' : 'vs. last month' },
    { key: 'expenses',  label: 'Expenses',     icon: 'fa-wallet',         value: expensesError  ? '—' : formatCurrency(totalExpenses),  delta: expDelta, compare: expensesError  ? 'Could not load' : 'vs. last month' },
    { key: 'profit',    label: 'Net Profit',   icon: 'fa-chart-pie',      value: formatCurrency(profit),         delta: profitDelta, compare: 'vs. last month' },
    { key: 'stock',     label: 'Stock Value',  icon: 'fa-cube',           value: formatCurrency(inventoryValue), delta: { change: 0, up: true, text: '—', cls: 'neutral' }, compare: 'current inventory' }
  ];

  renderMetricCards(grid, metrics);
}

/* =========================================================
   RECENT SALES & PURCHASES
   ========================================================= */

function getSortedPurchases() {
  return (purchasesData || []).slice().sort((a, b) =>
    safeTime(b.createdAt, b.date, b.timestamp) - safeTime(a.createdAt, a.date, a.timestamp)
  );
}

function setupSPTabs() {
  if (_initialized.spTabs) return;
  _initialized.spTabs = true;
  const tabs = document.querySelectorAll('.sp-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      currentSPTab = tab.dataset.tab || 'all';
      renderSalesPurchasesFeed();
    });
  });
}

function renderSalesPurchasesFeed() {
  const list = document.getElementById("spList");
  if (!list) return;

  const salesCountEl = document.getElementById("spSalesCount");
  const purchasesCountEl = document.getElementById("spPurchasesCount");
  if (salesCountEl) salesCountEl.textContent = (salesData || []).length;
  if (purchasesCountEl) purchasesCountEl.textContent = (purchasesData || []).length;

  const feed = [];

  (salesData || []).slice(0, 30).forEach(s => {
    feed.push({
      kind: 'sale',
      title: s.customerName || s.customer || 'Walk-in Customer',
      subtitle: `Order ${s.saleNumber || s.invoiceNumber || s.invoice || '#' + s.id}`,
      avatar: getInitials(s.customerName || s.customer || 'Walk-in'),
      amountLabel: formatCurrency(Number(s.grandTotal) || Number(s.amount) || 0),
      status: s.paymentStatus || s.saleStatus || 'Unpaid',
      time: timeAgo(s.createdAt),
      sortKey: safeTime(s.createdAt, s.date, s.timestamp)
    });
  });

  getSortedPurchases().slice(0, 30).forEach(p => {
    feed.push({
      kind: 'purchase',
      title: p.supplierName || p.supplier || 'Unknown Supplier',
      subtitle: `PO ${p.purchaseNumber || '#' + p.id}`,
      avatar: getInitials(p.supplierName || p.supplier || 'Supplier'),
      amountLabel: formatCurrency(Number(p.grandTotal) || Number(p.amount) || 0),
      status: p.paymentStatus || p.status || 'Unpaid',
      time: timeAgo(p.createdAt || p.date),
      sortKey: safeTime(p.createdAt, p.date, p.timestamp)
    });
  });

  feed.sort((a, b) => b.sortKey - a.sortKey);

  let filtered = feed;
  if (currentSPTab === 'sales') filtered = feed.filter(x => x.kind === 'sale');
  else if (currentSPTab === 'purchases') filtered = feed.filter(x => x.kind === 'purchase');

  const visible = filtered.slice(0, 10);

  const salesTotal = (salesData || []).reduce((s, x) => s + (Number(x.grandTotal) || Number(x.amount) || 0), 0);
  const purchasesTotal = calculateTotalPurchases(purchasesData);
  const net = salesTotal - purchasesTotal;
  const salesTotalEl = document.getElementById("spSalesTotal");
  const purchasesTotalEl = document.getElementById("spPurchasesTotal");
  const netTotalEl = document.getElementById("spNetTotal");
  if (salesTotalEl) salesTotalEl.textContent = formatCurrency(salesTotal);
  if (purchasesTotalEl) purchasesTotalEl.textContent = formatCurrency(purchasesTotal);
  if (netTotalEl) {
    netTotalEl.textContent = formatCurrency(Math.abs(net));
    netTotalEl.style.color = net >= 0 ? 'var(--sp-sale-text)' : 'var(--sp-purchase-text)';
  }

  if (!visible.length) {
    const emptyMsg = currentSPTab === 'sales'
      ? 'No recent sales yet.'
      : currentSPTab === 'purchases'
        ? 'No recent purchases yet.'
        : 'Sales and purchases will appear here as they happen.';
    list.innerHTML = `<li class="sp-empty">
      <div class="empty-state">
        <span class="empty-icon"><i class="fas fa-inbox"></i></span>
        <h4>No transactions yet</h4>
        <p>${emptyMsg}</p>
      </div>
    </li>`;
    return;
  }

  list.innerHTML = visible.map(item => {
    const kindClass = item.kind === 'sale' ? 'sp-type-sale' : 'sp-type-purchase';
    const avatarClass = item.kind === 'sale' ? 'sp-avatar-sale' : 'sp-avatar-purchase';
    const amountClass = item.kind === 'sale' ? 'sp-amount-pos' : 'sp-amount-neg';
    const sign = item.kind === 'sale' ? '+' : '−';
    const kindLabel = item.kind === 'sale' ? 'Sale' : 'Purchase';

    return `
      <li class="sp-item ${kindClass}" tabindex="0" aria-label="${escapeHtml(item.title)} — ${escapeHtml(item.amountLabel)}">
        <div class="sp-avatar ${avatarClass}">${escapeHtml(item.avatar)}</div>
        <div class="sp-main">
          <div class="sp-line1">
            <span class="sp-title">${escapeHtml(item.title)}</span>
            <span class="status-pill ${statusClass(item.status)}">
              <span class="dot"></span>${escapeHtml(item.status)}
            </span>
          </div>
          <div class="sp-line2">
            <span class="sp-desc">${escapeHtml(item.subtitle)}</span>
            <span class="sp-dot-sep">•</span>
            <span class="sp-time">${escapeHtml(item.time)}</span>
          </div>
        </div>
        <div class="sp-amount ${amountClass}">
          ${sign}${escapeHtml(item.amountLabel)}
          <span class="sp-amount-sub">${kindLabel}</span>
        </div>
        <button class="sp-action" aria-label="View details"><i class="fas fa-chevron-right"></i></button>
      </li>
    `;
  }).join("");
}

/* ---------------------------------------------------------
   LOW STOCK
   --------------------------------------------------------- */

function renderLowStock() {
  const body = document.getElementById("lowStockBody");
  if (!body) return;
  if (!dashboardDataReady) return;
  if (!dashboardUnlocked) return;

  const low = (productsData || []).filter(p => {
    const stock = Number(p.stock) || 0;
    const min = Number(p.reorderLevel || p.minStock || p.minimumStock) || 0;
    return stock <= min;
  });

  if (!low.length) {
    body.innerHTML = `<tr><td colspan="5">
      <div class="empty-state">
        <span class="empty-icon"><i class="fas fa-circle-check" style="color: var(--status-paid);"></i></span>
        <h4>All stocked up!</h4>
        <p>All products are sufficiently stocked.</p>
      </div>
    </td></tr>`;
    return;
  }

  body.innerHTML = low.map(p => {
    const stock = Number(p.stock) || 0;
    const min = Number(p.reorderLevel || p.minStock || p.minimumStock) || 0;
    const s = stockStatus(stock, min);
    return `<tr>
      <td data-label="Product">${escapeHtml(p.name || '-')}</td>
      <td data-label="SKU" class="cell-mono cell-muted">${escapeHtml(p.sku || '-')}</td>
      <td data-label="Stock" class="cell-mono">${stock}</td>
      <td data-label="Min." class="cell-mono cell-muted">${min}</td>
      <td data-label="Status"><span class="status-pill ${s.cls}"><span class="dot"></span>${s.label}</span></td>
    </tr>`;
  }).join("");
}

/* ---------------------------------------------------------
   RECENT ACTIVITY
   --------------------------------------------------------- */

function renderRecentActivity() {
  const list = document.getElementById("activityList");
  if (!list) return;
  if (!dashboardDataReady) return;
  if (!dashboardUnlocked) return;

  const activities = [];

  (salesData || [])
    .slice()
    .sort((a, b) => safeTime(b.createdAt, b.date) - safeTime(a.createdAt, a.date))
    .slice(0, 6)
    .forEach(s => activities.push({
      icon: 'fa-cart-plus',
      desc: `Sale ${s.saleNumber || '-'} for ${s.customerName || 'Walk-in'} — ${formatCurrency(Number(s.grandTotal) || 0)}`,
      time: s.createdAt ? new Date(s.createdAt).toLocaleString() : 'Unknown',
      date: safeTime(s.createdAt, s.date, s.timestamp)
    }));

  getSortedPurchases().slice(0, 6).forEach(p => activities.push({
    icon: 'fa-dolly',
    desc: `Purchase ${p.purchaseNumber || '-'} from ${p.supplierName || 'Supplier'} — ${formatCurrency(Number(p.grandTotal) || 0)}`,
    time: p.createdAt ? new Date(p.createdAt).toLocaleString() : (p.date ? new Date(p.date).toLocaleString() : 'Unknown'),
    date: safeTime(p.createdAt, p.date, p.timestamp)
  }));

  (expensesData || [])
    .slice()
    .sort((a, b) => safeTime(b.date, b.createdAt) - safeTime(a.date, a.createdAt))
    .slice(0, 6)
    .forEach(e => activities.push({
      icon: 'fa-wallet',
      desc: `Expense: ${e.category || 'General'} — ${formatCurrency(Number(e.amount) || Number(e.total) || 0)}${e.description ? ` (${e.description})` : ''}`,
      time: e.date ? new Date(e.date).toLocaleString() : (e.createdAt ? new Date(e.createdAt).toLocaleString() : 'Unknown'),
      date: safeTime(e.date, e.createdAt)
    }));

  (productsData || [])
    .filter(p => {
      const stock = Number(p.stock) || 0;
      const min = Number(p.reorderLevel || p.minStock || p.minimumStock) || 0;
      return stock <= min;
    })
    .slice(0, 6)
    .forEach(p => activities.push({
      icon: 'fa-triangle-exclamation',
      desc: `Low stock: ${p.name || '-'} (${p.stock || 0} left)`,
      time: p.updatedAt ? new Date(p.updatedAt).toLocaleString() : (p.createdAt ? new Date(p.createdAt).toLocaleString() : 'Unknown'),
      date: safeTime(p.updatedAt, p.createdAt)
    }));

  activities.sort((a, b) => b.date - a.date);
  const items = activities.slice(0, 8);

  if (!items.length) {
    list.innerHTML = `<div class="empty-state">
      <span class="empty-icon"><i class="fas fa-clock-rotate-left"></i></span>
      <h4>No recent activity</h4>
      <p>Activity from your business will appear here.</p>
    </div>`;
    return;
  }

  list.innerHTML = items.map(a => `<li class="activity-item">
    <span class="activity-icon"><i class="fas ${a.icon}"></i></span>
    <span>
      <div class="activity-desc">${escapeHtml(a.desc)}</div>
      <div class="activity-time">${escapeHtml(a.time)}</div>
    </span>
  </li>`).join('');
}

/* =========================================================
   SALES CHART
   ========================================================= */

let _chartAnimationFrame;

function updateSalesChart(range) {
  if (!dashboardUnlocked) return;
  currentChartRange = range || currentChartRange;
  const svg = document.getElementById("salesChart");
  const totalEl = document.getElementById("chartTotal");
  const growthEl = document.getElementById("chartGrowth");
  if (!svg || !totalEl || !growthEl) return;

  const data = buildChartData(range);
  const total = data.reduce((sum, [, v]) => sum + v, 0);

  let growth = 0;
  if (data.length >= 2) {
    const first = data[0][1] || 0;
    const last = data[data.length - 1][1] || 0;
    growth = first === 0 ? (last === 0 ? 0 : 100) : ((last - first) / first) * 100;
  }

  totalEl.textContent = formatCurrency(total);
  const growthText = `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`;
  growthEl.innerHTML = `<i class="fas fa-arrow-trend-${growth >= 0 ? 'up' : 'down'}"></i> ${growthText}`;
  growthEl.className = 'stat-change ' + (growth >= 0 ? 'up' : 'down');

  drawSalesChart(svg, data);
}

function buildChartData(range) {
  const now = new Date();
  const out = [];

  if (salesData && salesData.length > 0) {
    if (range === '7d') {
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(now); d.setDate(d.getDate() - (6 - i));
        return d;
      });
      const labels = days.map(d => d.toLocaleDateString('en-US', { weekday: 'short' }));
      const values = days.map(() => 0);

      for (const s of salesData) {
        if (!s.createdAt) continue;
        const d = new Date(s.createdAt);
        if (Number.isNaN(d.getTime())) continue;
        const diff = Math.floor((now - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
        if (diff >= 0 && diff < 7) values[6 - diff] += Number(s.grandTotal) || Number(s.amount) || 0;
      }
      labels.forEach((l, i) => out.push([l, values[i]]));

    } else if (range === '30d') {
      const step = 3;
      const days = Array.from({ length: 10 }, (_, i) => {
        const d = new Date(now); d.setDate(d.getDate() - (29 - i * step));
        return d;
      });
      const labels = days.map(d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      const buckets = Array.from({ length: 10 }, () => 0);

      for (const s of salesData) {
        if (!s.createdAt) continue;
        const d = new Date(s.createdAt);
        if (Number.isNaN(d.getTime())) continue;
        const diff = Math.floor((now - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
        if (diff < 0 || diff >= 30) continue;
        const bucket = 9 - Math.floor(diff / step);
        if (bucket >= 0 && bucket < 10) buckets[bucket] += Number(s.grandTotal) || Number(s.amount) || 0;
      }
      labels.forEach((l, i) => out.push([l, buckets[i]]));

    } else {
      const months = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(now); d.setMonth(d.getMonth() - (11 - i));
        return d;
      });
      const labels = months.map(d => d.toLocaleDateString('en-US', { month: 'short' }));
      const buckets = Array.from({ length: 12 }, () => 0);

      for (const s of salesData) {
        if (!s.createdAt) continue;
        const d = new Date(s.createdAt);
        if (Number.isNaN(d.getTime())) continue;
        const monthsAgo = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
        if (monthsAgo >= 0 && monthsAgo < 12) buckets[11 - monthsAgo] += Number(s.grandTotal) || Number(s.amount) || 0;
      }
      labels.forEach((l, i) => out.push([l, buckets[i]]));
    }
  } else {
    const series = range === '7d' ? salesSeries["7d"]
                 : range === '12m' ? salesSeries["12m"]
                 : salesSeries["30d"];

    if (range === '7d') {
      const labels = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(now); d.setDate(d.getDate() - (6 - i));
        return d.toLocaleDateString('en-US', { weekday: 'short' });
      });
      labels.forEach((l, i) => out.push([l, series[i]]));
    } else if (range === '12m') {
      const labels = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(now); d.setMonth(d.getMonth() - (11 - i));
        return d.toLocaleDateString('en-US', { month: 'short' });
      });
      labels.forEach((l, i) => out.push([l, series[i]]));
    } else {
      const step = 3;
      const labels = Array.from({ length: 10 }, (_, i) => {
        const d = new Date(now); d.setDate(d.getDate() - (29 - i * step));
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });
      labels.forEach((l, i) => out.push([l, series[i * step] || 0]));
    }
  }

  return out;
}

function drawSalesChart(svg, data) {
  const W = 1000;
  const H = 380;
  const PAD = { top: 46, right: 28, bottom: 46, left: 66 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const values = data.map(d => d[1]);
  const maxRaw = Math.max(...values, 1);
  const max = Math.ceil((maxRaw * 1.15) / 5000) * 5000 || 5000;
  const min = 0;

  const points = data.map(([label, value], index) => {
    const x = PAD.left + (chartW * index) / Math.max(data.length - 1, 1);
    const y = PAD.top + chartH - ((value - min) / (max - min)) * chartH;
    return { label, value, x, y };
  });

  function smoothPath(pts) {
    if (pts.length < 2) return "";
    let path = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? i : i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return path;
  }

  const path = smoothPath(points);
  const bottom = PAD.top + chartH;

  // Y-axis grid + labels
  let gridMarkup = "";
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (chartH / 4) * i;
    const value = max - ((max - min) / 4) * i;
    gridMarkup += `
      <line class="chart-grid-line" x1="${PAD.left}" y1="${y.toFixed(2)}"
            x2="${W - PAD.right}" y2="${y.toFixed(2)}"/>
      <text class="chart-axis-label y-label" x="${PAD.left - 14}" y="${(y + 4).toFixed(2)}"
            text-anchor="end">${formatCompactCurrency(value)}</text>
    `;
  }

  // X-axis labels
  const labelStep = data.length > 12 ? 2 : 1;
  let labelMarkup = "";
  points.forEach((p, i) => {
    if (i % labelStep === 0 || i === points.length - 1) {
      labelMarkup += `
        <text class="chart-axis-label x-label" x="${p.x.toFixed(2)}" y="${H - 14}"
              text-anchor="middle">${p.label}</text>
      `;
    }
  });

  const areaPath = `${path} L ${points[points.length - 1].x} ${bottom} L ${points[0].x} ${bottom} Z`;

  // Points + halos + value labels
  let dotsMarkup = "";
  let halosMarkup = "";
  let valueLabelsMarkup = "";

  points.forEach((p, i) => {
    const isCurrent = i === points.length - 1;
    const isFirst = i === 0;

    if (isCurrent) {
      halosMarkup += `
        <circle class="chart-point-halo" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="12"/>
      `;
    }

    const showStatic = isFirst || isCurrent || (points.length <= 8);
    if (showStatic && p.value > 0) {
      valueLabelsMarkup += `
        <text class="chart-value-label show" x="${p.x.toFixed(2)}" y="${(p.y - 14).toFixed(2)}"
              text-anchor="middle" data-index="${i}">${formatCompactCurrency(p.value)}</text>
      `;
    }

    dotsMarkup += `
      <circle class="chart-point ${isCurrent ? 'is-current' : ''}"
              cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${isCurrent ? 6 : 5}"
              data-index="${i}" data-label="${p.label}" data-value="${Math.round(p.value)}"/>
    `;
  });

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");

  svg.innerHTML = `
    <defs>
      <linearGradient id="salesGradient" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%"   stop-color="#2962FF" stop-opacity="0.30"/>
        <stop offset="55%"  stop-color="#5B84FF" stop-opacity="0.10"/>
        <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="lineGradient" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0%"   stop-color="#2962FF"/>
        <stop offset="55%"  stop-color="#5B84FF"/>
        <stop offset="100%" stop-color="#8B5CF6"/>
      </linearGradient>
    </defs>

    <g class="chart-grid">${gridMarkup}</g>

    <rect class="chart-hover-column" x="0" y="${PAD.top}" width="44" height="${chartH}" rx="8"/>

    <path class="chart-area" d="${areaPath}"/>
    <path class="chart-line" d="${path}"/>

    <line class="chart-hover-line" x1="0" x2="0" y1="${PAD.top}" y2="${bottom}" style="opacity:0;"/>

    <g class="chart-halos">${halosMarkup}</g>
    <g class="chart-points">${dotsMarkup}</g>
    <g class="chart-value-labels">${valueLabelsMarkup}</g>
    <g class="chart-labels">${labelMarkup}</g>
  `;

  // Draw-in animation
  const lineEl = svg.querySelector(".chart-line");
  cancelAnimationFrame(_chartAnimationFrame);
  const length = lineEl.getTotalLength();
  lineEl.style.strokeDasharray = length;
  lineEl.style.strokeDashoffset = length;
  const startTime = performance.now();
  const duration = 850;

  function frame(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 4);
    lineEl.style.strokeDashoffset = length * (1 - eased);
    if (progress < 1) _chartAnimationFrame = requestAnimationFrame(frame);
  }
  _chartAnimationFrame = requestAnimationFrame(frame);

  // Tooltip interactions
  const hoverLine = svg.querySelector(".chart-hover-line");
  const hoverColumn = svg.querySelector(".chart-hover-column");
  const tooltip = document.getElementById("chartTooltip");
  const tooltipLabel = document.getElementById("tooltipDate");
  const tooltipValue = document.getElementById("tooltipValue");

  if (tooltip && tooltipLabel && tooltipValue) {
    const chartWrap = svg.closest(".chart-wrap");
    const valueLabels = svg.querySelectorAll(".chart-value-label");

    svg.querySelectorAll(".chart-point").forEach(dot => {
      dot.addEventListener("mouseenter", function () {
        const idx = Number(this.dataset.index);
        const p = points[idx];

        tooltipLabel.textContent = this.dataset.label;
        tooltipValue.textContent = formatMoneyCompact(this.dataset.value);
        tooltip.hidden = false;

        const rect = svg.getBoundingClientRect();
        const wrapRect = chartWrap.getBoundingClientRect();
        const px = (p.x / W) * rect.width + rect.left - wrapRect.left;
        const py = (p.y / H) * rect.height + rect.top - wrapRect.top;

        tooltip.style.left = px + "px";
        tooltip.style.top = py + "px";
        tooltip.classList.add("visible");

        if (hoverLine) {
          hoverLine.setAttribute("x1", p.x);
          hoverLine.setAttribute("x2", p.x);
          hoverLine.style.opacity = "1";
        }
        if (hoverColumn) {
          hoverColumn.setAttribute("x", (p.x - 22).toFixed(2));
          hoverColumn.setAttribute("width", 44);
          hoverColumn.classList.add("active");
        }
        valueLabels.forEach(lbl => {
          if (Number(lbl.dataset.index) === idx) lbl.classList.add("show");
        });
      });

      dot.addEventListener("mouseleave", function () {
        tooltip.classList.remove("visible");
        if (hoverLine) hoverLine.style.opacity = "0";
        if (hoverColumn) hoverColumn.classList.remove("active");
        const idx = Number(this.dataset.index);
        const isStatic = idx === 0 || idx === points.length - 1 || points.length <= 8;
        if (!isStatic) {
          valueLabels.forEach(lbl => {
            if (Number(lbl.dataset.index) === idx) lbl.classList.remove("show");
          });
        }
      });
    });
  }
}

function setupRangeSelector() {
  if (_initialized.range) return;
  _initialized.range = true;
  document.querySelectorAll(".range-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".range-btn").forEach(b => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      updateSalesChart(btn.dataset.range);
    });
  });
}

/* ---------------------------------------------------------
   MODALS (generic)
   --------------------------------------------------------- */

let activeModalId = null;

function setupModals() {
  if (_initialized.modals) return;
  _initialized.modals = true;

  const overlay = document.getElementById("modalOverlay");
  if (!overlay) return;

  document.querySelectorAll("[data-close-modal]").forEach(btn => {
    btn.addEventListener("click", () => closeModal());
  });
  overlay.addEventListener("click", () => closeModal());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeModalId) closeModal();
  });
  document.querySelectorAll("[data-modal-form]").forEach(form => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      handleFormSubmit(form);
    });
  });
}

function openModal(id) {
  const modal = document.getElementById(id);
  const overlay = document.getElementById("modalOverlay");
  if (!modal || !overlay) return;

  resetModal(modal);

  document.body.classList.add("modal-open");

  modal.hidden = false;
  overlay.classList.add("open");
  requestAnimationFrame(() => modal.classList.add("open"));
  activeModalId = id;

  const firstInput = modal.querySelector("input, select");
  if (firstInput) {
    setTimeout(() => {
      try { firstInput.focus({ preventScroll: true }); }
      catch (_) { firstInput.focus(); }
    }, 150);
  }
}

function closeModal() {
  if (!activeModalId) return;
  const modal = document.getElementById(activeModalId);
  const overlay = document.getElementById("modalOverlay");
  if (!modal || !overlay) return;
  modal.classList.remove("open");
  overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => {
    modal.hidden = true;
    resetModal(modal);
  }, 220);
  activeModalId = null;
}

function resetModal(modal) {
  const form = modal.querySelector("[data-modal-form]");
  const success = modal.querySelector(".modal-success");
  if (form) {
    form.hidden = false;
    form.reset();
    form.querySelectorAll(".form-row").forEach(row => row.classList.remove("invalid"));
  }
  if (success) success.classList.remove("show");
}

function handleFormSubmit(form) {
  let valid = true;
  form.querySelectorAll(".form-row").forEach(row => {
    const field = row.querySelector("input, select");
    if (!field) return;
    row.classList.remove("invalid");
    if (field.hasAttribute("required")) {
      const val = field.value.trim();
      if (!val || (field.type === "number" && Number(val) < 0)) {
        row.classList.add("invalid");
        valid = false;
      }
    }
  });
  if (!valid) return;
  const modal = form.closest(".modal");
  if (!modal) return;
  form.hidden = true;
  const success = modal.querySelector(".modal-success");
  if (success) success.classList.add("show");
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "add-product") openModal("modalAddProduct");
  else if (action === "create-sale") openModal("modalCreateSale");
  else if (action === "add-customer") openModal("modalAddCustomer");
  else if (action === "add-purchase") openModal("modalAddPurchase");
  else if (action === "create-invoice") openModal("modalCreateInvoice");
  else if (action === "record-expense") openModal("modalRecordExpense");
});

/* =========================================================
   ADMIN HELPERS
   ========================================================= */

export async function approveMembership(userId, planId, reason = '') {
  const plan = PLAN_CATALOG[planId] || PLAN_CATALOG.monthly;
  const ref = membershipDocRef(userId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Membership doc not found');

  const now = new Date();
  const expires = new Date(now);
  expires.setMonth(expires.getMonth() + plan.durationMonths);

  await updateDoc(ref, {
    status: 'approved',
    planId: plan.id,
    planName: plan.name,
    planPrice: plan.price,
    planDurationMonths: plan.durationMonths,
    approvedAt: serverTimestamp(),
    approvedBy: auth.currentUser?.uid || null,
    approvalNote: reason,
    startsAt: Timestamp.fromDate(now),
    expiresAt: Timestamp.fromDate(expires),
    updatedAt: serverTimestamp()
  });
}

export async function rejectMembership(userId, reason = '') {
  const ref = membershipDocRef(userId);
  await updateDoc(ref, {
    status: 'rejected',
    rejectedAt: serverTimestamp(),
    rejectedBy: auth.currentUser?.uid || null,
    rejectionReason: reason,
    updatedAt: serverTimestamp()
  });
}

// ============================================================
// END OF FILE
// ============================================================