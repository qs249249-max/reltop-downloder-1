/* =====================================================
   RELTOP DOWNLOADER — Live Polling Progress Script
   ===================================================== */

document.addEventListener('DOMContentLoaded', () => {

  /* -----------------------------------------------------
     1. SPLASH SCREEN
  ----------------------------------------------------- */
  const splash = document.getElementById('splash');
  if (splash) {
    window.setTimeout(() => {
      splash.classList.add('is-hidden');
      splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    }, 2500);
  }

  /* -----------------------------------------------------
     2. THEME TOGGLE
  ----------------------------------------------------- */
  const root = document.documentElement;
  const themeToggle = document.getElementById('themeToggle');
  const storedTheme = localStorage.getItem('reltop-theme');
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  
  applyTheme(storedTheme || (prefersLight ? 'light' : 'dark'));

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const nextTheme = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(nextTheme);
      localStorage.setItem('reltop-theme', nextTheme);
    });
  }

  function applyTheme(theme) {
    if (theme === 'light') {
      root.setAttribute('data-theme', 'light');
      if (themeToggle) themeToggle.setAttribute('aria-pressed', 'true');
    } else {
      root.removeAttribute('data-theme');
      if (themeToggle) themeToggle.setAttribute('aria-pressed', 'false');
    }
  }

  /* -----------------------------------------------------
     3. PASTE BUTTON & ERROR HANDLING
  ----------------------------------------------------- */
  const urlInput = document.getElementById('urlInput');
  const pasteBtn = document.getElementById('pasteBtn');
  const inputError = document.getElementById('inputError');

  if (pasteBtn) {
    pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          urlInput.value = text.trim();
          urlInput.focus();
          clearError();
        }
      } catch (err) {
        urlInput.focus();
      }
    });
  }

  if (urlInput) {
    urlInput.addEventListener('input', clearError);
    urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        downloadBtn.click();
      }
    });
  }

  function clearError() {
    if (inputError) {
      inputError.textContent = '';
      inputError.classList.remove('is-visible');
    }
    if (urlInput) urlInput.classList.remove('is-invalid');
  }

  function showError(message) {
    if (inputError) {
      inputError.textContent = message;
      inputError.classList.add('is-visible');
    }
    if (urlInput) urlInput.classList.add('is-invalid');
  }

  /* -----------------------------------------------------
     4. PWA — INSTALL PROMPT
  ----------------------------------------------------- */
  const installBtn = document.getElementById('installBtn');
  let deferredInstallPrompt = null;

  // Hide the install button by default; only show it once the browser tells
  // us the app is actually installable (Android/Desktop Chrome/Edge).
  if (installBtn) installBtn.hidden = true;

  window.addEventListener('beforeinstallprompt', (event) => {
    // Stop Chrome/Edge from auto-showing their mini-infobar so we can
    // trigger the prompt from our own button instead.
    event.preventDefault();
    deferredInstallPrompt = event;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      console.log('Install prompt outcome:', outcome);
      deferredInstallPrompt = null;
      installBtn.hidden = true;
    });
  }

  // Once installed (or if already installed / launched standalone e.g. on
  // iOS Safari's "Add to Home Screen", which has no beforeinstallprompt),
  // keep the button hidden.
  window.addEventListener('appinstalled', () => {
    if (installBtn) installBtn.hidden = true;
    deferredInstallPrompt = null;
  });

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true; // iOS Safari
  if (isStandalone && installBtn) installBtn.hidden = true;

  /* -----------------------------------------------------
     5. PWA — SERVICE WORKER REGISTRATION
  ----------------------------------------------------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  /* -----------------------------------------------------
     6. POLLING PROGRESS LOGIC
  ----------------------------------------------------- */
  const downloadBtn = document.getElementById('downloadBtn');
  const qualitySelect = document.getElementById('qualitySelect');
  const resultSection = document.getElementById('result');
  const resultTitle = document.getElementById('resultTitle');
  const resultThumbnail = document.getElementById('resultThumbnail');
  const resultBadge = document.getElementById('resultBadge');
  const resultDuration = document.getElementById('resultDuration');
  const resultProgressFill = document.getElementById('resultProgressFill');
  const resultProgressLabel = document.getElementById('resultProgressLabel');
  const resultProgressPct = document.getElementById('resultProgressPct');
  const saveBtn = document.getElementById('saveBtn');
  const saveBtnLabel = document.getElementById('saveBtnLabel');

  let pollInterval = null;

  if (downloadBtn) {
    downloadBtn.addEventListener('click', async () => {
      const url = urlInput ? urlInput.value.trim() : '';
      const quality = qualitySelect ? qualitySelect.value : '720p';

      if (!url) {
        showError('Pehle video ka link paste karein!');
        return;
      }

      clearError();

      if (pollInterval) clearInterval(pollInterval);

      downloadBtn.classList.add('is-loading');
      updateUIProgress(5, 'Fetching video info...');

      if (resultSection) {
        resultSection.hidden = false;
        resultSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (resultBadge) resultBadge.textContent = quality.toUpperCase();
      if (saveBtn) saveBtn.disabled = true;

      try {
        // 1. Download Task Start Karein
        const response = await fetch('/api/start-download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, quality })
        });

        const resData = await response.json();

        if (!response.ok || resData.error) {
          downloadBtn.classList.remove('is-loading');
          showError(resData.error || 'Server error occurred!');
          return;
        }

        const taskId = resData.task_id;

        // 2. Har 500ms (0.5 second) baad Progress check karein
        pollInterval = setInterval(async () => {
          try {
            const progRes = await fetch(`/api/progress/${taskId}`);
            const progData = await progRes.json();

            if (progData.error) {
              clearInterval(pollInterval);
              downloadBtn.classList.remove('is-loading');
              showError(progData.error);
              return;
            }

            // Live Update UI
            updateUIProgress(progData.percent, progData.status);

            // Agar Task mukammal ho gaya
            if (progData.complete) {
              clearInterval(pollInterval);
              downloadBtn.classList.remove('is-loading');

              if (progData.data) {
                showResultCard(progData.data, quality);
              } else {
                showError('Download error occurred.');
              }
            }
          } catch (err) {
            console.error('Polling error:', err);
          }
        }, 500);

      } catch (err) {
        downloadBtn.classList.remove('is-loading');
        showError('Server band hai! Terminal mein "python app.py" chalaayein.');
      }
    });
  }

  function updateUIProgress(pct, statusText) {
    const loadingElem = downloadBtn.querySelector('.download-btn__loading');
    if (loadingElem) {
      loadingElem.innerHTML = `<span class="spinner"></span> Fetching... ${pct}%`;
    }
    if (resultProgressFill) resultProgressFill.style.width = `${pct}%`;
    if (resultProgressPct) resultProgressPct.textContent = `${pct}%`;
    if (statusText && resultProgressLabel) {
      resultProgressLabel.textContent = statusText;
    }
  }

  function showResultCard(data, quality) {
    if (resultTitle) resultTitle.textContent = data.title;
    if (resultBadge) resultBadge.textContent = quality.toUpperCase();
    
    if (resultThumbnail) {
      if (data.thumbnail && data.thumbnail !== '') {
        resultThumbnail.src = data.thumbnail;
      } else {
        resultThumbnail.src = 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500&q=80';
      }
    }

    if (resultDuration && data.duration) {
      const mins = Math.floor(data.duration / 60);
      const secs = data.duration % 60;
      resultDuration.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    updateUIProgress(100, 'YOUR VIDEO IS READY TO DOWNLOAD!');

    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.classList.add('is-ready');
      if (saveBtnLabel) saveBtnLabel.textContent = 'Save to Device';

      saveBtn.onclick = () => {
        window.location.href = `/api/get-file/${encodeURIComponent(data.filename)}`;
      };
    }
  }

});