function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function deltaIcon(cls, icon) {
  if (icon) return icon;
  if (cls === "up") return "fa-arrow-trend-up";
  if (cls === "down") return "fa-arrow-trend-down";
  return "fa-minus";
}

/**
 * Dashboard metric card — single markup used by every module.
 * @param {HTMLElement} grid
 * @param {Array<{
 *   key?: string,
 *   label: string,
 *   icon: string,
 *   value: string|number,
 *   delta?: { cls?: string, text?: string, icon?: string },
 *   foot?: string,
 *   compare?: string,
 *   variant?: string
 * }>} metrics
 */
export function renderMetricCards(grid, metrics = []) {
  if (!grid) return;

  grid.innerHTML = metrics.map((m) => {
    const delta = m.delta || { cls: "neutral", text: "—" };
    const cls = delta.cls || "neutral";
    const variant = m.variant ? ` is-${m.variant}` : "";
    const keyAttr = m.key ? ` data-metric="${escapeHtml(m.key)}"` : "";
    const foot = m.foot || m.compare || "overview";

    return `
      <article class="metric-card${variant}"${keyAttr} tabindex="0" aria-label="${escapeHtml(m.label)}">
        <div class="metric-card-top">
          <div class="metric-icon"><i class="fas ${escapeHtml(m.icon)}"></i></div>
          <span class="metric-label">${escapeHtml(m.label)}</span>
        </div>
        <div class="metric-body">
          <div class="metric-value">${escapeHtml(m.value)}</div>
          <span class="metric-delta ${escapeHtml(cls)}">
            <i class="fas ${escapeHtml(deltaIcon(cls, delta.icon))}"></i>
            ${escapeHtml(delta.text ?? "—")}
          </span>
        </div>
        <div class="metric-foot">
          <span><i class="fas fa-clock"></i> ${escapeHtml(foot)}</span>
        </div>
      </article>
    `;
  }).join("");
}
