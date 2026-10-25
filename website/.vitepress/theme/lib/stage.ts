// A canvas that sizes itself to its box (sharp on any screen), runs a frame loop only while it is on screen, and reads
// the site's colours from CSS so light and dark both work.
export interface Palette {
  paper: string; panel: string; ink: string; ink2: string; ink3: string; rule: string; grid: string;
  ws: string; wsSoft: string; dg: string; dgFill: string; dgSoft: string; loss: string; ok: string; server: string;
  display: string; body: string; mono: string;
}
export interface Frame { g: CanvasRenderingContext2D; w: number; h: number; dt: number; c: Palette; t: number }

export function palette(el: Element): Palette {
  const s = getComputedStyle(el), v = (n: string) => s.getPropertyValue(n).trim();
  return {
    paper: v('--tw-paper'), panel: v('--tw-panel'), ink: v('--tw-ink'), ink2: v('--tw-ink-2'), ink3: v('--tw-ink-3'),
    rule: v('--tw-rule'), grid: v('--tw-grid'), ws: v('--tw-ws'), wsSoft: v('--tw-ws-soft'), dg: v('--tw-dg'),
    dgFill: v('--tw-dg-fill'), dgSoft: v('--tw-dg-soft'), loss: v('--tw-loss'), ok: v('--tw-ok'), server: v('--tw-server'),
    display: v('--tw-font-display'), body: v('--tw-font-body'), mono: v('--tw-font-mono'),
  };
}

export function stage(canvas: HTMLCanvasElement, height: (width: number) => number, draw: (f: Frame) => void): () => void {
  const g = canvas.getContext('2d')!;
  let w = 0, h = 0, raf = 0, last = performance.now(), visible = true, c = palette(canvas), stopped = false;
  const resize = () => {
    const box = canvas.parentElement!.clientWidth || 600, dpr = Math.min(3, window.devicePixelRatio || 1);
    w = box; h = Math.round(height(box));
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const ro = new ResizeObserver(resize); ro.observe(canvas.parentElement!); resize();
  const io = new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); }, { rootMargin: '120px' }); io.observe(canvas);
  const mo = new MutationObserver(() => { c = palette(canvas); }); mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  const loop = (now: number) => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    // (the first frame's timestamp can be earlier than the performance.now() taken at setup)
    const dt = Math.max(0, Math.min(100, now - last)); last = Math.max(last, now);
    if (!visible || document.hidden) return;
    g.clearRect(0, 0, w, h);
    draw({ g, w, h, dt, c, t: now });
  };
  raf = requestAnimationFrame(loop);
  return () => { stopped = true; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); mo.disconnect(); };
}

/** A rounded rectangle path. */
export function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
export function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, font: string, align: CanvasTextAlign = 'left') {
  g.fillStyle = color; g.font = font; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(text, x, y);
}
