/* =========================================================
   MoeezFlow — Settings Module
   Firestore: businesses/{uid}/settings/profile,
              businesses/{uid}/settings/account
   Reuses businesses/{uid}/counters/invoices for the
   "starting invoice number" control.
   ========================================================= */
import { auth, db } from "../js/firebase.js";

import {
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import {
  onAuthStateChanged,
  updateProfile,
  updatePassword,
  deleteUser,
  signOut,
  reauthenticateWithCredential,
  EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

/* ---------------------------------------------------------
   AUTH / BUSINESS CONTEXT (same pattern as sales.js)
   --------------------------------------------------------- */

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
function bizDoc(path, id) { return doc(db, "businesses", getBusinessId(), path, id); }
function bizCollection(name) { return collection(db, "businesses", getBusinessId(), name); }

/* ---------------------------------------------------------
   STATE
   --------------------------------------------------------- */

let profileData = {};
let accountData = {};
let logoDataUrl = "";
let photoDataUrl = "";

/* ---------------------------------------------------------
   INIT
   --------------------------------------------------------- */

async function initializeSettings() {
  setupSidebar();
  setupSettingsNav();
  setupModals();
  setupCopyButtons();
  setupLogoUpload();
  setupPhotoUpload();
  setupForms();
  setupChangePassword();
  setupDangerZone();
  setupSignOut();

  document.getElementById("sidebarLogoutBtn").addEventListener("click", handleSignOutClick);
  document.getElementById("securitySignOutBtn").addEventListener("click", handleSignOutClick);

  await authReady;
  if (!currentUser) {
    showNotification("You must be signed in to view settings.", "fa-lock", true);
    document.getElementById("loadingState").hidden = true;
    return;
  }

  await loadSettings();
  populateAccountMetadata();
  document.getElementById("loadingState").hidden = true;
}

document.addEventListener("DOMContentLoaded", initializeSettings);

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

function setupSettingsNav() {
  document.querySelectorAll(".settings-nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".settings-nav-item").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".settings-section").forEach(s => s.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("section-" + btn.dataset.section).classList.add("active");
    });
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

function showNotification(message, icon, isError) {
  const toast = document.getElementById("toast");
  toast.classList.toggle("toast-error", !!isError);
  toast.innerHTML = `<i class="fas ${icon || "fa-circle-check"}"></i> ${escapeHtml(message)}`;
  toast.classList.add("show");
  clearTimeout(showNotification._t);
  showNotification._t = setTimeout(() => toast.classList.remove("show"), 3600);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const DEFAULT_INVOICE_CUSTOMIZATION = {
  invoiceNumber: true,
  invoiceDate: true,
  dueDate: false,
  purchaseOrder: true,
  notesTerms: true,
  customerSupplierPhone: true,
  customerSupplierAddress: true,
  customerSupplierEmail: true,
  taxId: true,
  genericName: false,
  strength: false,
  packSize: false,
  sku: true,
  description: true,
  unit: true,
  quantity: true,
  unitPrice: true,
  discount: true,
  tax: true,
  batchLot: true,
  expiryDate: false,
  manufacturer: false,
  size: false,
  color: false,
  brand: false,
  warehouse: false,
  serialNumber: false,
  subtotal: true,
  discountTotal: true,
  taxTotal: true,
  grandTotal: true,
  amountPaid: true,
  balance: true,
  paymentMethod: true,
  paymentStatus: true,
  itemColumnOrder: ["item", "sku", "qty", "unit", "unitPrice", "discount", "tax", "lineTotal"]
};

function normalizeInvoiceCustomization(raw = {}) {
  const config = { ...DEFAULT_INVOICE_CUSTOMIZATION, ...(raw || {}) };
  const allowedColumns = ["item", "sku", "qty", "unit", "unitPrice", "discount", "tax", "lineTotal"];
  const order = Array.isArray(raw?.itemColumnOrder) ? raw.itemColumnOrder.filter(key => allowedColumns.includes(key)) : [];
  config.itemColumnOrder = [...new Set([...(order.length ? order : DEFAULT_INVOICE_CUSTOMIZATION.itemColumnOrder), ...allowedColumns])].filter(key => allowedColumns.includes(key));
  return config;
}

function applyInvoiceCustomizationForm(customization) {
  const fields = [
    ["invoiceNumber", "invCustomInvoiceNumber"],
    ["invoiceDate", "invCustomInvoiceDate"],
    ["dueDate", "invCustomDueDate"],
    ["purchaseOrder", "invCustomPurchaseOrder"],
    ["notesTerms", "invCustomNotesTerms"],
    ["customerSupplierPhone", "invCustomCustomerSupplierPhone"],
    ["customerSupplierAddress", "invCustomCustomerSupplierAddress"],
    ["customerSupplierEmail", "invCustomCustomerSupplierEmail"],
    ["taxId", "invCustomTaxId"],
    ["genericName", "invCustomGenericName"],
    ["strength", "invCustomStrength"],
    ["packSize", "invCustomPackSize"],
    ["sku", "invCustomSku"],
    ["description", "invCustomDescription"],
    ["unit", "invCustomUnit"],
    ["quantity", "invCustomQuantity"],
    ["unitPrice", "invCustomUnitPrice"],
    ["discount", "invCustomDiscount"],
    ["tax", "invCustomTax"],
    ["batchLot", "invCustomBatchLot"],
    ["expiryDate", "invCustomExpiryDate"],
    ["manufacturer", "invCustomManufacturer"],
    ["size", "invCustomSize"],
    ["color", "invCustomColor"],
    ["brand", "invCustomBrand"],
    ["warehouse", "invCustomWarehouse"],
    ["serialNumber", "invCustomSerialNumber"],
    ["subtotal", "invCustomSubtotal"],
    ["discountTotal", "invCustomDiscountTotal"],
    ["taxTotal", "invCustomTaxTotal"],
    ["grandTotal", "invCustomGrandTotal"],
    ["amountPaid", "invCustomAmountPaid"],
    ["balance", "invCustomBalance"],
    ["paymentMethod", "invCustomPaymentMethod"],
    ["paymentStatus", "invCustomPaymentStatus"]
  ];

  fields.forEach(([key, id]) => {
    const element = document.getElementById(id);
    if (element) element.checked = customization[key] !== false;
  });

  const list = document.getElementById("itemColumnOrderList");
  if (!list) return;

  const rows = Array.from(list.querySelectorAll(".sort-row"));
  const order = Array.isArray(customization.itemColumnOrder) && customization.itemColumnOrder.length ? customization.itemColumnOrder : DEFAULT_INVOICE_CUSTOMIZATION.itemColumnOrder;
  rows.forEach(row => row.remove());
  order.forEach(key => {
    const row = rows.find(item => item.dataset.columnKey === key);
    if (row) list.appendChild(row);
  });
}

function getInvoiceCustomizationFromForm() {
  const config = {
    invoiceNumber: document.getElementById("invCustomInvoiceNumber").checked,
    invoiceDate: document.getElementById("invCustomInvoiceDate").checked,
    dueDate: document.getElementById("invCustomDueDate").checked,
    purchaseOrder: document.getElementById("invCustomPurchaseOrder").checked,
    notesTerms: document.getElementById("invCustomNotesTerms").checked,
    customerSupplierPhone: document.getElementById("invCustomCustomerSupplierPhone").checked,
    customerSupplierAddress: document.getElementById("invCustomCustomerSupplierAddress").checked,
    customerSupplierEmail: document.getElementById("invCustomCustomerSupplierEmail").checked,
    taxId: document.getElementById("invCustomTaxId").checked,
    genericName: document.getElementById("invCustomGenericName").checked,
    strength: document.getElementById("invCustomStrength").checked,
    packSize: document.getElementById("invCustomPackSize").checked,
    sku: document.getElementById("invCustomSku").checked,
    description: document.getElementById("invCustomDescription").checked,
    unit: document.getElementById("invCustomUnit").checked,
    quantity: document.getElementById("invCustomQuantity").checked,
    unitPrice: document.getElementById("invCustomUnitPrice").checked,
    discount: document.getElementById("invCustomDiscount").checked,
    tax: document.getElementById("invCustomTax").checked,
    batchLot: document.getElementById("invCustomBatchLot").checked,
    expiryDate: document.getElementById("invCustomExpiryDate").checked,
    manufacturer: document.getElementById("invCustomManufacturer").checked,
    size: document.getElementById("invCustomSize").checked,
    color: document.getElementById("invCustomColor").checked,
    brand: document.getElementById("invCustomBrand").checked,
    warehouse: document.getElementById("invCustomWarehouse").checked,
    serialNumber: document.getElementById("invCustomSerialNumber").checked,
    subtotal: document.getElementById("invCustomSubtotal").checked,
    discountTotal: document.getElementById("invCustomDiscountTotal").checked,
    taxTotal: document.getElementById("invCustomTaxTotal").checked,
    grandTotal: document.getElementById("invCustomGrandTotal").checked,
    amountPaid: document.getElementById("invCustomAmountPaid").checked,
    balance: document.getElementById("invCustomBalance").checked,
    paymentMethod: document.getElementById("invCustomPaymentMethod").checked,
    paymentStatus: document.getElementById("invCustomPaymentStatus").checked,
    itemColumnOrder: Array.from(document.querySelectorAll("#itemColumnOrderList .sort-row")).map(row => row.dataset.columnKey)
  };

  return normalizeInvoiceCustomization(config);
}

function setupInvoiceCustomizationControls() {
  const list = document.getElementById("itemColumnOrderList");
  if (!list) return;

  list.querySelectorAll(".sort-btn").forEach(button => {
    button.addEventListener("click", () => {
      const row = button.closest(".sort-row");
      const direction = button.dataset.direction;
      const rows = Array.from(list.querySelectorAll(".sort-row"));
      const index = rows.indexOf(row);
      if (index < 0) return;
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= rows.length) return;
      const targetRow = rows[targetIndex];
      if (direction === "up") {
        list.insertBefore(row, targetRow);
      } else {
        list.insertBefore(targetRow, row);
      }
    });
  });
}

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }) +
    " · " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

