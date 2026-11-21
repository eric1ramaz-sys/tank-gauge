/**
 * TankGauge App Controller
 * Connects UI, IndexedDB photo vault, guided camera/needle overlay, weather, charts, and advisor.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'tankgauge_state_v1';
  const THEME_KEY = 'tankgauge_theme_v1';
  const SHARE_URL = 'https://eric1ramaz-sys.github.io/tank-gauge/';

  const PhotoVault = {
    _dbPromise: null,
    _open() {
      if (this._dbPromise) return this._dbPromise;
      this._dbPromise = new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open('tankgauge_photos_v1', 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('photos')) {
            db.createObjectStore('photos');
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => resolve(null);
      });
      return this._dbPromise;
    },
    async put(id, dataUrl) {
      const db = await this._open();
      if (!db || !dataUrl) return;
      return new Promise((resolve) => {
        const tx = db.transaction('photos', 'readwrite');
        tx.objectStore('photos').put(dataUrl, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    },
    async get(id) {
      const db = await this._open();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction('photos', 'readonly');
        const req = tx.objectStore('photos').get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    },
    async remove(id) {
      const db = await this._open();
      if (!db) return;
      return new Promise((resolve) => {
        const tx = db.transaction('photos', 'readwrite');
        tx.objectStore('photos').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    },
    async clearAll() {
      const db = await this._open();
      if (!db) return;
      return new Promise((resolve) => {
        const tx = db.transaction('photos', 'readwrite');
        tx.objectStore('photos').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    },
  };

  function defaultState() {
    return {
      isDemo: false,
      settings: {
        mode: 'bulk',
        tankCapacityLitres: 2000,
        reorderAlertPct: 25,
        meterUnit: 'm3',
        locationQuery: '',
        locationLabel: '',
        lat: null,
        lon: null,
        calibration: { ...TankEngine.CONSTANTS.DIAL_PRESETS.rochester_5_95 },
      },
      readings: [],
      bills: [],
      profile: {
        homeType: 'park_home',
        heaterType: 'condensing_combi',
        controls: 'programmer_stat',
        flowTemp: 'high_70plus',
        insulation: 'average',
        region: 'scotland',
      },
      completedActions: {},
    };
  }

  let state = loadState();
  let demoWeatherCache = {};
  let chartOptions = {
    granularity: 'daily',
    metric: 'cost',
    showWeather: true,
  };
  let activeTab = 'dashboard';
  let pendingSnapCanvas = null;
  let helperComputedTankSize = null;
  let lastAnalytics = null;

  const $ = (id) => document.getElementById(id);

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();
      return {
        ...base,
        ...parsed,
        settings: {
          ...base.settings,
          ...(parsed.settings || {}),
          calibration: {
            ...base.settings.calibration,
            ...((parsed.settings && parsed.settings.calibration) || {}),
          },
        },
        profile: { ...base.profile, ...(parsed.profile || {}) },
        readings: Array.isArray(parsed.readings) ? parsed.readings : [],
        bills: Array.isArray(parsed.bills) ? parsed.bills : [],
        completedActions: parsed.completedActions || {},
      };
    } catch (_) {
      return defaultState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
      showToast('Storage full — consider exporting a JSON backup.');
    }
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 3200);
  }

  function applyTheme(theme) {
    const clean = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', clean);
    localStorage.setItem(THEME_KEY, clean);
    $('btnThemeToggle').textContent = clean === 'dark' ? '☀️' : '🌙';
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', clean === 'dark' ? '#080D19' : '#0F172A');
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function activeWeatherMap() {
    if (state.isDemo && Object.keys(demoWeatherCache).length) {
      return demoWeatherCache;
    }
    if (state.settings.lat !== null && state.settings.lon !== null) {
      return TankWeather.getCachedWeather(state.settings.lat, state.settings.lon);
    }
    return {};
  }

  // Camera & Overlay instances
  const cameraCtrl = new TankVision.CameraController($('cameraVideo'));
  const overlayCtrl = new TankVision.DialOverlayController(
    $('dialOverlayCanvas'),
    (pct) => {
      updateDetectedPctUi(pct);
    },
    (fitInfo) => {
      if (!fitInfo) return;
      $('fitZoomSlider').value = Number(fitInfo.zoom || 1).toFixed(1);
      $('fitZoomLbl').textContent = `${Number(fitInfo.zoom || 1).toFixed(1)}x`;
      $('fitRotSlider').value = Math.round(fitInfo.rotationDeg || 0);
      $('fitRotLbl').textContent = `${Math.round(fitInfo.rotationDeg || 0)}°`;
    }
  );

  function switchTab(tabName) {
    activeTab = tabName;
    if (tabName !== 'snap') {
      cameraCtrl.stop();
      resetCameraPlaceholder();
    }
    document.querySelectorAll('.tab-panel').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `tab-${tabName}`);
    });
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    renderAll();
  }

  function resetCameraPlaceholder() {
    $('cameraVideo').hidden = true;
    $('reticleOverlay').hidden = true;
    $('cameraControlsRow').hidden = true;
    $('btnCaptureFrame').hidden = true;
    $('cameraPlaceholder').hidden = false;
  }

  function updateDetectedPctUi(pct) {
    const clean = Number(pct).toFixed(1);
    $('detectedPctDisplay').textContent = `${clean}%`;
    const cap = Number(state.settings.tankCapacityLitres) || 2000;
    const litres = Math.round((Number(pct) / 100) * cap);
    $('bulkReadingLitresPreview').value = `${litres.toLocaleString('en-GB')} L (of ${cap.toLocaleString('en-GB')} L)`;

    // Check auto refill detection against most recent bulk reading
    const prev = getLatestBulkReading();
    const isRefill = prev ? TankEngine.detectAutoRefill(prev, { pct }, 'bulk') : false;
    $('refillDetectBanner').hidden = !isRefill;
    $('chkReadingIsRefill').checked = isRefill;
  }

  function getLatestBulkReading() {
    const list = (state.readings || [])
      .filter((r) => Number.isFinite(Number(r.pct)))
      .slice()
      .sort((a, b) => String(a.timestamp || a.date).localeCompare(String(b.timestamp || b.date)));
    return list.length ? list[list.length - 1] : null;
  }

  function setOverlayUiMode(mode) {
    const isFit = mode === 'fit';
    const isMap = mode === 'map';
    if (!isMap) overlayCtrl.setMode(isFit ? 'fit' : 'needle');
    $('btnModeFit').classList.toggle('active', isFit);
    $('btnModeNeedle').classList.toggle('active', !isFit && !isMap);
    $('fitControlsBox').hidden = !isFit;
    $('needleControlsBox').hidden = isFit || isMap;
    $('mapDialBanner').hidden = !isMap;
    $('confidenceBadge').hidden = isFit || isMap;
    if (isMap) {
      $('confirmCardTitle').textContent = 'Map Your Dial (4 Taps)';
      $('confirmStepHelper').textContent = 'Tap the needle centre pin first, then 20, 50, and 80.';
    } else if (isFit) {
      $('confirmCardTitle').textContent = 'Fit Dial in Yellow Ring';
      $('confirmStepHelper').innerHTML =
        'Slide &amp; zoom the photo until the dial fills the yellow ring, then tap <strong>Read Needle Now</strong>.';
    } else {
      $('confirmCardTitle').textContent = 'Confirm Needle Reading';
      $('confirmStepHelper').innerHTML =
        'Drag the orange tip to adjust reading, or drag the <strong>white centre dot</strong> onto the needle pin.';
    }
  }

  function updateConfidenceBadge(res) {
    const confPct = res ? Math.round(res.confidence * 100) : 0;
    const badge = $('confidenceBadge');
    badge.textContent = confPct >= 55 ? `Auto Match (${confPct}%)` : `Check Line (${confPct}%)`;
    badge.className = `status-pill ${confPct >= 55 ? 'badge-ok' : 'badge-warn'}`;
  }

  function beginDialConfirmation(canvas, opts) {
    const options = typeof opts === 'number' ? { presetOverridePct: opts } : opts || {};
    const startInFitMode = Boolean(options.startInFitMode);
    pendingSnapCanvas = canvas;
    $('confirmNeedleCard').hidden = false;
    $('bulkReadingDate').value = todayStr();
    $('bulkReadingNote').value = '';

    overlayCtrl.setRawImage(canvas, state.settings.calibration, { startInFitMode });
    if (startInFitMode) {
      setOverlayUiMode('fit');
    } else {
      setOverlayUiMode('needle');
      const res = overlayCtrl.runAutoDetect();
      updateConfidenceBadge(res);
      if (options.presetOverridePct !== undefined) {
        updateDetectedPctUi(overlayCtrl.percent);
      }
    }
    $('confirmNeedleCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderAll() {
    const weatherMap = activeWeatherMap();
    const analytics = TankEngine.computeAnalytics(state, weatherMap);
    lastAnalytics = analytics;
    const s = analytics.summary;

    $('demoRibbon').hidden = !state.isDemo;
    $('welcomeCard').hidden = state.readings.length > 0 || state.bills.length > 0;

    // Snap tab bulk vs meter mode
    const isMeter = state.settings.mode === 'meter';
    $('bulkCameraCard').hidden = isMeter;
    $('meterSnapCard').hidden = !isMeter;
    if (isMeter) {
      $('confirmNeedleCard').hidden = true;
      $('meterUnitBadge').textContent = state.settings.meterUnit;
      $('meterUnitLabel').textContent = state.settings.meterUnit;
    }

    // Dashboard Hero & KPIs
    TankCharts.renderHeroTankGauge($('heroGaugeContainer'), s, state.settings);
    $('kpiDailyCost').textContent = s.hasRealBurnRate ? `£${s.recentCostPerDay.toFixed(2)}` : '—';
    $('kpiLitresDay').textContent = s.hasRealBurnRate ? `${s.recentLitresPerDay.toFixed(1)} L/day` : 'Need 2+ logs';
    $('kpiMonthlyCost').textContent = s.hasRealBurnRate ? `£${Math.round(s.projectedMonthlyCost)}` : '—';
    $('kpiKwhDay').textContent = s.hasRealBurnRate ? `${s.recentKwhPerDay} kWh/day` : '— kWh/day';
    $('kpiCurrentPpl').textContent = s.hasBills ? `${s.latestPplIncVat.toFixed(1)}p` : '—';
    if (!s.hasBills) {
      $('kpiPplDelta').textContent = 'Add bill';
    } else if (s.pplDeltaPence !== 0) {
      const sign = s.pplDeltaPence > 0 ? '+' : '';
      $('kpiPplDelta').textContent = `${sign}${s.pplDeltaPence.toFixed(1)}p vs prev`;
    } else {
      $('kpiPplDelta').textContent = 'UK VAT inc.';
    }

    // Milestones from Advisor completed actions
    const advice = TankEngine.computeHeatingAdvice(state.profile, s, state.completedActions);
    const allTips = advice.tiers.quickWins
      .concat(advice.tiers.lowCost)
      .concat(advice.tiers.majorUpgrades);
    const milestones = allTips
      .filter((t) => t.done && t.completedAt)
      .map((t) => ({ date: t.completedAt, title: t.title }));

    if (activeTab === 'dashboard') {
      TankCharts.renderConsumptionChart(
        $('consumptionChartCanvas'),
        analytics.dailySeries,
        analytics.monthlySeries,
        {
          granularity: chartOptions.granularity,
          metric: chartOptions.metric,
          showWeather: chartOptions.showWeather,
          milestones,
        },
        $('chartTooltip')
      );
    }

    // Weather insight card
    $('weatherLocationLabel').textContent = state.settings.locationLabel || 'Location not set';
    if (analytics.weatherInsight) {
      $('weatherInsightText').textContent = analytics.weatherInsight.headline;
    } else if (state.settings.locationLabel) {
      $('weatherInsightText').textContent =
        'Weather synced. Log readings spanning 10+ days to unlock cold-weather efficiency alerts.';
    } else {
      $('weatherInsightText').textContent =
        'Add your UK postcode in Settings to plot local outside temperature (°C) alongside your gas use.';
    }

    // Watchdog card
    const wBadge = $('watchdogBadge');
    if (!s.hasBills) {
      wBadge.textContent = 'No Bills';
      wBadge.className = 'status-pill badge-muted';
      $('watchdogSummaryText').textContent =
        'Add your latest Calor bill in the Bills tab to check if you are overpaying per litre.';
    } else {
      const bandLabel =
        s.pplBand === 'competitive'
          ? 'Competitive Rate'
          : s.pplBand === 'typical'
            ? 'Typical UK Band'
            : 'High Price Alert';
      wBadge.textContent = bandLabel;
      wBadge.className = `status-pill ${
        s.pplBand === 'competitive'
          ? 'badge-ok'
          : s.pplBand === 'typical'
            ? 'badge-warn'
            : 'badge-danger'
      }`;
      const deltaMsg =
        s.pplDeltaPence > 0
          ? ` Your price crept up by +${s.pplDeltaPence.toFixed(1)}p/L since your previous delivery.`
          : s.pplDeltaPence < 0
            ? ` Good news — down ${Math.abs(s.pplDeltaPence).toFixed(1)}p/L from your previous delivery.`
            : '';
      $('watchdogSummaryText').textContent = `Latest rate: ${s.latestPplIncVat.toFixed(
        1
      )}p/L (inc. 5% VAT). UK domestic bulk LPG typically sits around 55–68p/L.${deltaMsg}`;
    }

    renderReadingHistory();
    renderBillsTab(analytics);
    renderAdvisorTab(advice);
  }

  function renderReadingHistory() {
    const listEl = $('readingHistoryList');
    const sorted = (state.readings || [])
      .slice()
      .sort((a, b) => String(b.timestamp || b.date).localeCompare(String(a.timestamp || a.date)));
    $('readingCountLabel').textContent = `${sorted.length} logged`;

    if (!sorted.length) {
      listEl.innerHTML = '<div class="muted">No readings yet. Tap Snap Dial below to take your first photo.</div>';
      return;
    }

    listEl.innerHTML = '';
    sorted.slice(0, 20).forEach((r) => {
      const item = document.createElement('div');
      item.className = 'list-item';

      const left = document.createElement('div');
      left.style.display = 'flex';
      left.style.alignItems = 'center';
      left.style.gap = '10px';

      if (r.hasPhoto) {
        const thumbBtn = document.createElement('button');
        thumbBtn.type = 'button';
        thumbBtn.className = 'thumb-btn';
        thumbBtn.title = 'View dial photo';
        const img = document.createElement('img');
        img.alt = 'Dial snap';
        PhotoVault.get(r.id).then((url) => {
          if (url) img.src = url;
        });
        thumbBtn.appendChild(img);
        thumbBtn.addEventListener('click', async () => {
          const url = await PhotoVault.get(r.id);
          if (!url) return showToast('Photo thumbnail not found on this device.');
          $('photoModalImg').src = url;
          $('photoModalTitle').textContent = `Dial Reading • ${r.date}`;
          $('photoModal').hidden = false;
        });
        left.appendChild(thumbBtn);
      }

      const info = document.createElement('div');
      const mainTxt =
        r.pct !== undefined && r.pct !== null
          ? `${Number(r.pct).toFixed(1)}%${r.isRefill ? ' 🚚 Refill' : ''}`
          : `${r.meterValue} ${r.meterUnit || state.settings.meterUnit}`;
      info.innerHTML = `<strong>${mainTxt}</strong><div class="muted">${r.date}${
        r.note ? ' • ' + escapeHtml(r.note) : ''
      }</div>`;
      left.appendChild(info);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-sm btn-secondary';
      delBtn.textContent = '🗑️';
      delBtn.title = 'Delete reading';
      delBtn.addEventListener('click', async () => {
        state.readings = state.readings.filter((x) => x.id !== r.id);
        await PhotoVault.remove(r.id);
        saveState();
        renderAll();
        showToast('Reading removed.');
      });

      item.appendChild(left);
      item.appendChild(delBtn);
      listEl.appendChild(item);
    });
  }

  function renderBillsTab(analytics) {
    if (activeTab === 'bills') {
      TankCharts.renderPriceTrendChart($('priceTrendCanvas'), analytics.bills);
    }
    const listEl = $('billHistoryList');
    const bills = analytics.bills.slice().reverse();
    $('billCountLabel').textContent = `${bills.length} bill${bills.length === 1 ? '' : 's'}`;
    if (!bills.length) {
      listEl.innerHTML = '<div class="muted">No bills saved yet.</div>';
      return;
    }

    listEl.innerHTML = '';
    bills.forEach((b) => {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `
        <div>
          <strong>${b.date} • ${escapeHtml(b.supplier)}</strong>
          <div class="muted">${b.litresEquivalent.toLocaleString('en-GB')} L eq • £${b.totalPaidIncVat.toFixed(
            2
          )} (${b.effectivePricePerLitreIncVat.toFixed(1)}p/L inc. VAT)</div>
        </div>
      `;
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-sm btn-secondary';
      delBtn.textContent = '🗑️';
      delBtn.addEventListener('click', () => {
        state.bills = state.bills.filter((x) => x.id !== b.id);
        saveState();
        renderAll();
        showToast('Bill removed.');
      });
      item.appendChild(delBtn);
      listEl.appendChild(item);
    });
  }

  function renderAdvisorTab(advice) {
    $('profHomeType').value = state.profile.homeType;
    $('profHeaterType').value = state.profile.heaterType;
    $('profControls').value = state.profile.controls;
    $('profFlowTemp').value = state.profile.flowTemp;
    $('profInsulation').value = state.profile.insulation;
    $('profRegion').value = state.profile.region;

    $('advImplementedVal').textContent = `£${advice.implementedAnnual}`;
    $('advRemainingVal').textContent = `£${advice.remainingAnnual}`;
    $('advBaselineVal').textContent = `£${advice.baseAnnualSpend}`;
    const badge = $('adviceBasisBadge');
    badge.textContent = advice.isEstimated ? 'UK Avg Estimate (<7d data)' : 'Based on Your Readings';
    badge.className = `status-pill ${advice.isEstimated ? 'badge-muted' : 'badge-ok'}`;

    renderTipList($('tipsQuickWins'), advice.tiers.quickWins);
    renderTipList($('tipsLowCost'), advice.tiers.lowCost);
    renderTipList($('tipsMajorUpgrades'), advice.tiers.majorUpgrades);

    const grantsEl = $('grantLinksBox');
    grantsEl.innerHTML = '';
    advice.grantLinks.forEach((g) => {
      const a = document.createElement('a');
      a.href = g.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'btn btn-secondary btn-sm';
      a.textContent = `🔗 ${g.label}`;
      grantsEl.appendChild(a);
    });
  }

  function renderTipList(container, tips) {
    container.innerHTML = '';
    if (!tips.length) {
      container.innerHTML = '<div class="muted">No further actions needed in this tier for your setup.</div>';
      return;
    }
    tips.forEach((t) => {
      const card = document.createElement('div');
      card.className = `tip-card${t.done ? ' done' : ''}`;
      const paybackTxt = t.paybackYears > 0 ? `Payback: ~${t.paybackYears} yrs` : 'Instant payback';
      card.innerHTML = `
        <div class="tip-head">
          <h3 class="tip-title">${escapeHtml(t.title)}</h3>
          <span class="tip-saving">Save ~£${t.savingAnnual}/yr</span>
        </div>
        <div class="tip-meta">
          <span>Cost: <strong>${escapeHtml(t.costLabel)}</strong></span>
          <span>• ${paybackTxt}</span>
        </div>
        <details class="tip-details">
          <summary>Why it works &amp; how to do it</summary>
          <p><strong>Why:</strong> ${escapeHtml(t.whyItWorks)}</p>
          <p><strong>How:</strong> ${escapeHtml(t.steps)}</p>
        </details>
      `;

      const lbl = document.createElement('label');
      lbl.className = 'checkbox-row';
      lbl.style.minHeight = '36px';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = t.done;
      chk.addEventListener('change', () => {
        if (chk.checked) {
          state.completedActions[t.id] = { completedAt: todayStr() };
          showToast(`Marked done! Saved ~£${t.savingAnnual}/yr pinned on Dashboard ★`);
        } else {
          delete state.completedActions[t.id];
        }
        saveState();
        renderAll();
      });
      const span = document.createElement('span');
      span.textContent = t.done
        ? `Done ✓ (${t.completedAt || 'Completed'})`
        : 'Mark as Done ✓ (adds ★ pin to usage graph)';
      lbl.appendChild(chk);
      lbl.appendChild(span);
      card.appendChild(lbl);

      container.appendChild(card);
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==================== EVENT WIRING ====================

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('btnThemeToggle').addEventListener('click', () => {
    const curr = document.documentElement.getAttribute('data-theme');
    applyTheme(curr === 'dark' ? 'light' : 'dark');
    renderAll();
  });

  // Modals open/close
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $(btn.dataset.closeModal).hidden = true;
    });
  });

  $('btnOpenShare').addEventListener('click', () => {
    $('shareModal').hidden = false;
  });

  $('btnCopyShareUrl').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(SHARE_URL);
      showToast('App link copied to clipboard!');
    } catch (_) {
      showToast(SHARE_URL);
    }
  });

  $('btnOpenSettings').addEventListener('click', () => {
    syncSettingsModalFromState();
    $('settingsModal').hidden = false;
  });

  // Demo Data buttons
  function loadDemoMode() {
    const demo = TankEngine.generateDemoDataset();
    demoWeatherCache = demo.demoWeather || {};
    state = {
      ...defaultState(),
      isDemo: true,
      settings: {
        ...defaultState().settings,
        ...demo.settings,
      },
      readings: demo.readings,
      bills: demo.bills,
      profile: demo.profile,
      completedActions: demo.completedActions,
    };
    saveState();
    renderAll();
    showToast('Loaded Aberdeenshire 55-day sample tank & weather!');
  }

  function clearDemoMode() {
    demoWeatherCache = {};
    state = defaultState();
    PhotoVault.clearAll();
    saveState();
    renderAll();
    showToast('Sample data cleared — ready for your own tank!');
  }

  $('btnTryDemo').addEventListener('click', loadDemoMode);
  $('btnClearDemoTop').addEventListener('click', clearDemoMode);
  $('btnStartFirstSnap').addEventListener('click', () => switchTab('snap'));

  // Chart toggles
  document.querySelectorAll('#granularityToggle .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      chartOptions.granularity = b.dataset.gran;
      document.querySelectorAll('#granularityToggle .seg-btn').forEach((x) =>
        x.classList.toggle('active', x === b)
      );
      renderAll();
    });
  });

  document.querySelectorAll('#metricToggle .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      chartOptions.metric = b.dataset.metric;
      document.querySelectorAll('#metricToggle .seg-btn').forEach((x) =>
        x.classList.toggle('active', x === b)
      );
      renderAll();
    });
  });

  $('btnToggleWeatherOverlay').addEventListener('click', () => {
    chartOptions.showWeather = !chartOptions.showWeather;
    $('btnToggleWeatherOverlay').textContent = chartOptions.showWeather ? '🌡️ °C On' : '🌡️ °C Off';
    renderAll();
  });

  $('btnRefreshWeather').addEventListener('click', async () => {
    if (state.settings.lat === null || state.settings.lon === null) {
      syncSettingsModalFromState();
      $('settingsModal').hidden = false;
      showToast('Enter your UK postcode in Settings first.');
      return;
    }
    showToast('Syncing local temperatures...');
    await TankWeather.fetchDailyTemperatures(state.settings.lat, state.settings.lon);
    renderAll();
    showToast('Weather temperatures updated.');
  });

  // Camera & Snap Dial
  $('btnStartCamera').addEventListener('click', async () => {
    try {
      const caps = await cameraCtrl.start();
      $('cameraPlaceholder').hidden = true;
      $('cameraVideo').hidden = false;
      $('reticleOverlay').hidden = false;
      $('btnCaptureFrame').hidden = false;

      $('cameraControlsRow').hidden = false;
      $('zoomControlWrap').hidden = false;
      const sl = $('cameraZoomSlider');
      sl.min = caps.zoomMin;
      sl.max = caps.zoomMax;
      sl.step = caps.zoomStep;
      const startZoom = caps.defaultZoom || 2.0;
      sl.value = startZoom;
      $('zoomValueLabel').textContent = `${Number(startZoom).toFixed(1)}x`;
      $('btnToggleTorch').hidden = !caps.hasTorch;
      $('btnToggleTorch').textContent = '🔦 Light Off';

      cameraCtrl.startTiltSensor((tiltDeg) => {
        const badge = $('tiltBadge');
        if (tiltDeg <= 8) {
          badge.textContent = 'Level ✓ Fits ring? Tap Capture';
          badge.classList.add('flat');
        } else {
          badge.textContent = `Hold steady (${tiltDeg}° tilt)`;
          badge.classList.remove('flat');
        }
      });
    } catch (err) {
      showToast(err.message || 'Camera access declined — use Pick Saved Photo instead.');
    }
  });

  $('cameraZoomSlider').addEventListener('input', (e) => {
    const val = Number(e.target.value);
    $('zoomValueLabel').textContent = `${val.toFixed(1)}x`;
    cameraCtrl.setZoom(val);
  });

  $('btnToggleTorch').addEventListener('click', async () => {
    const isOn = await cameraCtrl.toggleTorch();
    $('btnToggleTorch').textContent = isOn ? '🔦 Light ON' : '🔦 Light Off';
  });

  $('btnCaptureFrame').addEventListener('click', () => {
    const frame = cameraCtrl.captureFrame();
    if (!frame) return showToast('Camera is still warming up.');
    cameraCtrl.stop();
    resetCameraPlaceholder();
    beginDialConfirmation(frame);
  });

  $('dialPhotoUpload').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        cameraCtrl.stop();
        resetCameraPlaceholder();
        beginDialConfirmation(c, { startInFitMode: true });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  $('btnTestSampleDial').addEventListener('click', () => {
    const bar = $('samplePresetBar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) {
      const c = document.createElement('canvas');
      c.width = 440;
      c.height = 440;
      TankVision.renderSyntheticDial(c, 48, state.settings.calibration);
      beginDialConfirmation(c, 48);
    }
  });

  document.querySelectorAll('.sample-dial-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pct = Number(btn.dataset.pct);
      const c = document.createElement('canvas');
      c.width = 440;
      c.height = 440;
      TankVision.renderSyntheticDial(c, pct, state.settings.calibration);
      beginDialConfirmation(c, pct);
    });
  });

  $('btnModeFit').addEventListener('click', () => setOverlayUiMode('fit'));
  $('btnModeNeedle').addEventListener('click', () => setOverlayUiMode('needle'));

  $('fitZoomSlider').addEventListener('input', (e) => {
    const z = Number(e.target.value) || 1;
    $('fitZoomLbl').textContent = `${z.toFixed(1)}x`;
    overlayCtrl.setPhotoZoom(z);
  });

  $('fitRotSlider').addEventListener('input', (e) => {
    const deg = Number(e.target.value) || 0;
    $('fitRotLbl').textContent = `${deg}°`;
    overlayCtrl.setPhotoRotation(deg);
  });

  $('btnDetectFromFit').addEventListener('click', () => {
    setOverlayUiMode('needle');
    const res = overlayCtrl.runAutoDetect();
    updateConfidenceBadge(res);
    if (res) showToast(`Auto needle scan: ${res.percent.toFixed(1)}%`);
  });

  $('btnReScanNeedle').addEventListener('click', () => {
    const res = overlayCtrl.runAutoDetect();
    updateConfidenceBadge(res);
    if (res) showToast(`Re-scanned needle: ${res.percent.toFixed(1)}%`);
  });

  $('btnStartMapDial').addEventListener('click', () => {
    setOverlayUiMode('map');
    overlayCtrl.startDialMap((info) => {
      if (!info.done) {
        $('mapDialPrompt').textContent =
          info.targetLabel === 'PIN'
            ? 'Step 1 of 4: Tap the CENTRE PIN where the needle turns'
            : `Step ${info.stepIndex + 1} of 4: Tap the number ${info.targetLabel} on your dial`;
        return;
      }
      const res = info.result;
      if (!res || !res.ok) {
        setOverlayUiMode('needle');
        showToast((res && res.error) || 'Please tap 20, then 50, then 80 clockwise.');
        return;
      }
      state.settings.calibration = res.calibration;
      saveState();
      overlayCtrl.setCalibration(res.calibration);
      setOverlayUiMode('needle');
      const det = overlayCtrl.runAutoDetect();
      updateConfidenceBadge(det);
      showToast('✅ Dial centred, mapped & saved!');
    });
  });

  $('btnCancelMapDial').addEventListener('click', () => {
    overlayCtrl.cancelDialMap();
    setOverlayUiMode('needle');
  });

  $('btnNudgeDown').addEventListener('click', () => overlayCtrl.nudge(-0.5));
  $('btnNudgeUp').addEventListener('click', () => overlayCtrl.nudge(0.5));

  $('btnDiscardSnap').addEventListener('click', () => {
    pendingSnapCanvas = null;
    $('confirmNeedleCard').hidden = true;
  });

  $('btnSaveBulkReading').addEventListener('click', async () => {
    const id = 'r_' + Date.now();
    const dateVal = $('bulkReadingDate').value || todayStr();
    const isRefill = $('chkReadingIsRefill').checked;
    const pct = overlayCtrl.percent;
    let hasPhoto = false;

    const saveCanvas = overlayCtrl.getFittedCanvas() || pendingSnapCanvas;
    if (saveCanvas) {
      const thumbUrl = TankVision.compressPhotoBlob(saveCanvas, 480, 0.82);
      await PhotoVault.put(id, thumbUrl);
      hasPhoto = true;
    }

    state.readings.push({
      id,
      date: dateVal,
      timestamp: dateVal === todayStr() ? new Date().toISOString() : `${dateVal}T12:00:00Z`,
      pct,
      isRefill,
      hasPhoto,
      note: $('bulkReadingNote').value.trim(),
    });
    saveState();

    pendingSnapCanvas = null;
    $('confirmNeedleCard').hidden = true;
    if (isRefill) {
      showToast(`Saved ${pct.toFixed(1)}% Refill! Log the delivery bill in Bills.`);
      switchTab('bills');
    } else {
      showToast(`Saved reading: ${pct.toFixed(1)}%`);
      switchTab('dashboard');
    }
  });

  // Piped meter save
  $('meterReadingDate').value = todayStr();
  let meterPhotoDataUrl = null;
  $('btnSaveMeterReading').addEventListener('click', async () => {
    const val = Number($('meterValueInput').value);
    if (!Number.isFinite(val) || val < 0) {
      return showToast('Enter a valid meter reading number.');
    }
    const id = 'm_' + Date.now();
    const dateVal = $('meterReadingDate').value || todayStr();
    let hasPhoto = false;
    if (meterPhotoDataUrl) {
      await PhotoVault.put(id, meterPhotoDataUrl);
      hasPhoto = true;
    }
    state.readings.push({
      id,
      date: dateVal,
      timestamp: dateVal === todayStr() ? new Date().toISOString() : `${dateVal}T12:00:00Z`,
      meterValue: val,
      meterUnit: state.settings.meterUnit,
      hasPhoto,
      note: $('meterReadingNote').value.trim(),
    });
    saveState();
    meterPhotoDataUrl = null;
    $('meterValueInput').value = '';
    $('meterReadingNote').value = '';
    showToast(`Saved meter reading: ${val} ${state.settings.meterUnit}`);
    switchTab('dashboard');
  });

  $('meterPhotoUpload').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      meterPhotoDataUrl = r.result;
      showToast('Meter photo attached — enter reading & save.');
    };
    r.readAsDataURL(f);
    e.target.value = '';
  });

  // Bills form & Live Total <-> p/L sync
  $('billDate').value = todayStr();
  $('billLitres').addEventListener('input', syncBillPricesFromTotal);
  $('billTotalPaid').addEventListener('input', syncBillPricesFromTotal);
  $('billUnitPrice').addEventListener('input', () => {
    const l = Number($('billLitres').value);
    const ppl = Number($('billUnitPrice').value);
    if (l > 0 && ppl > 0) {
      $('billTotalPaid').value = ((l * ppl) / 100).toFixed(2);
    }
  });

  function syncBillPricesFromTotal() {
    const l = Number($('billLitres').value);
    const total = Number($('billTotalPaid').value);
    if (l > 0 && total > 0) {
      $('billUnitPrice').value = ((total * 100) / l).toFixed(2);
    }
  }

  $('billUnitType').addEventListener('change', () => {
    const u = $('billUnitType').value;
    $('billQtyLabel').textContent =
      u === 'litres' ? 'Litres Delivered' : u === 'm3' ? 'Units Billed (m³)' : 'Units Billed (ft³)';
  });

  $('billForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const litres = Number($('billLitres').value);
    const totalPaid = Number($('billTotalPaid').value);
    const unitPricePence = Number($('billUnitPrice').value);
    if (!Number.isFinite(litres) || litres <= 0) {
      return showToast('Enter litres or units delivered.');
    }
    if ((!Number.isFinite(totalPaid) || totalPaid <= 0) && (!Number.isFinite(unitPricePence) || unitPricePence <= 0)) {
      return showToast('Enter either Total Paid (£) or Price per Litre (p/L).');
    }
    state.bills.push({
      id: 'b_' + Date.now(),
      date: $('billDate').value || todayStr(),
      supplier: $('billSupplier').value.trim() || 'Calor Gas',
      litres,
      unitType: $('billUnitType').value,
      totalPaid: totalPaid > 0 ? totalPaid : 0,
      unitPricePence: unitPricePence > 0 ? unitPricePence : 0,
      standingChargePencePerDay: Number($('billStandingCharge').value) || 0,
      vatIncluded: $('billVatIncluded').checked,
      note: $('billNote').value.trim(),
    });
    saveState();
    $('billLitres').value = '';
    $('billTotalPaid').value = '';
    $('billUnitPrice').value = '';
    $('billNote').value = '';
    renderAll();
    showToast('Gas bill saved!');
  });

  // Tank size helper modal
  $('btnOpenTankHelper').addEventListener('click', () => {
    $('tankHelperResult').hidden = true;
    $('btnApplyTankSize').hidden = true;
    $('tankHelperModal').hidden = false;
  });

  $('btnCalcTankSize').addEventListener('click', () => {
    const est = TankEngine.estimateTankCapacity(
      $('helpLitres').value,
      $('helpPctBefore').value,
      $('helpPctAfter').value
    );
    if (!est) return showToast('Enter delivery litres and ensure % After > % Before.');
    helperComputedTankSize = est.nearestStandard;
    const box = $('tankHelperResult');
    box.hidden = false;
    box.innerHTML = `Raw estimate: <strong>${est.rawLitres.toLocaleString(
      'en-GB'
    )} L</strong>.<br/>Closest standard UK Calor tank: <strong>${est.nearestStandard.toLocaleString(
      'en-GB'
    )} Litres</strong>.`;
    $('btnApplyTankSize').hidden = false;
  });

  $('btnApplyTankSize').addEventListener('click', () => {
    if (!helperComputedTankSize) return;
    state.settings.tankCapacityLitres = helperComputedTankSize;
    saveState();
    $('tankHelperModal').hidden = true;
    renderAll();
    showToast(`Tank size updated to ${helperComputedTankSize.toLocaleString('en-GB')} L!`);
  });

  // Advisor profile selects
  ['profHomeType', 'profHeaterType', 'profControls', 'profFlowTemp', 'profInsulation', 'profRegion'].forEach(
    (id) => {
      $(id).addEventListener('change', () => {
        state.profile = {
          homeType: $('profHomeType').value,
          heaterType: $('profHeaterType').value,
          controls: $('profControls').value,
          flowTemp: $('profFlowTemp').value,
          insulation: $('profInsulation').value,
          region: $('profRegion').value,
        };
        saveState();
        renderAll();
      });
    }
  );

  // Settings Modal Sync & Handlers
  function syncSettingsModalFromState() {
    const s = state.settings;
    $('setMode').value = s.mode;
    $('setTankCapacity').value = String(s.tankCapacityLitres);
    $('setReorderPct').value = s.reorderAlertPct;
    $('setMeterUnit').value = s.meterUnit;
    $('setDialPreset').value = s.calibration.presetId || 'rochester_5_95';
    $('setDialRotation').value = s.calibration.rotationDeg || 0;
    $('rotValLbl').textContent = `${s.calibration.rotationDeg || 0}°`;
    const span = Math.abs(s.calibration.endDeg || 140);
    $('setDialSpan').value = span;
    $('spanValLbl').textContent = `±${span}°`;
    $('setLocationQuery').value = s.locationQuery || '';
    $('btnToggleDemoSettings').textContent = state.isDemo ? '🧹 Clear Sample Data' : '✨ Load Sample Data';
  }

  $('setMode').addEventListener('change', () => {
    state.settings.mode = $('setMode').value;
    saveState();
    renderAll();
  });

  $('setTankCapacity').addEventListener('change', () => {
    state.settings.tankCapacityLitres = Number($('setTankCapacity').value) || 2000;
    saveState();
    renderAll();
  });

  $('setReorderPct').addEventListener('change', () => {
    state.settings.reorderAlertPct = TankEngine.clamp(Number($('setReorderPct').value) || 25, 10, 45);
    saveState();
    renderAll();
  });

  $('setMeterUnit').addEventListener('change', () => {
    state.settings.meterUnit = $('setMeterUnit').value;
    saveState();
    renderAll();
  });

  $('setDialPreset').addEventListener('change', () => {
    const p = TankEngine.CONSTANTS.DIAL_PRESETS[$('setDialPreset').value];
    if (p) {
      state.settings.calibration = { ...p };
      syncSettingsModalFromState();
      overlayCtrl.setCalibration(state.settings.calibration);
      saveState();
    }
  });

  $('setDialRotation').addEventListener('input', () => {
    const deg = Number($('setDialRotation').value) || 0;
    $('rotValLbl').textContent = `${deg}°`;
    state.settings.calibration.rotationDeg = deg;
    overlayCtrl.setCalibration(state.settings.calibration);
    saveState();
  });

  $('setDialSpan').addEventListener('input', () => {
    const span = Number($('setDialSpan').value) || 140;
    $('spanValLbl').textContent = `±${span}°`;
    state.settings.calibration.startDeg = -span;
    state.settings.calibration.endDeg = span;
    overlayCtrl.setCalibration(state.settings.calibration);
    saveState();
  });

  $('btnSaveLocation').addEventListener('click', async () => {
    const q = $('setLocationQuery').value.trim();
    if (!q) return showToast('Enter a UK postcode or town.');
    try {
      showToast('Finding UK location...');
      const loc = await TankWeather.resolveUkLocation(q);
      state.settings.locationQuery = loc.postcode || q;
      state.settings.locationLabel = loc.label;
      state.settings.lat = loc.lat;
      state.settings.lon = loc.lon;
      saveState();
      await TankWeather.fetchDailyTemperatures(loc.lat, loc.lon);
      renderAll();
      showToast(`Weather synced for ${loc.label}`);
    } catch (err) {
      showToast(err.message);
    }
  });

  $('btnToggleDemoSettings').addEventListener('click', () => {
    if (state.isDemo) {
      clearDemoMode();
    } else {
      loadDemoMode();
    }
    syncSettingsModalFromState();
  });

  $('btnResetAll').addEventListener('click', async () => {
    if (!window.confirm('Erase all readings, bills, and settings on this phone?')) return;
    await PhotoVault.clearAll();
    demoWeatherCache = {};
    state = defaultState();
    saveState();
    $('settingsModal').hidden = true;
    renderAll();
    showToast('All TankGauge data cleared.');
  });

  $('btnExportJson').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `tankgauge-backup-${todayStr()}.json`);
  });

  $('btnExportCsv').addEventListener('click', () => {
    const rows = ['Date,Litres,kWh,GasCostGBP,StandingCostGBP,TotalCostGBP,TempC'];
    (lastAnalytics ? lastAnalytics.dailySeries : []).forEach((d) => {
      rows.push(
        [
          d.date,
          d.litres,
          d.kWh,
          d.gasCost.toFixed(2),
          d.standingCost.toFixed(2),
          d.totalCost.toFixed(2),
          d.tempC !== null ? d.tempC : '',
        ].join(',')
      );
    });
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, `tankgauge-usage-${todayStr()}.csv`);
  });

  $('importJsonInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.readings)) {
          throw new Error('Invalid TankGauge backup file.');
        }
        state = { ...defaultState(), ...parsed };
        saveState();
        syncSettingsModalFromState();
        renderAll();
        showToast('Backup restored successfully!');
      } catch (err) {
        showToast(err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // Register Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
    });
  }

  window.addEventListener('resize', () => {
    if (activeTab === 'dashboard' || activeTab === 'bills') renderAll();
  });

  // Boot
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
  if (state.isDemo) {
    demoWeatherCache = TankEngine.generateDemoDataset().demoWeather;
  }
  renderAll();
})();
