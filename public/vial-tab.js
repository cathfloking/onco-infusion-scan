(function () {
  'use strict';
  var link = document.querySelector('.dock a[data-tab="scan"]');
  var cv = link && link.querySelector('canvas.vial-ico');
  if (!cv || !cv.getContext) return;
  var ctx = cv.getContext('2d');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SIZE = 44, R = 17, STEP = 1 / 240, LIQUID = '#ff4d5e';
  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  cv.width = Math.round(SIZE * dpr);
  cv.height = Math.round(SIZE * dpr);
  cv.style.width = SIZE + 'px';
  cv.style.height = SIZE + 'px';

  /* The vial is a small spring-mounted body. Tapping the tab kicks it, and the liquid inside uses the same slosh
     model as the falling items in the easter egg: the surface stays level in the world while the vial tumbles. */
  var b = { r: R, x: 0, y: 0, vx: 0, vy: 0, a: 0, w: 0, s: 0, sv: 0, wa: 0, wp: 0, pvx: 0, pvy: 0 };
  var raf = 0, last = 0, acc = 0, calm = 0;

  function rrPath(x0, y0, w, h, rad) {
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

  function drawFluid(cx, cy, w, h, frac, color, ws) {
    var sa = b.s + b.a, dnx = Math.sin(sa), dny = Math.cos(sa), tnx = Math.cos(sa), tny = -Math.sin(sa);
    var lev = (frac - 0.5) * h, span = Math.max(w, h) * 1.2, big = (w + h) * 2, nPts = 14, sx = [], sy = [], j;
    for (j = 0; j <= nPts; j++) {
      var u = -span + (2 * span * j) / nPts, wv = b.wa * ws * Math.sin((u / b.r) * 2.6 + b.wp);
      sx.push(-dnx * (lev + wv) + tnx * u);
      sy.push(-dny * (lev + wv) + tny * u);
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(sx[0], sy[0]);
    for (j = 1; j <= nPts; j++) ctx.lineTo(sx[j], sy[j]);
    ctx.lineTo(sx[nPts] + dnx * big, sy[nPts] + dny * big);
    ctx.lineTo(sx[0] + dnx * big, sy[0] + dny * big);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(sx[0], sy[0]);
    for (j = 1; j <= nPts; j++) ctx.lineTo(sx[j], sy[j]);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    var r = R, bw = r * 1.0, bh = r * 1.07, bx0 = -bw / 2, by0 = -r * 0.32;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.translate(SIZE / 2 + b.x, SIZE / 2 + b.y);
    ctx.rotate(b.a);
    ctx.lineJoin = 'round';
    rrPath(bx0, by0, bw, bh, r * 0.14);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fill();
    ctx.save();
    rrPath(bx0, by0, bw, bh, r * 0.14);
    ctx.clip();
    drawFluid(0, by0 + bh / 2, bw, bh, 0.58, LIQUID, 0.6);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(bx0 + bw * 0.14, by0 + bh * 0.08, bw * 0.14, bh * 0.84);
    ctx.restore();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    rrPath(bx0, by0, bw, bh, r * 0.14);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillRect(-r * 0.22, -r * 0.52, r * 0.44, r * 0.24);
    ctx.strokeRect(-r * 0.22, -r * 0.52, r * 0.44, r * 0.24);
    ctx.fillStyle = '#ffffff';
    rrPath(-r * 0.32, -r * 0.76, r * 0.64, r * 0.26, r * 0.06);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function step(h) {
    b.vx += (-300 * b.x - 8 * b.vx) * h; b.x += b.vx * h;
    b.vy += (-300 * b.y - 8 * b.vy) * h; b.y += b.vy * h;
    b.w += (-120 * b.a - 6 * b.w) * h; b.a += b.w * h;
    if (b.x > 7) { b.x = 7; if (b.vx > 0) b.vx = 0; } else if (b.x < -7) { b.x = -7; if (b.vx < 0) b.vx = 0; }
    if (b.y > 7) { b.y = 7; if (b.vy > 0) b.vy = 0; } else if (b.y < -7) { b.y = -7; if (b.vy < 0) b.vy = 0; }
    var dvx = b.vx - b.pvx, dvy = b.vy - b.pvy;
    b.pvx = b.vx; b.pvy = b.vy;
    b.sv -= dvx * 0.06;
    if (dvy < -60) b.wa = Math.min(b.r * 0.3, b.wa + b.r * Math.min(0.25, -dvy / 7000));
    b.sv += (-70 * b.s - 3.2 * b.sv) * h;
    b.s += b.sv * h;
    if (b.s > 0.9) { b.s = 0.9; if (b.sv > 0) b.sv = 0; } else if (b.s < -0.9) { b.s = -0.9; if (b.sv < 0) b.sv = 0; }
    b.wp += 16 * h;
    b.wa *= 1 - 2.4 * h;
  }

  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    acc += dt;
    while (acc >= STEP) { step(STEP); acc -= STEP; }
    draw();
    var energy = Math.abs(b.x) + Math.abs(b.y) + Math.abs(b.a) + Math.abs(b.s) + b.wa / R +
      (Math.abs(b.vx) + Math.abs(b.vy)) / 100 + Math.abs(b.w) * 0.1 + Math.abs(b.sv) * 0.1;
    calm = energy < 0.02 ? calm + dt : 0;
    if (calm > 0.3) {
      b.x = b.y = b.vx = b.vy = b.a = b.w = b.s = b.sv = b.wa = 0;
      b.pvx = b.pvy = 0;
      draw();
      raf = 0;
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function jostle(power) {
    if (reduce) return;
    var p = power || 1, sg = Math.random() < 0.5 ? -1 : 1;
    b.vx += sg * (160 + Math.random() * 100) * p;
    b.vy += (Math.random() - 0.4) * 160 * p;
    b.w += (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 3) * p;
    b.wa = Math.max(b.wa, R * 0.3);
    calm = 0;
    if (!raf) { last = performance.now(); acc = 0; raf = requestAnimationFrame(frame); }
  }

  draw();
  link.addEventListener('click', function () { jostle(1); });
  setTimeout(function () { jostle(0.6); }, 700);
})();