/* ---------------------------------------------------------
   COPY BUTTONS
   --------------------------------------------------------- */

function setupCopyButtons() {
  document.querySelectorAll(".copy-btn[data-copy-target]").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target || !target.value) {
        showNotification("Nothing to copy yet.", "fa-circle-info", true);
        return;
      }
      navigator.clipboard.writeText(target.value).then(() => {
        const original = btn.innerHTML;
        btn.innerHTML = `<i class="fas fa-check"></i>`;
        btn.classList.add("copied");
        setTimeout(() => { btn.innerHTML = original; btn.classList.remove("copied"); }, 1500);
        showNotification("Copied to clipboard.", "fa-copy");
      }).catch(() => showNotification("Could not copy to clipboard.", "fa-triangle-exclamation", true));
    });
  });
}

/* ---------------------------------------------------------
   IMAGE COMPRESSION (client-side resize before storing as
   base64 inside the Firestore settings document — no
   Firebase Storage bucket has been set up in this project,
   so this keeps logo/photo storage self-contained).
   --------------------------------------------------------- */

function compressImageFile(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Could not read image file."));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------
   LOGO UPLOAD (Business Profile)
   --------------------------------------------------------- */

function setupLogoUpload() {
  const input = document.getElementById("logoInput");
  const removeBtn = document.getElementById("removeLogoBtn");

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      logoDataUrl = await compressImageFile(file, 240, 0.82);
      renderLogoPreview();
    } catch (err) {
      showNotification(err.message, "fa-triangle-exclamation", true);
    }
  });

  removeBtn.addEventListener("click", () => {
    logoDataUrl = "";
    input.value = "";
    renderLogoPreview();
  });
}

