/**
 * TankGauge Visual Charts Module
 * Zero-dependency SVG Hero Tank Gauge + High-DPI interactive Canvas charts.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TankCharts = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad),
    };
  }

  function describeArc(cx, cy, r, startDeg, endDeg) {
    const start = polarToCartesian(cx, cy, r, endDeg);
    const end = polarToCartesian(cx, cy, r, startDeg);
    const largeArc = endDeg - startDeg <= 180 ? '0' : '1';
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 0 ${end.x.toFixed(
      2
    )} ${end.y.toFixed(2)}`;
  }

  function getThemeColors() {
    const isDark =
      typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme') === 'dark';
    return isDark
      ? {
          text: '#F8FAFC',
          muted: '#94A3B8',
          grid: 'rgba(148, 163, 184, 0.16)',
          track: '#1E293B',
          bar: '#FB923C',
          barHover: '#FDBA74',
          temp: '#38BDF8',
          pin: '#4ADE80',
          band: 'rgba(34, 197, 94, 0.14)',
          tooltipBg: '#0F172A',
          tooltipBorder: '#475569',
        }
      : {
          text: '#0F172A',
          muted: '#64748B',
          grid: 'rgba(15, 23, 42, 0.09)',
          track: '#E2E8F0',
          bar: '#EA580C',
          barHover: '#C2410C',
          temp: '#0284C7',
          pin: '#16A34A',
          band: 'rgba(22, 163, 74, 0.11)',
          tooltipBg: '#0F172A',
          tooltipBorder: '#334155',
        };
  }

  function renderHeroTankGauge(containerEl, summary, settings) {
    if (!containerEl) return;
    const mode = (settings && settings.mode) || 'bulk';
    const colors = getThemeColors();

    if (mode === 'meter') {
      const latestVal =
        summary && summary.latestReading && summary.latestReading.meterValue !== undefined
          ? summary.latestReading.meterValue
          : '—';
      const unit = (settings && settings.meterUnit) || 'm3';
      containerEl.innerHTML = `
        <div class="meter-hero-box">
          <div class="meter-hero-label">Latest Piped LPG Meter Reading</div>
          <div class="meter-hero-digits">${latestVal} <span class="meter-unit">${unit}</span></div>
          <div class="meter-hero-sub">${
            summary && summary.recentLitresPerDay > 0
              ? `Burning ~${summary.recentLitresPerDay.toFixed(1)} L eq/day (${summary.recentKwhPerDay} kWh/day)`
              : 'Log two readings to see your daily burn rate'
          }</div>
        </div>
      `;
      return;
    }

    const pct = summary && summary.currentPct !== null ? summary.currentPct : null;
    const displayPct = pct !== null ? Math.max(0, Math.min(100, pct)) : 0;
    const status = (summary && summary.tankStatus) || 'unknown';
    const reorderPct = (settings && settings.reorderAlertPct) || 25;

    const statusBadge =
      status === 'low'
        ? { text: 'Order Calor Soon', cls: 'badge-danger' }
        : status === 'plan'
          ? { text: 'Plan Top-Up', cls: 'badge-warn' }
          : status === 'healthy'
            ? { text: 'Tank Healthy', cls: 'badge-ok' }
            : { text: 'No Reading Yet', cls: 'badge-muted' };

    const cx = 120;
    const cy = 115;
    const r = 88;
    const startDeg = -140;
    const endDeg = 140;
    const span = endDeg - startDeg;
    const redEndDeg = startDeg + (reorderPct / 100) * span;
    const valueEndDeg = startDeg + (displayPct / 100) * span;

    const litresLeftText =
      summary && summary.litresRemaining !== null
        ? `${summary.litresRemaining.toLocaleString('en-GB')} L / ${(
            summary.tankCapacityLitres || 2000
          ).toLocaleString('en-GB')} L`
        : 'Snap your dial to start';

    let countdownText = 'Need 2+ readings for forecast';
    if (summary && summary.daysToReorder !== null) {
      if (summary.daysToReorder <= 0) {
        countdownText = `At or below ${reorderPct}% reorder level`;
      } else {
        countdownText = `~${summary.daysToReorder} days until ${reorderPct}% (${summary.reorderDate})`;
      }
    }

    containerEl.innerHTML = `
      <div class="hero-gauge-wrap">
        <svg viewBox="0 0 240 205" class="hero-gauge-svg" aria-label="Tank level gauge">
          <defs>
            <linearGradient id="flameArcGrad" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="#EA580C" />
              <stop offset="60%" stop-color="#F59E0B" />
              <stop offset="100%" stop-color="#16A34A" />
            </linearGradient>
          </defs>
          <path d="${describeArc(cx, cy, r, startDeg, endDeg)}" fill="none" stroke="${
      colors.track
    }" stroke-width="18" stroke-linecap="round" />
          <path d="${describeArc(
            cx,
            cy,
            r,
            startDeg,
            redEndDeg
          )}" fill="none" stroke="rgba(220, 38, 38, 0.35)" stroke-width="18" stroke-linecap="round" />
          ${
            pct !== null && displayPct > 0.5
              ? `<path d="${describeArc(cx, cy, r, startDeg, valueEndDeg)}" fill="none" stroke="${
                  status === 'low' ? '#DC2626' : 'url(#flameArcGrad)'
                }" stroke-width="18" stroke-linecap="round" />`
              : ''
          }
          <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="${
      colors.text
    }" font-size="38" font-weight="800" font-family="system-ui, sans-serif">${
      pct !== null ? `${pct.toFixed(1)}%` : '--%'
    }</text>
          <text x="${cx}" y="${cy + 20}" text-anchor="middle" fill="${
      colors.muted
    }" font-size="13" font-weight="600" font-family="system-ui, sans-serif">${litresLeftText}</text>
        </svg>
        <div class="hero-status-row">
          <span class="status-pill ${statusBadge.cls}">${statusBadge.text}</span>
          <span class="countdown-text">${countdownText}</span>
        </div>
      </div>
    `;
  }

  function setupHiDpiCanvas(canvas, cssHeight) {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const width = canvas.parentElement ? canvas.parentElement.clientWidth || 340 : 340;
    const height = cssHeight || 220;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  }

  function renderConsumptionChart(canvas, dailySeries, monthlySeries, options, tooltipEl) {
    if (!canvas) return;
    const opts = Object.assign(
      {
        granularity: 'daily', // 'daily' | 'monthly'
        metric: 'cost', // 'cost' | 'litres' | 'kwh'
        showWeather: true,
        milestones: [], // [{ date, title }]
      },
      options || {}
    );

    const colors = getThemeColors();
    const { ctx, width, height } = setupHiDpiCanvas(canvas, 225);
    ctx.clearRect(0, 0, width, height);

    const rows =
      opts.granularity === 'monthly'
        ? (monthlySeries || []).map((m) => ({
            label: m.month,
            shortLabel: m.month.slice(2),
            val: opts.metric === 'litres' ? m.litres : opts.metric === 'kwh' ? m.kWh : m.totalCost,
            tempC: m.avgTempC,
          }))
        : (dailySeries || []).slice(-30).map((d) => ({
            label: d.date,
            shortLabel: d.date.slice(5),
            val: opts.metric === 'litres' ? d.litres : opts.metric === 'kwh' ? d.kWh : d.totalCost,
            tempC: d.tempC,
          }));

    if (!rows.length) {
      ctx.fillStyle = colors.muted;
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Log 2+ dial readings to see your usage graph', width / 2, height / 2);
      if (tooltipEl) tooltipEl.hidden = true;
      return;
    }

    const padL = 42;
    const padR = opts.showWeather ? 34 : 12;
    const padT = 22;
    const padB = 28;
    const plotW = Math.max(40, width - padL - padR);
    const plotH = Math.max(40, height - padT - padB);

    const maxVal = Math.max(1, ...rows.map((r) => r.val)) * 1.15;
    const temps = rows.map((r) => r.tempC).filter((t) => t !== null && Number.isFinite(t));
    const hasTemp = opts.showWeather && temps.length >= 2;
    const minT = hasTemp ? Math.floor(Math.min(...temps) - 2) : 0;
    const maxT = hasTemp ? Math.ceil(Math.max(...temps) + 2) : 20;

    // Horizontal grid lines & Y axis labels
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= 3; g++) {
      const ratio = g / 3;
      const y = padT + plotH - ratio * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.stroke();

      const labelNum = ratio * maxVal;
      const yTxt =
        opts.metric === 'cost'
          ? `£${labelNum >= 10 ? Math.round(labelNum) : labelNum.toFixed(1)}`
          : `${Math.round(labelNum)}`;
      ctx.fillStyle = colors.muted;
      ctx.fillText(yTxt, padL - 6, y);

      if (hasTemp) {
        const tVal = minT + ratio * (maxT - minT);
        ctx.save();
        ctx.textAlign = 'left';
        ctx.fillStyle = colors.temp;
        ctx.fillText(`${Math.round(tVal)}°`, padL + plotW + 5, y);
        ctx.restore();
      }
    }

    // Bars
    const slotW = plotW / rows.length;
    const barW = Math.max(4, Math.min(28, slotW * 0.66));
    const barRects = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const barH = (r.val / maxVal) * plotH;
      const x = padL + i * slotW + (slotW - barW) / 2;
      const y = padT + plotH - barH;

      ctx.fillStyle = colors.bar;
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, barW, Math.max(2, barH), [3, 3, 0, 0]);
      } else {
        ctx.rect(x, y, barW, Math.max(2, barH));
      }
      ctx.fill();

      barRects.push({
        x: padL + i * slotW,
        w: slotW,
        cx: padL + i * slotW + slotW / 2,
        row: r,
      });

      // Sparse X labels
      const labelEvery = rows.length > 16 ? 5 : rows.length > 8 ? 2 : 1;
      if (i === 0 || i === rows.length - 1 || i % labelEvery === 0) {
        ctx.fillStyle = colors.muted;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(r.shortLabel, padL + i * slotW + slotW / 2, padT + plotH + 7);
      }
    }

    // Advisor milestone pins ★
    const milestones = opts.milestones || [];
    for (let m = 0; m < milestones.length; m++) {
      const ms = milestones[m];
      const targetKey = opts.granularity === 'monthly' ? ms.date.slice(0, 7) : ms.date;
      const hit = barRects.find((b) => b.row.label === targetKey);
      if (hit) {
        ctx.fillStyle = colors.pin;
        ctx.font = '700 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('★', hit.cx, padT - 2);
      }
    }

    // Weather line overlay
    if (hasTemp) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < rows.length; i++) {
        const t = rows[i].tempC;
        if (t === null || !Number.isFinite(t)) continue;
        const x = padL + i * slotW + slotW / 2;
        const y = padT + plotH - ((t - minT) / Math.max(1, maxT - minT)) * plotH;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = colors.temp;
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }

    // Pointer hover / tap tooltip
    canvas.onpointerdown = canvas.onpointermove = (evt) => {
      if (!tooltipEl) return;
      const rect = canvas.getBoundingClientRect();
      const px = evt.clientX - rect.left;
      const hit = barRects.find((b) => px >= b.x && px <= b.x + b.w);
      if (!hit) {
        tooltipEl.hidden = true;
        return;
      }
      const r = hit.row;
      const valTxt =
        opts.metric === 'cost'
          ? `£${r.val.toFixed(2)}`
          : opts.metric === 'litres'
            ? `${r.val.toFixed(1)} L`
            : `${r.val.toFixed(1)} kWh`;
      const tempTxt = r.tempC !== null ? ` • Outside ${r.tempC.toFixed(1)}°C` : '';
      tooltipEl.hidden = false;
      tooltipEl.textContent = `${r.label}: ${valTxt}${tempTxt}`;
    };
  }

  function renderPriceTrendChart(canvas, bills) {
    if (!canvas) return;
    const colors = getThemeColors();
    const { ctx, width, height } = setupHiDpiCanvas(canvas, 150);
    ctx.clearRect(0, 0, width, height);

    const list = (bills || []).filter((b) => b.effectivePricePerLitreIncVat > 0);
    if (!list.length) {
      ctx.fillStyle = colors.muted;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Add a delivery bill to track Calor p/L price changes', width / 2, height / 2);
      return;
    }

    const padL = 38;
    const padR = 16;
    const padT = 18;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const prices = list.map((b) => b.effectivePricePerLitreIncVat);
    const minP = Math.min(48, Math.floor(Math.min(...prices) - 4));
    const maxP = Math.max(74, Math.ceil(Math.max(...prices) + 4));

    const yFor = (p) => padT + plotH - ((p - minP) / Math.max(1, maxP - minP)) * plotH;

    // Shaded UK typical bulk LPG band (55 - 68 p/L)
    const yTop = yFor(Math.min(maxP, 68));
    const yBot = yFor(Math.max(minP, 55));
    ctx.fillStyle = colors.band;
    ctx.fillRect(padL, yTop, plotW, Math.max(0, yBot - yTop));

    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [minP, 55, 68, maxP].forEach((p) => {
      if (p >= minP && p <= maxP) {
        const y = yFor(p);
        ctx.fillText(`${p}p`, padL - 5, y);
      }
    });

    ctx.beginPath();
    list.forEach((b, idx) => {
      const x =
        list.length === 1 ? padL + plotW / 2 : padL + (idx / (list.length - 1)) * plotW;
      const y = yFor(b.effectivePricePerLitreIncVat);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = colors.bar;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    list.forEach((b, idx) => {
      const x =
        list.length === 1 ? padL + plotW / 2 : padL + (idx / (list.length - 1)) * plotW;
      const y = yFor(b.effectivePricePerLitreIncVat);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = colors.bar;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = colors.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${b.effectivePricePerLitreIncVat.toFixed(1)}p`, x, y - 7);

      ctx.fillStyle = colors.muted;
      ctx.textBaseline = 'top';
      ctx.fillText(b.date.slice(2, 7), x, padT + plotH + 6);
    });
  }

  return {
    renderHeroTankGauge,
    renderConsumptionChart,
    renderPriceTrendChart,
  };
});
