function toggleMenu(button) {
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(open));
  document.getElementById("submenu").hidden = !open;
}
function moreClicked() {
  document.title += " +";
}
document.addEventListener("DOMContentLoaded", () => {
  const menu = document.getElementById("menu");
  menu.addEventListener("click", () => toggleMenu(menu));
  document.getElementById("more").addEventListener("click", moreClicked);
});