function renderLogoPreview() {
  const preview = document.getElementById("logoPreview");
  const removeBtn = document.getElementById("removeLogoBtn");
  if (logoDataUrl) {
    preview.innerHTML = `<img src="${logoDataUrl}" alt="Business logo">`;
    removeBtn.hidden = false;
  } else {
    preview.innerHTML = `<i class="fas fa-building"></i>`;
    removeBtn.hidden = true;
  }
}

/* ---------------------------------------------------------
   PHOTO UPLOAD (Account)
   --------------------------------------------------------- */

function setupPhotoUpload() {
  const input = document.getElementById("photoInput");
  const removeBtn = document.getElementById("removePhotoBtn");

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      photoDataUrl = await compressImageFile(file, 200, 0.82);
      renderPhotoPreview();
    } catch (err) {
      showNotification(err.message, "fa-triangle-exclamation", true);
    }
  });

  removeBtn.addEventListener("click", () => {
    photoDataUrl = "";
    input.value = "";
    renderPhotoPreview();
  });
}

function renderPhotoPreview() {
  const preview = document.getElementById("photoPreview");
  const removeBtn = document.getElementById("removePhotoBtn");
  if (photoDataUrl) {
    preview.innerHTML = `<img src="${photoDataUrl}" alt="Profile photo">`;
    removeBtn.hidden = false;
  } else {
    preview.innerHTML = `<i class="fas fa-user"></i>`;
    removeBtn.hidden = true;
  }
}

