/** Studio design tokens — light professional UI for delivery overlay */
export const studioTokens = {
  bg: "#f4f6f9",
  card: "#ffffff",
  border: "#dfe4ec",
  primary: "#0f4c81",
  primaryHover: "#0c3d68",
  amber: "#f59e0b",
  amberSoft: "#fef3c7",
  text: "#1e293b",
  muted: "#64748b",
  radius: "14px",
  font: '"Heebo", "Assistant", system-ui, -apple-system, sans-serif',
} as const;

export const studioCssVars = `
:root {
  --studio-bg: ${studioTokens.bg};
  --studio-card: ${studioTokens.card};
  --studio-border: ${studioTokens.border};
  --studio-primary: ${studioTokens.primary};
  --studio-primary-hover: ${studioTokens.primaryHover};
  --studio-amber: ${studioTokens.amber};
  --studio-amber-soft: ${studioTokens.amberSoft};
  --studio-text: ${studioTokens.text};
  --studio-muted: ${studioTokens.muted};
  --studio-radius: ${studioTokens.radius};
  --studio-font: ${studioTokens.font};
}
.studio-root {
  background: var(--studio-bg);
  color: var(--studio-text);
  font-family: var(--studio-font);
  direction: rtl;
}
.studio-card {
  background: var(--studio-card);
  border: 1px solid var(--studio-border);
  border-radius: var(--studio-radius);
  box-shadow: 0 1px 3px rgba(15, 76, 129, 0.06);
}
.studio-btn-primary {
  background: var(--studio-primary);
  color: #fff;
  border: none;
  border-radius: 12px;
  padding: 12px 20px;
  font-weight: 600;
  font-size: 15px;
  min-height: 48px;
  cursor: pointer;
}
.studio-btn-primary:hover { background: var(--studio-primary-hover); }
.studio-btn-primary:active { transform: scale(0.98); }
.studio-btn-amber {
  background: var(--studio-amber);
  color: #1e293b;
  border: none;
  border-radius: 12px;
  padding: 10px 16px;
  font-weight: 600;
  min-height: 44px;
  cursor: pointer;
}
.studio-input {
  width: 100%;
  border: 1px solid var(--studio-border);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 15px;
  font-family: inherit;
  background: #fff;
}
.studio-input:focus {
  outline: 2px solid var(--studio-primary);
  outline-offset: 1px;
}
.studio-tabular { font-variant-numeric: tabular-nums; }
`;
