window.fixtureApp = { ready: true };

function greet(name) {
  return "Hello " + name;
}

window.fixtureApp.greet = greet;

// Runs on the about page only: coverage tells the pages where greet ran.
if (location.pathname.endsWith("/about.html")) greet("about");
