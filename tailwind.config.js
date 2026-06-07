/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        theme: {
          base: "rgb(var(--color-bg-base) / <alpha-value>)",
          surface: "rgb(var(--color-bg-surface) / <alpha-value>)",
          panel: "rgb(var(--color-bg-panel) / <alpha-value>)",
          border: "rgb(var(--color-border) / <alpha-value>)",
          text: "rgb(var(--color-text-main) / <alpha-value>)",
          muted: "rgb(var(--color-text-muted) / <alpha-value>)",
          primary: "rgb(var(--color-primary) / <alpha-value>)",
          "primary-light": "rgb(var(--color-primary-light) / <alpha-value>)",
          accent: "rgb(var(--color-accent) / <alpha-value>)",
          error: "rgb(var(--color-error) / <alpha-value>)",
        }
      },
      fontFamily: {
        ui: ["Outfit", "Inter", "sans-serif"],
        mono: ["D2Coding", "Fira Code", "monospace"],
      },
    },
  },
  plugins: [],
}
