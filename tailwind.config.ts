import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-dm-sans)', 'ui-sans-serif', 'system-ui'],
        display: ['var(--font-syne)', 'ui-sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace'],
      },
      colors: {
        background: "var(--bg-base)",
        foreground: "var(--text-primary)",
        accent: {
          DEFAULT: '#4F70FF',
          hover: '#6B87FF',
        },
        success: '#00D87A',
        warning: '#F5A200',
        danger: '#FF4545',
      },
    },
  },
  plugins: [],
};
export default config;
