(function () {
  'use strict';
  var dock = document.querySelector('.dock');
  if (!dock) return;
  var NEED = 5, WINDOW = 2000, COUNT = 30, MAX_SETS = 10, SPAWN = 1000, CALM_MS = 1500, FLOOR_MAX = 7000, HARD_STOP = 16000;
  var G = 3800, E_BALL = 0.7, E_WALL = 0.7, E_FLOOR = 0.65, MU = 0.35, INERTIA = 2 / 3, KF = 1 + 1 / INERTIA;
  var BOUNCE_MIN = 40, STEP = 1 / 240, ITER = 5, SLOP = 0.2, PUSH = 0.8;
  var REST_V = 50, REST_W = 40, ROLL_K = 4, ROLL_DEC = 280, SPIN_K = 4;
  var WAKE_V = 80, SWIPE_R = 16, MAX_V = 2200, MIN_SWIPE = 150;
  var BTN_DELAY = 1000, DWELL = 0.5, BLAST = 3400, LIFT = 1200, MAXB = 3600;
  var BOMB_R = 26, BOMB_M = 60, BOMB_GRAV = 4500, BOMB_V = 500, SINK_S = 2, UPBIAS = 0.3;
  var BOMB_E = 0.2, BOMB_BOUNCES = 2, BOMB_MIN_V = 150;
  var PALETTE = ['#e63946', '#f4a261', '#f6c945', '#2a9d8f', '#3a86ff', '#8338ec', '#ff5fa2', '#ffffff', '#7bd88f', '#1d3557'];
  var taps = [], running = false, show = null;

  /* The middle dock button in OncoScan is the Scan tab. */
  dock.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[data-tab="scan"]') : null;
    if (!a) return;
    var now = Date.now();
    taps.push(now);
    taps = taps.filter(function (t) { return now - t <= WINDOW; });
    if (taps.length >= NEED) {
      taps = [];
      if (!running) start();
      else if (show && show.sets < MAX_SETS) show.add();
    }
  }, true);

  function bounce(e, v) {
    var s = (v - BOUNCE_MIN) / 300;
    return s <= 0 ? 0 : Math.min(e, e * s);
  }
  function wake(b) { if (b.sleep) { b.sleep = false; b.rest = 0; } }
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    var t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function pickColors() {
    var i = Math.floor(Math.random() * PALETTE.length), j;
    do { j = Math.floor(Math.random() * PALETTE.length); } while (j === i);
    return [PALETTE[i], PALETTE[j]];
  }

  function start() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    running = true;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = window.innerWidth, H = window.innerHeight;
    var cv = document.createElement('canvas');
    cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:60';
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    document.body.appendChild(cv);
    var ctx = cv.getContext('2d');
    var prevTouch = document.documentElement.style.touchAction;
    document.documentElement.style.touchAction = 'none';

    var balls = [], bombs = [], fxs = [], btns = [], box = null, btnArmed = true, ceilOn = false;
    var t0 = performance.now(), last = t0, floorOn = true, calm = 0, acc = 0, raf = 0, lp = null, simT = 0, setAt = 0;

    function spawnSet(base) {
      for (var i = 0; i < COUNT; i++) {
        var r = 13 + Math.random() * 8, cc = pickColors();
        balls.push({
          x: r + Math.random() * Math.max(1, W - 2 * r), y: -r - Math.random() * 60,
          vx: (Math.random() - 0.5) * 240, vy: Math.random() * 200,
          r: r, m: r * r, a: Math.random() * 6.28, w: (Math.random() - 0.5) * 6,
          at: base + (i * SPAWN) / COUNT + Math.random() * 40,
          c1: cc[0], c2: cc[1],
          live: false, gone: false, floor: false, touch: false, sleep: false, rest: 0, freed: false, bomb: false
        });
      }
    }
    spawnSet(0);
    show = {
      sets: 1,
      add: function () {
        var el = performance.now() - t0;
        show.sets++;
        setAt = el; calm = 0; btnArmed = true; ceilOn = false;
        spawnSet(el);
        if (!floorOn) {
          floorOn = true;
          balls.forEach(function (b) {
            if (!b.live || b.gone) return;
            if (b.y > H - b.r) b.gone = true;
            else if (b.x > b.r && b.x < W - b.r) b.freed = false;
          });
        }
      }
    };

    function collide(p, q) {
      var dx = q.x - p.x, dy = q.y - p.y, min = p.r + q.r, d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 === 0) return;
      var d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
      var vn = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
      if (vn < -WAKE_V || p.bomb || q.bomb) { wake(p); wake(q); }
      var ip = p.sleep ? 0 : 1 / p.m, iq = q.sleep ? 0 : 1 / q.m, sum = ip + iq;
      if (sum === 0) return;
      var pen = min - d - SLOP;
      if (pen > 0) {
        var c = (PUSH * pen) / sum;
        p.x -= nx * c * ip; p.y -= ny * c * ip;
        q.x += nx * c * iq; q.y += ny * c * iq;
      }
      p.touch = true; q.touch = true;
      var jn = 0;
      if (vn < 0) {
        jn = (-(1 + bounce(E_BALL, -vn)) * vn) / sum;
        p.vx -= jn * ip * nx; p.vy -= jn * ip * ny;
        q.vx += jn * iq * nx; q.vy += jn * iq * ny;
      }
      var tx = -ny, ty = nx;
      var vt = (p.vx - q.vx) * tx + (p.vy - q.vy) * ty + p.w * p.r + q.w * q.r;
      var jt = -vt / (KF * sum), lim = MU * jn;
      if (jt > lim) jt = lim; else if (jt < -lim) jt = -lim;
      p.vx += jt * ip * tx; p.vy += jt * ip * ty;
      q.vx -= jt * iq * tx; q.vy -= jt * iq * ty;
      if (!p.sleep) p.w += jt / (INERTIA * p.m * p.r);
      if (!q.sleep) q.w += jt / (INERTIA * q.m * q.r);
    }

    function bounds() {
      for (var k = 0; k < balls.length; k++) {
        var b = balls[k];
        if (!b.live || b.gone || b.sleep) continue;
        if (!b.freed) {
          if (b.x < b.r) { b.x = b.r; if (b.vx < 0) b.vx = -b.vx * bounce(E_WALL, -b.vx); }
          else if (b.x > W - b.r) { b.x = W - b.r; if (b.vx > 0) b.vx = -b.vx * bounce(E_WALL, b.vx); }
        }
        if (ceilOn && b.y < b.r) { b.y = b.r; if (b.vy < 0) b.vy = -b.vy * bounce(E_WALL, -b.vy); }
        if (floorOn && b.y > H - b.r) {
          b.y = H - b.r;
          var jn = 0;
          if (b.vy > 0) {
            var e = bounce(E_FLOOR, b.vy);
            if (b.bomb) {
              if (b.vy > BOMB_MIN_V && b.bounces < BOMB_BOUNCES) { e = BOMB_E; b.bounces++; }
              else { e = 0; if (b.hitAt === null) b.hitAt = simT; }
            }
            jn = (1 + e) * b.vy * b.m;
            b.vy = -e * b.vy;
          }
          var vs = b.vx - b.w * b.r;
          var jt = (-vs * b.m) / KF, lim = MU * jn;
          if (jt > lim) jt = lim; else if (jt < -lim) jt = -lim;
          b.vx += jt / b.m;
          b.w -= jt / (INERTIA * b.m * b.r);
          b.floor = true;
        }
      }
    }

    /* Fluid in the IV bag: a lightweight slosh model, not a full fluid simulation.
       The surface stays level in the world while the bag tumbles. A spring-damper tilts it when the bag is pushed
       sideways, and floor impacts start a decaying surface wave. */
    function slosh(b, h) {
      var dvx = b.vx - b.pvx, dvy = b.vy - b.pvy - BOMB_GRAV * h;
      b.pvx = b.vx; b.pvy = b.vy;
      b.sv -= dvx * 0.02;
      if (dvy < -60) b.wa = Math.min(b.r * 0.3, b.wa + b.r * Math.min(0.25, -dvy / 7000));
      b.sv += (-70 * b.s - 3.2 * b.sv) * h;
      b.s += b.sv * h;
      if (b.s > 0.9) { b.s = 0.9; if (b.sv > 0) b.sv = 0; } else if (b.s < -0.9) { b.s = -0.9; if (b.sv < 0) b.sv = 0; }
      b.wp += 16 * h;
      b.wa *= 1 - 2.4 * h;
    }

    function step(h, el) {
      var k, m, b, it, dv, dw;
      simT += h;
      for (k = 0; k < balls.length; k++) {
        b = balls[k];
        if (b.gone || b.sleep) continue;
        if (!b.live) { if (el >= b.at) b.live = true; else continue; }
        if (b.bomb) slosh(b, h);
        b.vy += (b.bomb ? BOMB_GRAV : G) * h;
        b.vx *= 1 - 0.1 * h;
        b.w *= 1 - 0.1 * h;
        if (b.floor) {
          b.vx *= 1 - ROLL_K * h;
          b.w *= 1 - ROLL_K * h;
        }
        if (!b.bomb && (b.floor || b.touch)) {
          dv = ROLL_DEC * h;
          dw = dv / b.r;
          b.vx = b.vx > dv ? b.vx - dv : (b.vx < -dv ? b.vx + dv : 0);
          b.w = b.w > dw ? b.w - dw : (b.w < -dw ? b.w + dw : 0);
        }
        if (b.touch && !b.bomb) b.w *= 1 - SPIN_K * h;
        if (!b.bomb) {
          if ((b.floor || b.touch) && b.vx * b.vx + b.vy * b.vy < REST_V * REST_V && Math.abs(b.w * b.r) < REST_W) b.rest += h;
          else b.rest = 0;
          if (b.rest > 0.25) { b.sleep = true; b.vx = 0; b.vy = 0; b.w = 0; }
        }
        b.floor = false; b.touch = false;
        if (b.sleep) continue;
        b.x += b.vx * h; b.y += b.vy * h; b.a += b.w * h;
      }
      for (it = 0; it < ITER; it++) {
        for (k = 0; k < balls.length; k++) {
          if (!balls[k].live || balls[k].gone) continue;
          for (m = k + 1; m < balls.length; m++) {
            if (balls[m].live && !balls[m].gone) collide(balls[k], balls[m]);
          }
        }
        bounds();
      }
    }

    function hit(ax, ay, px, py, pvx, pvy) {
      for (var k = 0; k < balls.length; k++) {
        var b = balls[k];
        if (!b.live || b.gone || b.bomb) continue;
        if (segDist(b.x, b.y, ax, ay, px, py) > b.r + SWIPE_R) continue;
        wake(b);
        b.vx += (pvx * 0.8 - b.vx) * 0.6;
        b.vy += (pvy * 0.8 - b.vy) * 0.6;
        var sp = Math.hypot(b.vx, b.vy);
        if (sp > MAX_V) { b.vx *= MAX_V / sp; b.vy *= MAX_V / sp; sp = MAX_V; }
        b.w += (((px - b.x) * pvy - (py - b.y) * pvx) / (b.r * b.r)) * 0.3;
        if (sp > 500) b.freed = true;
      }
    }
    function onDown(e) { lp = { x: e.clientX, y: e.clientY, t: performance.now() }; }
    function onMove(e) {
      var now = performance.now(), x = e.clientX, y = e.clientY;
      if (lp && now > lp.t) {
        var dt = Math.max(now - lp.t, 8) / 1000;
        var vx = (x - lp.x) / dt, vy = (y - lp.y) / dt;
        if (Math.hypot(vx, vy) > MIN_SWIPE) hit(lp.x, lp.y, x, y, vx, vy);
      }
      lp = { x: x, y: y, t: now };
    }
    function onEnd() { lp = null; }
    window.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onEnd, { passive: true });
    window.addEventListener('pointercancel', onEnd, { passive: true });

    function openFloor() {
      floorOn = false;
      ceilOn = false;
      balls.forEach(function (b) {
        if (b.gone) return;
        wake(b);
        b.vx += (Math.random() - 0.5) * 120;
      });
    }

    function hideBtns(slide) {
      var list = btns, wrap = box;
      btns = [];
      box = null;
      list.forEach(function (el, i) {
        el.style.pointerEvents = 'none';
        if (!el.animate) return;
        if (slide) el.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(170%)', opacity: 1 }], { duration: 380, delay: i * 30, easing: 'cubic-bezier(.5,0,.9,.4)', fill: 'forwards' });
        else el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.6)' }], { duration: 180, fill: 'forwards' });
      });
      setTimeout(function () { if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); }, slide ? 440 + list.length * 30 : 220);
    }
    function pressBtn(el) {
      var at = btns.indexOf(el);
      if (at < 0) return;
      btns.splice(at, 1);
      el.style.pointerEvents = 'none';
      if (el.animate) el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.6)' }], { duration: 180, fill: 'forwards' });
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
      if (!btns.length && box) {
        var wrap = box;
        box = null;
        setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 220);
      }
      dropBomb();
    }
    function showBtns() {
      var n = Math.max(1, Math.min(show ? show.sets : 1, MAX_SETS));
      var add = n - btns.length, i, el;
      btnArmed = false;
      if (add <= 0) return;
      if (!box) {
        box = document.createElement('div');
        box.style.cssText = 'position:fixed;right:12px;top:24%;z-index:61;display:flex;flex-direction:column;flex-wrap:wrap-reverse;align-items:flex-end;gap:8px;max-height:56vh;pointer-events:none';
        document.body.appendChild(box);
      }
      for (i = 0; i < add; i++) {
        el = document.createElement('button');
        el.type = 'button';
        el.textContent = 'TNT \uD83D\uDCA5';
        el.setAttribute('aria-label', 'Drop an IV bag bomb');
        el.style.cssText = 'padding:.6rem 1.05rem;border-radius:999px;border:2px solid #fff;background:#d92d20;color:#fff;font-family:inherit;font-weight:800;font-size:1rem;letter-spacing:.06em;box-shadow:0 6px 18px rgba(217,45,32,.5);cursor:pointer;touch-action:manipulation;pointer-events:auto';
        el.addEventListener('click', pressBtn.bind(null, el));
        box.appendChild(el);
        btns.push(el);
        if (el.animate) el.animate([{ transform: 'scale(0) rotate(-12deg)', opacity: 0 }, { transform: 'scale(1.15) rotate(3deg)', opacity: 1, offset: 0.7 }, { transform: 'scale(1) rotate(0deg)', opacity: 1 }], { duration: 420, delay: i * 60, easing: 'cubic-bezier(.3,1.4,.5,1)', fill: 'both' });
      }
    }

    function dropBomb() {
      var r = BOMB_R, d = H + 10, g = BOMB_GRAV;
      var tFall = (-BOMB_V + Math.sqrt(BOMB_V * BOMB_V + 2 * g * d)) / g;
      var b = {
        x: W * 0.2 + Math.random() * W * 0.6, y: -r - 10, vx: (Math.random() - 0.5) * 60, vy: BOMB_V,
        r: r, m: BOMB_M * r * r, a: 0, w: 0, at: 0, live: true, gone: false, floor: false, touch: false,
        sleep: false, rest: 0, freed: false, bomb: true, hitAt: null, bounces: 0, born: simT, fuse: tFall + SINK_S,
        s: 0, sv: 0, wa: 0, wp: 0, pvx: 0, pvy: BOMB_V
      };
      b.pvx = b.vx;
      bombs.push(b);
      balls.push(b);
    }

    function explode(b, now) {
      var bx = b.x, by = b.y, reach = Math.max(W, H) * 0.9;
      var at = bombs.indexOf(b);
      if (at >= 0) bombs.splice(at, 1);
      b.gone = true;
      calm = 0;
      ceilOn = true;
      if (!bombs.length) floorOn = false;
      setAt = (now - t0) - SPAWN;
      balls.forEach(function (o) {
        if (o.gone || !o.live || o.bomb) return;
        wake(o);
        var dx = o.x - bx, dy = o.y - by, d = Math.hypot(dx, dy) || 1;
        var f = Math.max(0.3, 1 - d / reach);
        var ux = dx / d, uy = dy / d - UPBIAS, un = Math.hypot(ux, uy) || 1;
        ux /= un; uy /= un;
        o.vx += ux * BLAST * f;
        o.vy += uy * BLAST * f - LIFT * f;
        var sp = Math.hypot(o.vx, o.vy);
        if (sp > MAXB) { o.vx *= MAXB / sp; o.vy *= MAXB / sp; }
        o.w += (Math.random() - 0.5) * 20;
        o.freed = false;
      });
      fxs.push({ x: bx, y: by, t: now });
      if (navigator.vibrate) { try { navigator.vibrate(80); } catch (e) {} }
    }

    /* Pill: a capsule split down the middle, one colour per half. */
    function capsulePath(hl, hw) {
      ctx.beginPath();
      ctx.moveTo(-hl + hw, -hw);
      ctx.lineTo(hl - hw, -hw);
      ctx.arc(hl - hw, 0, hw, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(-hl + hw, hw);
      ctx.arc(-hl + hw, 0, hw, Math.PI / 2, Math.PI * 1.5);
      ctx.closePath();
    }
    function draw(b) {
      var hl = b.r * 1.15, hw = b.r * 0.5;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      capsulePath(hl, hw);
      ctx.save();
      ctx.clip();
      ctx.fillStyle = b.c1;
      ctx.fillRect(-hl, -hw, hl, hw * 2);
      ctx.fillStyle = b.c2;
      ctx.fillRect(0, -hw, hl, hw * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(-hl, -hw * 0.75, hl * 2, hw * 0.3);
      ctx.restore();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      capsulePath(hl, hw);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -hw);
      ctx.lineTo(0, hw);
      ctx.stroke();
      ctx.restore();
    }

    /* IV bag bomb: bag body, fluid, label, ticks, drip tube, and a fuse out of the top port. */
    function bagPath(x0, y0, w, h, rad) {
      ctx.beginPath();
      ctx.moveTo(x0 + rad, y0);
      ctx.lineTo(x0 + w - rad, y0);
      ctx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + rad);
      ctx.lineTo(x0 + w, y0 + h - rad);
      ctx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - rad, y0 + h);
      ctx.lineTo(x0 + rad, y0 + h);
      ctx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - rad);
      ctx.lineTo(x0, y0 + rad);
      ctx.quadraticCurveTo(x0, y0, x0 + rad, y0);
      ctx.closePath();
    }
    function drawBomb(b) {
      var r = b.r, bw = r * 1.3, bh = r * 1.6, x0 = -bw / 2, y0 = -bh / 2;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#6b7a86';
      ctx.lineWidth = Math.max(2, r * 0.12);
      ctx.beginPath(); ctx.moveTo(0, bh / 2 - 1); ctx.lineTo(0, bh / 2 + r * 0.45); ctx.stroke();
      ctx.fillStyle = '#9fb3c0';
      ctx.fillRect(-r * 0.12, bh / 2 + r * 0.1, r * 0.24, r * 0.14);
      bagPath(x0, y0, bw, bh, r * 0.28);
      ctx.fillStyle = 'rgba(214,236,244,0.95)';
      ctx.fill();
      ctx.save();
      bagPath(x0, y0, bw, bh, r * 0.28);
      ctx.clip();
      /* Fluid: bright red like doxorubicin. Surface is level in the world frame (rotate back by the bag angle). */
      var sa = b.s + b.a, dnx = Math.sin(sa), dny = Math.cos(sa), tnx = Math.cos(sa), tny = -Math.sin(sa);
      var lev = bh * 0.2, span = bw * 1.5, nPts = 14, sx = [], sy = [], j;
      for (j = 0; j <= nPts; j++) {
        var u = -span + (2 * span * j) / nPts, wv = b.wa * Math.sin((u / r) * 2.6 + b.wp);
        sx.push(-dnx * (lev + wv) + tnx * u);
        sy.push(-dny * (lev + wv) + tny * u);
      }
      ctx.beginPath();
      ctx.moveTo(sx[0], sy[0]);
      for (j = 1; j <= nPts; j++) ctx.lineTo(sx[j], sy[j]);
      ctx.lineTo(sx[nPts] + dnx * bh * 2, sy[nPts] + dny * bh * 2);
      ctx.lineTo(sx[0] + dnx * bh * 2, sy[0] + dny * bh * 2);
      ctx.closePath();
      ctx.fillStyle = '#e3112c';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(sx[0], sy[0]);
      for (j = 1; j <= nPts; j++) ctx.lineTo(sx[j], sy[j]);
      ctx.strokeStyle = 'rgba(255,200,200,0.7)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillRect(x0 + bw * 0.12, y0, bw * 0.12, bh);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x0 + bw * 0.18, y0 + bh * 0.42, bw * 0.64, bh * 0.28);
      ctx.fillStyle = '#d92d20';
      ctx.font = '800 ' + Math.round(r * 0.46) + 'px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TNT', 0, y0 + bh * 0.56);
      ctx.strokeStyle = 'rgba(40,60,75,0.55)';
      ctx.lineWidth = 1;
      for (var i = 0; i < 4; i++) {
        var ty = y0 + bh * (0.34 + i * 0.16);
        ctx.beginPath(); ctx.moveTo(x0 + bw, ty); ctx.lineTo(x0 + bw - r * (i % 2 ? 0.16 : 0.26), ty); ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = '#33505f';
      ctx.lineWidth = 1.6;
      bagPath(x0, y0, bw, bh, r * 0.28);
      ctx.stroke();
      ctx.fillStyle = '#33505f';
      ctx.fillRect(-r * 0.16, y0 - r * 0.14, r * 0.32, r * 0.16);
      var burn = Math.min(1, (simT - b.born) / b.fuse);
      if (b.hitAt !== null) burn = Math.max(burn, 0.6 + 0.4 * Math.min(1, (simT - b.hitAt) / DWELL));
      var len = 1 - burn, fx0 = 0, fy0 = y0 - r * 0.14;
      var ex = fx0 + r * 0.5 * len, ey = fy0 - r * 0.9 * len;
      ctx.strokeStyle = '#c9a66b';
      ctx.lineWidth = Math.max(2, r * 0.12);
      ctx.beginPath();
      ctx.moveTo(fx0, fy0);
      ctx.quadraticCurveTo(fx0 + r * 0.05, fy0 - r * 0.6 * len, ex, ey);
      ctx.stroke();
      var rr = r * (0.22 + 0.12 * Math.random());
      ctx.fillStyle = Math.random() < 0.5 ? '#ffd23f' : '#ff7a1a';
      ctx.beginPath(); ctx.arc(ex, ey, rr, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(ex, ey, rr * 0.45, 0, 6.2832); ctx.fill();
      ctx.restore();
    }

    function drawFx(f, now) {
      var p = (now - f.t) / 600;
      if (p >= 1) return false;
      var rad = p * Math.max(W, H) * 0.7 + 1;
      var g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, rad);
      g.addColorStop(0, 'rgba(255,255,255,' + 0.9 * (1 - p) + ')');
      g.addColorStop(0.35, 'rgba(255,170,40,' + 0.6 * (1 - p) + ')');
      g.addColorStop(1, 'rgba(255,90,20,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,220,150,' + 0.8 * (1 - p) + ')';
      ctx.lineWidth = 6 * (1 - p) + 1;
      ctx.beginPath();
      ctx.arc(f.x, f.y, rad * 0.9, 0, 6.2832);
      ctx.stroke();
      return true;
    }

    function finish() {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      document.documentElement.style.touchAction = prevTouch;
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null;
      btns = [];
      if (cv.parentNode) cv.parentNode.removeChild(cv);
      show = null;
      running = false;
    }

    function frame(now) {
      var dt = Math.min((now - last) / 1000, 0.05), k, b;
      last = now;
      var el = now - t0;
      acc += dt;
      while (acc >= STEP) { step(STEP, el); acc -= STEP; }
      bombs.slice().forEach(function (o) {
        if (o.gone) { var i = bombs.indexOf(o); if (i >= 0) bombs.splice(i, 1); return; }
        if ((o.hitAt !== null && simT - o.hitAt >= DWELL) || simT - o.born >= o.fuse) explode(o, now);
      });
      if (floorOn && btnArmed && (btns.length || el - setAt > BTN_DELAY)) showBtns();
      if (btns.length && !floorOn) hideBtns(true);
      if (floorOn && !bombs.length) {
        if (el - setAt > FLOOR_MAX) openFloor();
        else if (el > setAt + SPAWN + 300) {
          var busy = false;
          for (k = 0; k < balls.length; k++) {
            b = balls[k];
            if (b.live && !b.gone && !b.sleep) { busy = true; break; }
          }
          calm = busy ? 0 : calm + dt * 1000;
          if (calm > CALM_MS) openFloor();
        }
      }
      for (k = 0; k < balls.length; k++) {
        b = balls[k];
        if (!b.live || b.gone) continue;
        if (b.x < -b.r - 30 || b.x > W + b.r + 30 || b.y < -H * 3 || (!floorOn && !b.bomb && b.y > H + b.r + 20)) b.gone = true;
      }
      if (balls.length > 40) balls = balls.filter(function (x) { return !x.gone; });
      var alive = 0;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      fxs = fxs.filter(function (f) { return drawFx(f, now); });
      for (k = 0; k < balls.length; k++) {
        b = balls[k];
        if (b.gone) continue;
        alive++;
        if (b.live) { if (b.bomb) drawBomb(b); else draw(b); }
      }
      if ((alive === 0 && !fxs.length) || el - setAt > HARD_STOP) { finish(); return; }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  }
})();
