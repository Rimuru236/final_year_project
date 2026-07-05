/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        headline: ["Inter", "system-ui", "sans-serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      colors: {
        // Material You Design tokens — maps to CSS custom properties
        primary: "hsl(var(--color-primary) / <alpha-value>)",
        "primary-dim": "hsl(var(--color-primary-dim) / <alpha-value>)",
        "on-primary": "hsl(var(--color-on-primary) / <alpha-value>)",
        "primary-container": "hsl(var(--color-primary-container) / <alpha-value>)",
        "on-primary-container": "hsl(var(--color-on-primary-container) / <alpha-value>)",
        secondary: "hsl(var(--color-secondary) / <alpha-value>)",
        "on-secondary": "hsl(var(--color-on-secondary) / <alpha-value>)",
        "secondary-container": "hsl(var(--color-secondary-container) / <alpha-value>)",
        "on-secondary-container": "hsl(var(--color-on-secondary-container) / <alpha-value>)",
        tertiary: "hsl(var(--color-tertiary) / <alpha-value>)",
        "on-tertiary": "hsl(var(--color-on-tertiary) / <alpha-value>)",
        "tertiary-container": "hsl(var(--color-tertiary-container) / <alpha-value>)",
        "on-tertiary-container": "hsl(var(--color-on-tertiary-container) / <alpha-value>)",
        background: "hsl(var(--color-background) / <alpha-value>)",
        "on-background": "hsl(var(--color-on-background) / <alpha-value>)",
        surface: "hsl(var(--color-surface) / <alpha-value>)",
        "on-surface": "hsl(var(--color-on-surface) / <alpha-value>)",
        "on-surface-variant": "hsl(var(--color-on-surface-variant) / <alpha-value>)",
        "surface-container-lowest": "hsl(var(--color-surface-container-lowest) / <alpha-value>)",
        "surface-container-low": "hsl(var(--color-surface-container-low) / <alpha-value>)",
        "surface-container": "hsl(var(--color-surface-container) / <alpha-value>)",
        "surface-container-high": "hsl(var(--color-surface-container-high) / <alpha-value>)",
        "outline": "hsl(var(--color-outline) / <alpha-value>)",
        "outline-variant": "hsl(var(--color-outline-variant) / <alpha-value>)",
      },
      keyframes: {
        "slide-in-from-right-4": {
          from: { transform: "translateX(1rem)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-in-from-top": {
          from: { transform: "translateY(-0.5rem)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
      },
      animation: {
        "in": "fade-in 0.2s ease-out",
        "slide-in-right": "slide-in-from-right-4 0.3s ease-out",
        "slide-in-top": "slide-in-from-top 0.2s ease-out",
      },
    },
  },
  plugins: [],
};
