import type { LoopNode } from './types';
import { KIND_LABEL, fmtChars, fmtInt, fmtTime, fmtTokens, isCodeLike } from './format';
import { el } from './util';

/**
 * One shared tooltip for the whole app.
 *
 * - Lives in the top layer via the Popover API (`popover="manual"`) when
 *   supported (feature-detected: `'popover' in HTMLElement.prototype`), with a
 *   position:fixed fallback otherwise — per the position-aware-tooltips guide.
 * - Placement, primary path (engines with CSS anchor positioning): a zero-size
 *   HTML anchor shim is placed ONCE at the trigger's client-rect centre (a single
 *   getBoundingClientRect read at show time) and the tooltip attaches to it with
 *   `position-area: right` + `position-try-fallbacks: left, block-start, block-end`,
 *   so the BROWSER self-regulates left-vs-right by available space and keeps
 *   tracking the anchor through scroll and resize. The shim exists because SVG
 *   shape elements cannot be anchor targets (verified in Chromium 151: anchor-name
 *   on an SVG rect is ignored and the popover falls back to the default position);
 *   triggers here are D3-generated SVG marks.
 * - Placement, fallback path (engines without anchor positioning, or forced via
 *   `?no-anchor` for QA): side-first manual placement — right of the trigger, then
 *   left, then below/above when neither side fits — with viewport clamping and
 *   reposition on scroll/resize, so behaviour matches the native path.
 * - WCAG 1.4.13: hoverable (pointer can move onto the tooltip), dismissible
 *   (Escape), persistent (stays while hovered/focused). Click / Enter / Space
 *   pins it so the scrollable full text can be read with the keyboard.
 */

export interface TipContent {
  title: string;
  badges?: { text: string; color?: string }[];
  rows: [label: string, value: string][];
  text?: { body: string; mono: boolean; truncated?: boolean; label?: string };
  actions?: { label: string; onClick: () => void }[];
}

export type TipResolver = (target: Element) => TipContent | null;

const supportsPopover = 'popover' in HTMLElement.prototype;

/**
 * Native CSS anchor positioning: gate behind CSS.supports (position-aware-tooltips
 * guide) and allow QA to force the manual fallback path with ?no-anchor.
 *
 * The anchor name itself (--obvious-tip) lives in styles.css, which binds the tooltip
 * to the shim with position-anchor / position-area / position-try-fallbacks.
 */
const supportsAnchor =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('anchor-name: --a') &&
  CSS.supports('position-area: right') &&
  !new URLSearchParams(location.search).has('no-anchor');

class Tooltip {
  readonly root: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly anchorEl: HTMLDivElement | null;
  private trigger: Element | null = null;
  private pinned = false;
  private hideTimer = 0;
  private overTip = false;

