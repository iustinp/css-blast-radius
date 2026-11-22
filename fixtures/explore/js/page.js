const out = () => document.getElementById("out");
function searched(e) {
  out().textContent = "searching " + e.target.value;
}
function picked(e) {
  out().textContent = "picked " + e.target.value;
}
function hovered() {
  out().textContent = "hovered";
}
function opened() {
  out().textContent = "opened";
}
function saved() {
  out().textContent = "saved";
}
function blocked() {
  out().textContent = "blocked";
}
function submitted(e) {
  e.preventDefault();
  out().textContent = "submitted";
}
function dot(i) {
  out().textContent = "dot " + i;
}
function soon() {
  out().dataset.soon = "1";
}
function awayClicked() {
  out().dataset.away = "1";
}
function neverCalled() {
  out().textContent = "never";
}
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("q").addEventListener("input", searched);
  document.getElementById("country").addEventListener("change", picked);
  document.getElementById("hov").addEventListener("mouseenter", hovered);
  document.getElementById("det").addEventListener("toggle", opened);
  document.getElementById("save").addEventListener("click", () => fetch("/api/save", { method: "POST" }).then(saved, blocked));
  document.getElementById("lazy").addEventListener("click", () => import("/js/lazy.js").then((m) => m.run()));
  document.getElementById("login").addEventListener("submit", submitted);
  document.querySelectorAll(".dot").forEach((b, i) => b.addEventListener("click", () => dot(i)));
  document.getElementById("away").addEventListener("click", awayClicked);
  setTimeout(soon, 100);
});
