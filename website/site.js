document.documentElement.classList.add("has-js");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const aliasExamples = [
  "cedar-moon-river",
  "amber-fern-lake",
  "birch-owl-meadow",
  "maple-dawn-brook",
];
const aliasEase = getComputedStyle(document.documentElement)
  .getPropertyValue("--ease-in-out")
  .trim();

class AliasLoop {
  constructor(demo) {
    this.demo = demo;
    this.current = demo.querySelector(".alias-current");
    this.next = demo.querySelector(".alias-next");
    this.sweep = demo.querySelector(".alias-sweep");
    this.label = demo.querySelector(".alias-label");
    this.index = -1;
    this.animations = [];
    this.visible = false;
    this.pauses = new Set();
    this.current.textContent = "john.doe";
    this.label.textContent = demo.dataset.personalLabel;
    this.observe();
    this.sync();
  }

  observe() {
    const observer = new IntersectionObserver(
      (entries) => {
        this.visible = entries[0].isIntersecting;
        this.sync();
      },
      { threshold: 0.5 },
    );
    observer.observe(this.demo);
    reducedMotion.addEventListener("change", () => this.sync());
    document.addEventListener("visibilitychange", () => this.sync());
    this.demo.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") this.pause("pointer", true);
    });
    this.demo.addEventListener("pointerleave", () => this.pause("pointer", false));
    this.demo.addEventListener("focusin", () => this.pause("focus", true));
    this.demo.addEventListener("focusout", () => this.pause("focus", false));
  }

  pause(reason, paused) {
    if (paused) this.pauses.add(reason);
    else this.pauses.delete(reason);
    this.sync();
  }

  reset() {
    clearTimeout(this.timer);
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
  }

  canPlay() {
    return this.visible && this.pauses.size === 0 && !document.hidden && !reducedMotion.matches;
  }

  sync() {
    this.reset();
    if (reducedMotion.matches) {
      this.index = 0;
      this.current.textContent = aliasExamples[0];
      this.label.textContent = this.demo.dataset.aliasLabel;
    }
    if (this.canPlay()) {
      this.timer = setTimeout(() => this.advance(), this.index < 0 ? 1100 : 2800);
    }
  }

  advance() {
    const index = (this.index + 1) % aliasExamples.length;
    this.next.textContent = aliasExamples[index];
    this.animations = [
      this.current.animate(
        [
          { clipPath: "inset(0 0 0 0)", opacity: 1 },
          { clipPath: "inset(0 0 0 100%)", opacity: 0 },
        ],
        { duration: 640, easing: aliasEase, fill: "both" },
      ),
      this.next.animate(
        [
          { clipPath: "inset(0 100% 0 0)", opacity: 0, transform: "translateX(-4px)" },
          { clipPath: "inset(0 0 0 0)", opacity: 1, transform: "translateX(0)" },
        ],
        { duration: 640, easing: aliasEase, fill: "both" },
      ),
      this.sweep.animate(
        [
          { transform: "translateX(-100%)", opacity: 0 },
          { opacity: 1, offset: 0.3 },
          { transform: "translateX(800%)", opacity: 0 },
        ],
        { duration: 640, easing: aliasEase, fill: "both" },
      ),
    ];
    Promise.all(this.animations.map((animation) => animation.finished))
      .then(() => {
        this.index = index;
        this.current.textContent = aliasExamples[index];
        this.label.textContent = this.demo.dataset.aliasLabel;
        this.sync();
      })
      .catch(() => {
        // Visibility, focus, or reduced-motion changes cancel an in-flight transition.
      });
  }
}

for (const demo of document.querySelectorAll("[data-alias-demo]")) new AliasLoop(demo);

function selectTab(group, tab, animate) {
  for (const candidate of group.querySelectorAll('[role="tab"]')) {
    const selected = candidate === tab;
    candidate.setAttribute("aria-selected", String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(candidate.getAttribute("aria-controls"));
    panel.hidden = !selected;
  }
  if (!animate || reducedMotion.matches) return;
  const panel = document.getElementById(tab.getAttribute("aria-controls"));
  for (const animation of panel.getAnimations()) animation.cancel();
  panel.animate(
    [
      { opacity: 0.65, transform: "translateY(4px)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
    { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
  );
}

function keyboardTab(event, group, tabs, current) {
  const positions = {
    ArrowRight: (current + 1) % tabs.length,
    ArrowDown: (current + 1) % tabs.length,
    ArrowLeft: (current + tabs.length - 1) % tabs.length,
    ArrowUp: (current + tabs.length - 1) % tabs.length,
    Home: 0,
    End: tabs.length - 1,
  };
  const index = positions[event.key];
  if (index === undefined) return;
  event.preventDefault();
  selectTab(group, tabs[index], false);
  tabs[index].focus();
}

for (const group of document.querySelectorAll("[data-tabs]")) {
  const tabs = [...group.querySelectorAll('[role="tab"]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", (event) => selectTab(group, tab, event.detail > 0));
    tab.addEventListener("keydown", (event) => keyboardTab(event, group, tabs, index));
  });
}

const resetTimers = new WeakMap();
async function copyCode(button) {
  const status = document.getElementById("copy-status");
  const code = document.getElementById(button.dataset.copy);
  clearTimeout(resetTimers.get(button));
  try {
    await navigator.clipboard.writeText(code.textContent);
    const label = button.dataset.label;
    button.textContent = button.dataset.copied;
    status.textContent = button.dataset.copied;
    resetTimers.set(
      button,
      setTimeout(() => {
        button.textContent = label;
      }, 1800),
    );
  } catch {
    status.textContent = status.dataset.error;
    button.textContent = button.dataset.failure;
  }
}
for (const button of document.querySelectorAll("[data-copy]")) {
  button.dataset.label = button.textContent;
  button.addEventListener("click", () => copyCode(button));
}
