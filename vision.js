/**
 * TankGauge Vision & Camera Module
 * On-device radial needle finder, synthetic Calor dial renderer, camera controls,
 * interactive canvas overlay editor, and optional Gemini Vision bill/meter scanner.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.TankVision = factory(root.TankEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TankEngine) {
  'use strict';

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function sampleBilinear(rgba, w, h, x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) {
      const cx = clamp(Math.round(x), 0, w - 1);
      const cy = clamp(Math.round(y), 0, h - 1);
      const idx = (cy * w + cx) * 4;
      return [rgba[idx], rgba[idx + 1], rgba[idx + 2]];
    }
    const fx = x - x0;
    const fy = y - y0;
    const i00 = (y0 * w + x0) * 4;
    const i10 = i00 + 4;
    const i01 = i00 + w * 4;
    const i11 = i01 + 4;

    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;

    return [
      rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11,
      rgba[i00 + 1] * w00 + rgba[i10 + 1] * w10 + rgba[i01 + 1] * w01 + rgba[i11 + 1] * w11,
      rgba[i00 + 2] * w00 + rgba[i10 + 2] * w10 + rgba[i01 + 2] * w01 + rgba[i11 + 2] * w11,
    ];
  }

  function lumaAndRed(rgb) {
    const r = rgb[0];
    const g = rgb[1];
    const b = rgb[2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const redness = r - 0.5 * (g + b);
    return { luma, redness };
  }

  /**
   * Pure pixel-buffer needle detector.
   * Scans radial profiles around (cx, cy) within calibration bounds.
   * 0 deg = 12 o'clock, positive = clockwise.
   */
  function detectDialNeedleFromRGBA(rgbaData, width, height, cx, cy, radius, calibration) {
    const cal = TankEngine.resolveCalibration(calibration);
    const startScan = cal.startDeg + cal.rotationDeg - 4;
    const endScan = cal.endDeg + cal.rotationDeg + 4;
    const stepDeg = 0.5;

    // Sample radii inside the clean dial face (inside outer tick ring & numbers)
    const radialSteps = [0.22, 0.27, 0.32, 0.37, 0.42, 0.47, 0.52, 0.57, 0.62, 0.67, 0.72];
    const outerReachStartIdx = 5; // >= 0.47 * R distinguishes tip from short counterweight tail

    const candidates = [];

    for (let deg = startScan; deg <= endScan + 0.001; deg += stepDeg) {
      const rad = (deg * Math.PI) / 180;
      const dx = Math.sin(rad);
      const dy = -Math.cos(rad);

      // Flanking angles at +-8 deg and +-14 deg for local background comparison (handles glass glare!)
      const flankAngles = [-14, -8, 8, 14].map((offset) => {
        const fr = ((deg + offset) * Math.PI) / 180;
        return { dx: Math.sin(fr), dy: -Math.cos(fr) };
      });

      let innerSum = 0;
      let outerSum = 0;
      let hits = 0;

      for (let i = 0; i < radialSteps.length; i++) {
        const rPx = radialSteps[i] * radius;
        const px = cx + dx * rPx;
        const py = cy + dy * rPx;
        const centerSample = lumaAndRed(sampleBilinear(rgbaData, width, height, px, py));

        let flankLumaSum = 0;
        let flankRedSum = 0;
        for (let f = 0; f < flankAngles.length; f++) {
          const fx = cx + flankAngles[f].dx * rPx;
          const fy = cy + flankAngles[f].dy * rPx;
          const fs = lumaAndRed(sampleBilinear(rgbaData, width, height, fx, fy));
          flankLumaSum += fs.luma;
          flankRedSum += fs.redness;
        }
        const flankLuma = flankLumaSum / flankAngles.length;
        const flankRed = flankRedSum / flankAngles.length;

        const darkContrast = Math.max(0, flankLuma - centerSample.luma);
        const redContrast = Math.max(0, centerSample.redness - flankRed) * 0.9;
        const ptScore = Math.max(darkContrast, redContrast);

        if (ptScore > 14) hits += 1;
        if (i < outerReachStartIdx) {
          innerSum += ptScore;
        } else {
          // Outer reach weighted slightly higher so long needle tip beats short counterweight
          outerSum += ptScore * 1.35;
        }
      }

      const consistency = hits / radialSteps.length;
      const continuityBonus = consistency >= 0.72 ? 1.28 : consistency >= 0.5 ? 1.0 : 0.45;
      const rawScore = ((innerSum + outerSum) / radialSteps.length) * continuityBonus;

      // Penalise if outer reach is near zero (likely counterweight tail or logo)
      const outerAvg = outerSum / (radialSteps.length - outerReachStartIdx);
      const score = outerAvg < 8 ? rawScore * 0.25 : rawScore;

      candidates.push({ deg, score });
    }

    let bestIdx = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].score > candidates[bestIdx].score) {
        bestIdx = i;
      }
    }

    // Weighted sub-step centroid over immediate neighbours +-1.5 deg
    const bestAngleRaw = candidates[bestIdx].deg;
    const bestScore = candidates[bestIdx].score;
    let wSum = 0;
    let aSum = 0;
    for (let i = Math.max(0, bestIdx - 3); i <= Math.min(candidates.length - 1, bestIdx + 3); i++) {
      const w = Math.max(0, candidates[i].score - bestScore * 0.45);
      wSum += w;
      aSum += candidates[i].deg * w;
    }
    const refinedAngle = wSum > 0 ? aSum / wSum : bestAngleRaw;

    // Second-best distinct peak (> 18 deg away) for confidence rating
    let secondBest = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (Math.abs(candidates[i].deg - bestAngleRaw) > 18 && candidates[i].score > secondBest) {
        secondBest = candidates[i].score;
      }
    }

    const confidence =
      bestScore <= 4
        ? 0.1
        : clamp((bestScore - secondBest) / Math.max(18, bestScore), 0.12, 0.99);

    const normalizedAngle = TankEngine.normalizeAngle180(refinedAngle);
    const percent = TankEngine.angleDegToPercent(normalizedAngle, cal);

    return {
      angleDeg: TankEngine.roundTo(normalizedAngle, 2),
      percent,
      confidence: TankEngine.roundTo(confidence, 2),
    };
  }

  /**
   * Pure pixel-buffer synthetic Calor Rochester dial renderer.
   * Used for Node verification tests and as base texture when needed.
   */
  function renderSyntheticDialToRGBA(width, height, targetPercent, calibration) {
    const cal = TankEngine.resolveCalibration(calibration);
    const rgba = new Uint8ClampedArray(width * height * 4);
    const cx = width / 2;
    const cy = height / 2;
    const R = Math.min(width, height) * 0.44;
    const needleDeg = TankEngine.percentToAngleDeg(targetPercent, cal);
    const needleRad = (needleDeg * Math.PI) / 180;
    const nx = Math.sin(needleRad);
    const ny = -Math.cos(needleRad);

    function setPx(x, y, r, g, b) {
      const idx = (y * width + x) * 4;
      rgba[idx] = clamp(Math.round(r), 0, 255);
      rgba[idx + 1] = clamp(Math.round(g), 0, 255);
      rgba[idx + 2] = clamp(Math.round(b), 0, 255);
      rgba[idx + 3] = 255;
    }

    const startRedDeg = TankEngine.percentToAngleDeg(cal.minPct, cal);
    const endRedDeg = TankEngine.percentToAngleDeg(25, cal);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.hypot(dx, dy);

        // Background outside dial
        let r = 212;
        let g = 218;
        let b = 224;

        if (dist <= R * 1.08 && dist > R * 0.96) {
          // Metallic bezel rim
          r = 105;
          g = 114;
          b = 125;
        } else if (dist <= R * 0.96) {
          // Off-white dial face
          r = 247;
          g = 248;
          b = 246;

          // Angle in degrees (0 at top, clockwise positive)
          const ang = (Math.atan2(dx, -dy) * 180) / Math.PI;

          // Red warning arc (< 25%) near outer band
          if (dist >= R * 0.78 && dist <= R * 0.91 && ang >= startRedDeg && ang <= endRedDeg) {
            r = 220;
            g = 52;
            b = 45;
          }

          // Outer tick marks every 5%
          if (dist >= R * 0.78 && dist <= R * 0.92) {
            for (let p = cal.minPct; p <= cal.maxPct; p += 5) {
              const tDeg = TankEngine.percentToAngleDeg(p, cal);
              if (Math.abs(ang - tDeg) <= (p % 10 === 0 ? 1.1 : 0.6)) {
                r = 28;
                g = 34;
                b = 42;
                break;
              }
            }
          }

          // Subtle diagonal glass reflection sheen across upper-left quadrant
          const glareDist = Math.abs((dx + dy) * 0.707 + R * 0.22);
          if (glareDist < R * 0.14) {
            const lift = (1 - glareDist / (R * 0.14)) * 18;
            r += lift;
            g += lift;
            b += lift;
          }

          // Tapered needle tip + short counterweight tail
          const proj = dx * nx + dy * ny;
          const perp = Math.abs(dx * -ny + dy * nx);

          if (proj >= -R * 0.23 && proj <= R * 0.77) {
            const halfWidth =
              proj >= 0
                ? Math.max(1.2, (1 - proj / (R * 0.85)) * (R * 0.048))
                : R * 0.044;
            if (perp <= halfWidth) {
              r = 22;
              g = 26;
              b = 34;
            }
          }

          // Center brass/dark pivot cap
          if (dist <= R * 0.11) {
            r = 45;
            g = 52;
            b = 62;
          } else if (dist <= R * 0.05) {
            r = 190;
            g = 152;
            b = 85;
          }
        }

        setPx(x, y, r, g, b);
      }
    }

    return rgba;
  }

  /**
   * Browser Canvas2D synthetic Calor Rochester dial renderer (with readable numbers & glare).
   */
  function renderSyntheticDial(canvas, targetPercent, calibration) {
    const cal = TankEngine.resolveCalibration(calibration);
    const size = canvas.width || 420;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2;
    const cy = size / 2;
    const R = size * 0.44;

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#d4dae0';
    ctx.fillRect(0, 0, size, size);

    // Metallic housing & bezel
    const rimGrad = ctx.createLinearGradient(0, 0, size, size);
    rimGrad.addColorStop(0, '#94a3b8');
    rimGrad.addColorStop(0.5, '#475569');
    rimGrad.addColorStop(1, '#64748b');
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.08, 0, Math.PI * 2);
    ctx.fillStyle = rimGrad;
    ctx.fill();

    // Dial face
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.96, 0, Math.PI * 2);
    ctx.fillStyle = '#f7f8f6';
    ctx.fill();

    // Red < 25% zone arc
    const startRedRad = ((TankEngine.percentToAngleDeg(cal.minPct, cal) - 90) * Math.PI) / 180;
    const endRedRad = ((TankEngine.percentToAngleDeg(25, cal) - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.85, startRedRad, endRedRad);
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = R * 0.085;
    ctx.stroke();

    // Ticks & numbers
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(R * 0.11)}px system-ui, sans-serif`;
    for (let p = cal.minPct; p <= cal.maxPct; p += 5) {
      const deg = TankEngine.percentToAngleDeg(p, cal);
      const rad = (deg * Math.PI) / 180;
      const isMajor = p % 10 === 0 || p === cal.minPct || p === cal.maxPct;
      const rIn = isMajor ? R * 0.77 : R * 0.83;
      const rOut = R * 0.91;

      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(rad) * rIn, cy - Math.cos(rad) * rIn);
      ctx.lineTo(cx + Math.sin(rad) * rOut, cy - Math.cos(rad) * rOut);
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = isMajor ? 2.8 : 1.5;
      ctx.stroke();

      if (p % 10 === 0 || p === 5 || p === 95) {
        const rTxt = R * 0.65;
        ctx.fillStyle = p <= 20 ? '#b91c1c' : '#1e293b';
        ctx.fillText(String(p), cx + Math.sin(rad) * rTxt, cy - Math.cos(rad) * rTxt);
      }
    }

    // Dial text label
    ctx.fillStyle = '#475569';
    ctx.font = `700 ${Math.round(R * 0.075)}px system-ui, sans-serif`;
    ctx.fillText('% TANK CAPACITY', cx, cy + R * 0.44);

    // Tapered needle + counterweight
    const nDeg = TankEngine.percentToAngleDeg(targetPercent, cal);
    const nRad = (nDeg * Math.PI) / 180;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(nRad);
    ctx.beginPath();
    ctx.moveTo(-R * 0.042, R * 0.22);
    ctx.lineTo(R * 0.042, R * 0.22);
    ctx.lineTo(R * 0.012, -R * 0.76);
    ctx.lineTo(-R * 0.012, -R * 0.76);
    ctx.closePath();
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.restore();

    // Center hub
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.1, 0, Math.PI * 2);
    ctx.fillStyle = '#334155';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.045, 0, Math.PI * 2);
    ctx.fillStyle = '#d97706';
    ctx.fill();

    // Soft glass glare streak
    const glare = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.4, cy + R * 0.4);
    glare.addColorStop(0, 'rgba(255,255,255,0.22)');
    glare.addColorStop(0.45, 'rgba(255,255,255,0.03)');
    glare.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.96, 0, Math.PI * 2);
    ctx.fillStyle = glare;
    ctx.fill();
  }

  function compressPhotoBlob(sourceCanvas, maxDim, quality) {
    const dim = maxDim || 480;
    const q = quality || 0.82;
    const w = sourceCanvas.width || dim;
    const h = sourceCanvas.height || dim;
    const scale = Math.min(1, dim / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const tmp = document.createElement('canvas');
    tmp.width = tw;
    tmp.height = th;
    tmp.getContext('2d').drawImage(sourceCanvas, 0, 0, tw, th);
    return tmp.toDataURL('image/jpeg', q);
  }

  /**
   * Interactive Dial Overlay Controller:
   * Draws captured image + calibrated reticle + glowing draggable needle overlay.
   */
  class DialOverlayController {
    constructor(canvas, onPercentChange) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.onPercentChange = onPercentChange;
      this.sourceCanvas = null;
      this.calibration = TankEngine.resolveCalibration(null);
      this.size = 420;
      this.cx = 210;
      this.cy = 210;
      this.radius = 165;
      this.percent = 50;
      this.angleDeg = 0;
      this.dragMode = 'needle'; // 'needle' | 'center'
      this.isDragging = false;
      this._bindEvents();
    }

    _bindEvents() {
      const getPos = (evt) => {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const pt = evt.touches ? evt.touches[0] : evt;
        return {
          x: (pt.clientX - rect.left) * scaleX,
          y: (pt.clientY - rect.top) * scaleY,
        };
      };

      const onDown = (evt) => {
        if (!this.sourceCanvas) return;
        evt.preventDefault();
        this.isDragging = true;
        onMove(evt);
      };

      const onMove = (evt) => {
        if (!this.isDragging || !this.sourceCanvas) return;
        evt.preventDefault();
        const pos = getPos(evt);
        if (this.dragMode === 'center') {
          this.cx = clamp(pos.x, this.size * 0.2, this.size * 0.8);
          this.cy = clamp(pos.y, this.size * 0.2, this.size * 0.8);
          this.render();
        } else {
          const dx = pos.x - this.cx;
          const dy = pos.y - this.cy;
          if (Math.hypot(dx, dy) < 8) return;
          const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
          this.setAngle(deg);
        }
      };

      const onUp = () => {
        this.isDragging = false;
      };

      this.canvas.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    setImage(sourceCanvas, calibration, initialResult) {
      this.calibration = TankEngine.resolveCalibration(calibration);
      this.size = 420;
      this.canvas.width = this.size;
      this.canvas.height = this.size;

      // Center-crop square into clean 420x420 working canvas
      const sq = document.createElement('canvas');
      sq.width = this.size;
      sq.height = this.size;
      const sw = sourceCanvas.width;
      const sh = sourceCanvas.height;
      const side = Math.min(sw, sh);
      const sx = (sw - side) / 2;
      const sy = (sh - side) / 2;
      sq.getContext('2d').drawImage(sourceCanvas, sx, sy, side, side, 0, 0, this.size, this.size);
      this.sourceCanvas = sq;

      this.cx = this.size / 2;
      this.cy = this.size / 2;
      this.radius = this.size * 0.42;

      if (initialResult) {
        this.angleDeg = initialResult.angleDeg;
        this.percent = initialResult.percent;
      } else {
        this.runAutoDetect();
      }
      this.render();
    }

    runAutoDetect() {
      if (!this.sourceCanvas) return null;
      const imgData = this.sourceCanvas
        .getContext('2d')
        .getImageData(0, 0, this.size, this.size);
      const res = detectDialNeedleFromRGBA(
        imgData.data,
        this.size,
        this.size,
        this.cx,
        this.cy,
        this.radius,
        this.calibration
      );
      this.angleDeg = res.angleDeg;
      this.percent = res.percent;
      this.render();
      if (this.onPercentChange) this.onPercentChange(this.percent, res.confidence);
      return res;
    }

    setCalibration(calibration) {
      this.calibration = TankEngine.resolveCalibration(calibration);
      this.percent = TankEngine.angleDegToPercent(this.angleDeg, this.calibration);
      this.render();
      if (this.onPercentChange) this.onPercentChange(this.percent);
    }

    setPercent(pct) {
      const cal = this.calibration;
      this.percent = TankEngine.roundTo(clamp(pct, cal.minPct, cal.maxPct), 1);
      this.angleDeg = TankEngine.percentToAngleDeg(this.percent, cal);
      this.render();
      if (this.onPercentChange) this.onPercentChange(this.percent);
    }

    nudge(deltaPct) {
      this.setPercent(this.percent + deltaPct);
    }

    setAngle(deg) {
      this.angleDeg = TankEngine.normalizeAngle180(deg);
      this.percent = TankEngine.angleDegToPercent(this.angleDeg, this.calibration);
      this.render();
      if (this.onPercentChange) this.onPercentChange(this.percent);
    }

    setDragMode(mode) {
      this.dragMode = mode === 'center' ? 'center' : 'needle';
      this.render();
    }

    render() {
      const ctx = this.ctx;
      const size = this.size;
      ctx.clearRect(0, 0, size, size);
      if (!this.sourceCanvas) return;

      ctx.drawImage(this.sourceCanvas, 0, 0);

      // Subtle translucent target circle & major tick markers
      ctx.save();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.72)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, this.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      for (let p = this.calibration.minPct; p <= this.calibration.maxPct; p += 10) {
        const deg = TankEngine.percentToAngleDeg(p, this.calibration);
        const rad = (deg * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(this.cx + Math.sin(rad) * (this.radius * 0.92), this.cy - Math.cos(rad) * (this.radius * 0.92));
        ctx.lineTo(this.cx + Math.sin(rad) * (this.radius * 1.03), this.cy - Math.cos(rad) * (this.radius * 1.03));
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // Glowing confirmation needle overlay
      const nRad = (this.angleDeg * Math.PI) / 180;
      const tipX = this.cx + Math.sin(nRad) * (this.radius * 0.92);
      const tipY = this.cy - Math.cos(nRad) * (this.radius * 0.92);

      ctx.shadowColor = 'rgba(234, 88, 12, 0.9)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(this.cx, this.cy);
      ctx.lineTo(tipX, tipY);
      ctx.strokeStyle = '#fb923c';
      ctx.lineWidth = 4.5;
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#ea580c';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // Center pivot dot
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, this.dragMode === 'center' ? 9 : 6, 0, Math.PI * 2);
      ctx.fillStyle = this.dragMode === 'center' ? '#38bdf8' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.restore();
    }
  }

  /**
   * Guided Camera Controller with Zoom, Torch, Tilt Level & Clean Track Release.
   */
  class CameraController {
    constructor(videoEl) {
      this.videoEl = videoEl;
      this.stream = null;
      this.track = null;
      this.torchOn = false;
      this.onTiltUpdate = null;
      this._orientHandler = null;
    }

    async start() {
      this.stop();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Live camera not available in this browser — use Upload / Take Photo below.');
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();
      this.track = this.stream.getVideoTracks()[0] || null;
      const caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : {};
      return {
        hasZoom: Boolean(caps && caps.zoom),
        zoomMin: caps && caps.zoom ? caps.zoom.min : 1,
        zoomMax: caps && caps.zoom ? Math.min(4, caps.zoom.max) : 1,
        zoomStep: caps && caps.zoom ? caps.zoom.step || 0.1 : 0.1,
        hasTorch: Boolean(caps && caps.torch),
      };
    }

    async setZoom(val) {
      if (!this.track || !this.track.applyConstraints) return;
      try {
        await this.track.applyConstraints({ advanced: [{ zoom: Number(val) }] });
      } catch (_) {
        // Ignore unsupported zoom constraints cleanly
      }
    }

    async toggleTorch() {
      if (!this.track || !this.track.applyConstraints) return false;
      this.torchOn = !this.torchOn;
      try {
        await this.track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
      } catch (_) {
        this.torchOn = false;
      }
      return this.torchOn;
    }

    startTiltSensor(callback) {
      this.onTiltUpdate = callback;
      if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return;
      if (this._orientHandler) window.removeEventListener('deviceorientation', this._orientHandler);
      this._orientHandler = (e) => {
        if (e.beta === null || e.gamma === null) return;
        // Near-flat or clean perpendicular phone orientation helper
        const tiltDeg = Math.round(Math.hypot(e.gamma || 0, Math.abs(e.beta || 0) > 60 ? 90 - Math.abs(e.beta) : e.beta));
        if (this.onTiltUpdate) this.onTiltUpdate(tiltDeg);
      };
      window.addEventListener('deviceorientation', this._orientHandler, { passive: true });
    }

    captureFrame() {
      if (!this.videoEl || !this.videoEl.videoWidth) return null;
      const vw = this.videoEl.videoWidth;
      const vh = this.videoEl.videoHeight;
      const side = Math.min(vw, vh);
      const sx = (vw - side) / 2;
      const sy = (vh - side) / 2;
      const out = document.createElement('canvas');
      out.width = 640;
      out.height = 640;
      out.getContext('2d').drawImage(this.videoEl, sx, sy, side, side, 0, 0, 640, 640);
      return out;
    }

    stop() {
      if (this._orientHandler && typeof window !== 'undefined') {
        window.removeEventListener('deviceorientation', this._orientHandler);
        this._orientHandler = null;
      }
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.track = null;
        this.torchOn = false;
      }
      if (this.videoEl) {
        this.videoEl.srcObject = null;
      }
    }
  }

  /**
   * Optional Gemini Vision API scanner for bills or piped meters (requires user's own API key).
   */
  async function aiScanWithGemini(apiKey, imageDataUrl, scanType) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('Add your free Gemini API key in Settings to use AI scanning.');
    }
    const match = String(imageDataUrl || '').match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid image format for AI scan.');

    const prompt =
      scanType === 'meter'
        ? 'Read the numeric digits on this UK LPG gas meter. Reply with valid JSON only: {"readingValue": number, "unit": "m3" or "ft3"}.'
        : 'Extract UK Calor/LPG gas bill delivery figures. Reply with valid JSON only: {"litres": number or null, "totalPaid": number or null, "unitPricePence": number or null, "standingChargePencePerDay": number or null, "vatIncluded": boolean, "date": "YYYY-MM-DD" or null, "supplier": string or null}.';

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
      apiKey.trim()
    )}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: match[1], data: match[2] } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      }),
    });

    if (!res.ok) {
      const errTxt = await res.text();
      throw new Error(`Gemini API returned ${res.status}: ${errTxt.slice(0, 140)}`);
    }

    const payload = await res.json();
    const rawText =
      payload &&
      payload.candidates &&
      payload.candidates[0] &&
      payload.candidates[0].content &&
      payload.candidates[0].content.parts &&
      payload.candidates[0].content.parts[0] &&
      payload.candidates[0].content.parts[0].text;

    if (!rawText) throw new Error('Gemini returned an empty response.');
    return JSON.parse(rawText);
  }

  return {
    detectDialNeedleFromRGBA,
    renderSyntheticDialToRGBA,
    renderSyntheticDial,
    compressPhotoBlob,
    DialOverlayController,
    CameraController,
    aiScanWithGemini,
  };
});