  constructor() {
    this.root = el('div', { id: 'tip', class: 'tip', role: 'tooltip' });
    if (supportsPopover) this.root.setAttribute('popover', 'manual');
    this.content = el('div', { class: 'tip-content' });
    this.closeBtn = el('button', { type: 'button', class: 'tip-close', 'aria-label': 'Close details' }, '×');
    this.closeBtn.hidden = true;
    this.closeBtn.addEventListener('click', () => this.unpin(true));
    this.root.append(this.closeBtn, this.content);
    document.body.append(this.root);
    // Native path only: a zero-size fixed shim carries the anchor (SVG shapes cannot be
    // anchor targets — see header comment); styles.css binds the tooltip to it by name.
    this.anchorEl = supportsAnchor ? el('div', { class: 'tip-anchor', 'aria-hidden': 'true' }) : null;
    if (this.anchorEl) document.body.append(this.anchorEl);

    this.root.addEventListener('pointerenter', () => { this.overTip = true; clearTimeout(this.hideTimer); });
    this.root.addEventListener('pointerleave', () => { this.overTip = false; if (!this.pinned) this.scheduleHide(); });
    this.root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.unpin(true); } });
    document.addEventListener('pointerdown', (e) => {
      if (!this.pinned) return;
      const t = e.target as Node;
      if (this.root.contains(t) || (this.trigger && this.trigger.contains(t))) return;
      this.unpin(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen()) this.unpin(true); });
    if (!supportsAnchor) {
      // Fallback path only: reposition on scroll/resize. With native anchor positioning the
      // browser tracks the anchor itself (position-visibility: anchors-visible hides the tip
      // when the anchor scrolls out of view).
      window.addEventListener('scroll', () => { if (this.isOpen() && this.trigger) this.positionFallback(this.trigger); }, { passive: true, capture: true });
      window.addEventListener('resize', () => { if (this.isOpen() && this.trigger) this.positionFallback(this.trigger); });
    }
  }

  /** Delegate hover/focus/click handling to a container; `resolve` maps a target to content. */
  attach(container: HTMLElement, resolve: TipResolver): void {
    const find = (t: EventTarget | null): Element | null => (t instanceof Element ? t.closest('[data-tip]') : null);
    container.addEventListener('pointerover', (e) => {
      const t = find(e.target);
      if (!t || t === this.trigger) return;
      if (this.pinned) return;
      const c = resolve(t); if (c) this.show(t, c, false);
    });
    container.addEventListener('pointerout', (e) => {
      const t = find(e.target);
      if (!t || this.pinned) return;
      const to = (e as PointerEvent).relatedTarget as Node | null;
      if (to && (t.contains(to) || this.root.contains(to))) return;
      this.scheduleHide();
    });
    container.addEventListener('focusin', (e) => {
      const t = find(e.target);
      if (!t || this.pinned) return;
      const c = resolve(t); if (c) this.show(t, c, false);
    });
    container.addEventListener('focusout', (e) => {
      const t = find(e.target);
      if (!t || this.pinned) return;
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (to && this.root.contains(to)) return;
      this.hide();
    });
    container.addEventListener('click', (e) => {
      const t = find(e.target);
      if (!t) return;
      e.preventDefault();
      this.togglePin(t, resolve);
    });
    // Enter on keydown, Space on keyup (native button semantics, accessibility guide §5).
    container.addEventListener('keydown', (e) => {
      const t = find(e.target); if (!t) return;
      if (e.key === 'Enter') { e.preventDefault(); this.togglePin(t, resolve); }
      else if (e.key === ' ') e.preventDefault();
    });
    container.addEventListener('keyup', (e) => {
      const t = find(e.target); if (!t) return;
      if (e.key === ' ') { e.preventDefault(); this.togglePin(t, resolve); }
    });
  }

  private togglePin(t: Element, resolve: TipResolver): void {
    if (this.pinned && this.trigger === t) { this.unpin(true); return; }
    const c = resolve(t); if (!c) return;
    this.show(t, c, true);
  }

  isOpen(): boolean {
    return supportsPopover ? this.root.matches(':popover-open') : this.root.classList.contains('is-open');
  }

  show(trigger: Element, c: TipContent, pin: boolean): void {
    clearTimeout(this.hideTimer);
    if (this.trigger && this.trigger !== trigger) this.detach(this.trigger);
    this.trigger = trigger;
    this.pinned = pin;
    this.render(c);
    this.root.classList.toggle('is-pinned', pin);
    this.root.setAttribute('role', pin ? 'dialog' : 'tooltip');
    if (pin) this.root.setAttribute('aria-label', `${c.title} details`); else this.root.removeAttribute('aria-label');
    this.closeBtn.hidden = !pin;
    trigger.setAttribute('aria-describedby', 'tip');
    trigger.setAttribute('aria-expanded', pin ? 'true' : 'false');
    if (supportsAnchor) this.placeAnchor(trigger);
    if (!this.isOpen()) {
      if (supportsPopover) this.root.showPopover(); else this.root.classList.add('is-open');
    }
    if (!supportsAnchor) this.positionFallback(trigger);
    if (pin) this.closeBtn.focus({ preventScroll: true });
  }

  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => { if (!this.overTip && !this.pinned) this.hide(); }, 120);
  }

  hide(): void {
    clearTimeout(this.hideTimer);
    if (this.trigger) this.detach(this.trigger);
    this.trigger = null;
    this.pinned = false;
    this.root.classList.remove('is-pinned');
    if (this.isOpen()) {
      if (supportsPopover) this.root.hidePopover(); else this.root.classList.remove('is-open');
    }
  }

  private unpin(returnFocus: boolean): void {
    const t = this.trigger;
    this.hide();
    if (returnFocus && (t instanceof HTMLElement || t instanceof SVGElement)) t.focus({ preventScroll: true });
  }

  private detach(t: Element): void {
    t.removeAttribute('aria-describedby');
    t.setAttribute('aria-expanded', 'false');
  }

  private render(c: TipContent): void {
    const frag = document.createDocumentFragment();
    const head = el('div', { class: 'tip-head' });
    head.append(el('strong', { class: 'tip-title' }, c.title));
    if (c.badges?.length) {
      const b = el('div', { class: 'tip-badges' });
      for (const bd of c.badges) {
        const s = el('span', { class: 'badge' }, bd.text);
        if (bd.color) s.style.setProperty('--badge', bd.color);
        b.append(s);
      }
      head.append(b);
    }
    frag.append(head);
    if (c.rows.length) {
      const dl = el('dl', { class: 'tip-rows' });
      for (const [k, v] of c.rows) dl.append(el('dt', {}, k), el('dd', {}, v));
      frag.append(dl);
    }
    if (c.text) {
      const lab = el('div', { class: 'tip-textlabel' }, c.text.label ?? 'Full text');
      if (c.text.truncated) lab.append(el('span', { class: 'muted' }, ' (truncated at 6,000 chars by the pipeline)'));
      const pre = el('pre', { class: `tip-text${c.text.mono ? ' mono' : ''}`, tabindex: '0' });
      pre.textContent = c.text.body || '(empty)';
      frag.append(lab, pre);
    }
    if (c.actions?.length) {
      const bar = el('div', { class: 'tip-actions' });
      for (const a of c.actions) {
        const btn = el('button', { type: 'button', class: 'btn' }, a.label);
        btn.addEventListener('click', () => a.onClick());
        bar.append(btn);
      }
      frag.append(bar);
    }
    frag.append(el('p', { class: 'tip-hint muted' }, this.pinned ? 'Esc closes · click outside to dismiss' : 'Click / Enter / Space to pin and scroll the text'));
    this.content.replaceChildren(frag);
  }

  /**
   * Native path: move the anchor shim to the trigger's centre — one getBoundingClientRect
   * read per show(), no continuous tracking. CSS anchor positioning (styles.css @supports
   * block) opens the tooltip to the side and the browser flips it by available space.
   * The shim is absolutely positioned in DOCUMENT coordinates (client rect + scroll
   * offsets), so the browser's scroll tracking keeps the tooltip glued to the mark.
   */
  private placeAnchor(trigger: Element): void {
    if (!this.anchorEl) return;
    const r = trigger.getBoundingClientRect();
    this.anchorEl.style.left = `${Math.round(r.left + r.width / 2 + window.scrollX)}px`;
    this.anchorEl.style.top = `${Math.round(r.top + r.height / 2 + window.scrollY)}px`;
  }

  /**
   * Manual fallback: side-first to match the native path — right of the trigger, then
   * left, vertically centred and clamped; below (flipping above when it would overflow,
   * then clamping) only when neither side has room for a readable tooltip.
   */
  private positionFallback(trigger: Element): void {
    const r = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const gap = 8;
    // Measure after content render
    const tw = this.root.offsetWidth;
    const th = this.root.offsetHeight;
    const rightSpace = vw - (r.right + gap);
    const leftSpace = r.left - gap;
    const minSide = Math.min(tw, 240); // a partially clamped side tooltip still beats stacking
    let top: number;
    let left: number;
    if (rightSpace >= minSide || leftSpace >= minSide) {
      const placeRight = rightSpace >= leftSpace;
      left = placeRight ? r.right + gap : r.left - gap - tw;
      top = r.top + r.height / 2 - th / 2;
      top = Math.max(gap, Math.min(top, vh - gap - th));
      this.root.dataset.placement = placeRight ? 'right' : 'left';
    } else {
      top = r.bottom + gap;
      let flipped = false;
      if (top + th > vh - gap && r.top - gap - th >= gap) { top = r.top - gap - th; flipped = true; }
      else if (top + th > vh - gap) top = Math.max(gap, vh - gap - th);
      left = Math.max(gap, Math.min(r.left + r.width / 2 - tw / 2, vw - gap - tw));
      this.root.dataset.placement = flipped ? 'above' : 'below';
    }
    this.root.style.top = `${Math.round(top)}px`;
    this.root.style.left = `${Math.round(left)}px`;
  }
}