/* ---------------------------------------------------------
   LOAD SETTINGS
   --------------------------------------------------------- */

async function loadSettings() {
  try {
    const profileSnap = await getDoc(bizDoc("settings", "profile"));
    profileData = profileSnap.exists() ? profileSnap.data() : {};
  } catch (err) {
    console.error("Failed to load business profile:", err);
    profileData = {};
  }

  try {
    const accountSnap = await getDoc(bizDoc("settings", "account"));
    accountData = accountSnap.exists() ? accountSnap.data() : {};
  } catch (err) {
    console.error("Failed to load account settings:", err);
    accountData = {};
  }

  // Business Profile
  document.getElementById("bizName").value = profileData.businessName || "";
  document.getElementById("bizOwner").value = profileData.ownerName || "";
  document.getElementById("bizPhone").value = profileData.phone || "";
  document.getElementById("bizEmail").value = profileData.email || "";
  document.getElementById("bizAddress").value = profileData.address || "";
  document.getElementById("bizCurrency").value = profileData.currency || "PKR";
  document.getElementById("bizType").value = profileData.businessType === "Retail"
    ? "General Retail"
    : (profileData.businessType || "General Retail");
  logoDataUrl = profileData.logo || "";
  renderLogoPreview();

  // Account
  document.getElementById("acctName").value = accountData.displayName || currentUser.displayName || "";
  document.getElementById("acctEmail").value = currentUser.email || "";
  photoDataUrl = accountData.photo || "";
  renderPhotoPreview();

  // Invoice & Sales
  document.getElementById("invPrefix").value = profileData.invoicePrefix || "INV-";
  document.getElementById("invStartNumber").value = profileData.startingInvoiceNumber || "";
  document.getElementById("invDefaultPayment").value = profileData.defaultPaymentMethod || "Cash";
  document.getElementById("invFooterNotes").value = profileData.invoiceNotes || "";
  document.getElementById("invShowBusinessInfo").checked = profileData.showBusinessInfoOnInvoice !== false;
  applyInvoiceCustomizationForm(normalizeInvoiceCustomization(profileData.invoiceCustomization || {}));

  // FlowAI
  document.getElementById("flowAIEnabled").checked = profileData.flowAIEnabled !== false;
}

function populateAccountMetadata() {
  const created = currentUser.metadata?.creationTime ? formatDateTime(currentUser.metadata.creationTime) : "—";
  const lastLogin = currentUser.metadata?.lastSignInTime ? formatDateTime(currentUser.metadata.lastSignInTime) : "—";
  const verified = currentUser.emailVerified ? "Verified" : "Not verified";
  const providerId = currentUser.providerData?.[0]?.providerId || "password";
  const providerLabel = providerId === "password" ? "Email & Password" : providerId;

  document.getElementById("acctCreated").textContent = created;
  document.getElementById("acctLastLogin").textContent = lastLogin;
  document.getElementById("acctVerified").textContent = verified;
  document.getElementById("secCreated").textContent = created;
  document.getElementById("secLastLogin").textContent = lastLogin;
  document.getElementById("secProvider").textContent = providerLabel;
}

/* ---------------------------------------------------------
   FORM SUBMISSIONS
   --------------------------------------------------------- */

