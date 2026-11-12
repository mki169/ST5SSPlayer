export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function on(element, event, handler, options) {
  element?.addEventListener(event, handler, options);
  return () => element?.removeEventListener(event, handler, options);
}

export function show(element, visible = true) {
  element?.classList.toggle("is-hidden", !visible);
}

export function setText(element, text) {
  if (element) element.textContent = text;
}

export function createId(prefix = "t") {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function readTokenFromHash() {
  const raw = location.hash.replace(/^#/, "").trim();
  if (!raw) return "";
  if (raw.length > 256) return "";
  return raw.replace(/[^A-Za-z0-9_-]/g, "");
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function throttle(fn, wait = 80) {
  let last = 0;
  let timer = null;
  let trailingArgs = null;
  return (...args) => {
    const now = performance.now();
    trailingArgs = args;
    if (now - last >= wait) {
      last = now;
      fn(...args);
      trailingArgs = null;
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = performance.now();
        if (trailingArgs) fn(...trailingArgs);
        trailingArgs = null;
      }, wait - (now - last));
    }
  };
}

export function ageLabel(timestamp) {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

let toastContainer = null;

function ensureToastContainer() {
  if (toastContainer) return toastContainer;
  toastContainer = document.createElement("div");
  toastContainer.className = "toast-stack";
  toastContainer.setAttribute("role", "status");
  toastContainer.setAttribute("aria-live", "polite");
  document.body.append(toastContainer);
  return toastContainer;
}

export function toast(message, kind = "info", timeout = 3600) {
  const container = ensureToastContainer();
  const item = document.createElement("div");
  item.className = `toast toast-${kind}`;
  const dot = document.createElement("span");
  dot.className = "toast-dot";
  dot.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = message;
  item.append(dot, text);
  container.append(item);
  requestAnimationFrame(() => item.classList.add("toast-in"));
  const remove = () => {
    item.classList.remove("toast-in");
    item.classList.add("toast-out");
    setTimeout(() => item.remove(), 220);
  };
  const timer = setTimeout(remove, timeout);
  item.addEventListener("click", () => {
    clearTimeout(timer);
    remove();
  });
  return remove;
}

export async function copyText(text, successMessage = "Copied to clipboard") {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage, "success");
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      if (ok) {
        toast(successMessage, "success");
        return true;
      }
    } catch {}
    toast("Could not copy. Select the link manually.", "error");
    return false;
  }
}

export function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

export function setButtonBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
  if (label) {
    if (!button.dataset.originalLabel) button.dataset.originalLabel = button.innerHTML;
    if (busy) button.innerHTML = label;
    else if (button.dataset.originalLabel) button.innerHTML = button.dataset.originalLabel;
  }
}

export function formatSigned(value, digits = 0) {
  const n = Number(value) || 0;
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

export function safeFileTitle(name) {
  const clean = (name || "Untitled track").replace(/\.[^.]+$/, "").replace(/[_]+/g, " ");
  return clean.trim() || "Untitled track";
}
