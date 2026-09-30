(function () {
  "use strict";

  var listEl = document.getElementById("items");
  var summaryEl = document.getElementById("summary");
  var inputEl = document.getElementById("new-item");

  function render(state) {
    var items = state && Array.isArray(state.items) ? state.items : [];
    listEl.innerHTML = "";
    if (items.length === 0) {
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "Nothing here yet.";
      listEl.appendChild(empty);
    }
    items.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "item" + (item.done ? " done" : "");
      li.dataset.id = item.id;

      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!item.done;
      box.addEventListener("change", function () {
        window.canvas.send({ type: "toggle", id: item.id, done: box.checked });
      });

      var text = document.createElement("span");
      text.className = "text";
      text.textContent = item.text;

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.setAttribute("aria-label", "Remove item");
      remove.textContent = "×";
      remove.addEventListener("click", function () {
        window.canvas.send({ type: "remove", id: item.id });
      });

      li.appendChild(box);
      li.appendChild(text);
      li.appendChild(remove);
      listEl.appendChild(li);
    });
    var done = items.filter(function (i) {
      return i.done;
    }).length;
    summaryEl.textContent = done + " of " + items.length + " done";
  }

  // Not a <form>: the iframe sandbox has no "allow-forms".
  function submitAdd() {
    var text = inputEl.value.trim();
    if (!text) return;
    window.canvas.send({ type: "add", text: text });
    inputEl.value = "";
  }
  document.getElementById("add-btn").addEventListener("click", submitAdd);
  inputEl.addEventListener("keydown", function (event) {
    if (event.key === "Enter") submitAdd();
  });
  document.getElementById("clear-btn").addEventListener("click", function () {
    window.canvas.send({ type: "clear_completed" });
  });

  window.canvas.onState(render);
})();