function setupForms() {
  setupInvoiceCustomizationControls();
  document.getElementById("businessForm").addEventListener("submit", handleBusinessSave);
  document.getElementById("accountForm").addEventListener("submit", handleAccountSave);
  document.getElementById("invoiceForm").addEventListener("submit", handleInvoiceSave);
  document.getElementById("flowAISaveBtn").addEventListener("click", handleFlowAISave);
}

async function handleBusinessSave(e) {
  e.preventDefault();
  const nameRow = document.getElementById("bizName").closest(".form-row");
  const emailRow = document.getElementById("bizEmail").closest(".form-row");
  nameRow.classList.remove("invalid");
  emailRow.classList.remove("invalid");

  const businessName = document.getElementById("bizName").value.trim();
  const email = document.getElementById("bizEmail").value.trim();
  let valid = true;
  if (!businessName) { nameRow.classList.add("invalid"); valid = false; }
  if (email && !isValidEmail(email)) { emailRow.classList.add("invalid"); valid = false; }
  if (!valid) return;

  const btn = document.getElementById("businessSaveBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Saving...`;

  try {
    const data = {
      businessName,
      ownerName: document.getElementById("bizOwner").value.trim(),
      phone: document.getElementById("bizPhone").value.trim(),
      email,
      address: document.getElementById("bizAddress").value.trim(),
      currency: document.getElementById("bizCurrency").value,
      businessType: document.getElementById("bizType").value,
      logo: logoDataUrl,
      ownerId: currentUser.uid,
      updatedAt: serverTimestamp()
    };
    // preserve invoice/FlowAI fields already stored on this same document
    await setDoc(bizDoc("settings", "profile"), data, { merge: true });
    profileData = { ...profileData, ...data };
    showNotification("Business profile saved.", "fa-circle-check");
  } catch (err) {
    console.error("Save business profile failed:", err);
    showNotification(err.message || "Could not save business profile.", "fa-triangle-exclamation", true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Business Profile";
  }
}

async function handleAccountSave(e) {
  e.preventDefault();
  const btn = document.getElementById("accountSaveBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Saving...`;

  try {
    const displayName = document.getElementById("acctName").value.trim();

    await setDoc(bizDoc("settings", "account"), {
      displayName,
      photo: photoDataUrl,
      ownerId: currentUser.uid,
      updatedAt: serverTimestamp()
    }, { merge: true });

    // keep Firebase Auth's own displayName in sync for consistency elsewhere in the app
    if (displayName && displayName !== currentUser.displayName) {
      await updateProfile(currentUser, { displayName });
    }

    accountData.displayName = displayName;
    accountData.photo = photoDataUrl;
    showNotification("Account saved.", "fa-circle-check");
  } catch (err) {
    console.error("Save account failed:", err);
    showNotification(err.message || "Could not save account.", "fa-triangle-exclamation", true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Account";
  }
}

async function handleInvoiceSave(e) {
  e.preventDefault();
  const startRow = document.getElementById("invStartNumber").closest(".form-row");
  startRow.classList.remove("invalid");

  const startRaw = document.getElementById("invStartNumber").value;
  const startingInvoiceNumber = startRaw === "" ? null : Number(startRaw);
  if (startRaw !== "" && (isNaN(startingInvoiceNumber) || startingInvoiceNumber < 1)) {
    startRow.classList.add("invalid");
    return;
  }

  const btn = document.getElementById("invoiceSaveBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Saving...`;

  try {
    const invoicePrefix = document.getElementById("invPrefix").value.trim() || "INV-";
    const invoiceCustomization = getInvoiceCustomizationFromForm();

    const data = {
      invoicePrefix,
      startingInvoiceNumber,
      defaultPaymentMethod: document.getElementById("invDefaultPayment").value,
      invoiceNotes: document.getElementById("invFooterNotes").value.trim(),
      showBusinessInfoOnInvoice: document.getElementById("invShowBusinessInfo").checked,
      invoiceCustomization,
      ownerId: currentUser.uid,
      updatedAt: serverTimestamp()
    };
    await setDoc(bizDoc("settings", "profile"), data, { merge: true });
    profileData = { ...profileData, ...data };

    // Reset the invoice counters so the NEXT generated invoice starts at
    // the requested number. Existing invoices are untouched — only the
    // counter used for future numbering changes.
    if (startingInvoiceNumber) {
      await setDoc(bizDoc("counters", "invoices"), {
        lastSalesInvoice: startingInvoiceNumber - 1,
        lastPurchaseInvoice: startingInvoiceNumber - 1
      }, { merge: true });
    }

    showNotification("Invoice settings saved.", "fa-circle-check");
  } catch (err) {
    console.error("Save invoice settings failed:", err);
    showNotification(err.message || "Could not save invoice settings.", "fa-triangle-exclamation", true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Invoice Settings";
  }
}

async function handleFlowAISave() {
  const btn = document.getElementById("flowAISaveBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Saving...`;

  try {
    const flowAIEnabled = document.getElementById("flowAIEnabled").checked;
    await setDoc(bizDoc("settings", "profile"), {
      flowAIEnabled, ownerId: currentUser.uid, updatedAt: serverTimestamp()
    }, { merge: true });
    profileData.flowAIEnabled = flowAIEnabled;
    showNotification("FlowAI setting saved.", "fa-circle-check");
  } catch (err) {
    console.error("Save FlowAI setting failed:", err);
    showNotification(err.message || "Could not save FlowAI setting.", "fa-triangle-exclamation", true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save FlowAI Setting";
  }
}

/* ---------------------------------------------------------
   CHANGE PASSWORD
   --------------------------------------------------------- */

function setupChangePassword() {
  document.getElementById("openChangePasswordBtn").addEventListener("click", () => openModal("changePasswordModal"));
  document.getElementById("securityChangePasswordBtn").addEventListener("click", () => openModal("changePasswordModal"));
  document.getElementById("changePasswordForm").addEventListener("submit", handleChangePassword);
}

async function handleChangePassword(e) {
  e.preventDefault();
  const currentRow = document.getElementById("cpCurrent").closest(".form-row");
  const newRow = document.getElementById("cpNew").closest(".form-row");
  const confirmRow = document.getElementById("cpConfirm").closest(".form-row");
  [currentRow, newRow, confirmRow].forEach(r => r.classList.remove("invalid"));

  const currentPassword = document.getElementById("cpCurrent").value;
  const newPassword = document.getElementById("cpNew").value;
  const confirmPassword = document.getElementById("cpConfirm").value;

  let valid = true;
  if (!currentPassword) { currentRow.classList.add("invalid"); valid = false; }
  if (!newPassword || newPassword.length < 6) { newRow.classList.add("invalid"); valid = false; }
  if (newPassword !== confirmPassword) { confirmRow.classList.add("invalid"); valid = false; }
  if (!valid) return;

  const btn = document.getElementById("cpSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Updating...`;

  try {
    const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
    await reauthenticateWithCredential(currentUser, credential);
    await updatePassword(currentUser, newPassword);
    document.getElementById("changePasswordForm").reset();
    closeModal();
    showNotification("Password updated successfully.", "fa-circle-check");
  } catch (err) {
    console.error("Change password failed:", err);
    if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
      currentRow.classList.add("invalid");
      showNotification("Current password is incorrect.", "fa-triangle-exclamation", true);
    } else {
      showNotification(err.message || "Could not update password.", "fa-triangle-exclamation", true);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Update Password";
  }
}

/* ---------------------------------------------------------
   SIGN OUT
   --------------------------------------------------------- */

function setupSignOut() {
  // handled via handleSignOutClick bound in initializeSettings
}

async function handleSignOutClick(e) {
  e.preventDefault();
  try {
    await signOut(auth);
    // TODO: confirm this matches your real login page path/filename.
    window.location.href = "../login/login.html";
  } catch (err) {
    console.error("Sign out failed:", err);
    showNotification(err.message || "Could not sign out.", "fa-triangle-exclamation", true);
  }
}

/* ---------------------------------------------------------
   DANGER ZONE
   --------------------------------------------------------- */

const FIRESTORE_COLLECTIONS_TO_WIPE = [
  "products", "sales", "purchases", "invoices", "expenses"
];
const LOCAL_STORAGE_KEYS_TO_WIPE = [
  "moeezflow_customers", "moeezflow_suppliers", "moeezflow_purchases",
  "moeezflow_purchase_suppliers", "moeezflow_purchase_inventory", "moeezflow_products"
];

async function wipeAllFirestoreCollections() {
  for (const name of FIRESTORE_COLLECTIONS_TO_WIPE) {
    const snap = await getDocs(bizCollection(name));
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const batch = writeBatch(db);
      docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }
  // settings + counters are single documents, not collections of many docs
  const finalBatch = writeBatch(db);
  finalBatch.delete(bizDoc("settings", "profile"));
  finalBatch.delete(bizDoc("settings", "account"));
  finalBatch.delete(bizDoc("counters", "invoices"));
  finalBatch.delete(bizDoc("counters", "sales"));
  finalBatch.delete(bizDoc("counters", "purchases"));
  await finalBatch.commit();

  LOCAL_STORAGE_KEYS_TO_WIPE.forEach(key => localStorage.removeItem(key));
}

function setupDangerZone() {
  const deleteBusinessInput = document.getElementById("deleteBusinessConfirmInput");
  const confirmBusinessBtn = document.getElementById("confirmDeleteBusinessDataBtn");
  deleteBusinessInput.addEventListener("input", () => {
    confirmBusinessBtn.disabled = deleteBusinessInput.value.trim() !== "DELETE";
  });

  document.getElementById("deleteBusinessDataBtn").addEventListener("click", () => {
    deleteBusinessInput.value = "";
    confirmBusinessBtn.disabled = true;
    openModal("deleteBusinessDataModal");
  });

  confirmBusinessBtn.addEventListener("click", async () => {
    confirmBusinessBtn.disabled = true;
    confirmBusinessBtn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Deleting...`;
    try {
      await wipeAllFirestoreCollections();
      closeModal();
      showNotification("All business data has been deleted.", "fa-trash");
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      console.error("Delete business data failed:", err);
      showNotification(err.message || "Could not delete business data.", "fa-triangle-exclamation", true);
      confirmBusinessBtn.disabled = false;
      confirmBusinessBtn.textContent = "Delete Business Data";
    }
  });

  const deleteAccountInput = document.getElementById("deleteAccountConfirmInput");
  const deleteAccountPassword = document.getElementById("deleteAccountPassword");
  const confirmAccountBtn = document.getElementById("confirmDeleteAccountBtn");

  function updateAccountDeleteButtonState() {
    confirmAccountBtn.disabled = deleteAccountInput.value.trim() !== "DELETE" || !deleteAccountPassword.value;
  }
  deleteAccountInput.addEventListener("input", updateAccountDeleteButtonState);
  deleteAccountPassword.addEventListener("input", updateAccountDeleteButtonState);

  document.getElementById("deleteAccountBtn").addEventListener("click", () => {
    deleteAccountInput.value = "";
    deleteAccountPassword.value = "";
    confirmAccountBtn.disabled = true;
    openModal("deleteAccountModal");
  });

  confirmAccountBtn.addEventListener("click", async () => {
    const passwordRow = deleteAccountPassword.closest(".form-row");
    passwordRow.classList.remove("invalid");

    confirmAccountBtn.disabled = true;
    confirmAccountBtn.innerHTML = `<span class="module-spinner" aria-hidden="true"></span> Deleting...`;

    try {
      const credential = EmailAuthProvider.credential(currentUser.email, deleteAccountPassword.value);
      await reauthenticateWithCredential(currentUser, credential);
      await wipeAllFirestoreCollections();
      await deleteUser(currentUser);
      showNotification("Your account has been deleted.", "fa-trash");
      setTimeout(() => { window.location.href = "../login/login.html"; }, 1200);
    } catch (err) {
      console.error("Delete account failed:", err);
      if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
        passwordRow.classList.add("invalid");
        showNotification("Password is incorrect.", "fa-triangle-exclamation", true);
      } else {
        showNotification(err.message || "Could not delete account.", "fa-triangle-exclamation", true);
      }
      confirmAccountBtn.disabled = false;
      confirmAccountBtn.textContent = "Delete Account";
    }
  });
}

/* ---------------------------------------------------------
   GENERIC MODAL SYSTEM
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
}
