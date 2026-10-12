#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// Seeded PRNG: Mulberry32
function createPrng(seed = 0x2f6e2b1) {
  let a = seed >>> 0;
  return function rand() {
    let t = (a += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1x1 transparent PNG buffer
const PNG_1X1_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// JavaScript code for /js/menu.js
const MENU_JS_CONTENT = `document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('js-ready');
  const header = document.querySelector('.site-header');
  if (header) {
    header.classList.add('is-loading');
    setTimeout(() => {
      header.classList.remove('is-loading');
    }, 50);
  }
  document.querySelectorAll('.dropdown__toggle').forEach((toggle) => {
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      const dropdown = toggle.closest('.dropdown');
      if (dropdown) {
        dropdown.classList.toggle('is-open');
      }
    });
  });
});
`;

function countCssRules(css) {
  let clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let count = 0;
  let prev = '';
  while (clean !== prev) {
    prev = clean;
    clean = clean.replace(/\{([^{}]*)\}/g, (match, body) => {
      if (body.includes(':')) {
        count++;
      }
      return ' __BLOCK__ ';
    });
  }
  return count;
}

function buildBaseCss() {
  return `@layer base, components;

@font-face {
  font-family: "Brand Sans";
  src: local("Arial");
}

:root {
  --brand: #0050d8;
  --accent: var(--brand);
  --space-2: 8px;
  --radius: 4px;
}

.theme-dark {
  --brand: #7aa7ff;
}

@layer base {
  *, *::before, *::after {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    line-height: 1.5;
    font-family: "Brand Sans", sans-serif;
    color: #1f2937;
    background-color: #ffffff;
    -webkit-font-smoothing: antialiased;
  }

  img, picture, video, canvas, svg {
    display: block;
    max-width: 100%;
    height: auto;
  }

  input, button, textarea, select {
    font: inherit;
  }

  h1, h2, h3, h4, h5, h6 {
    margin-top: 0;
    color: #111827;
    overflow-wrap: break-word;
  }

  h1 {
    font-size: 2.25rem;
    line-height: 2.5rem;
    font-weight: 700;
  }

  h2 {
    font-size: 1.75rem;
    line-height: 2rem;
    font-weight: 600;
  }

  h3 {
    font-size: 1.25rem;
    line-height: 1.75rem;
    font-weight: 600;
  }

  p {
    margin-top: 0;
    margin-bottom: 1rem;
    color: #374151;
  }

  code, pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.875em;
  }

  pre {
    background-color: #1e293b;
    color: #f8fafc;
    padding: 1rem;
    border-radius: var(--radius);
    overflow-x: auto;
  }

  ul, ol {
    margin-top: 0;
    padding-left: 1.5rem;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }
}

a[href^="https"] {
  color: var(--brand);
  text-decoration: underline;
  text-underline-offset: 2px;
}

a[href^="https"]:hover {
  text-decoration-thickness: 2px;
}

a[href^="https"]::after {
  content: " ↗";
  font-size: 0.8em;
}

@media (max-width: 600px) {
  body {
    font-size: 14px;
  }
  h1 {
    font-size: 1.75rem;
  }
  .nav {
    flex-direction: column;
    gap: 0.5rem;
  }
}

@supports (display: grid) {
  .grid-supported {
    display: grid;
    gap: var(--space-2);
  }
}
`;
}

function buildComponentsCss() {
  return `@layer components {
  .site-header {
    position: sticky;
    top: 0;
    background: #ffffff;
    border-bottom: 1px solid #e5e7eb;
    z-index: 100;
  }

  .site-header.is-loading {
    opacity: 0.7;
  }

  .nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    max-width: 1200px;
    margin: 0 auto;
    padding: 0.75rem 1rem;
  }

  .nav ul {
    display: flex;
    list-style: none;
    margin: 0;
    padding: 0;
    gap: 1.25rem;
    align-items: center;
  }

  .nav__item {
    position: relative;
  }

  .nav__item a {
    text-decoration: none;
    color: #374151;
    font-weight: 500;
  }

  .nav__item a:hover {
    color: var(--brand);
  }

  .dropdown {
    position: relative;
  }

  .dropdown__toggle {
    background: none;
    border: 1px solid #d1d5db;
    padding: 0.35rem 0.75rem;
    border-radius: var(--radius);
    cursor: pointer;
    font-weight: 500;
  }

  .dropdown__toggle:hover {
    border-color: var(--brand);
  }

  .dropdown__menu {
    display: none;
    position: absolute;
    right: 0;
    top: 100%;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: var(--radius);
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    padding: 0.5rem 0;
    min-width: 160px;
    z-index: 50;
    list-style: none;
  }

  .dropdown.is-open .dropdown__menu {
    display: block;
  }

  .dropdown__menu li a {
    display: block;
    padding: 0.5rem 1rem;
    color: #374151;
    text-decoration: none;
  }

  .dropdown__menu li a:hover {
    background: #f3f4f6;
    color: var(--brand);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem 1rem;
    font-weight: 500;
    border-radius: var(--radius);
    border: 1px solid #d1d5db;
    background-color: #ffffff;
    color: #374151;
    cursor: pointer;
    text-decoration: none;
    transition: background-color 0.15s ease;
  }

  .btn.btn-primary {
    background-color: var(--brand);
    color: #ffffff;
    border-color: var(--brand);
  }

  .btn:hover {
    background-color: #f9fafb;
    border-color: #9ca3af;
  }

  .btn.btn-primary:hover {
    opacity: 0.92;
  }

  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .card {
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: var(--radius);
    padding: 1.25rem;
    position: relative;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  }

  .card .title {
    margin-top: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: #111827;
  }

  .card:not(:hover) .title {
    opacity: 0.95;
  }

  .card:has(img) {
    overflow: hidden;
    padding-top: 0;
  }

  .card:has(img) img {
    width: 100%;
    height: 180px;
    object-fit: cover;
    margin-bottom: 1rem;
  }

  .card--featured {
    border: 2px solid var(--brand);
    box-shadow: 0 4px 12px rgba(0, 80, 216, 0.15);
  }

  .card::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: var(--radius);
    pointer-events: none;
  }

  .price {
    color: var(--accent);
    font-size: 1.5rem;
    font-weight: 700;
  }

  .price--sale {
    color: #dc2626;
    text-decoration: line-through;
    margin-right: 0.5rem;
    font-size: 1.125rem;
  }

  .site-footer {
    border-top: 1px solid #e5e7eb;
    background: #f9fafb;
    padding: 2.5rem 1rem;
    margin-top: 3.5rem;
    text-align: center;
  }

  .site-footer__links {
    display: flex;
    justify-content: center;
    gap: 1.5rem;
    margin-bottom: 1rem;
  }

  .site-footer__links a {
    color: #6b7280;
    text-decoration: none;
    font-size: 0.875rem;
  }

  .site-footer__links a:hover {
    color: var(--brand);
  }

  .site-footer__legal {
    color: #9ca3af;
    font-size: 0.8125rem;
    margin: 0;
  }
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1.5rem;
  container: card / inline-size;
}

@container card (min-width: 400px) {
  .card {
    padding: 1.75rem;
  }
  .card .title {
    font-size: 1.25rem;
  }
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.85;
    transform: scale(1.02);
  }
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.promo-banner {
  background: #e0e7ff;
  border: 1px solid #c7d2fe;
  color: #3730a3;
  padding: 0.75rem 1.25rem;
  border-radius: var(--radius);
  margin-bottom: 1.5rem;
  animation: pulse 2s infinite;
}

.toast {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  background: #1f2937;
  color: #ffffff;
  padding: 1rem 1.25rem;
  border-radius: var(--radius);
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.2);
  animation-name: fade-in;
  animation-duration: 0.3s;
  z-index: 1000;
  & .toast__close {
    background: none;
    border: none;
    color: #9ca3af;
    font-size: 1.25rem;
    cursor: pointer;
    margin-left: 0.75rem;
  }
  &.is-visible {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
}

.specs {
  list-style: none;
  padding: 0;
  margin: 1rem 0;
}

.specs .item {
  padding: 0.5rem 0;
  border-bottom: 1px solid #f3f4f6;
}

.specs .item:nth-child(2 of .item) {
  font-weight: 600;
  background-color: #fafafa;
}

li:nth-child(odd) {
  background-color: rgba(0, 0, 0, 0.015);
}

.campaign-1, .campaign-2, .campaign-3, .campaign-4, .campaign-5,
.campaign-6, .campaign-7, .campaign-8, .campaign-9, .campaign-10 {
  background-color: #fef3c7;
  border: 1px solid #fde68a;
  color: #92400e;
  padding: 0.75rem 1.25rem;
  border-radius: var(--radius);
  margin: 1rem 0;
  font-size: 0.875rem;
}
`;
}

function buildArticleCss() {
  return `.article {
  max-width: 1000px;
  margin: 2rem auto;
  padding: 0 1.25rem;
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 2.5rem;
}

.article__title {
  font-size: 2.25rem;
  margin-bottom: 0.5rem;
  line-height: 1.25;
}

.article__meta {
  color: #6b7280;
  font-size: 0.875rem;
  margin-bottom: 1.75rem;
}

.article__body {
  line-height: 1.8;
  color: #374151;
}

.article__figure {
  margin: 2rem 0;
}

.article__figure img {
  width: 100%;
  border-radius: var(--radius);
  border: 1px solid #e5e7eb;
}

.article__figure figcaption {
  font-size: 0.875rem;
  color: #6b7280;
  margin-top: 0.5rem;
  text-align: center;
}

.pullquote {
  border-left: 4px solid var(--brand);
  padding-left: 1.25rem;
  font-style: italic;
  font-size: 1.125rem;
  color: #4b5563;
  margin: 2rem 0;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.legacy-wrapper {
  border: 2px dashed #93c5fd;
  padding: 1.25rem;
  border-radius: var(--radius);
  margin-bottom: 1.5rem;
}

.legacy-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

/* Dead CSS selectors matching nothing */
.article__author-badge-deprecated {
  display: none;
}

.article-v1-comments {
  padding: 2rem;
  background: #f8fafc;
}

.article__tag--archived {
  background-color: #e2e8f0;
  color: #64748b;
}

.article-reading-progress {
  position: fixed;
  top: 0;
  left: 0;
  height: 3px;
  background: var(--brand);
}

.article__related-posts-carousel {
  display: flex;
  overflow-x: scroll;
}
`;
}

function buildProductCss() {
  return `.product {
  max-width: 1150px;
  margin: 2rem auto;
  padding: 0 1.25rem;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3rem;
}

.product__gallery {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.product__gallery img {
  width: 100%;
  border-radius: var(--radius);
  border: 1px solid #e5e7eb;
}

.product__info {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.product__name {
  font-size: 2.25rem;
  margin: 0;
  line-height: 1.2;
}

.product__actions {
  display: flex;
  gap: 1rem;
  margin: 1rem 0;
}

.reviews {
  margin-top: 3.5rem;
  grid-column: span 2;
}

.reviews__title {
  font-size: 1.5rem;
  margin-bottom: 1.5rem;
}

.review {
  border-top: 1px solid #e5e7eb;
  padding: 1.25rem 0;
}

.review__header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.review__author {
  font-weight: 600;
  color: #111827;
}

.review__rating {
  color: #f59e0b;
}

.legacy-wrapper {
  border: 2px dashed #a7f3d0;
  padding: 1.25rem;
  border-radius: var(--radius);
  margin-bottom: 1.5rem;
}

.legacy-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
}

/* Dead CSS selectors */
.product-badge-legacy {
  color: #ef4444;
}

.product__wishlist-v0 {
  border: none;
}

.product-installments-calculator {
  background: #f1f5f9;
  padding: 1rem;
}

.product-size-chart-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
}

.product__rating-distribution-bar {
  height: 8px;
  background: #e2e8f0;
}
`;
}

function buildDocsCss() {
  return `.docs-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  max-width: 1250px;
  margin: 0 auto;
  gap: 2.5rem;
  padding: 2rem 1.25rem;
}

.docs-header {
  grid-column: span 2;
  margin-bottom: 1rem;
}

.docs-search {
  width: 100%;
  max-width: 450px;
  padding: 0.625rem 1rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius);
  font-size: 0.9375rem;
}

.docs-search:focus {
  outline: 2px solid var(--brand);
}

.toc {
  position: sticky;
  top: 5rem;
  height: fit-content;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.toc a {
  color: #4b5563;
  text-decoration: none;
  font-size: 0.875rem;
  padding: 0.25rem 0.5rem;
  border-radius: var(--radius);
}

.toc a:hover {
  background-color: #f3f4f6;
  color: var(--brand);
}

.docs-content {
  min-width: 0;
}

.docs-content h2 {
  margin-top: 2rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid #e5e7eb;
}

.docs-table {
  width: 100%;
  border-collapse: collapse;
  margin: 1.75rem 0;
}

.docs-table th, .docs-table td {
  border: 1px solid #e5e7eb;
  padding: 0.75rem 1rem;
  text-align: left;
}

.docs-table th {
  background: #f9fafb;
  font-weight: 600;
}

.legacy-wrapper {
  background: #fcfcfc;
  border: 1px solid #d1d5db;
  padding: 1rem;
  margin-bottom: 1.5rem;
}

.legacy-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* Dead CSS selectors */
.docs-old-tree {
  display: none;
}

.docs-version-selector-deprecated {
  color: #94a3b8;
}

.docs-feedback-widget-v1 {
  border-top: 1px dashed #cbd5e1;
}

.docs-interactive-repl {
  height: 300px;
}
`;
}

function buildLandingCss() {
  return `.hero {
  text-align: center;
  padding: 4.5rem 1.25rem;
  background: linear-gradient(180deg, #f0f7ff 0%, #ffffff 100%);
  border-bottom: 1px solid #e5e7eb;
}

.hero h1 {
  font-size: 3rem;
  margin-bottom: 1rem;
  color: #111827;
  letter-spacing: -0.025em;
}

.hero__subtitle {
  font-size: 1.25rem;
  color: #4b5563;
  max-width: 650px;
  margin: 0 auto 2.25rem;
}

.features {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2rem;
  max-width: 1150px;
  margin: 3.5rem auto;
  padding: 0 1.25rem;
}

.feature {
  text-align: center;
  padding: 2rem 1.5rem;
  border-radius: var(--radius);
  border: 1px solid #f3f4f6;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.feature__title {
  font-size: 1.25rem;
  margin-bottom: 0.75rem;
  color: #111827;
}

.feature__desc {
  color: #6b7280;
  font-size: 0.9375rem;
  line-height: 1.6;
}

.landing-showcase {
  max-width: 1000px;
  margin: 3.5rem auto;
  padding: 2.5rem 1.5rem;
  background: #f8fafc;
  border-radius: var(--radius);
  border: 1px solid #e2e8f0;
}

.legacy-wrapper {
  border: 2px dashed #0050d8;
  padding: 1.25rem;
  border-radius: var(--radius);
  margin-bottom: 1.5rem;
}

.legacy-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.25rem;
}

/* Dead CSS selectors */
.hero-video-fallback {
  opacity: 0;
}

.landing-banner-beta {
  display: none;
}

.landing-pricing-toggle-v0 {
  cursor: pointer;
}

.landing-social-proof-strip {
  filter: grayscale(100%);
}
`;
}

function buildLegacyCss() {
  const rules = [];
  for (let i = 1; i <= 30; i++) {
    rules.push(`.legacy-rule-${i} {
  display: inline-block;
  margin: ${i}px;
  padding: ${i * 2}px;
  color: #555555;
}`);
  }
  return rules.join('\n\n') + '\n';
}

function buildUtilitiesCss(targetTotalRules, existingRules) {
  const needed = Math.max(0, targetTotalRules - existingRules);
  const rules = [];

  const spacings = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60];
  const directions = [
    { p: 'm', prop: 'margin' },
    { p: 'mt', prop: 'margin-top' },
    { p: 'mr', prop: 'margin-right' },
    { p: 'mb', prop: 'margin-bottom' },
    { p: 'ml', prop: 'margin-left' },
    { p: 'p', prop: 'padding' },
    { p: 'pt', prop: 'padding-top' },
    { p: 'pr', prop: 'padding-right' },
    { p: 'pb', prop: 'padding-bottom' },
    { p: 'pl', prop: 'padding-left' },
  ];

  for (const dir of directions) {
    for (const s of spacings) {
      if (rules.length >= needed) break;
      rules.push(`.u-${dir.p}-${s} { ${dir.prop}: ${s}px; }`);
    }
  }

  for (let i = 1; i <= 12; i++) {
    if (rules.length >= needed) break;
    rules.push(`.col-${i} { grid-column: span ${i}; }`);
  }

  for (let i = 1; i <= 12; i++) {
    if (rules.length >= needed) break;
    rules.push(`.col-offset-${i} { margin-left: ${(i / 12) * 100}%; }`);
  }

  const baseUtils = [
    '.u-block { display: block; }',
    '.u-inline-block { display: inline-block; }',
    '.u-inline { display: inline; }',
    '.u-flex { display: flex; }',
    '.u-inline-flex { display: inline-flex; }',
    '.u-grid { display: grid; }',
    '.u-hidden { display: none; }',
    '.u-items-center { align-items: center; }',
    '.u-items-start { align-items: flex-start; }',
    '.u-items-end { align-items: flex-end; }',
    '.u-justify-center { justify-content: center; }',
    '.u-justify-between { justify-content: space-between; }',
    '.u-justify-start { justify-content: flex-start; }',
    '.u-justify-end { justify-content: flex-end; }',
    '.text-left { text-align: left; }',
    '.text-center { text-align: center; }',
    '.text-right { text-align: right; }',
    '.text-uppercase { text-transform: uppercase; }',
    '.text-lowercase { text-transform: lowercase; }',
    '.font-light { font-weight: 300; }',
    '.font-normal { font-weight: 400; }',
    '.font-medium { font-weight: 500; }',
    '.font-semibold { font-weight: 600; }',
    '.font-bold { font-weight: 700; }',
    '.hide-sm { display: none; }',
    '.hide-md { display: none; }',
    '.hide-lg { display: none; }',
    '.show-sm { display: block; }',
    '.show-md { display: block; }',
    '.show-lg { display: block; }',
  ];

  for (const bu of baseUtils) {
    if (rules.length >= needed) break;
    rules.push(bu);
  }

  let counter = 1;
  while (rules.length < needed) {
    rules.push(`.u-scale-${counter} { transform: scale(${1 + counter * 0.01}); }`);
    counter++;
  }

  return rules.slice(0, needed).join('\n') + '\n';
}

function generateSite(outDir, pageTarget = 400) {
  const startTime = performance.now();
  const prng = createPrng(0x2f6e2b1);

  const targetDir = path.resolve(process.cwd(), outDir);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const subdirs = [
    'articles',
    'products',
    'docs',
    'listing',
    'landing',
    'css',
    'css/pages',
    'js',
    'img',
  ];
  for (const sub of subdirs) {
    fs.mkdirSync(path.join(targetDir, sub), { recursive: true });
  }

  // 1x1 PNG
  fs.writeFileSync(path.join(targetDir, 'img', 'x.png'), PNG_1X1_BUFFER);

  // /js/menu.js
  fs.writeFileSync(path.join(targetDir, 'js', 'menu.js'), MENU_JS_CONTENT, 'utf8');

  // CSS files
  const baseCss = buildBaseCss();
  const componentsCss = buildComponentsCss();
  const articleCss = buildArticleCss();
  const productCss = buildProductCss();
  const docsCss = buildDocsCss();
  const landingCss = buildLandingCss();
  const legacyCss = buildLegacyCss();

  const nonUtilRules =
    countCssRules(baseCss) +
    countCssRules(componentsCss) +
    countCssRules(articleCss) +
    countCssRules(productCss) +
    countCssRules(docsCss) +
    countCssRules(landingCss) +
    countCssRules(legacyCss);

  const TARGET_TOTAL_RULES = 1500;
  const utilitiesCss = buildUtilitiesCss(TARGET_TOTAL_RULES, nonUtilRules);

  fs.writeFileSync(path.join(targetDir, 'css', 'base.css'), baseCss, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'css', 'components.css'), componentsCss, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'css', 'utilities.css'), utilitiesCss, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'css', 'legacy.css'), legacyCss, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'css', 'pages', 'article.css'), articleCss, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'css', 'pages', 'product.css'), productCss, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'css', 'pages', 'docs.css'), docsCss, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'css', 'landing.css'), landingCss, 'utf8');

  const totalCssRules =
    nonUtilRules + countCssRules(utilitiesCss);

  // Template distribution
  const countArticle = Math.floor(pageTarget * 0.35);
  const countProduct = Math.floor(pageTarget * 0.30);
  const countDocs = Math.floor(pageTarget * 0.15);
  const countListing = Math.floor(pageTarget * 0.10);
  const countLanding = pageTarget - (countArticle + countProduct + countDocs + countListing);

  const pageDefs = [];

  pageDefs.push({
    url: '/index.html',
    template: 'landing',
    fileRel: 'index.html',
  });

  for (let i = 1; i <= countArticle; i++) {
    const id = String(i).padStart(4, '0');
    pageDefs.push({
      url: `/articles/a-${id}.html`,
      template: 'article',
      fileRel: path.join('articles', `a-${id}.html`),
    });
  }

  for (let i = 1; i <= countProduct; i++) {
    const id = String(i).padStart(4, '0');
    pageDefs.push({
      url: `/products/p-${id}.html`,
      template: 'product',
      fileRel: path.join('products', `p-${id}.html`),
    });
  }

  for (let i = 1; i <= countDocs; i++) {
    const id = String(i).padStart(4, '0');
    pageDefs.push({
      url: `/docs/d-${id}.html`,
      template: 'docs',
      fileRel: path.join('docs', `d-${id}.html`),
    });
  }

  for (let i = 1; i <= countListing; i++) {
    const id = String(i).padStart(4, '0');
    pageDefs.push({
      url: `/listing/l-${id}.html`,
      template: 'listing',
      fileRel: path.join('listing', `l-${id}.html`),
    });
  }

  for (let i = 1; i <= countLanding; i++) {
    const id = String(i).padStart(4, '0');
    pageDefs.push({
      url: `/landing/x-${id}.html`,
      template: 'landing',
      fileRel: path.join('landing', `x-${id}.html`),
    });
  }

  // Assign copy status (~15% of each template)
  const templateGroups = {};
  for (const p of pageDefs) {
    if (!templateGroups[p.template]) templateGroups[p.template] = [];
    templateGroups[p.template].push(p);
  }

  const deviationTypes = [
    'legacy-wrapper',
    'extra-classes',
    'missing-block',
    'section-tag',
    'cross-template',
    'inline-styles',
  ];

  for (const [tpl, pages] of Object.entries(templateGroups)) {
    const numCopies = Math.max(1, Math.round(pages.length * 0.15));
    // deterministic selection of copy pages
    const copyIndices = new Set();
    while (copyIndices.size < numCopies) {
      const idx = Math.floor(prng() * pages.length);
      copyIndices.add(idx);
    }
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (copyIndices.has(i)) {
        page.copy = true;
        const numDevs = 1 + Math.floor(prng() * 3); // 1 to 3 deviations
        const chosenDevs = [];
        const pool = [...deviationTypes];
        while (chosenDevs.length < numDevs && pool.length > 0) {
          const pickIdx = Math.floor(prng() * pool.length);
          const dev = pool.splice(pickIdx, 1)[0];
          chosenDevs.push(dev);
        }
        page.deviations = chosenDevs;
      } else {
        page.copy = false;
        page.deviations = [];
      }
    }
  }

  // Assign campaign classes: campaign-<k> (k = 1..10) on 3-6 pages each
  const pageCampaigns = new Map();
  for (let k = 1; k <= 10; k++) {
    const size = 3 + Math.floor(prng() * 4); // 3, 4, 5, or 6
    const selectedIndices = new Set();
    while (selectedIndices.size < size) {
      const idx = Math.floor(prng() * pageDefs.length);
      selectedIndices.add(idx);
    }
    for (const idx of selectedIndices) {
      if (!pageCampaigns.has(idx)) {
        pageCampaigns.set(idx, []);
      }
      pageCampaigns.get(idx).push(`campaign-${k}`);
    }
  }

  // Shared Chrome HTML
  const headerHtml = `<header class="site-header">
  <nav class="nav">
    <ul>
      <li class="nav__item"><a href="/index.html">Home</a></li>
      <li class="nav__item"><a href="/articles/a-0001.html">Articles</a></li>
      <li class="nav__item"><a href="/products/p-0001.html">Products</a></li>
      <li class="nav__item"><a href="/docs/d-0001.html">Documentation</a></li>
      <li class="nav__item dropdown">
        <button type="button" class="dropdown__toggle">Categories</button>
        <ul class="dropdown__menu">
          <li><a href="/listing/l-0001.html">All Listings</a></li>
          <li><a href="/landing/x-0001.html">Featured</a></li>
          <li><a href="/docs/d-0001.html">Guides</a></li>
        </ul>
      </li>
    </ul>
  </nav>
</header>`;

  const footerHtml = `<footer class="site-footer">
  <div class="site-footer__links">
    <a href="/docs/d-0001.html">API Docs</a>
    <a href="/articles/a-0001.html">Blog</a>
    <a href="/products/p-0001.html">Store</a>
    <a href="/listing/l-0001.html">Directory</a>
  </div>
  <p class="site-footer__legal">&copy; 2026 BlastRadius Corp. All rights reserved. Deterministic fixture suite.</p>
</footer>`;

  // Content generators
  const paragraphsCorpus = [
    'Static selector evaluation requires inspecting DOM nodes against complex stylesheet rules to calculate exact match boundaries and minimize unintended rendering regressions.',
    'Headless browser orchestration captures runtime rendering metrics, verifying layout shifts and paint times across responsive breakpoints before releasing updates.',
    'Cascading stylesheets introduce non-linear dependency graphs where seemingly minor utility modifications can propagate across thousands of distinct views unexpectedly.',
    'Automated perceptual diffing leverages structural hashing and headless snapshots to isolate visual deviations with sub-pixel precision across staging environments.',
    'Component design patterns must balance modular styling encapsulation with centralized global design tokens to prevent specificity escalation.',
    'Optimizing selector parsing speed within continuous integration pipelines reduces feedback cycles and accelerates deployment cadences for engineering teams.',
    'Legacy stylesheet rules often accumulate dead declarations that degrade browser parsing efficiency and introduce subtle visual regressions over time.',
    'Modern CSS architecture embraces container queries and cascade layers to provide deterministic scoping without sacrificing performance.',
  ];

  function getParagraphs(count) {
    const res = [];
    for (let i = 0; i < count; i++) {
      res.push(`<p>${paragraphsCorpus[i % paragraphsCorpus.length]}</p>`);
    }
    return res.join('\n');
  }

  // Generate pages
  let totalBytes = 0;
  const manifestPages = [];
  const trackedMarkers = [
    'promo-banner',
    'card--featured',
    'legacy-wrapper',
    'legacy-grid',
    'theme-dark',
    'price--sale',
    'pullquote',
    'docs-search',
    ...Array.from({ length: 10 }, (_, i) => `campaign-${i + 1}`),
    'toast',
    'card-grid',
  ];

  const markerMap = {};
  for (const m of trackedMarkers) {
    markerMap[m] = [];
  }

  for (let idx = 0; idx < pageDefs.length; idx++) {
    const page = pageDefs[idx];
    const isCopy = page.copy;
    const devs = page.deviations || [];
    const campaigns = pageCampaigns.get(idx) || [];

    const hasDev = (d) => devs.includes(d);

    let bodyClass = `tpl-${page.template}`;
    if (hasDev('extra-classes') && (idx % 2 === 0)) {
      bodyClass += ' theme-dark';
    }

    // Stylesheet links
    const cssLinks = [
      '<link rel="stylesheet" href="/css/base.css">',
      '<link rel="stylesheet" href="/css/components.css">',
      '<link rel="stylesheet" href="/css/utilities.css">',
    ];
    if (page.template === 'article') {
      cssLinks.push('<link rel="stylesheet" href="/css/pages/article.css">');
    } else if (page.template === 'product') {
      cssLinks.push('<link rel="stylesheet" href="/css/pages/product.css">');
    } else if (page.template === 'docs') {
      cssLinks.push('<link rel="stylesheet" href="/css/pages/docs.css">');
    } else if (page.template === 'landing') {
      cssLinks.push('<link rel="stylesheet" href="/css/landing.css">');
    }

    let campaignHtml = '';
    for (const c of campaigns) {
      campaignHtml += `<div class="${c}"><p>Special promotional event active for this segment.</p></div>\n`;
    }

    let extLinkHtml = '';
    if (prng() < 0.30) {
      extLinkHtml = `<p class="ext-ref">External reference document: <a href="https://example.com/reference-data-${idx}">https://example.com/reference-data-${idx}</a></p>`;
    }

    let mainContent = '';

    if (page.template === 'article') {
      const hasPullquote = (idx % 3 === 0);
      const missingSidebar = hasDev('missing-block');
      const bodyTag = hasDev('section-tag') ? 'section' : 'div';

      let sidebarHtml = '';
      if (!missingSidebar) {
        sidebarHtml = `<aside class="sidebar">
          <div class="card">
            <h3 class="title">Related Insights</h3>
            <p>Exploring automated verification pipelines and blast radius bounds.</p>
          </div>
          <div class="card">
            <h3 class="title">Engineering Team</h3>
            <p>Frontend architecture and automated regression testing specialists.</p>
          </div>
        </aside>`;
      }

      let crossElement = '';
      if (hasDev('cross-template')) {
        crossElement = `<div class="cross-info"><span class="price">$79.00</span> <button type="button" class="btn btn-primary">Purchase Access</button></div>`;
      }

      let extraClassElem = '';
      if (hasDev('extra-classes')) {
        extraClassElem = `<div class="promo-banner"><p>Notice: Legacy document layout active.</p></div>`;
      }

      let inlineStyleAttr = '';
      if (hasDev('inline-styles')) {
        inlineStyleAttr = ` style="color: var(--brand); font-family: 'Brand Sans', sans-serif; animation-name: pulse;"`;
      }

      mainContent = `<main class="article">
        <div>
          <h1 class="article__title"${inlineStyleAttr}>Technical Architecture Analysis #${idx}</h1>
          <p class="article__meta">Published on October 12, 2026 · 6 min read</p>
          ${campaignHtml}
          ${extraClassElem}
          <${bodyTag} class="article__body">
            ${getParagraphs(6)}
            <figure class="article__figure">
              <img src="/img/x.png" alt="Selector analysis flow diagram">
              <figcaption>Figure 1: Architectural pipeline for headless DOM inspection.</figcaption>
            </figure>
            ${hasPullquote ? '<blockquote class="pullquote"><p>Evaluating selector impact across thousands of DOM trees requires deterministic state capture.</p></blockquote>' : ''}
            ${getParagraphs(5)}
            ${crossElement}
            ${extLinkHtml}
          </${bodyTag}>
        </div>
        ${sidebarHtml}
      </main>`;
    } else if (page.template === 'product') {
      const isSale = (idx % 5 < 2); // 40% sale
      const missingGallery = hasDev('missing-block');
      const infoTag = hasDev('section-tag') ? 'section' : 'div';

      let galleryHtml = '';
      if (!missingGallery) {
        galleryHtml = `<div class="product__gallery">
          <img src="/img/x.png" alt="Product primary inspection view">
          <img src="/img/x.png" alt="Product perspective detail">
          <img src="/img/x.png" alt="Product packaging and accessories">
        </div>`;
      }

      let crossElement = '';
      if (hasDev('cross-template')) {
        crossElement = `<blockquote class="pullquote"><p>Highest rated by the frontend engineering consortium.</p></blockquote>`;
      }

      let extraClassElem = '';
      if (hasDev('extra-classes')) {
        extraClassElem = `<div class="card card--featured"><h3 class="title">Featured Upgrade</h3><p>Includes extended warranty and automated support.</p></div>`;
      }

      let inlineStyleAttr = '';
      if (hasDev('inline-styles')) {
        inlineStyleAttr = ` style="color: var(--brand); font-family: 'Brand Sans', sans-serif; animation-name: pulse;"`;
      }

      mainContent = `<main class="product">
        ${galleryHtml}
        <${infoTag} class="product__info">
          <h1 class="product__name"${inlineStyleAttr}>Enterprise Performance Module #${idx}</h1>
          ${campaignHtml}
          ${extraClassElem}
          <div>
            ${isSale ? '<span class="price--sale">$149.00</span> ' : ''}
            <span class="price">$99.00</span>
          </div>
          <p>High-throughput headless analysis node configured for large-scale enterprise test suites.</p>
          <div class="product__actions">
            <button type="button" class="btn btn-primary">Add to Cart</button>
            <button type="button" class="btn">Add to Wishlist</button>
          </div>
          <ul class="specs">
            <li class="item"><strong>Form Factor:</strong> Cloud Container</li>
            <li class="item"><strong>Memory Bandwidth:</strong> High Precision</li>
            <li class="item"><strong>Concurrency:</strong> Multi-threaded</li>
            <li class="item"><strong>Protocol:</strong> HTTP/2 & gRPC</li>
            <li class="item"><strong>Latency:</strong> Low Overhead</li>
            <li class="item"><strong>Compliance:</strong> ISO Certified</li>
          </ul>
          ${crossElement}
          ${extLinkHtml}
        </${infoTag}>
        <section class="reviews">
          <h2 class="reviews__title">Verified User Reviews</h2>
          <div class="review">
            <div class="review__header">
              <span class="review__author">Sarah Jenkins</span>
              <span class="review__rating">★★★★★</span>
            </div>
            <p>Transformed our testing speed completely. Highly recommended for complex multi-page apps.</p>
          </div>
          <div class="review">
            <div class="review__header">
              <span class="review__author">David Kim</span>
              <span class="review__rating">★★★★★</span>
            </div>
            <p>Seamless integration with our continuous integration runners and zero false alarms.</p>
          </div>
          <div class="review">
            <div class="review__header">
              <span class="review__author">Elena Rostova</span>
              <span class="review__rating">★★★★☆</span>
            </div>
            <p>Detailed reporting and robust deterministic snapshots make tracking changes straightforward.</p>
          </div>
        </section>
      </main>`;
    } else if (page.template === 'docs') {
      const missingToc = hasDev('missing-block');
      const layoutTag = hasDev('section-tag') ? 'section' : 'div';

      let tocHtml = '';
      if (!missingToc) {
        tocHtml = `<nav class="toc">
          <a href="#overview">System Overview</a>
          <a href="#architecture">Architecture Details</a>
          <a href="#configuration">Configuration Schema</a>
          <a href="#integration">Workflow Integration</a>
          <a href="#diagnostics">Diagnostics & Logs</a>
        </nav>`;
      }

      let crossElement = '';
      if (hasDev('cross-template')) {
        crossElement = `<div class="card-grid">
          <div class="card">
            <h3 class="title">Related Document</h3>
            <p>Deep dive into selector evaluation algorithms.</p>
            <a href="#" class="card__link">Read Documentation</a>
          </div>
        </div>`;
      }

      let extraClassElem = '';
      if (hasDev('extra-classes')) {
        extraClassElem = `<div class="legacy-grid"><div class="card"><h3 class="title">Legacy Notice</h3><p>Compatibility mode enabled.</p></div></div>`;
      }

      let inlineStyleAttr = '';
      if (hasDev('inline-styles')) {
        inlineStyleAttr = ` style="color: var(--brand); font-family: 'Brand Sans', sans-serif; animation-name: pulse;"`;
      }

      mainContent = `<${layoutTag} class="docs-layout">
        <div class="docs-header">
          <input type="search" class="docs-search" placeholder="Search documentation...">
          ${campaignHtml}
          ${extraClassElem}
        </div>
        ${tocHtml}
        <article class="docs-content">
          <h1${inlineStyleAttr}>Specification & Implementation Guide #${idx}</h1>
          <h2 id="overview">1. System Overview</h2>
          ${getParagraphs(3)}
          <pre><code>// Engine configuration example
const engine = new AnalysisEngine({
  concurrency: 8,
  deterministic: true,
  snapshotMode: "bitmap"
});
await engine.initialize();</code></pre>
          <h2 id="architecture">2. Architecture Details</h2>
          ${getParagraphs(3)}
          <table class="docs-table">
            <thead>
              <tr><th>Parameter</th><th>Type</th><th>Default</th><th>Description</th></tr>
            </thead>
            <tbody>
              <tr><td>concurrency</td><td>number</td><td>4</td><td>Headless renderer pool count</td></tr>
              <tr><td>deterministic</td><td>boolean</td><td>true</td><td>Enforce seeded PRNG execution</td></tr>
              <tr><td>timeout</td><td>number</td><td>5000</td><td>Per-page navigation timeout in ms</td></tr>
              <tr><td>retries</td><td>number</td><td>2</td><td>Maximum retry attempts on network error</td></tr>
            </tbody>
          </table>
          ${crossElement}
          <h2 id="configuration">3. Configuration Schema</h2>
          ${getParagraphs(2)}
          ${extLinkHtml}
        </article>
      </${layoutTag}>`;
    } else if (page.template === 'listing') {
      const gridTag = hasDev('section-tag') ? 'section' : 'div';
      const cardCount = hasDev('missing-block') ? 8 : 12;

      let crossElement = '';
      if (hasDev('cross-template')) {
        crossElement = `<div class="promo-banner"><p>Exclusive directory catalog deals available.</p></div>`;
      }

      let inlineStyleAttr = '';
      if (hasDev('inline-styles')) {
        inlineStyleAttr = ` style="color: var(--brand); font-family: 'Brand Sans', sans-serif; animation-name: pulse;"`;
      }

      const cardsHtml = [];
      for (let c = 1; c <= cardCount; c++) {
        const isFeatured = (c % 4 === 0) || (hasDev('extra-classes') && c === 1);
        const cardClass = isFeatured ? 'card card--featured' : 'card';
        const hasImg = (c % 2 === 0);
        cardsHtml.push(`<div class="${cardClass}">
          ${hasImg ? '<img src="/img/x.png" alt="Catalog item preview">' : ''}
          <h3 class="title">Catalog Listing Item ${c}</h3>
          <p>Detailed performance profile and capability metrics for test item #${c}.</p>
          <a href="/products/p-0001.html" class="card__link">View Item Details</a>
        </div>`);
      }

      let extraGridClass = hasDev('extra-classes') ? ' legacy-grid' : '';

      mainContent = `<main class="listing-page" style="max-width: 1200px; margin: 2rem auto; padding: 0 1.25rem;">
        <h1${inlineStyleAttr}>Component Directory & Index #${idx}</h1>
        ${campaignHtml}
        ${crossElement}
        <${gridTag} class="card-grid${extraGridClass}">
          ${cardsHtml.join('\n')}
        </${gridTag}>
        <div style="margin-top: 2rem;">
          ${extLinkHtml}
        </div>
      </main>`;
    } else if (page.template === 'landing') {
      const missingFeatures = hasDev('missing-block');
      let crossElement = '';
      if (hasDev('cross-template')) {
        crossElement = `<div style="margin: 2rem 0;"><input type="search" class="docs-search" placeholder="Search documentation..."></div>`;
      }

      let extraClassElem = '';
      if (hasDev('extra-classes')) {
        extraClassElem = `<div class="card card--featured"><h3 class="title">Special Access Pass</h3><p>Enterprise subscription tier benefits enabled.</p></div>`;
      }

      let inlineStyleAttr = '';
      if (hasDev('inline-styles')) {
        inlineStyleAttr = ` style="color: var(--brand); font-family: 'Brand Sans', sans-serif; animation-name: pulse;"`;
      }

      let featuresHtml = '';
      if (!missingFeatures) {
        featuresHtml = `<section class="features">
          <div class="feature">
            <h3 class="feature__title">Headless Evaluation</h3>
            <p class="feature__desc">Render every page in headless Chromium to capture exact selector behavior across viewports.</p>
          </div>
          <div class="feature">
            <h3 class="feature__title">Visual Diffing</h3>
            <p class="feature__desc">Compute pixel-perfect perceptual diffs for modified CSS rules with sub-pixel precision.</p>
          </div>
          <div class="feature">
            <h3 class="feature__title">Deterministic Builds</h3>
            <p class="feature__desc">Ensure reproducible test suites across all staging and continuous integration environments.</p>
          </div>
        </section>`;
      }

      mainContent = `<main class="landing-main">
        <section class="hero" id="hero">
          <h1${inlineStyleAttr}>CSS Blast Radius & Layout Inspection #${idx}</h1>
          <p class="hero__subtitle">Count which pages of a massive website a stylesheet edit can reach before deploying to production.</p>
          <a href="/products/p-0001.html" class="btn btn-primary">Get Started Now</a>
        </section>
        <div style="max-width: 1150px; margin: 1.5rem auto; padding: 0 1.25rem;">
          ${campaignHtml}
          ${extraClassElem}
          <div class="promo-banner" style="animation-name: pulse;">
            <p>Continuous inspection now available for enterprise workspaces across multiple domains.</p>
          </div>
        </div>
        ${featuresHtml}
        <section class="landing-showcase">
          <h2>Enterprise Platform Integration</h2>
          ${getParagraphs(4)}
          ${crossElement}
          ${extLinkHtml}
        </section>
        <div class="toast is-visible">
          <span>Session initialized successfully. Monitoring active pages.</span>
          <button type="button" class="toast__close">&times;</button>
        </div>
      </main>`;
    }

    if (hasDev('legacy-wrapper')) {
      mainContent = `<div class="legacy-wrapper">\n${mainContent}\n</div>`;
    }

    let pageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BlastRadius - Page ${page.url}</title>
  ${cssLinks.join('\n  ')}
  <script src="/js/menu.js" defer></script>
</head>
<body class="${bodyClass}">
${headerHtml}
${mainContent}
${footerHtml}
</body>
</html>`;

    // Ensure 3-10 KB size rule
    let byteLen = Buffer.byteLength(pageHtml, 'utf8');
    if (byteLen < 3200) {
      const padText = `\n<!-- Supplementary metadata padding for determinism -->\n<div style="display:none;">${paragraphsCorpus.join(' ')}</div>`;
      pageHtml = pageHtml.replace('</body>', `${padText}\n</body>`);
      byteLen = Buffer.byteLength(pageHtml, 'utf8');
    }

    // Safety check: is-open must NEVER appear in HTML
    if (pageHtml.includes('is-open')) {
      throw new Error(`Forbidden string "is-open" detected in ${page.url}`);
    }

    // Record classes for exact markers
    const classMatches = pageHtml.matchAll(/class=["']([^"']+)["']/g);
    const classesInPage = new Set();
    for (const cm of classMatches) {
      const tokens = cm[1].trim().split(/\s+/);
      for (const t of tokens) {
        if (t) classesInPage.add(t);
      }
    }

    for (const m of trackedMarkers) {
      if (classesInPage.has(m)) {
        markerMap[m].push(page.url);
      }
    }

    const outPath = path.join(targetDir, page.fileRel);
    fs.writeFileSync(outPath, pageHtml, 'utf8');
    totalBytes += byteLen;

    manifestPages.push({
      url: page.url,
      template: page.template,
      copy: page.copy,
      deviations: page.deviations,
    });
  }

  // Count templates
  const templateCounts = {};
  for (const p of manifestPages) {
    templateCounts[p.template] = (templateCounts[p.template] || 0) + 1;
  }

  // Sitemap.xml
  const sitemapLines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const p of manifestPages) {
    sitemapLines.push(`  <url><loc>${p.url}</loc></url>`);
  }
  sitemapLines.push('</urlset>\n');
  const sitemapContent = sitemapLines.join('\n');
  fs.writeFileSync(path.join(targetDir, 'sitemap.xml'), sitemapContent, 'utf8');
  totalBytes += Buffer.byteLength(sitemapContent, 'utf8');

  // Sort marker lists for determinism
  for (const m of trackedMarkers) {
    markerMap[m].sort();
  }

  // fixture-manifest.json
  const manifest = {
    pages: manifestPages,
    templates: templateCounts,
    markers: markerMap,
  };
  const manifestContent = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(targetDir, 'fixture-manifest.json'), manifestContent, 'utf8');
  totalBytes += Buffer.byteLength(manifestContent, 'utf8');

  // Include CSS & JS in total bytes
  totalBytes +=
    Buffer.byteLength(baseCss, 'utf8') +
    Buffer.byteLength(componentsCss, 'utf8') +
    Buffer.byteLength(utilitiesCss, 'utf8') +
    Buffer.byteLength(legacyCss, 'utf8') +
    Buffer.byteLength(articleCss, 'utf8') +
    Buffer.byteLength(productCss, 'utf8') +
    Buffer.byteLength(docsCss, 'utf8') +
    Buffer.byteLength(landingCss, 'utf8') +
    Buffer.byteLength(MENU_JS_CONTENT, 'utf8') +
    PNG_1X1_BUFFER.length;

  const totalCopies = manifestPages.filter((p) => p.copy).length;
  const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(2);

  const summary = `Generated ${manifestPages.length} pages (${totalCopies} copies), ${totalCssRules} CSS rules, ${totalBytes} bytes in ${elapsedSec}s`;
  console.log(summary);
}

// CLI argument parsing
const args = process.argv.slice(2);
let outDir = null;
let pages = 400;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--pages') {
    pages = parseInt(args[++i], 10);
  } else if (arg.startsWith('--pages=')) {
    pages = parseInt(arg.slice('--pages='.length), 10);
  } else if (!arg.startsWith('-') && !outDir) {
    outDir = arg;
  }
}

if (!outDir) {
  console.error('Usage: node fixtures/generate-large-site.mjs <outDir> [--pages N]');
  process.exit(1);
}

if (Number.isNaN(pages) || pages <= 0) {
  pages = 400;
}

generateSite(outDir, pages);
