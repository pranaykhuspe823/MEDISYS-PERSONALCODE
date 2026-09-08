(function () {
  const CAPTCHA_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // excludes look-alikes (I,O,0,1)
  const captchaCodeEl = document.getElementById("captchaCode");
  const captchaInput = document.getElementById("captchaInput");
  const refreshBtn = document.getElementById("refreshCaptcha");
  const form = document.getElementById("loginForm");
  const formError = document.getElementById("formError");
  const togglePasswordBtn = document.getElementById("togglePassword");
  const passwordInput = document.getElementById("password");

  const forgotPasswordLink = document.getElementById("forgotPasswordLink");
  const backToLoginLink = document.getElementById("backToLoginLink");
  const forgotPasswordForm = document.getElementById("forgotPasswordForm");
  const resetError = document.getElementById("resetError");

  let currentCaptcha = "";

  function generateCaptcha(length = 6) {
    let code = "";
    for (let i = 0; i < length; i++) {
      code += CAPTCHA_CHARS.charAt(Math.floor(Math.random() * CAPTCHA_CHARS.length));
    }
    return code;
  }

  function renderCaptcha() {
    currentCaptcha = generateCaptcha();
    captchaCodeEl.textContent = currentCaptcha;
    captchaInput.value = "";
    formError.textContent = "";
  }

  refreshBtn.addEventListener("click", renderCaptcha);

  togglePasswordBtn.addEventListener("click", () => {
    const isHidden = passwordInput.type === "password";
    passwordInput.type = isHidden ? "text" : "password";
    togglePasswordBtn.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
  });


  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.style.color = "";
    formError.textContent = "";

    const userId = document.getElementById("userId").value.trim();
    const password = passwordInput.value;
    const enteredCaptcha = captchaInput.value.trim();

    if (!userId || !password) {
      formError.textContent = window.i18n ? window.i18n.t("login.error_empty") : "Please enter User ID and password.";
      return;
    }

    if (enteredCaptcha.toUpperCase() !== currentCaptcha.toUpperCase()) {
      formError.textContent = window.i18n ? window.i18n.t("login.error_captcha") : "Incorrect captcha. Please try again.";
      renderCaptcha();
      return;
    }

    const submitBtn = form.querySelector(".lp-submit-btn");
    submitBtn.disabled = true;

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, password }),
        credentials: "same-origin",
      });
      const data = await response.json();

      if (data.success) {
        if (data.user.role === "superadmin") {
          window.location.href = "/admin/dashboard";
          return;
        }
        if (data.user.role === "hospital_admin") {
          window.location.href = "/hospital/dashboard";
          return;
        }
        if (data.user.role === "patient") {
          window.location.href = "/patient/dashboard";
          return;
        }
        window.location.href = "/staff/dashboard";
        return;
      } else {
        formError.textContent = data.message || (window.i18n ? window.i18n.t("login.error_credentials") : "Invalid User ID or password.");
        renderCaptcha();
      }
    } catch (err) {
      formError.textContent = window.i18n ? window.i18n.t("login.error_network") : "Unable to reach the server. Please try again.";
    } finally {
      submitBtn.disabled = false;
    }
  });

  renderCaptcha();

  // ---------- Forgot password ----------

  function showForgotPassword() {
    form.hidden = true;
    forgotPasswordForm.hidden = false;
    resetError.textContent = "";
    forgotPasswordForm.reset();
  }

  function showLogin() {
    forgotPasswordForm.hidden = true;
    form.hidden = false;
    renderCaptcha();
  }

  forgotPasswordLink.addEventListener("click", (e) => {
    e.preventDefault();
    showForgotPassword();
  });

  backToLoginLink.addEventListener("click", (e) => {
    e.preventDefault();
    showLogin();
  });

  forgotPasswordForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    resetError.style.color = "";
    resetError.textContent = "";

    const userId = document.getElementById("resetUserId").value.trim();
    const newPassword = document.getElementById("newPassword").value;
    const confirmPassword = document.getElementById("confirmPassword").value;

    if (!userId || !newPassword || !confirmPassword) {
      resetError.textContent = window.i18n
        ? window.i18n.t("login.error_reset_empty")
        : "Please fill in all fields.";
      return;
    }

    if (newPassword.length < 6) {
      resetError.textContent = window.i18n
        ? window.i18n.t("login.error_password_length")
        : "Password must be at least 6 characters.";
      return;
    }

    if (newPassword !== confirmPassword) {
      resetError.textContent = window.i18n
        ? window.i18n.t("login.error_password_mismatch")
        : "Passwords do not match.";
      return;
    }

    const submitBtn = forgotPasswordForm.querySelector(".lp-submit-btn");
    submitBtn.disabled = true;

    try {
      const response = await fetch("/api/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, newPassword }),
        credentials: "same-origin",
      });
      const data = await response.json();

      if (data.success) {
        resetError.style.color = "green";
        resetError.textContent = window.i18n
          ? window.i18n.t("login.reset_success")
          : "Password updated. You can now log in with your new password.";
        setTimeout(showLogin, 1500);
      } else {
        resetError.textContent = data.message || (window.i18n ? window.i18n.t("login.error_reset_generic") : "Could not reset password.");
      }
    } catch (err) {
      resetError.textContent = window.i18n ? window.i18n.t("login.error_network") : "Unable to reach the server. Please try again.";
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
