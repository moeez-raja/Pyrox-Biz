/* =========================================================
   Pyrox Biz — Help & Support Module
   Pure UI/navigation logic only. No forms, no data, no
   Firebase dependency — this page has nothing to fetch or
   store.
   ========================================================= */

document.addEventListener("DOMContentLoaded", initializeHelp);

function initializeHelp() {
  setupSidebar();
  setupNavigation();
}

/* ---------------------------------------------------------
   SIDEBAR (mobile) — same pattern as every other module
   --------------------------------------------------------- */

function setupSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const openBtn = document.getElementById("menuToggle");
  const closeBtn = document.getElementById("sidebarClose");

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

/* ---------------------------------------------------------
   NAVIGATION
   --------------------------------------------------------- */

function setupNavigation() {
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      // TODO: wire this to your real sign-out flow once auth is finalized here.
      console.log("Logout clicked — connect to real auth sign-out.");
    });
  }
}