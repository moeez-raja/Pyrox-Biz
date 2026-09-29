import { auth } from "../js/firebase.js";
import {
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

document.addEventListener("DOMContentLoaded", () => {

  // DOM elements
  const form = document.getElementById("loginForm");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const emailError = document.getElementById("emailError");
  const passwordError = document.getElementById("passwordError");
  const toggleBtn = document.getElementById("togglePassword");
  const rememberMe = document.getElementById("rememberMe");
  const signInBtn = document.getElementById("signInBtn");
  const googleBtn = document.getElementById("googleLoginBtn");
  const githubBtn = document.getElementById("githubLoginBtn");

  const forgotBtn = document.getElementById("forgotPasswordBtn");
  const forgotModal = document.getElementById("forgotModal");
  const closeModal = document.getElementById("closeForgotModal");
  const resetEmail = document.getElementById("resetEmail");
  const resetError = document.getElementById("resetEmailError");
  const sendResetBtn = document.getElementById("sendResetBtn");
  const resetToast = document.getElementById("resetToast");

  // New elements for premium features
  const strengthFill = document.getElementById("strengthFill");
  const strengthText = document.getElementById("strengthText");
  const strengthMeter = document.getElementById("strengthMeter");
  const toastContainer = document.getElementById("toastContainer");

  // ==============================
  // PASSWORD STRENGTH METER
  // ==============================

  passwordInput.addEventListener("input", function() {
    const strength = checkPasswordStrength(this.value);
    
    if (strengthFill) {
      strengthFill.className = 'strength-fill ' + strength.label;
    }
    
    if (strengthText) {
      strengthText.textContent = strength.label.charAt(0).toUpperCase() + strength.label.slice(1);
      strengthText.style.color = strength.color;
    }
    
    if (strengthMeter) {
      if (this.value.length > 0) {
        strengthMeter.classList.add('visible');
      } else {
        strengthMeter.classList.remove('visible');
        if (strengthText) {
          strengthText.textContent = 'Enter password';
          strengthText.style.color = 'var(--text-secondary)';
        }
      }
    }
  });

  function checkPasswordStrength(password) {
    let score = 0;
    if (password.length >= 8) score++;
    if (password.match(/[a-z]/)) score++;
    if (password.match(/[A-Z]/)) score++;
    if (password.match(/[0-9]/)) score++;
    if (password.match(/[^a-zA-Z0-9]/)) score++;
    
    const levels = [
      { label: 'weak', color: '#ef4444' },
      { label: 'weak', color: '#ef4444' },
      { label: 'medium', color: '#f59e0b' },
      { label: 'strong', color: '#22c55e' },
      { label: 'strong', color: '#22c55e' },
      { label: 'excellent', color: '#166534' }
    ];
    return levels[Math.min(score, 5)];
  }

  // ==============================
  // PASSWORD VISIBILITY (Enhanced)
  // ==============================

  toggleBtn.addEventListener("click", () => {
    const type = passwordInput.getAttribute("type") === "password" ? "text" : "password";
    passwordInput.setAttribute("type", type);
    
    // Update icon
    const icon = toggleBtn.querySelector('i');
    if (icon) {
      icon.className = type === "password" ? 'fas fa-eye' : 'fas fa-eye-slash';
    }
    
    toggleBtn.setAttribute(
      "aria-label",
      type === "password" ? "Show password" : "Hide password"
    );
  });

  // ==============================
  // VALIDATION (Enhanced)
  // ==============================

  const setError = (element, message) => {
    element.textContent = message;
    element.classList.remove("success");
    element.classList.add("visible");
    
    // Add error class to parent input group
    const group = element.closest('.input-group');
    if (group) {
      group.classList.add('error');
      group.classList.remove('valid');
    }
  };

  const setSuccess = (element, message = "✓") => {
    element.textContent = message;
    element.classList.add("success");
    element.classList.add("visible");
    
    // Add success class to parent input group
    const group = element.closest('.input-group');
    if (group) {
      group.classList.remove('error');
      group.classList.add('valid');
    }
  };

  const clearValidation = (element) => {
    if (element) {
      element.textContent = "";
      element.classList.remove("visible", "success");
      
      const group = element.closest('.input-group');
      if (group) {
        group.classList.remove('error', 'valid');
      }
    }
  };

  const validateEmail = (email) => {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email.trim());
  };

  const validateForm = () => {
    let valid = true;
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    // Clear previous validation
    clearValidation(emailError);
    clearValidation(passwordError);

    if (!email) {
      setError(emailError, "Email is required");
      valid = false;
    } else if (!validateEmail(email)) {
      setError(emailError, "Please enter a valid email address");
      valid = false;
    } else {
      setSuccess(emailError);
    }

    if (!password) {
      setError(passwordError, "Password is required");
      valid = false;
    } else if (password.length < 6) {
      setError(passwordError, "Password must be at least 6 characters");
      valid = false;
    } else {
      setSuccess(passwordError);
    }

    return valid;
  };

  // ==============================
  // TOAST NOTIFICATION SYSTEM
  // ==============================

  function showToast(message, type = 'success', title = '') {
    const icons = {
      success: 'fa-check-circle',
      error: 'fa-exclamation-circle',
      warning: 'fa-exclamation-triangle',
      info: 'fa-info-circle'
    };
    
    const titles = {
      success: 'Success',
      error: 'Error',
      warning: 'Warning',
      info: 'Information'
    };
    
    const colors = {
      success: '#22C55E',
      error: '#ef4444',
      warning: '#f59e0b',
      info: '#3b82f6'
    };
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <i class="fas ${icons[type] || icons.info}" style="color: ${colors[type] || colors.info}"></i>
      <div class="toast-content">
        <div class="toast-title">${title || titles[type] || 'Notification'}</div>
        <div class="toast-message-text">${message}</div>
      </div>
      <button class="toast-close" aria-label="Close notification">&times;</button>
    `;
    
    if (toastContainer) {
      toastContainer.appendChild(toast);
    } else {
      // Fallback if toast container doesn't exist
      console.log('Toast:', message);
      return;
    }
    
    // Auto remove after 5 seconds
    const timeout = setTimeout(() => {
      removeToast(toast);
    }, 5000);
    
    // Close button
    toast.querySelector('.toast-close').addEventListener('click', () => {
      clearTimeout(timeout);
      removeToast(toast);
    });
    
    // Hover pause
    toast.addEventListener('mouseenter', () => clearTimeout(timeout));
    toast.addEventListener('mouseleave', () => {
      setTimeout(() => removeToast(toast), 3000);
    });
  }
  
  function removeToast(toast) {
    toast.classList.add('hiding');
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }

  // ==============================
  // EMAIL / PASSWORD LOGIN (Enhanced)
  // ==============================

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!validateForm()) {
      // Shake animation for invalid form
      form.querySelector('.auth-card')?.classList.add('shake');
      setTimeout(() => {
        form.querySelector('.auth-card')?.classList.remove('shake');
      }, 400);
      showToast('Please fix the errors above', 'error');
      return;
    }

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const originalText = signInBtn.innerHTML;

    try {
      // Loading state
      signInBtn.classList.add('loading');
      signInBtn.disabled = true;

      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      
      console.log("Logged in user:", userCredential.user);
      
      // Show success
      setSuccess(emailError);
      setSuccess(passwordError);
      showToast('Welcome back! Redirecting...', 'success', 'Login Successful');
      
      // Remember me
      if (rememberMe && rememberMe.checked) {
        localStorage.setItem('moeezflow_email', email);
      } else {
        localStorage.removeItem('moeezflow_email');
      }

      signInBtn.innerHTML = '<span class="btn-text"><i class="fas fa-check"></i> Signed in!</span>';

      setTimeout(() => {
        window.location.href = "../dashboard/dashboard.html";
      }, 700);

    } catch (error) {
      console.error("Login error:", error);
      
      // Reset button
      signInBtn.classList.remove('loading');
      signInBtn.disabled = false;
      signInBtn.innerHTML = originalText;
      
      // Clear success states
      clearValidation(emailError);
      clearValidation(passwordError);
      
      // Show error
      let errorMessage = '';
      let errorField = passwordError;

      switch (error.code) {
        case "auth/invalid-credential":
          errorMessage = "Incorrect email or password.";
          errorField = passwordError;
          break;
        case "auth/user-not-found":
          errorMessage = "No account found with this email.";
          errorField = emailError;
          break;
        case "auth/wrong-password":
          errorMessage = "Incorrect password.";
          errorField = passwordError;
          break;
        case "auth/too-many-requests":
          errorMessage = "Too many attempts. Please try again later.";
          errorField = passwordError;
          break;
        case "auth/invalid-email":
          errorMessage = "Invalid email format.";
          errorField = emailError;
          break;
        default:
          errorMessage = "Unable to sign in. Please try again.";
          errorField = passwordError;
      }
      
      setError(errorField, errorMessage);
      showToast(errorMessage, 'error', 'Login Failed');
    }
  });

  // ==============================
  // GOOGLE SIGN-IN (Enhanced)
  // ==============================

  googleBtn.addEventListener("click", async () => {
    console.log("Google Sign-In button clicked.");
    
    const provider = new GoogleAuthProvider();
    const originalText = googleBtn.innerHTML;

    try {
      googleBtn.classList.add('loading');
      googleBtn.disabled = true;
      googleBtn.innerHTML = '<span class="btn-text">Signing in with Google...</span>';

      console.log("Starting Google popup...");
      const result = await signInWithPopup(auth, provider);
      
      console.log("Google authentication successful.");
      console.log("Google user:", result.user);
      
      showToast('Signed in with Google! Redirecting...', 'success', 'Welcome!');
      
      setTimeout(() => {
        window.location.href = "../dashboard/dashboard.html";
      }, 700);

    } catch (error) {
      console.error("GOOGLE FIREBASE ERROR CODE:", error.code);
      console.error("GOOGLE FIREBASE ERROR MESSAGE:", error.message);
      console.error("FULL GOOGLE FIREBASE ERROR:", error);
      
      googleBtn.classList.remove('loading');
      googleBtn.disabled = false;
      googleBtn.innerHTML = originalText;
      
      if (error.code === "auth/popup-closed-by-user") {
        showToast('Sign-in cancelled', 'info', 'Cancelled');
        return;
      }
      
      if (error.code === "auth/popup-blocked") {
        showToast('Popup was blocked. Please allow popups for this site.', 'warning', 'Popup Blocked');
        return;
      }
      
      setError(emailError, "Google sign-in failed. Please try again.");
      showToast('Google sign-in failed. Please try again.', 'error', 'Google Error');
    }
  });

  // ==============================
  // GITHUB SIGN-IN (New Feature)
  // ==============================

  if (githubBtn) {
    githubBtn.addEventListener("click", async () => {
      // Note: You'll need to set up GitHub OAuth in Firebase
      // This is a placeholder - you can implement it similarly to Google
      showToast('GitHub sign-in coming soon!', 'info', 'Coming Soon');
      
      // Example implementation (you would need to configure GitHub provider):
      /*
      const provider = new GithubAuthProvider();
      const originalText = githubBtn.innerHTML;
      
      try {
        githubBtn.classList.add('loading');
        githubBtn.disabled = true;
        githubBtn.innerHTML = '<span class="btn-text">Signing in with GitHub...</span>';
        
        const result = await signInWithPopup(auth, provider);
        console.log("GitHub user:", result.user);
        
        showToast('Signed in with GitHub!', 'success', 'Welcome!');
        setTimeout(() => {
          window.location.href = "../dashboard/dashboard.html";
        }, 700);
      } catch (error) {
        githubBtn.classList.remove('loading');
        githubBtn.disabled = false;
        githubBtn.innerHTML = originalText;
        showToast('GitHub sign-in failed', 'error', 'Error');
        console.error("GitHub error:", error);
      }
      */
    });
  }

  // ==============================
  // FORGOT PASSWORD MODAL (Enhanced)
  // ==============================

  const openModal = () => {
    forgotModal.classList.add("active");
    document.body.style.overflow = 'hidden';
    
    resetEmail.value = "";
    resetError.textContent = "";
    resetError.classList.remove('visible');
    resetToast.textContent = "";
    
    // Clear validation state
    const group = resetEmail.closest('.input-group');
    if (group) {
      group.classList.remove('error', 'valid');
    }
    
    setTimeout(() => resetEmail.focus(), 100);
  };

  const closeModalFn = () => {
    forgotModal.classList.remove("active");
    document.body.style.overflow = '';
    
    // Reset button state
    sendResetBtn.classList.remove('loading');
    sendResetBtn.disabled = false;
    sendResetBtn.innerHTML = '<span class="btn-text">Send Reset Link</span>';
  };

  forgotBtn.addEventListener("click", openModal);
  
  closeModal.addEventListener("click", closeModalFn);
  
  forgotModal.addEventListener("click", (event) => {
    if (event.target === forgotModal) {
      closeModalFn();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && forgotModal.classList.contains("active")) {
      closeModalFn();
    }
  });

  // Focus trap for modal
  forgotModal.addEventListener("keydown", (e) => {
    if (!forgotModal.classList.contains('active')) return;
    
    const focusable = forgotModal.querySelectorAll(
      'button, input, [href], [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    
    if (e.key === 'Tab') {
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // ==============================
  // PASSWORD RESET (Enhanced)
  // ==============================

  sendResetBtn.addEventListener("click", async () => {
    const email = resetEmail.value.trim();
    const originalText = sendResetBtn.innerHTML;

    // Clear previous errors
    resetError.textContent = "";
    resetError.classList.remove('visible');
    const group = resetEmail.closest('.input-group');
    if (group) {
      group.classList.remove('error', 'valid');
    }

    if (!email) {
      resetError.textContent = "Email is required";
      resetError.classList.add('visible');
      if (group) group.classList.add('error');
      showToast('Please enter your email address', 'warning', 'Email Required');
      return;
    }

    if (!validateEmail(email)) {
      resetError.textContent = "Please enter a valid email address";
      resetError.classList.add('visible');
      if (group) group.classList.add('error');
      showToast('Please enter a valid email address', 'warning', 'Invalid Email');
      return;
    }

    try {
      sendResetBtn.classList.add('loading');
      sendResetBtn.disabled = true;

      await sendPasswordResetEmail(auth, email);
      
      resetError.textContent = "";
      resetError.classList.remove('visible');
      if (group) group.classList.add('valid');
      
      resetToast.textContent = "✅ Password reset email sent! Check your inbox.";
      resetToast.style.color = 'var(--dark-green)';
      
      showToast('Password reset link sent to your email!', 'success', 'Email Sent');

      setTimeout(() => {
        sendResetBtn.classList.remove('loading');
        sendResetBtn.disabled = false;
        sendResetBtn.innerHTML = originalText;
        closeModalFn();
      }, 2500);

    } catch (error) {
      console.error("Password reset error:", error);
      
      sendResetBtn.classList.remove('loading');
      sendResetBtn.disabled = false;
      sendResetBtn.innerHTML = originalText;

      if (error.code === "auth/user-not-found") {
        resetError.textContent = "No account found with this email.";
        resetError.classList.add('visible');
        if (group) group.classList.add('error');
        showToast('No account found with this email', 'error', 'Not Found');
      } else {
        resetError.textContent = "Unable to send reset email. Please try again.";
        resetError.classList.add('visible');
        if (group) group.classList.add('error');
        showToast('Unable to send reset email. Please try again.', 'error', 'Error');
      }
    }
  });

  // Enter key support for reset email
  resetEmail.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendResetBtn.click();
    }
  });

  // ==============================
  // REAL-TIME VALIDATION (Enhanced)
  // ==============================

  emailInput.addEventListener("blur", () => {
    const value = emailInput.value.trim();
    
    if (value && !validateEmail(value)) {
      setError(emailError, "Enter a valid email");
    } else if (value) {
      setSuccess(emailError);
    } else {
      clearValidation(emailError);
    }
  });

  emailInput.addEventListener("input", () => {
    const value = emailInput.value.trim();
    
    if (value && validateEmail(value)) {
      setSuccess(emailError);
    } else if (value) {
      setError(emailError, "Enter a valid email");
    } else {
      clearValidation(emailError);
    }
  });

  passwordInput.addEventListener("blur", () => {
    const value = passwordInput.value;
    
    if (value && value.length < 6) {
      setError(passwordError, "Minimum 6 characters");
    } else if (value) {
      setSuccess(passwordError);
    } else {
      clearValidation(passwordError);
    }
  });

  passwordInput.addEventListener("input", () => {
    const value = passwordInput.value;
    
    if (value && value.length < 6) {
      setError(passwordError, "Minimum 6 characters");
    } else if (value) {
      setSuccess(passwordError);
    } else {
      clearValidation(passwordError);
    }
  });

  // Clear errors on focus
  emailInput.addEventListener("focus", () => {
    clearValidation(emailError);
  });

  passwordInput.addEventListener("focus", () => {
    clearValidation(passwordError);
  });

  // ==============================
  // REMEMBER ME - LOAD SAVED EMAIL
  // ==============================

  const savedEmail = localStorage.getItem('moeezflow_email');
  if (savedEmail) {
    emailInput.value = savedEmail;
    if (rememberMe) rememberMe.checked = true;
    // Trigger validation
    if (validateEmail(savedEmail)) {
      setSuccess(emailError);
    }
  }

  // ==============================
  // KEYBOARD SHORTCUTS
  // ==============================

  document.addEventListener("keydown", (event) => {
    // Ctrl+Enter to submit
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      if (!forgotModal.classList.contains('active')) {
        event.preventDefault();
        form.dispatchEvent(new Event('submit'));
      }
    }
  });

  // ==============================
  // AUTOFILL DETECTION
  // ==============================

  emailInput.addEventListener("animationstart", (e) => {
    if (e.animationName === "onAutoFillStart") {
      const group = emailInput.closest('.input-group');
      if (group) group.classList.add('valid');
      if (validateEmail(emailInput.value)) {
        setSuccess(emailError);
      }
    }
  });

  // ==============================
  // PREVENT DOUBLE SUBMISSION
  // ==============================

  let isSubmitting = false;
  form.addEventListener("submit", (e) => {
    if (isSubmitting) {
      e.preventDefault();
      return;
    }
    isSubmitting = true;
    setTimeout(() => {
      isSubmitting = false;
    }, 3000);
  });

  // ==============================
  // INITIAL SETUP
  // ==============================

  // Set placeholder for floating labels
  document.querySelectorAll('.input-icon-wrapper input').forEach(input => {
    if (!input.value) {
      input.setAttribute('placeholder', ' ');
    }
  });

  console.log('🍃 MoeezFlow - Premium Login Experience Loaded');
});