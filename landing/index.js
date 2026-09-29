(function () {
    'use strict';

    /* ============================================================
       1. MOBILE MENU
       ============================================================ */
    const hamburger = document.getElementById('hamburger');
    const mobileMenu = document.getElementById('mobileMenu');

    if (hamburger && mobileMenu) {
        hamburger.addEventListener('click', function (e) {
            e.stopPropagation();
            const isOpen = mobileMenu.classList.toggle('open');
            hamburger.classList.toggle('active');
            hamburger.setAttribute('aria-expanded', isOpen);
        });

        mobileMenu.querySelectorAll('a').forEach(function (link) {
            link.addEventListener('click', function () {
                mobileMenu.classList.remove('open');
                hamburger.classList.remove('active');
                hamburger.setAttribute('aria-expanded', 'false');
            });
        });

        document.addEventListener('click', function (e) {
            if (!mobileMenu.contains(e.target) && !hamburger.contains(e.target)) {
                mobileMenu.classList.remove('open');
                hamburger.classList.remove('active');
                hamburger.setAttribute('aria-expanded', 'false');
            }
        });
    }

    /* ============================================================
       2. NAVBAR SCROLL STATE
       ============================================================ */
    const navbar = document.getElementById('navbar');
    let lastY = 0;

    window.addEventListener('scroll', function () {
        const y = window.scrollY;

        if (y > 20) navbar.classList.add('scrolled');
        else navbar.classList.remove('scrolled');

        if (y > lastY && y > 200) {
            navbar.style.transform = 'translateY(-110%)';
        } else {
            navbar.style.transform = 'translateY(0)';
        }

        lastY = y;
    }, { passive: true });

    /* ============================================================
       3. SCROLL-TRIGGERED REVEALS
       ============================================================ */
    const revealEls = document.querySelectorAll(
        '.anim-fade-up, .anim-slide-left, .anim-slide-right, .anim-scale-in'
    );

    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                const delay = parseInt(entry.target.getAttribute('data-delay')) || 0;
                setTimeout(function () {
                    entry.target.classList.add('visible');
                }, delay * 80);
                observer.unobserve(entry.target);
            });
        }, {
            threshold: 0.12,
            rootMargin: '0px 0px -40px 0px'
        });

        revealEls.forEach(function (el) { observer.observe(el); });
    } else {
        revealEls.forEach(function (el) { el.classList.add('visible'); });
    }

    /* ============================================================
       4. HERO ROTATING HEADLINE
       ============================================================ */
    const rotator = document.getElementById('rotatingText');
    if (rotator) {
        const phrases = [
            'from one place.',
            'with AI insight.',
            'without spreadsheets.',
            'without guessing stock.',
            'with live ledgers.',
            'faster than ever.'
        ];
        let i = 0;

        setInterval(function () {
            rotator.style.opacity = '0';
            rotator.style.transform = 'translateY(-10px)';

            setTimeout(function () {
                i = (i + 1) % phrases.length;
                rotator.textContent = phrases[i];
                rotator.style.transform = 'translateY(10px)';

                requestAnimationFrame(function () {
                    rotator.style.opacity = '1';
                    rotator.style.transform = 'translateY(0)';
                });
            }, 350);
        }, 3200);
    }

    /* ============================================================
       5. FAQ ACCORDION
       ============================================================ */
    const faqItems = document.querySelectorAll('.faq-item');

    faqItems.forEach(function (item, index) {
        const q = item.querySelector('.faq-question');
        const a = item.querySelector('.faq-answer');
        if (!q || !a) return;

        if (index === 0) {
            item.classList.add('active');
            a.classList.add('open');
            q.setAttribute('aria-expanded', 'true');
        }

        q.addEventListener('click', function () {
            const wasActive = item.classList.contains('active');

            faqItems.forEach(function (other) {
                if (other === item) return;
                other.classList.remove('active');
                const oa = other.querySelector('.faq-answer');
                const oq = other.querySelector('.faq-question');
                if (oa) oa.classList.remove('open');
                if (oq) oq.setAttribute('aria-expanded', 'false');
            });

            if (wasActive) {
                item.classList.remove('active');
                a.classList.remove('open');
                q.setAttribute('aria-expanded', 'false');
            } else {
                item.classList.add('active');
                a.classList.add('open');
                q.setAttribute('aria-expanded', 'true');
            }
        });

        q.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                q.click();
            }
        });
    });

    /* ============================================================
       6. PRICING TOGGLE
       ============================================================ */
    const pricingToggle = document.getElementById('pricingToggle');
    if (pricingToggle) {
        pricingToggle.addEventListener('change', function () {
            const yearly = this.checked;

            document.querySelectorAll('.pricing-card').forEach(function (card) {
                const priceEl = card.querySelector('.price');
                if (!priceEl || !priceEl.dataset.monthly || !priceEl.dataset.yearly) return;

                priceEl.textContent = yearly
                    ? priceEl.dataset.yearly
                    : priceEl.dataset.monthly;

                const perEl = priceEl.nextElementSibling;
                if (perEl && perEl.tagName === 'P') {
                    perEl.textContent = yearly
                        ? 'per year · billed annually'
                        : 'per month · billed monthly';
                }
            });
        });
    }

    /* ============================================================
       7. BACK-TO-TOP
       ============================================================ */
    const backBtn = document.getElementById('backToTop');
    if (backBtn) {
        window.addEventListener('scroll', function () {
            if (window.scrollY > 500) backBtn.classList.add('visible');
            else backBtn.classList.remove('visible');
        }, { passive: true });

        backBtn.addEventListener('click', function () {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    /* ============================================================
       8. SMOOTH ANCHOR SCROLL
       ============================================================ */
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
        anchor.addEventListener('click', function (e) {
            const href = this.getAttribute('href');
            if (href === '#' || href.length < 2) return;

            const target = document.querySelector(href);
            if (!target) return;

            e.preventDefault();
            const navH = navbar ? navbar.offsetHeight : 0;
            const top = target.getBoundingClientRect().top + window.scrollY - navH - 20;

            window.scrollTo({ top: top, behavior: 'smooth' });
        });
    });

    /* ============================================================
       9. FEATURE CARD CURSOR SPOTLIGHT
       ============================================================ */
    document.querySelectorAll('.feature-card').forEach(function (card) {
        card.addEventListener('mousemove', function (e) {
            const r = card.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * 100;
            const y = ((e.clientY - r.top) / r.height) * 100;
            card.style.setProperty('--mx', x + '%');
            card.style.setProperty('--my', y + '%');
        });
    });

    /* ============================================================
       10. KPI COUNTERS
       ============================================================ */
    const counters = document.querySelectorAll('.dash-kpi-value, .preview-stat-value');
    if (counters.length && 'IntersectionObserver' in window) {
        const counterObs = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                const el = entry.target;
                const original = el.textContent;
                const num = parseFloat(original.replace(/[^0-9.]/g, ''));
                if (isNaN(num) || num === 0) return;

                const prefix = original.replace(/[0-9.,]/g, '').trim();
                const duration = 900;
                const start = performance.now();

                function tick(now) {
                    const t = Math.min((now - start) / duration, 1);
                    const eased = 1 - Math.pow(1 - t, 3);
                    const current = Math.floor(num * eased);

                    el.textContent = prefix + current.toLocaleString('en-PK');

                    if (t < 1) requestAnimationFrame(tick);
                    else el.textContent = original;
                }

                requestAnimationFrame(tick);
                counterObs.unobserve(el);
            });
        }, { threshold: 0.3 });

        counters.forEach(function (el) { counterObs.observe(el); });
    }

    /* ============================================================
       11. DISABLE DOUBLE-CLICK ON CTAs
       ============================================================ */
    document.querySelectorAll('.btn-primary, .btn-outline, .btn-white, .btn-outline-white')
        .forEach(function (btn) {
            btn.addEventListener('click', function () {
                if (this.dataset.busy) return;
                this.dataset.busy = '1';
                setTimeout(() => { delete this.dataset.busy; }, 900);
            });
        });

    /* ============================================================
       12. READY LOG
       ============================================================ */
    console.log('%cPyrox Biz landing ready ✓', 'color:#29B6F6;font-weight:700;font-size:13px');

})();