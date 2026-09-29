import { auth, db } from "../js/firebase.js";

import {
  doc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";


document.addEventListener("DOMContentLoaded", () => {

  // ==============================
  // DOM REFERENCES
  // ==============================

  const form = document.getElementById("signupForm");

  const fullName = document.getElementById("fullName");
  const email = document.getElementById("email");
  const password = document.getElementById("password");
  const confirmPass = document.getElementById("confirmPassword");

  const nameError = document.getElementById("nameError");
  const emailError = document.getElementById("emailError");
  const passwordError = document.getElementById("passwordError");
  const confirmError = document.getElementById("confirmError");
  const termsError = document.getElementById("termsError");

  const termsCheck = document.getElementById("termsCheck");

  const togglePass = document.getElementById("togglePassword");
  const toggleConfirm = document.getElementById("toggleConfirm");

  // New elements for premium features
  const strengthFill = document.getElementById("strengthFill");
  const strengthText = document.getElementById("strengthText");
  const strengthMeter = document.getElementById("strengthMeter");

  const signupBtn = document.getElementById("signupBtn");
  const googleBtn = document.getElementById("googleSignupBtn");
  const githubBtn = document.getElementById("githubSignupBtn");

  const toastContainer = document.getElementById("toastContainer");

  // ==============================
  // PASSWORD STRENGTH METER (Enhanced)
  // ==============================

  password.addEventListener("input", function() {
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

  const toggleVisibility = (inputEl, btn) => {
    const type = inputEl.getAttribute("type") === "password" ? "text" : "password";
    inputEl.setAttribute("type", type);
    
    // Update icon
    const icon = btn.querySelector('i');
    if (icon) {
      icon.className = type === "password" ? 'fas fa-eye' : 'fas fa-eye-slash';
    }
    
    btn.setAttribute(
      "aria-label",
      type === "password" ? "Show password" : "Hide password"
    );
  };

  togglePass.addEventListener("click", () => toggleVisibility(password, togglePass));
  toggleConfirm.addEventListener("click", () => toggleVisibility(confirmPass, toggleConfirm));

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
  // VALIDATION HELPERS (Enhanced)
  // ==============================

  const setError = (el, msg) => {
    el.textContent = msg;
    el.classList.remove("success");
    el.classList.add("visible");
    
    // Add error class to parent input group
    const group = el.closest('.input-group');
    if (group) {
      group.classList.add('error');
      group.classList.remove('valid');
    }
  };

  const setSuccess = (el, msg = "✓") => {
    el.textContent = msg;
    el.classList.add("success");
    el.classList.add("visible");
    
    // Add success class to parent input group
    const group = el.closest('.input-group');
    if (group) {
      group.classList.remove('error');
      group.classList.add('valid');
    }
  };

  const clearValidation = (el) => {
    el.textContent = "";
    el.classList.remove("visible", "success");
    
    const group = el.closest('.input-group');
    if (group) {
      group.classList.remove('error', 'valid');
    }
  };

  const clearAllErrors = () => {
    [
      nameError,
      emailError,
      passwordError,
      confirmError,
      termsError
    ].forEach((el) => {
      el.textContent = "";
      el.classList.remove("visible", "success");
      
      const group = el.closest('.input-group');
      if (group) {
        group.classList.remove('error', 'valid');
      }
    });
  };

  const validateEmail = (val) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim());
  };

  // ==============================
  // FORM VALIDATION (Enhanced)
  // ==============================

  const validateForm = () => {
    clearAllErrors();

    let valid = true;

    const name = fullName.value.trim();
    const emailVal = email.value.trim();
    const pass = password.value;
    const confirm = confirmPass.value;
    const terms = termsCheck.checked;

    if (!name) {
      setError(nameError, "Full name is required");
      valid = false;
    } else {
      setSuccess(nameError);
    }

    if (!emailVal) {
      setError(emailError, "Email is required");
      valid = false;
    } else if (!validateEmail(emailVal)) {
      setError(emailError, "Please enter a valid email address");
      valid = false;
    } else {
      setSuccess(emailError);
    }

    if (!pass) {
      setError(passwordError, "Password is required");
      valid = false;
    } else if (pass.length < 6) {
      setError(passwordError, "Password must be at least 6 characters");
      valid = false;
    } else {
      setSuccess(passwordError);
    }

    if (!confirm) {
      setError(confirmError, "Please confirm your password");
      valid = false;
    } else if (pass !== confirm) {
      setError(confirmError, "Passwords do not match");
      valid = false;
    } else if (pass && confirm) {
      setSuccess(confirmError);
    }

    if (!terms) {
      setError(termsError, "You must accept the Terms and Conditions");
      valid = false;
    } else {
      setSuccess(termsError);
    }

    return valid;
  };

  // ==============================
  // CREATE FIRESTORE USER PROFILE
  // ==============================

  const createUserProfile = async (user, name) => {
    await setDoc(
      doc(db, "users", user.uid),
      {
        uid: user.uid,
        name: name || user.displayName || "",
        email: user.email || "",
        businessName: "",
        createdAt: serverTimestamp()
      }
    );
    console.log("Firestore user profile created:", user.uid);
  };

  // ==============================
  // EMAIL / PASSWORD SIGNUP (Enhanced)
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

    const name = fullName.value.trim();
    const emailValue = email.value.trim();
    const passwordValue = password.value;
    const originalText = signupBtn.innerHTML;

    try {
      // Loading state
      signupBtn.classList.add('loading');
      signupBtn.disabled = true;

      // Create Authentication account
      const userCredential = await createUserWithEmailAndPassword(
        auth,
        emailValue,
        passwordValue
      );

      const user = userCredential.user;

      // Save user's name in Authentication
      await updateProfile(user, { displayName: name });

      // Create Firestore profile
      await createUserProfile(user, name);

      console.log("Account created successfully:", user);

      // Show success
      setSuccess(nameError);
      setSuccess(emailError);
      setSuccess(passwordError);
      setSuccess(confirmError);
      setSuccess(termsError);
      
      showToast('Account created successfully! Redirecting...', 'success', 'Welcome!');

      signupBtn.innerHTML = '<span class="btn-text"><i class="fas fa-check"></i> Account created!</span>';

      // Redirect to dashboard
      setTimeout(() => {
        window.location.href = "../dashboard/dashboard.html";
      }, 800);

    } catch (error) {
      console.error("Signup error:", error);

      // Reset button
      signupBtn.classList.remove('loading');
      signupBtn.disabled = false;
      signupBtn.innerHTML = originalText;

      // Clear success states
      clearValidation(emailError);
      clearValidation(passwordError);
      clearValidation(confirmError);

      // Show error
      let errorMessage = '';
      let errorField = emailError;

      switch (error.code) {
        case "auth/email-already-in-use":
          errorMessage = "An account already exists with this email.";
          errorField = emailError;
          showToast('An account already exists with this email', 'error', 'Account Exists');
          break;
        case "auth/invalid-email":
          errorMessage = "Please enter a valid email address.";
          errorField = emailError;
          showToast('Invalid email address', 'error', 'Invalid Email');
          break;
        case "auth/weak-password":
          errorMessage = "Password is too weak. Please use a stronger password.";
          errorField = passwordError;
          showToast('Password is too weak', 'warning', 'Weak Password');
          break;
        case "permission-denied":
          errorMessage = "Firestore permission denied. Check your Firestore rules.";
          errorField = emailError;
          showToast('Permission denied. Please contact support.', 'error', 'Permission Error');
          break;
        case "auth/operation-not-allowed":
          errorMessage = "Email/password authentication is not enabled in Firebase.";
          errorField = emailError;
          showToast('Authentication not enabled', 'error', 'Configuration Error');
          break;
        default:
          errorMessage = "Unable to create account. Please try again.";
          errorField = emailError;
          showToast('Unable to create account. Please try again.', 'error', 'Signup Failed');
      }

      setError(errorField, errorMessage);
    }
  });

  // ==============================
  // GOOGLE SIGNUP (Enhanced)
  // ==============================

  googleBtn.addEventListener("click", async () => {
    console.log("Google Signup button clicked.");

    const provider = new GoogleAuthProvider();
    const originalText = googleBtn.innerHTML;

    try {
      googleBtn.classList.add('loading');
      googleBtn.disabled = true;
      googleBtn.innerHTML = '<span class="btn-text">Signing in with Google...</span>';

      console.log("Starting Google signup popup...");
      const result = await signInWithPopup(auth, provider);

      const user = result.user;
      console.log("Google authentication successful:", user);

      // Check whether the user already has a profile
      // and create/update the Firestore profile.
      await createUserProfile(user, user.displayName || "");

      console.log("Google Firestore profile created/updated.");
      
      showToast('Signed up with Google! Redirecting...', 'success', 'Welcome!');

      setTimeout(() => {
        window.location.href = "../dashboard/dashboard.html";
      }, 700);

    } catch (error) {
      console.error("GOOGLE SIGNUP FIREBASE ERROR CODE:", error.code);
      console.error("GOOGLE SIGNUP FIREBASE ERROR MESSAGE:", error.message);
      console.error("FULL GOOGLE SIGNUP ERROR:", error);

      googleBtn.classList.remove('loading');
      googleBtn.disabled = false;
      googleBtn.innerHTML = originalText;

      if (error.code === "auth/popup-closed-by-user") {
        showToast('Sign-up cancelled', 'info', 'Cancelled');
        return;
      }

      if (error.code === "auth/popup-blocked") {
        showToast('Popup was blocked. Please allow popups for this site.', 'warning', 'Popup Blocked');
        return;
      }

      if (error.code === "auth/unauthorized-domain") {
        setError(emailError, "This domain is not authorized in Firebase.");
        showToast('Domain not authorized', 'error', 'Configuration Error');
        return;
      }

      if (error.code === "permission-denied") {
        setError(emailError, "Firestore permission denied. Check your Firestore rules.");
        showToast('Permission denied', 'error', 'Error');
        return;
      }

      setError(emailError, "Google sign-up failed. Please try again.");
      showToast('Google sign-up failed. Please try again.', 'error', 'Google Error');
    }
  });

  // ==============================
  // GITHUB SIGNUP (New Feature)
  // ==============================

  if (githubBtn) {
    githubBtn.addEventListener("click", async () => {
      // Note: You'll need to set up GitHub OAuth in Firebase
      // This is a placeholder - you can implement it similarly to Google
      showToast('GitHub sign-up coming soon!', 'info', 'Coming Soon');
      
      // Example implementation (you would need to configure GitHub provider):
      /*
      const provider = new GithubAuthProvider();
      const originalText = githubBtn.innerHTML;
      
      try {
        githubBtn.classList.add('loading');
        githubBtn.disabled = true;
        githubBtn.innerHTML = '<span class="btn-text">Signing in with GitHub...</span>';
        
        const result = await signInWithPopup(auth, provider);
        const user = result.user;
        await createUserProfile(user, user.displayName || "");
        
        showToast('Signed up with GitHub! Redirecting...', 'success', 'Welcome!');
        setTimeout(() => {
          window.location.href = "../dashboard/dashboard.html";
        }, 700);
      } catch (error) {
        githubBtn.classList.remove('loading');
        githubBtn.disabled = false;
        githubBtn.innerHTML = originalText;
        showToast('GitHub sign-up failed', 'error', 'Error');
        console.error("GitHub error:", error);
      }
      */
    });
  }

  // ==============================
  // REAL-TIME VALIDATION (Enhanced)
  // ==============================

  fullName.addEventListener("blur", () => {
    const val = fullName.value.trim();
    if (val) {
      setSuccess(nameError);
    } else {
      clearValidation(nameError);
    }
  });

  fullName.addEventListener("input", () => {
    const val = fullName.value.trim();
    if (val) {
      setSuccess(nameError);
    } else {
      clearValidation(nameError);
    }
  });

  email.addEventListener("blur", () => {
    const val = email.value.trim();
    if (val && validateEmail(val)) {
      setSuccess(emailError);
    } else if (val && !validateEmail(val)) {
      setError(emailError, "Enter a valid email");
    } else {
      clearValidation(emailError);
    }
  });

  email.addEventListener("input", () => {
    const val = email.value.trim();
    if (val && validateEmail(val)) {
      setSuccess(emailError);
    } else if (val) {
      setError(emailError, "Enter a valid email");
    } else {
      clearValidation(emailError);
    }
  });

  password.addEventListener("blur", () => {
    const val = password.value;
    if (val && val.length >= 6) {
      setSuccess(passwordError);
    } else if (val && val.length < 6) {
      setError(passwordError, "Minimum 6 characters");
    } else {
      clearValidation(passwordError);
    }
  });

  password.addEventListener("input", () => {
    const val = password.value;
    if (val && val.length >= 6) {
      setSuccess(passwordError);
    } else if (val) {
      setError(passwordError, "Minimum 6 characters");
    } else {
      clearValidation(passwordError);
    }
  });

  confirmPass.addEventListener("blur", () => {
    const pass = password.value;
    const confirm = confirmPass.value;
    if (confirm && pass === confirm) {
      setSuccess(confirmError);
    } else if (confirm && pass !== confirm) {
      setError(confirmError, "Passwords do not match");
    } else {
      clearValidation(confirmError);
    }
  });

  confirmPass.addEventListener("input", () => {
    const pass = password.value;
    const confirm = confirmPass.value;
    if (confirm && pass === confirm) {
      setSuccess(confirmError);
    } else if (confirm) {
      setError(confirmError, "Passwords do not match");
    } else {
      clearValidation(confirmError);
    }
  });

  // ==============================
  // CLEAR ERRORS ON FOCUS
  // ==============================

  [fullName, email, password, confirmPass].forEach((el) => {
    el.addEventListener("focus", () => {
      const errorElement = 
        el.id === "fullName" ? nameError :
        el.id === "email" ? emailError :
        el.id === "password" ? passwordError :
        confirmError;
      
      clearValidation(errorElement);
    });
  });

  // ==============================
  // TERMS CHECKBOX
  // ==============================

  termsCheck.addEventListener("change", () => {
    if (termsCheck.checked) {
      setSuccess(termsError);
    } else {
      clearValidation(termsError);
    }
  });

  // ==============================
  // KEYBOARD SHORTCUTS
  // ==============================

  document.addEventListener("keydown", (event) => {
    // Ctrl+Enter to submit
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      form.dispatchEvent(new Event('submit'));
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

  console.log('🍃 MoeezFlow - Premium Signup Experience Loaded');
});