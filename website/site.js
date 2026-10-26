document.documentElement.classList.add("has-js");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

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