let instance: Tooltip | null = null;
export function tooltip(): Tooltip { return (instance ??= new Tooltip()); }

/** Standard content for any LoopNode — every field the schema exposes, sizes first. */
export function nodeTip(node: LoopNode, extraRows: [string, string][] = [], actions?: TipContent['actions']): TipContent {
  const m = node.meta;
  const rows: [string, string][] = [];
  rows.push(['kind', KIND_LABEL[node.kind] ?? node.kind]);
  if (m?.agent) rows.push(['agent', m.agent]);
  if (m?.role) rows.push(['role', m.role]);
  if (m?.toolName) rows.push(['tool', m.toolName]);
  if (m?.summary) rows.push(['summary', m.summary]);
  if (m?.status) rows.push(['status', m.status]);
  if (m?.assignee) rows.push(['assignee', m.assignee]);
  if (m?.isError) rows.push(['error', 'yes']);
  rows.push(['size', m ? `${fmtChars(m.chars)} · ${fmtTokens(m.tokensEst)}` : `value ${fmtInt(node.value)}`]);
  if (m?.contextChars !== undefined) rows.push(['context at this point', `${fmtChars(m.contextChars)}${m.contextTokensEst !== undefined ? ` · ${fmtTokens(m.contextTokensEst)}` : ''}`]);
  if (m?.promptChars !== undefined) rows.push(['prompt size', fmtChars(m.promptChars)]);
  if (m?.durationMs !== undefined) rows.push(['duration', `${fmtInt(m.durationMs)} ms`]);
  if (m?.createdAt) rows.push(['created', fmtTime(m.createdAt)]);
  if (m?.threadId) rows.push(['thread', m.threadId]);
  if (m?.turnIndex !== undefined) rows.push(['turn', `#${m.turnIndex + 1}${m.stepIndex !== undefined ? ` · step ${m.stepIndex}` : ''}`]);
  if (m?.messageId) rows.push(['message', m.messageId]);
  if (m?.toolCallId) rows.push(['call id', m.toolCallId]);
  rows.push(['id', node.id]);
  rows.push(...extraRows);
  const body = m?.fullText ?? m?.excerpt ?? '';
  return {
    title: node.name,
    badges: [{ text: KIND_LABEL[node.kind] ?? node.kind }, ...(m?.agent ? [{ text: m.agent }] : [])],
    rows,
    text: body ? { body, mono: isCodeLike(node), truncated: m?.truncated } : undefined,
    actions,
  };
}
